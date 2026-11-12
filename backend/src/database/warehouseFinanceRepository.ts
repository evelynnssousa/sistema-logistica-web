import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { redactValidCpf } from '../integrations/redaction.js'
import {
  agreementSituation,
  cents,
  deliveryDebit,
  entryValue,
  exitCost,
  unitCost,
} from '../requests/warehouseValuation.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { conflict, ModuleError, notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { protocolSql } from './protocolSql.js'
import { withTransaction } from './withTransaction.js'

/**
 * Valores do Almoxarifado (migração 020): custo médio, atas de registro de preços e painel
 * financeiro. Só quem tem warehouse:finance chega aqui pelas rotas; a baixa automática da entrega
 * usa recordStockMovement mesmo sem a 020, só que sem valores.
 */

type Client = Pick<PoolClient, 'query'>

export async function financeSchemaExists(client: Client) {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.warehouse_price_agreements') IS NOT NULL AS present`,
  )
  return result.rows[0].present
}

const missingMigration = () =>
  new ModuleError('Os valores do Almoxarifado dependem da migração 020, ainda não aplicada neste banco.', 409)

export type MovementFinance = {
  /** Valor total pago (só entrada). Ausente: a entrada vale o custo médio atual. */
  paid?: number | null
  invoice?: string | null
  commitment?: string | null
  supplier?: string | null
  agreementId?: string | null
}

const hasFinance = (finance: MovementFinance | undefined) =>
  Boolean(
    finance &&
      (finance.paid !== null && finance.paid !== undefined ||
        finance.invoice || finance.commitment || finance.supplier || finance.agreementId),
  )

/**
 * Registra uma entrada ou saída, com o valor quando a 020 existe. Quem chama já conferiu o saldo
 * (saída nunca maior que o estoque). O gatilho da estrutura original atualiza a quantidade; aqui
 * se atualiza o valor do estoque, sob o mesmo bloqueio da linha do material.
 */
export async function recordStockMovement(
  client: Client,
  input: {
    materialId: string
    type: 'entrada' | 'saida'
    quantity: number
    reason: string
    userId: string
    requestId?: string | null
    finance?: MovementFinance
  },
) {
  const withValues = await financeSchemaExists(client)
  if (!withValues && hasFinance(input.finance)) throw missingMigration()

  const found = await client.query<{ estoque_atual: string; valor_estoque: string | null }>(
    `SELECT estoque_atual, to_jsonb(m)->>'valor_estoque' AS valor_estoque FROM public.materials m WHERE id = $1 FOR UPDATE`,
    [input.materialId],
  )
  if (!found.rows[0]) throw notFound()
  const stock = { quantity: Number(found.rows[0].estoque_atual), value: Number(found.rows[0].valor_estoque ?? 0) }
  if (input.type === 'saida' && stock.quantity < input.quantity) {
    throw conflict('A saída é maior que o saldo interno registrado.')
  }

  if (!withValues) {
    await client.query(
      `INSERT INTO public.stock_movements (material_id, tipo, quantidade, motivo, usuario_id, material_request_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.materialId, input.type, input.quantity, input.reason, input.userId, input.requestId ?? null],
    )
    return { value: null }
  }

  const finance = input.finance ?? {}
  if (finance.agreementId) {
    const agreement = await client.query<{ ativo: boolean }>(
      `SELECT ativo FROM public.warehouse_price_agreements WHERE id = $1`,
      [finance.agreementId],
    )
    if (!agreement.rows[0]) throw new ModuleError('Ata não encontrada.', 400)
    if (!agreement.rows[0].ativo) throw conflict('Esta ata está encerrada. Escolha uma ata ativa.')
  }

  const valued =
    input.type === 'entrada'
      ? entryValue(stock, input.quantity, finance.paid ?? null)
      : { value: exitCost(stock, input.quantity), informed: false }
  const newValue = Math.max(0, cents(stock.value + (input.type === 'entrada' ? valued.value : -valued.value)))

  await client.query(
    `INSERT INTO public.stock_movements
       (material_id, tipo, quantidade, motivo, usuario_id, material_request_id,
        valor_total, valor_informado, nota_fiscal, empenho, fornecedor, ata_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.materialId,
      input.type,
      input.quantity,
      input.reason,
      input.userId,
      input.requestId ?? null,
      valued.value,
      valued.informed,
      input.type === 'entrada' ? finance.invoice ?? null : null,
      input.type === 'entrada' ? finance.commitment ?? null : null,
      input.type === 'entrada' ? finance.supplier ?? null : null,
      input.type === 'entrada' ? finance.agreementId ?? null : null,
    ],
  )
  await client.query(`UPDATE public.materials SET valor_estoque = $2 WHERE id = $1`, [input.materialId, newValue])
  return { value: valued.value }
}

/**
 * Baixa automática na entrega (12/11/2026): cada material atendido sai do saldo interno, com o
 * custo médio do momento. A entrega nunca falha por falta de saldo: sai o que houver, e a
 * justificativa diz quanto faltou.
 */
export async function debitDelivery(client: Client, input: { requestId: string; protocol: string; userId: string }) {
  const items = await client.query<{ material_id: string; atendida: string }>(
    `SELECT material_id::text AS material_id, sum(quantidade_atendida) AS atendida
       FROM public.material_request_items
      WHERE material_request_id = $1 AND quantidade_atendida > 0
      GROUP BY material_id
      ORDER BY material_id`,
    [input.requestId],
  )
  const result: { materialId: string; debited: number; missing: number }[] = []
  for (const item of items.rows) {
    const current = await client.query<{ estoque_atual: string }>(
      `SELECT estoque_atual FROM public.materials WHERE id = $1 FOR UPDATE`,
      [item.material_id],
    )
    if (!current.rows[0]) continue
    const { debited, missing } = deliveryDebit(Number(current.rows[0].estoque_atual), Number(item.atendida))
    result.push({ materialId: item.material_id, debited, missing })
    if (debited <= 0) continue
    const shortfall = missing > 0 ? ` Saldo interno insuficiente: baixado ${debited} de ${Number(item.atendida)}.` : ''
    await recordStockMovement(client, {
      materialId: item.material_id,
      type: 'saida',
      quantity: debited,
      reason: `Baixa automática da entrega do pedido ${input.protocol}.${shortfall}`,
      userId: input.userId,
      requestId: input.requestId,
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// Atas, valor do saldo e painel
// ---------------------------------------------------------------------------

export type AgreementInput = {
  number: string
  supplier: string | null
  subject: string | null
  total: number
  validFrom: string | null
  validUntil: string | null
  active: boolean
}

type AgreementRow = {
  id: string
  numero: string
  fornecedor: string | null
  objeto: string | null
  valor_total: string
  vigencia_inicio: string | null
  vigencia_fim: string | null
  ativo: boolean
  gasto: string | null
  entradas: number
}

const brasiliaToday = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })

function presentAgreement(row: AgreementRow, today: string) {
  const total = Number(row.valor_total)
  const spent = Number(row.gasto ?? 0)
  const agreement = { active: row.ativo, validFrom: row.vigencia_inicio, validUntil: row.vigencia_fim }
  return {
    id: row.id,
    number: row.numero,
    supplier: row.fornecedor,
    subject: row.objeto,
    total,
    spent,
    balance: cents(total - spent),
    usedPercent: total > 0 ? Math.round((spent / total) * 1000) / 10 : null,
    entries: row.entradas,
    validFrom: row.vigencia_inicio,
    validUntil: row.vigencia_fim,
    active: row.ativo,
    situation: agreementSituation(agreement, today),
  }
}

function auditFinance(
  client: Client,
  actor: AuthenticatedIdentity,
  eventType: 'warehouse_agreement_saved' | 'warehouse_value_set',
  resourceId: string,
  details: Record<string, string>,
) {
  return insertAuthAuditEvent(client, {
    actorUserId: actor.userId,
    actorKind: 'user',
    subjectUserId: null,
    sessionId: resourceId,
    eventType,
    details,
  })
}

/** Duplicidade de número de ata: mensagem clara em vez do erro do banco. */
function duplicateNumber(error: unknown) {
  return (error as { code?: string } | undefined)?.code === '23505'
}

export class WarehouseFinanceRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  private async requireSchema(client: Client) {
    if (!(await financeSchemaExists(client))) throw missingMigration()
  }

  async agreements() {
    const pool = this.poolProvider()
    await this.requireSchema(pool)
    const result = await pool.query<AgreementRow>(
      `SELECT a.id::text AS id, a.numero, a.fornecedor, a.objeto, a.valor_total,
              to_char(a.vigencia_inicio, 'YYYY-MM-DD') AS vigencia_inicio,
              to_char(a.vigencia_fim, 'YYYY-MM-DD') AS vigencia_fim, a.ativo,
              (SELECT sum(s.valor_total) FROM public.stock_movements s
                WHERE s.ata_id = a.id AND s.tipo = 'entrada' AND s.valor_informado) AS gasto,
              (SELECT count(*)::int FROM public.stock_movements s WHERE s.ata_id = a.id AND s.tipo = 'entrada') AS entradas
         FROM public.warehouse_price_agreements a
        ORDER BY a.ativo DESC, a.vigencia_fim DESC NULLS LAST, lower(a.numero)`,
    )
    const today = brasiliaToday()
    return result.rows.map((row) => presentAgreement(row, today))
  }

  async saveAgreement(actor: AuthenticatedIdentity, id: string | null, input: AgreementInput) {
    return withTransaction(this.poolProvider(), async (client) => {
      await this.requireSchema(client)
      try {
        let savedId = id
        if (id) {
          const updated = await client.query(
            `UPDATE public.warehouse_price_agreements
                SET numero = $2, fornecedor = $3, objeto = $4, valor_total = $5, vigencia_inicio = $6,
                    vigencia_fim = $7, ativo = $8, updated_at = now()
              WHERE id = $1`,
            [id, input.number, input.supplier, input.subject, input.total, input.validFrom, input.validUntil, input.active],
          )
          if (updated.rowCount === 0) throw notFound()
        } else {
          const created = await client.query<{ id: string }>(
            `INSERT INTO public.warehouse_price_agreements
               (numero, fornecedor, objeto, valor_total, vigencia_inicio, vigencia_fim, ativo, criado_por)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text AS id`,
            [input.number, input.supplier, input.subject, input.total, input.validFrom, input.validUntil, input.active, actor.userId],
          )
          savedId = created.rows[0].id
        }
        // Sem valores na auditoria: ela também é lida por quem não vê valores.
        await auditFinance(client, actor, 'warehouse_agreement_saved', savedId!, {
          action: id ? 'updated' : 'created',
          number: input.number,
        })
        return savedId!
      } catch (error) {
        if (duplicateNumber(error)) throw conflict('Já existe uma ata com este número.')
        throw error
      }
    })
  }

  /** Valor do saldo atual de um material, por exemplo o estoque que existia antes da 020. */
  async setStockValue(actor: AuthenticatedIdentity, materialId: string, value: number, justification: string) {
    await withTransaction(this.poolProvider(), async (client) => {
      await this.requireSchema(client)
      const found = await client.query<{ estoque_atual: string; valor_estoque: string }>(
        `SELECT estoque_atual, valor_estoque FROM public.materials WHERE id = $1 FOR UPDATE`,
        [materialId],
      )
      if (!found.rows[0]) throw notFound()
      const quantity = Number(found.rows[0].estoque_atual)
      if (quantity <= 0 && value > 0) throw conflict('Sem saldo em estoque, não há valor para informar.')
      await client.query(
        `INSERT INTO public.material_value_adjustments (material_id, quantidade, valor_anterior, valor_novo, justificativa, usuario_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [materialId, quantity, found.rows[0].valor_estoque, value, redactValidCpf(justification), actor.userId],
      )
      await client.query(`UPDATE public.materials SET valor_estoque = $2 WHERE id = $1`, [materialId, value])
      await auditFinance(client, actor, 'warehouse_value_set', materialId, { quantity: String(quantity) })
    })
  }

  /** Painel financeiro: período para compras, consumo e rankings; o valor do estoque é o de agora. */
  async summary(period: { from: Date; to: Date }) {
    const pool = this.poolProvider()
    await this.requireSchema(pool)
    const range = [period.from, period.to]

    const [stock, monthly, expensive, topSpend, bySector, agreements, pending] = await Promise.all([
      pool.query<{ valor: string | null; materiais: number; sem_valor: number }>(
        `SELECT sum(valor_estoque) AS valor, count(*) FILTER (WHERE estoque_atual > 0)::int AS materiais,
                count(*) FILTER (WHERE estoque_atual > 0 AND valor_estoque = 0)::int AS sem_valor
           FROM public.materials WHERE ativo`,
      ),
      pool.query<{ mes: string; compras: string | null; consumo: string | null }>(
        `SELECT to_char(date_trunc('month', s.created_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS mes,
                sum(s.valor_total) FILTER (WHERE s.tipo = 'entrada' AND s.valor_informado) AS compras,
                sum(s.valor_total) FILTER (WHERE s.tipo = 'saida') AS consumo
           FROM public.stock_movements s
          WHERE s.created_at >= $1 AND s.created_at < $2 AND s.valor_total > 0
          GROUP BY 1
         HAVING sum(s.valor_total) FILTER (WHERE s.tipo = 'saida') > 0
             OR sum(s.valor_total) FILTER (WHERE s.tipo = 'entrada' AND s.valor_informado) > 0
          ORDER BY 1`,
        range,
      ),
      pool.query<{ id: string; codigo: string | null; nome: string; unidade: string; estoque_atual: string; valor_estoque: string; ultimo_preco: string | null }>(
        `SELECT m.id::text AS id, m.codigo, m.nome, m.unidade, m.estoque_atual, m.valor_estoque,
                (SELECT s.valor_total / s.quantidade FROM public.stock_movements s
                  WHERE s.material_id = m.id AND s.tipo = 'entrada' AND s.valor_informado
                  ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS ultimo_preco
           FROM public.materials m
          WHERE m.ativo AND (m.valor_estoque > 0 OR EXISTS (
                SELECT 1 FROM public.stock_movements s WHERE s.material_id = m.id AND s.valor_informado))`,
      ),
      pool.query<{ nome: string; unidade: string; quantidade: string; valor: string }>(
        `SELECT m.nome, m.unidade, sum(s.quantidade) AS quantidade, sum(s.valor_total) AS valor
           FROM public.stock_movements s JOIN public.materials m ON m.id = s.material_id
          WHERE s.tipo = 'entrada' AND s.valor_informado AND s.created_at >= $1 AND s.created_at < $2
          GROUP BY m.id ORDER BY 4 DESC, lower(m.nome) LIMIT 10`,
        range,
      ),
      pool.query<{ setor: string | null; valor: string; pedidos: number }>(
        `SELECT COALESCE(to_jsonb(r)->>'setor_nome', st.nome) AS setor, sum(s.valor_total) AS valor,
                count(DISTINCT r.id)::int AS pedidos
           FROM public.stock_movements s
           JOIN public.material_requests r ON r.id = s.material_request_id
           LEFT JOIN public.setores st ON st.id = r.setor_id
          WHERE s.tipo = 'saida' AND s.created_at >= $1 AND s.created_at < $2
          GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT 15`,
        range,
      ),
      this.agreements(),
      pool.query<{ id: string; codigo: string | null; nome: string; unidade: string; estoque_atual: string }>(
        `SELECT id::text AS id, codigo, nome, unidade, estoque_atual FROM public.materials
          WHERE ativo AND estoque_atual > 0 AND valor_estoque = 0 ORDER BY lower(nome) LIMIT 200`,
      ),
    ])

    const purchases = monthly.rows.reduce((total, row) => total + Number(row.compras ?? 0), 0)
    const consumption = monthly.rows.reduce((total, row) => total + Number(row.consumo ?? 0), 0)
    const current = agreements.filter((agreement) => agreement.situation === 'vigente')
    const materials = expensive.rows.map((row) => ({
      id: row.id,
      code: row.codigo,
      name: row.nome,
      unit: row.unidade,
      quantity: Number(row.estoque_atual),
      stockValue: Number(row.valor_estoque),
      averageCost: unitCost(Number(row.estoque_atual), Number(row.valor_estoque)),
      lastPrice: row.ultimo_preco === null ? null : cents(Number(row.ultimo_preco)),
    }))
    const priceOf = (item: (typeof materials)[number]) => item.averageCost ?? item.lastPrice ?? 0

    return {
      period: { from: period.from, to: period.to },
      stockValue: cents(Number(stock.rows[0].valor ?? 0)),
      materialsInStock: stock.rows[0].materiais,
      materialsWithoutValue: stock.rows[0].sem_valor,
      purchases: cents(purchases),
      consumption: cents(consumption),
      agreementsTotal: cents(current.reduce((total, agreement) => total + agreement.total, 0)),
      agreementsSpent: cents(current.reduce((total, agreement) => total + agreement.spent, 0)),
      agreementsBalance: cents(current.reduce((total, agreement) => total + agreement.balance, 0)),
      monthly: monthly.rows.map((row) => ({
        month: row.mes,
        purchases: cents(Number(row.compras ?? 0)),
        consumption: cents(Number(row.consumo ?? 0)),
      })),
      mostExpensive: [...materials].sort((a, b) => priceOf(b) - priceOf(a) || a.name.localeCompare(b.name, 'pt-BR')).slice(0, 10),
      highestStockValue: [...materials].filter((item) => item.stockValue > 0).sort((a, b) => b.stockValue - a.stockValue).slice(0, 10),
      topSpend: topSpend.rows.map((row) => ({
        name: row.nome,
        unit: row.unidade,
        quantity: Number(row.quantidade),
        value: cents(Number(row.valor)),
      })),
      bySector: bySector.rows.map((row) => ({
        sector: row.setor ?? 'Sem setor',
        value: cents(Number(row.valor ?? 0)),
        requests: row.pedidos,
      })),
      agreements,
      withoutValue: pending.rows.map((row) => ({
        id: row.id,
        code: row.codigo,
        name: row.nome,
        unit: row.unidade,
        quantity: Number(row.estoque_atual),
      })),
    }
  }

  /** Linhas da planilha: entradas com valor e o valor por material, no período. */
  async spreadsheetRows(period: { from: Date; to: Date }) {
    const pool = this.poolProvider()
    if (!(await financeSchemaExists(pool))) return null
    const entries = await pool.query<{
      created_at: Date
      material: string
      unidade: string
      quantidade: string
      valor_total: string | null
      valor_informado: boolean
      nota_fiscal: string | null
      empenho: string | null
      fornecedor: string | null
      ata: string | null
      usuario: string | null
    }>(
      `SELECT s.created_at, m.nome AS material, m.unidade, s.quantidade, s.valor_total, s.valor_informado,
              s.nota_fiscal, s.empenho, s.fornecedor, a.numero AS ata, u.full_name AS usuario
         FROM public.stock_movements s
         JOIN public.materials m ON m.id = s.material_id
         LEFT JOIN public.warehouse_price_agreements a ON a.id = s.ata_id
         LEFT JOIN public.auth_users u ON u.id = s.usuario_id
        WHERE s.tipo = 'entrada' AND s.created_at >= $1 AND s.created_at < $2
        ORDER BY s.created_at, s.id`,
      [period.from, period.to],
    )
    const exits = await pool.query<{
      created_at: Date
      material: string
      unidade: string
      quantidade: string
      valor_total: string | null
      protocolo: string | null
      setor: string | null
    }>(
      `SELECT s.created_at, m.nome AS material, m.unidade, s.quantidade, s.valor_total,
              CASE WHEN r.id IS NULL THEN NULL ELSE ${protocolSql('r')} END AS protocolo,
              COALESCE(to_jsonb(r)->>'setor_nome', st.nome) AS setor
         FROM public.stock_movements s
         JOIN public.materials m ON m.id = s.material_id
         LEFT JOIN public.material_requests r ON r.id = s.material_request_id
         LEFT JOIN public.setores st ON st.id = r.setor_id
        WHERE s.tipo = 'saida' AND s.created_at >= $1 AND s.created_at < $2
        ORDER BY s.created_at, s.id`,
      [period.from, period.to],
    )
    return {
      summary: await this.summary(period),
      entries: entries.rows.map((row) => ({
        at: row.created_at,
        material: row.material,
        unit: row.unidade,
        quantity: Number(row.quantidade),
        value: row.valor_total === null ? null : Number(row.valor_total),
        informed: row.valor_informado,
        invoice: row.nota_fiscal,
        commitment: row.empenho,
        supplier: row.fornecedor,
        agreement: row.ata,
        user: row.usuario,
      })),
      exits: exits.rows.map((row) => ({
        at: row.created_at,
        material: row.material,
        unit: row.unidade,
        quantity: Number(row.quantidade),
        value: row.valor_total === null ? null : Number(row.valor_total),
        protocol: row.protocolo,
        sector: row.setor,
      })),
    }
  }
}
