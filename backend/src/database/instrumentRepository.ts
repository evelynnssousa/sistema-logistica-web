import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { AttachmentStorage } from '../attachments/storage.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { notifyDemand } from '../demands/demandNotifications.js'
import { visibleDemandSql } from '../demands/demandPolicy.js'
import {
  instrumentSituation,
  instrumentTotals,
  itemBalance,
  money,
  renewalDue,
  renewalTitle,
  visibleInstrumentSql,
} from '../demands/instrumentRules.js'
import type { InstrumentSituation } from '../demands/instrumentRules.js'
import { redactOptional } from '../integrations/redaction.js'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { canRespondFor, nextDemandNumber, recordDemandHistory, todayInSaoPaulo } from './demandSeriesRepository.js'
import { conflict, ModuleError, notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'

/**
 * Atas e contratos do Controle de Demandas (migração 021). Quem chama já conferiu o acesso com
 * instrumentRules.ts; aqui só se grava e se lê. Utilizações e aditivos são permanentes.
 */

type Client = Pick<PoolClient, 'query'>

export async function instrumentSchemaExists(client: Client) {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.contract_instruments') IS NOT NULL AS present`,
  )
  return rows[0].present
}

const missingMigration = () =>
  new ModuleError('Atas e contratos dependem da migração 021, ainda não aplicada neste banco.', 503)

export type InstrumentInput = {
  type: 'ata' | 'contrato'
  number: string
  subject: string
  category: string
  supplier: string | null
  process: string | null
  total: number
  validFrom: string | null
  validUntil: string | null
  responsibleSectorId: string
  sharedSectorIds: string[]
  managerId: string | null
  noticeDays: number
  closed: boolean
  notes: string | null
}

export type ItemInput = {
  itemNumber: string | null
  description: string
  unit: string
  registered: number
  unitPrice: number
  active: boolean
}

type InstrumentRow = {
  id: string
  tipo: 'ata' | 'contrato'
  numero: string
  objeto: string
  categoria: string
  fornecedor: string | null
  processo: string | null
  valor_total: string
  vigencia_inicio: string | null
  vigencia_fim: string | null
  setor_responsavel_id: string
  setor_responsavel: string
  gestor_id: string | null
  gestor: string | null
  aviso_dias: number
  renovacao_demanda_id: string | null
  renovacao_numero: string | null
  encerrado: boolean
  observacoes: string | null
  gasto: string | null
  setores_compartilhados: { id: string; nome: string }[] | null
  updated_at: Date
}

const instrumentSelect = `
  SELECT i.id::text AS id, i.tipo, i.numero, i.objeto, i.categoria, i.fornecedor, i.processo, i.valor_total,
         to_char(i.vigencia_inicio, 'YYYY-MM-DD') AS vigencia_inicio, to_char(i.vigencia_fim, 'YYYY-MM-DD') AS vigencia_fim,
         i.setor_responsavel_id::text AS setor_responsavel_id, s.nome AS setor_responsavel,
         i.gestor_id::text AS gestor_id, g.full_name AS gestor, i.aviso_dias,
         i.renovacao_demanda_id::text AS renovacao_demanda_id, rd.numero AS renovacao_numero,
         i.encerrado, i.observacoes, i.updated_at,
         (SELECT sum(u.valor_total) FROM public.contract_instrument_usages u WHERE u.instrument_id = i.id) AS gasto,
         (SELECT json_agg(json_build_object('id', cs.sector_id::text, 'nome', ds.nome) ORDER BY ds.nome)
            FROM public.contract_instrument_sectors cs JOIN public.demand_sectors ds ON ds.id = cs.sector_id
           WHERE cs.instrument_id = i.id) AS setores_compartilhados
    FROM public.contract_instruments i
    JOIN public.demand_sectors s ON s.id = i.setor_responsavel_id
    LEFT JOIN public.auth_users g ON g.id = i.gestor_id
    LEFT JOIN public.demands rd ON rd.id = i.renovacao_demanda_id`

function present(row: InstrumentRow, today: string) {
  const total = Number(row.valor_total)
  const { situation, daysLeft } = instrumentSituation(
    { closed: row.encerrado, validFrom: row.vigencia_inicio, validUntil: row.vigencia_fim, noticeDays: row.aviso_dias },
    today,
  )
  return {
    id: row.id,
    type: row.tipo,
    number: row.numero,
    subject: row.objeto,
    category: row.categoria,
    supplier: row.fornecedor,
    process: row.processo,
    total,
    ...instrumentTotals(total, Number(row.gasto ?? 0)),
    validFrom: row.vigencia_inicio,
    validUntil: row.vigencia_fim,
    situation,
    daysLeft,
    responsibleSector: { id: row.setor_responsavel_id, name: row.setor_responsavel },
    sharedSectors: (row.setores_compartilhados ?? []).map((item) => ({ id: item.id, name: item.nome })),
    manager: row.gestor_id ? { id: row.gestor_id, name: row.gestor } : null,
    noticeDays: row.aviso_dias,
    renewalDemand: row.renovacao_demanda_id ? { id: row.renovacao_demanda_id, number: row.renovacao_numero } : null,
    closed: row.encerrado,
    notes: row.observacoes,
    updatedAt: row.updated_at,
  }
}

export type InstrumentView = ReturnType<typeof present>

function audit(client: Client, actor: AuthenticatedIdentity, instrumentId: string, details: Record<string, string>) {
  return insertAuthAuditEvent(client, {
    actorUserId: actor.userId,
    actorKind: 'user',
    subjectUserId: null,
    sessionId: instrumentId,
    eventType: 'contract_instrument_changed',
    details,
  })
}

const duplicate = (error: unknown) => (error as { code?: string } | undefined)?.code === '23505'

async function assertSectors(client: Client, ids: readonly string[]) {
  if (ids.length === 0) return
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.demand_sectors WHERE id = ANY($1::uuid[]) AND ativo`,
    [[...new Set(ids)]],
  )
  if (rows[0].n !== new Set(ids).size) throw new ModuleError('Setor inválido ou desativado.', 400)
}

async function assertPerson(client: Client, userId: string | null) {
  if (!userId) return
  const { rowCount } = await client.query(`SELECT 1 FROM public.auth_users WHERE id = $1 AND status = 'approved'`, [userId])
  if (!rowCount) throw new ModuleError('Gestor inválido.', 400)
}

async function saveSharedSectors(client: Client, id: string, input: InstrumentInput) {
  await client.query(`DELETE FROM public.contract_instrument_sectors WHERE instrument_id = $1`, [id])
  for (const sectorId of new Set(input.sharedSectorIds)) {
    if (sectorId === input.responsibleSectorId) continue
    await client.query(
      `INSERT INTO public.contract_instrument_sectors (instrument_id, sector_id) VALUES ($1, $2)`,
      [id, sectorId],
    )
  }
}

export class InstrumentRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async requireSchema() {
    if (!(await instrumentSchemaExists(this.poolProvider()))) throw missingMigration()
  }

  /** Setores do instrumento, para conferir o acesso. Inexistente: null. */
  async sectorsOf(id: string) {
    await this.requireSchema()
    const { rows } = await this.poolProvider().query<{ setor: string; compartilhados: string[] }>(
      `SELECT i.setor_responsavel_id::text AS setor,
              coalesce(array_agg(cs.sector_id::text) FILTER (WHERE cs.sector_id IS NOT NULL), '{}') AS compartilhados
         FROM public.contract_instruments i
         LEFT JOIN public.contract_instrument_sectors cs ON cs.instrument_id = i.id
        WHERE i.id = $1 GROUP BY i.id`,
      [id],
    )
    return rows[0] ? { responsibleSectorId: rows[0].setor, sharedSectorIds: rows[0].compartilhados } : null
  }

  async list(viewer: { userId: string; level: number }, filters: {
    search: string
    type: string | null
    category: string | null
    situation: InstrumentSituation | null
    sectorId: string | null
  }) {
    await this.requireSchema()
    const values: unknown[] = [viewer.userId, viewer.level]
    const conditions = [visibleInstrumentSql('i', '$1', '$2')]
    if (filters.search) {
      values.push(`%${filters.search.replace(/[\\%_]/g, '\\$&')}%`)
      const n = values.length
      conditions.push(`(i.numero ILIKE $${n} OR i.objeto ILIKE $${n} OR i.fornecedor ILIKE $${n} OR i.processo ILIKE $${n})`)
    }
    if (filters.type) {
      values.push(filters.type)
      conditions.push(`i.tipo = $${values.length}`)
    }
    if (filters.category) {
      values.push(filters.category)
      conditions.push(`i.categoria = $${values.length}`)
    }
    if (filters.sectorId) {
      values.push(filters.sectorId)
      const n = values.length
      conditions.push(`(i.setor_responsavel_id = $${n} OR EXISTS (SELECT 1 FROM public.contract_instrument_sectors f WHERE f.instrument_id = i.id AND f.sector_id = $${n}))`)
    }
    const { rows } = await this.poolProvider().query<InstrumentRow>(
      `${instrumentSelect} WHERE ${conditions.join(' AND ')}
        ORDER BY i.encerrado, i.vigencia_fim NULLS LAST, lower(i.numero) LIMIT 500`,
      values,
    )
    const today = todayInSaoPaulo()
    const all = rows.map((row) => present(row, today))
    return filters.situation ? all.filter((item) => item.situation === filters.situation) : all
  }

  /** Para o formulário da demanda: instrumentos visíveis e não encerrados. */
  async options(viewer: { userId: string; level: number }) {
    if (!(await instrumentSchemaExists(this.poolProvider()))) return []
    const { rows } = await this.poolProvider().query<{ id: string; tipo: string; numero: string; objeto: string }>(
      `SELECT i.id::text AS id, i.tipo, i.numero, i.objeto FROM public.contract_instruments i
        WHERE NOT i.encerrado AND ${visibleInstrumentSql('i', '$1', '$2')}
        ORDER BY i.tipo, lower(i.numero) LIMIT 500`,
      [viewer.userId, viewer.level],
    )
    return rows.map((row) => ({ id: row.id, type: row.tipo, number: row.numero, subject: row.objeto }))
  }

  async detail(id: string, viewer: { userId: string; level: number }) {
    await this.requireSchema()
    const pool = this.poolProvider()
    const found = await pool.query<InstrumentRow>(`${instrumentSelect} WHERE i.id = $1`, [id])
    if (!found.rows[0]) throw notFound()
    const [items, usages, amendments, attachments, demands] = await Promise.all([
      pool.query<{
        id: string; numero_item: string | null; descricao: string; unidade: string; quantidade_registrada: string
        valor_unitario: string; ativo: boolean; usado: string | null
      }>(
        `SELECT it.id::text AS id, it.numero_item, it.descricao, it.unidade, it.quantidade_registrada, it.valor_unitario, it.ativo,
                (SELECT sum(u.quantidade) FROM public.contract_instrument_usages u WHERE u.item_id = it.id) AS usado
           FROM public.contract_instrument_items it WHERE it.instrument_id = $1
          ORDER BY it.numero_item NULLS LAST, it.created_at`,
        [id],
      ),
      pool.query<{
        id: string; item: string; unidade: string; quantidade: string; valor_total: string; data: string
        documento: string | null; observacao: string | null; demanda_id: string | null; demanda_numero: string | null
        registrado_por: string; created_at: Date
      }>(
        `SELECT u.id::text AS id, it.descricao AS item, it.unidade, u.quantidade, u.valor_total,
                to_char(u.data_utilizacao, 'YYYY-MM-DD') AS data, u.documento, u.observacao,
                u.demanda_id::text AS demanda_id, d.numero AS demanda_numero, p.full_name AS registrado_por, u.created_at
           FROM public.contract_instrument_usages u
           JOIN public.contract_instrument_items it ON it.id = u.item_id
           JOIN public.auth_users p ON p.id = u.registrado_por
           LEFT JOIN public.demands d ON d.id = u.demanda_id
          WHERE u.instrument_id = $1 ORDER BY u.data_utilizacao DESC, u.created_at DESC LIMIT 300`,
        [id],
      ),
      pool.query<{
        id: string; tipo: string; numero: string | null; data_assinatura: string | null; fim_anterior: string | null
        fim_novo: string | null; valor_anterior: string; valor_novo: string; descricao: string; registrado_por: string; created_at: Date
      }>(
        `SELECT a.id::text AS id, a.tipo, a.numero, to_char(a.data_assinatura, 'YYYY-MM-DD') AS data_assinatura,
                to_char(a.vigencia_fim_anterior, 'YYYY-MM-DD') AS fim_anterior, to_char(a.vigencia_fim_nova, 'YYYY-MM-DD') AS fim_novo,
                a.valor_anterior, a.valor_novo, a.descricao, p.full_name AS registrado_por, a.created_at
           FROM public.contract_instrument_amendments a JOIN public.auth_users p ON p.id = a.registrado_por
          WHERE a.instrument_id = $1 ORDER BY a.created_at DESC`,
        [id],
      ),
      pool.query<{ id: string; nome_original: string; tipo: string; tamanho_bytes: string; enviado_por: string; created_at: Date; aditivo: string | null }>(
        `SELECT f.id::text AS id, f.nome_original, f.tipo, f.tamanho_bytes::text AS tamanho_bytes, p.full_name AS enviado_por,
                f.created_at, f.amendment_id::text AS aditivo
           FROM public.contract_instrument_attachments f JOIN public.auth_users p ON p.id = f.enviado_por
          WHERE f.instrument_id = $1 AND f.removido_em IS NULL ORDER BY f.created_at DESC`,
        [id],
      ),
      // Só as demandas que a pessoa já pode ver: o vínculo não abre demanda de outro setor.
      pool.query<{ id: string; numero: string; titulo: string; status: string; prazo: string | null }>(
        `SELECT d.id::text AS id, d.numero, d.titulo, d.status, to_char(d.prazo, 'YYYY-MM-DD') AS prazo
           FROM public.demands d
          WHERE d.instrumento_id = $1 AND ${visibleDemandSql('d', '$2', '$3')}
          ORDER BY d.data_abertura DESC LIMIT 200`,
        [id, viewer.userId, viewer.level],
      ),
    ])
    return {
      ...present(found.rows[0], todayInSaoPaulo()),
      items: items.rows.map((row) => {
        const registered = Number(row.quantidade_registrada)
        const used = Number(row.usado ?? 0)
        const unitPrice = Number(row.valor_unitario)
        return {
          id: row.id,
          itemNumber: row.numero_item,
          description: row.descricao,
          unit: row.unidade,
          registered,
          used,
          unitPrice,
          active: row.ativo,
          ...itemBalance({ registered, used, unitPrice }),
        }
      }),
      usages: usages.rows.map((row) => ({
        id: row.id,
        item: row.item,
        unit: row.unidade,
        quantity: Number(row.quantidade),
        value: Number(row.valor_total),
        date: row.data,
        document: row.documento,
        note: row.observacao,
        demand: row.demanda_id ? { id: row.demanda_id, number: row.demanda_numero } : null,
        registeredBy: row.registrado_por,
        at: row.created_at,
      })),
      amendments: amendments.rows.map((row) => ({
        id: row.id,
        type: row.tipo,
        number: row.numero,
        signedAt: row.data_assinatura,
        previousEnd: row.fim_anterior,
        newEnd: row.fim_novo,
        previousValue: Number(row.valor_anterior),
        newValue: Number(row.valor_novo),
        description: row.descricao,
        registeredBy: row.registrado_por,
        at: row.created_at,
      })),
      attachments: attachments.rows.map((row) => ({
        id: row.id,
        name: row.nome_original,
        kind: row.tipo,
        sizeBytes: Number(row.tamanho_bytes),
        uploadedBy: row.enviado_por,
        at: row.created_at,
        amendmentId: row.aditivo,
      })),
      demands: demands.rows.map((row) => ({ id: row.id, number: row.numero, title: row.titulo, status: row.status, dueDate: row.prazo })),
    }
  }

  async create(actor: AuthenticatedIdentity, input: InstrumentInput) {
    await this.requireSchema()
    return withTransaction(this.poolProvider(), async (client) => {
      await assertSectors(client, [input.responsibleSectorId, ...input.sharedSectorIds])
      await assertPerson(client, input.managerId)
      try {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO public.contract_instruments
             (tipo, numero, objeto, categoria, fornecedor, processo, valor_total, vigencia_inicio, vigencia_fim,
              setor_responsavel_id, gestor_id, aviso_dias, encerrado, observacoes, criado_por)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id::text AS id`,
          [
            input.type, input.number, redactOptional(input.subject), input.category, input.supplier, input.process, input.total,
            input.validFrom, input.validUntil, input.responsibleSectorId, input.managerId, input.noticeDays, input.closed,
            redactOptional(input.notes), actor.userId,
          ],
        )
        const id = rows[0].id
        await saveSharedSectors(client, id, input)
        await audit(client, actor, id, { action: 'created', type: input.type, number: input.number })
        return id
      } catch (error) {
        if (duplicate(error)) throw conflict(`Já existe ${input.type === 'ata' ? 'uma ata' : 'um contrato'} com este número.`)
        throw error
      }
    })
  }

  async update(actor: AuthenticatedIdentity, id: string, input: InstrumentInput) {
    await this.requireSchema()
    await withTransaction(this.poolProvider(), async (client) => {
      await assertSectors(client, [input.responsibleSectorId, ...input.sharedSectorIds])
      await assertPerson(client, input.managerId)
      try {
        const current = await client.query<{ vigencia_fim: string | null }>(
          `SELECT to_char(vigencia_fim, 'YYYY-MM-DD') AS vigencia_fim FROM public.contract_instruments WHERE id = $1 FOR UPDATE`,
          [id],
        )
        if (!current.rows[0]) throw notFound()
        // Nova data de fim: a próxima renovação será avisada de novo.
        const endChanged = current.rows[0].vigencia_fim !== input.validUntil
        await client.query(
          `UPDATE public.contract_instruments
              SET tipo = $2, numero = $3, objeto = $4, categoria = $5, fornecedor = $6, processo = $7, valor_total = $8,
                  vigencia_inicio = $9, vigencia_fim = $10, setor_responsavel_id = $11, gestor_id = $12, aviso_dias = $13,
                  encerrado = $14, observacoes = $15, updated_at = now(),
                  renovacao_demanda_id = CASE WHEN $16 THEN NULL ELSE renovacao_demanda_id END
            WHERE id = $1`,
          [
            id, input.type, input.number, redactOptional(input.subject), input.category, input.supplier, input.process, input.total,
            input.validFrom, input.validUntil, input.responsibleSectorId, input.managerId, input.noticeDays, input.closed,
            redactOptional(input.notes), endChanged,
          ],
        )
        await saveSharedSectors(client, id, input)
        await audit(client, actor, id, { action: 'updated', number: input.number })
      } catch (error) {
        if (duplicate(error)) throw conflict(`Já existe ${input.type === 'ata' ? 'uma ata' : 'um contrato'} com este número.`)
        throw error
      }
    })
  }

  async saveItem(actor: AuthenticatedIdentity, instrumentId: string, itemId: string | null, input: ItemInput) {
    await this.requireSchema()
    return withTransaction(this.poolProvider(), async (client) => {
      if (itemId) {
        const used = await client.query<{ usado: string | null }>(
          `SELECT (SELECT sum(quantidade) FROM public.contract_instrument_usages WHERE item_id = it.id) AS usado
             FROM public.contract_instrument_items it WHERE it.id = $1 AND it.instrument_id = $2 FOR UPDATE`,
          [itemId, instrumentId],
        )
        if (!used.rows[0]) throw notFound()
        if (input.registered < Number(used.rows[0].usado ?? 0)) {
          throw conflict('A quantidade registrada não pode ficar abaixo do que já foi utilizado.')
        }
        await client.query(
          `UPDATE public.contract_instrument_items
              SET numero_item = $2, descricao = $3, unidade = $4, quantidade_registrada = $5, valor_unitario = $6,
                  ativo = $7, updated_at = now()
            WHERE id = $1`,
          [itemId, input.itemNumber, input.description, input.unit, input.registered, input.unitPrice, input.active],
        )
      } else {
        const exists = await client.query(`SELECT 1 FROM public.contract_instruments WHERE id = $1`, [instrumentId])
        if (!exists.rowCount) throw notFound()
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO public.contract_instrument_items
             (instrument_id, numero_item, descricao, unidade, quantidade_registrada, valor_unitario, ativo)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
          [instrumentId, input.itemNumber, input.description, input.unit, input.registered, input.unitPrice, input.active],
        )
        itemId = rows[0].id
      }
      await client.query(`UPDATE public.contract_instruments SET updated_at = now() WHERE id = $1`, [instrumentId])
      await audit(client, actor, instrumentId, { action: 'item_saved', item: itemId })
      return itemId
    })
  }

  /** Itens em lote (robô de atas pelo Excel): todos na mesma transação, com um só registro na auditoria. */
  async addItems(actor: AuthenticatedIdentity, instrumentId: string, items: readonly ItemInput[]) {
    await this.requireSchema()
    return withTransaction(this.poolProvider(), async (client) => {
      const exists = await client.query(`SELECT 1 FROM public.contract_instruments WHERE id = $1 FOR UPDATE`, [instrumentId])
      if (!exists.rowCount) throw notFound()
      for (const input of items) {
        await client.query(
          `INSERT INTO public.contract_instrument_items
             (instrument_id, numero_item, descricao, unidade, quantidade_registrada, valor_unitario, ativo)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [instrumentId, input.itemNumber, input.description, input.unit, input.registered, input.unitPrice, input.active],
        )
      }
      await client.query(`UPDATE public.contract_instruments SET updated_at = now() WHERE id = $1`, [instrumentId])
      await audit(client, actor, instrumentId, { action: 'items_imported', count: String(items.length) })
      return items.length
    })
  }

  /** Utilização de um item: nunca acima do saldo. O valor é quantidade × valor unitário. */
  async addUsage(
    actor: AuthenticatedIdentity,
    instrumentId: string,
    input: { itemId: string; quantity: number; date: string; document: string | null; note: string | null; demandId: string | null },
  ) {
    await this.requireSchema()
    return withTransaction(this.poolProvider(), async (client) => {
      const item = await client.query<{ quantidade_registrada: string; valor_unitario: string; ativo: boolean; usado: string | null }>(
        `SELECT it.quantidade_registrada, it.valor_unitario, it.ativo,
                (SELECT sum(quantidade) FROM public.contract_instrument_usages WHERE item_id = it.id) AS usado
           FROM public.contract_instrument_items it WHERE it.id = $1 AND it.instrument_id = $2 FOR UPDATE`,
        [input.itemId, instrumentId],
      )
      if (!item.rows[0]) throw new ModuleError('Item não encontrado.', 400)
      if (!item.rows[0].ativo) throw conflict('Este item está inativo.')
      const balance = Number(item.rows[0].quantidade_registrada) - Number(item.rows[0].usado ?? 0)
      if (input.quantity > balance + 1e-9) {
        throw conflict(`A quantidade é maior que o saldo do item (${balance.toLocaleString('pt-BR')}).`)
      }
      if (input.demandId) {
        const demand = await client.query(`SELECT 1 FROM public.demands WHERE id = $1 AND excluida_em IS NULL`, [input.demandId])
        if (!demand.rowCount) throw new ModuleError('Demanda não encontrada.', 400)
      }
      const value = money(input.quantity * Number(item.rows[0].valor_unitario))
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO public.contract_instrument_usages
           (instrument_id, item_id, quantidade, valor_total, data_utilizacao, documento, observacao, demanda_id, registrado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id::text AS id`,
        [instrumentId, input.itemId, input.quantity, value, input.date, input.document, redactOptional(input.note), input.demandId, actor.userId],
      )
      await client.query(`UPDATE public.contract_instruments SET updated_at = now() WHERE id = $1`, [instrumentId])
      await audit(client, actor, instrumentId, { action: 'usage_added', usage: rows[0].id })
      return rows[0].id
    })
  }

  /**
   * Aditivo ou prorrogação. Prorrogar exige nova data de fim depois da atual; os demais mudam o valor.
   * A nova vigência volta a permitir o aviso de renovação.
   */
  async addAmendment(
    actor: AuthenticatedIdentity,
    instrumentId: string,
    input: { type: string; number: string | null; signedAt: string | null; newEnd: string | null; newValue: number | null; description: string },
  ) {
    await this.requireSchema()
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await client.query<{ vigencia_fim: string | null; vigencia_inicio: string | null; valor_total: string }>(
        `SELECT to_char(vigencia_fim, 'YYYY-MM-DD') AS vigencia_fim, to_char(vigencia_inicio, 'YYYY-MM-DD') AS vigencia_inicio, valor_total
           FROM public.contract_instruments WHERE id = $1 FOR UPDATE`,
        [instrumentId],
      )
      const row = current.rows[0]
      if (!row) throw notFound()
      if (input.type === 'prorrogacao' && !input.newEnd) throw new ModuleError('Informe a nova data de fim da vigência.', 400)
      if (input.newEnd && row.vigencia_fim && input.newEnd <= row.vigencia_fim && input.type === 'prorrogacao') {
        throw new ModuleError('A prorrogação precisa terminar depois da vigência atual.', 400)
      }
      if (input.newEnd && row.vigencia_inicio && input.newEnd < row.vigencia_inicio) {
        throw new ModuleError('A nova data de fim não pode ser anterior ao início da vigência.', 400)
      }
      if (['acrescimo', 'supressao', 'reajuste'].includes(input.type) && input.newValue === null) {
        throw new ModuleError('Informe o novo valor total.', 400)
      }
      const previousValue = Number(row.valor_total)
      const newValue = input.newValue ?? previousValue
      const newEnd = input.newEnd ?? row.vigencia_fim
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO public.contract_instrument_amendments
           (instrument_id, tipo, numero, data_assinatura, vigencia_fim_anterior, vigencia_fim_nova, valor_anterior, valor_novo, descricao, registrado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text AS id`,
        [instrumentId, input.type, input.number, input.signedAt, row.vigencia_fim, newEnd, previousValue, newValue, redactOptional(input.description), actor.userId],
      )
      await client.query(
        `UPDATE public.contract_instruments
            SET vigencia_fim = $2, valor_total = $3, updated_at = now(),
                renovacao_demanda_id = CASE WHEN $4 THEN NULL ELSE renovacao_demanda_id END
          WHERE id = $1`,
        [instrumentId, newEnd, newValue, newEnd !== row.vigencia_fim],
      )
      await audit(client, actor, instrumentId, { action: 'amendment_added', type: input.type })
      return rows[0].id
    })
  }

  // -------------------------------------------------------------------------
  // Anexos: mesmas garantias dos anexos das demandas.
  // -------------------------------------------------------------------------
  async addAttachment(
    actor: AuthenticatedIdentity,
    storage: AttachmentStorage,
    instrumentId: string,
    input: { content: Buffer; name: string; kind: string; amendmentId: string | null },
  ) {
    await this.requireSchema()
    const id = randomUUID()
    const storageKey = randomUUID()
    const sha256 = createHash('sha256').update(input.content).digest('hex')
    await storage.save(storageKey, input.content)
    try {
      await withTransaction(this.poolProvider(), async (client) => {
        if (input.amendmentId) {
          const found = await client.query(
            `SELECT 1 FROM public.contract_instrument_amendments WHERE id = $1 AND instrument_id = $2`,
            [input.amendmentId, instrumentId],
          )
          if (!found.rowCount) throw notFound()
        }
        await client.query(
          `INSERT INTO public.contract_instrument_attachments
             (id, instrument_id, amendment_id, nome_original, tipo, tamanho_bytes, sha256, storage_key, enviado_por)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, instrumentId, input.amendmentId, input.name, input.kind, input.content.length, sha256, storageKey, actor.userId],
        )
        await insertAuthAuditEvent(client, {
          actorUserId: actor.userId,
          actorKind: 'user',
          subjectUserId: null,
          sessionId: instrumentId,
          eventType: 'attachment_uploaded',
          details: { attachmentId: id, kind: input.kind, module: 'contracts' },
        })
      })
    } catch (error) {
      await storage.remove(storageKey).catch(() => undefined)
      throw error
    }
    return id
  }

  async findAttachment(id: string) {
    await this.requireSchema()
    const { rows } = await this.poolProvider().query<{
      id: string; instrument_id: string; nome_original: string; tipo: string; tamanho_bytes: string; sha256: string
      storage_key: string; removido_em: Date | null
    }>(
      `SELECT id::text AS id, instrument_id::text AS instrument_id, nome_original, tipo, tamanho_bytes::text AS tamanho_bytes,
              sha256, storage_key, removido_em
         FROM public.contract_instrument_attachments WHERE id = $1`,
      [id],
    )
    const row = rows[0]
    return row
      ? {
          id: row.id,
          instrumentId: row.instrument_id,
          name: row.nome_original,
          kind: row.tipo,
          sizeBytes: Number(row.tamanho_bytes),
          sha256: row.sha256,
          storageKey: row.storage_key,
          removedAt: row.removido_em,
        }
      : null
  }

  async recordAttachmentDownload(actor: AuthenticatedIdentity, id: string, instrumentId: string) {
    await insertAuthAuditEvent(this.poolProvider(), {
      actorUserId: actor.userId,
      actorKind: 'user',
      subjectUserId: null,
      sessionId: instrumentId,
      eventType: 'attachment_downloaded',
      details: { attachmentId: id, module: 'contracts' },
    })
  }

  /** Remoção lógica: o arquivo e o registro continuam. */
  async removeAttachment(actor: AuthenticatedIdentity, id: string, instrumentId: string, reason: string) {
    await withTransaction(this.poolProvider(), async (client) => {
      const removed = await client.query(
        `UPDATE public.contract_instrument_attachments SET removido_em = now(), removido_por = $2, motivo_remocao = $3
          WHERE id = $1 AND instrument_id = $4 AND removido_em IS NULL`,
        [id, actor.userId, redactOptional(reason), instrumentId],
      )
      if (!removed.rowCount) throw conflict('Este anexo já foi removido.')
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: null,
        sessionId: instrumentId,
        eventType: 'attachment_removed',
        details: { attachmentId: id, module: 'contracts' },
      })
    })
  }

  // -------------------------------------------------------------------------
  // Vínculo com a demanda
  // -------------------------------------------------------------------------
  async linkedInstrument(demandId: string) {
    if (!(await instrumentSchemaExists(this.poolProvider()))) return null
    const { rows } = await this.poolProvider().query<{ id: string; tipo: string; numero: string; objeto: string; setor: string }>(
      `SELECT i.id::text AS id, i.tipo, i.numero, i.objeto, i.setor_responsavel_id::text AS setor
         FROM public.demands d JOIN public.contract_instruments i ON i.id = d.instrumento_id WHERE d.id = $1`,
      [demandId],
    )
    return rows[0] ? { id: rows[0].id, type: rows[0].tipo, number: rows[0].numero, subject: rows[0].objeto } : null
  }

  async linkDemand(actor: AuthenticatedIdentity, demandId: string, instrumentId: string | null) {
    await this.requireSchema()
    await withTransaction(this.poolProvider(), async (client) => {
      const current = await client.query<{ instrumento_id: string | null }>(
        `SELECT instrumento_id::text AS instrumento_id FROM public.demands WHERE id = $1 FOR UPDATE`,
        [demandId],
      )
      if (!current.rows[0]) throw notFound()
      if (current.rows[0].instrumento_id === instrumentId) return
      await client.query(`UPDATE public.demands SET instrumento_id = $2, ultima_atividade_em = now() WHERE id = $1`, [demandId, instrumentId])
      await recordDemandHistory(client, {
        demandId,
        userId: actor.userId,
        action: instrumentId ? 'instrumento_vinculado' : 'instrumento_desvinculado',
        details: { instrumentoId: instrumentId ?? current.rows[0].instrumento_id },
      })
    })
  }
}

/**
 * Demanda automática de renovação (worker do Controle de Demandas): ao entrar no prazo de aviso, abre
 * uma demanda no setor responsável, vinculada ao instrumento, uma vez por vigência.
 */
export async function openRenewalDemands(today = todayInSaoPaulo(), poolProvider: () => Pool = getDatabasePool) {
  const pool = poolProvider()
  if (!(await instrumentSchemaExists(pool))) return 0
  const { rows } = await pool.query<{
    id: string; tipo: string; numero: string; objeto: string; vigencia_fim: string; aviso_dias: number
    setor_responsavel_id: string; gestor_id: string | null; criado_por: string; encerrado: boolean; renovacao_demanda_id: string | null
  }>(
    `SELECT id::text AS id, tipo, numero, objeto, to_char(vigencia_fim, 'YYYY-MM-DD') AS vigencia_fim, aviso_dias,
            setor_responsavel_id::text AS setor_responsavel_id, gestor_id::text AS gestor_id, criado_por::text AS criado_por,
            encerrado, renovacao_demanda_id::text AS renovacao_demanda_id
       FROM public.contract_instruments
      WHERE NOT encerrado AND renovacao_demanda_id IS NULL AND vigencia_fim IS NOT NULL
        AND vigencia_fim - aviso_dias <= $1::date
      LIMIT 100`,
    [today],
  )
  let opened = 0
  for (const row of rows) {
    if (!renewalDue({ closed: row.encerrado, validUntil: row.vigencia_fim, noticeDays: row.aviso_dias, renewalDemandId: row.renovacao_demanda_id }, today)) continue
    try {
      await withTransaction(pool, async (client) => {
        // Outro ciclo pode ter aberto no meio tempo.
        const locked = await client.query(
          `SELECT 1 FROM public.contract_instruments WHERE id = $1 AND renovacao_demanda_id IS NULL FOR UPDATE`,
          [row.id],
        )
        if (!locked.rowCount) return
        const number = await nextDemandNumber(client)
        const responsibleId = row.gestor_id && (await canRespondFor(client, row.gestor_id, row.setor_responsavel_id)) ? row.gestor_id : null
        const title = renewalTitle({ type: row.tipo, number: row.numero, subject: row.objeto })
        const label = row.tipo === 'ata' ? 'A ata' : 'O contrato'
        const dueDate = row.vigencia_fim < today ? today : row.vigencia_fim
        const created = await client.query<{ id: string }>(
          `INSERT INTO public.demands
             (numero, titulo, descricao, categoria_id, setor_origem_id, setor_responsavel_id, solicitante_id, responsavel_id,
              criado_por, prazo, prioridade, instrumento_id)
           VALUES ($1, $2, $3,
                   -- Demanda publicada exige categoria: "Acompanhamento de processos" ou a primeira ativa.
                   COALESCE(
                     (SELECT id FROM public.demand_categories WHERE ativo AND lower(trim(nome)) = 'acompanhamento de processos' LIMIT 1),
                     (SELECT id FROM public.demand_categories WHERE ativo ORDER BY ordem, nome LIMIT 1)
                   ),
                   $4, $4, $5, $6, $7, $8, 'alta', $9) RETURNING id::text AS id`,
          [
            number, title,
            `${label} ${row.numero} termina em ${row.vigencia_fim.split('-').reverse().join('/')}. Demanda aberta automaticamente ${row.aviso_dias} dias antes, para providenciar a renovação, a prorrogação ou uma nova contratação.`,
            row.setor_responsavel_id, row.gestor_id ?? row.criado_por, responsibleId, row.criado_por, dueDate, row.id,
          ],
        )
        const demandId = created.rows[0].id
        await client.query(`UPDATE public.contract_instruments SET renovacao_demanda_id = $2 WHERE id = $1`, [row.id, demandId])
        await recordDemandHistory(client, {
          demandId,
          userId: null,
          action: 'renovacao_gerada',
          details: { numero: number, instrumentoId: row.id },
        })
        const leads = await client.query<{ user_id: string }>(
          `SELECT user_id::text AS user_id FROM public.demand_sector_members WHERE sector_id = $1 AND ativo AND papel = 'responsavel'`,
          [row.setor_responsavel_id],
        )
        await notifyDemand(client, {
          kind: 'atribuicao',
          key: `${demandId}:renovacao`,
          demand: { id: demandId, number, title, restricted: false },
          recipients: [responsibleId, ...leads.rows.map((lead) => lead.user_id)],
          actorId: null,
        })
      })
      opened += 1
    } catch (error) {
      recordTechnicalEvent('worker', 'contract_renewal_failed', error)
    }
  }
  return opened
}
