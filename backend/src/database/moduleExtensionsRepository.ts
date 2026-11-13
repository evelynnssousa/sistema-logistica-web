import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { redactOptional, redactValidCpf } from '../integrations/redaction.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import type { AuthAuditEventType } from './authAuditRepository.js'
import { conflict, ModuleError, notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { protocolSql } from './protocolSql.js'
import { recordHistory } from './serviceRequestRepository.js'
import { financeSchemaExists, recordStockMovement } from './warehouseFinanceRepository.js'
import type { MovementFinance } from './warehouseFinanceRepository.js'
import { withTransaction } from './withTransaction.js'
import { consumptionWindowMonths, monthlyConsumption } from '../requests/warehouseConsumption.js'
import { unitCost } from '../requests/warehouseValuation.js'

/** Ampliações de Frota, Manutenção, Passagens e Almoxarifado. Registros históricos não mudam. */

const pageSize = 25

// Antecedência dos alertas de revisão. Valores de trabalho, fáceis de ajustar aqui.
const reviewWarningKm = 500
const reviewWarningDays = 15

type Client = Pick<PoolClient, 'query'>

function audit(
  client: Client,
  actor: AuthenticatedIdentity,
  eventType: AuthAuditEventType,
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

/** Alerta calculado na leitura, a partir do cadastro: não há estado para ficar desatualizado. */
export function vehicleReviewAlert(
  vehicle: { kmAtual: number; proximaRevisaoKm: number | null; proximaRevisaoData: string | null },
  now = new Date(),
): 'vencida' | 'proxima' | null {
  const today = now.toISOString().slice(0, 10)
  const limit = new Date(now.getTime() + reviewWarningDays * 86_400_000).toISOString().slice(0, 10)
  const { kmAtual, proximaRevisaoKm: km, proximaRevisaoData: date } = vehicle

  if ((km !== null && kmAtual >= km) || (date !== null && date < today)) return 'vencida'
  if ((km !== null && kmAtual >= km - reviewWarningKm) || (date !== null && date <= limit)) return 'proxima'
  return null
}

type VehicleRow = {
  id: string
  placa: string
  modelo: string
  identificacao: string | null
  situacao: string
  km_atual: number
  proxima_revisao_km: number | null
  proxima_revisao_data: string | null
}

const vehicleColumns = `id::text AS id, placa, modelo, identificacao, situacao, km_atual, proxima_revisao_km,
  to_char(proxima_revisao_data, 'YYYY-MM-DD') AS proxima_revisao_data`

function presentVehicle(row: VehicleRow) {
  return {
    id: row.id,
    plate: row.placa,
    model: row.modelo,
    identification: row.identificacao,
    status: row.situacao,
    currentKm: row.km_atual,
    nextReviewKm: row.proxima_revisao_km,
    nextReviewDate: row.proxima_revisao_data,
    reviewAlert: vehicleReviewAlert({
      kmAtual: row.km_atual,
      proximaRevisaoKm: row.proxima_revisao_km,
      proximaRevisaoData: row.proxima_revisao_data,
    }),
  }
}

export type VehicleInput = {
  plate: string
  model: string
  identification: string | null
  status: string
  currentKm: number
  nextReviewKm: number | null
  nextReviewDate: string | null
}

export type VehicleLogInput = {
  type: string
  at: Date
  startKm: number | null
  endKm: number | null
  liters: number | null
  value: number | null
  description: string
  requestProtocol: string | null
}

export class ModuleExtensionsRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  // -------------------------------------------------------------------------
  // Veículos
  // -------------------------------------------------------------------------
  async listVehicles() {
    const result = await this.poolProvider().query<VehicleRow>(
      `SELECT ${vehicleColumns} FROM public.vehicles ORDER BY situacao = 'inativo', placa`,
    )
    return result.rows.map(presentVehicle)
  }

  async createVehicle(actor: AuthenticatedIdentity, input: VehicleInput) {
    return withTransaction(this.poolProvider(), async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO public.vehicles
          (placa, modelo, identificacao, situacao, km_atual, proxima_revisao_km, proxima_revisao_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id::text AS id`,
        [input.plate, input.model, input.identification, input.status, input.currentKm, input.nextReviewKm, input.nextReviewDate],
      )
      const { id } = created.rows[0]
      await audit(client, actor, 'vehicle_changed', id, { operation: 'created' })
      return id
    })
  }

  async updateVehicle(actor: AuthenticatedIdentity, id: string, input: VehicleInput) {
    await withTransaction(this.poolProvider(), async (client) => {
      const updated = await client.query(
        `UPDATE public.vehicles
            SET placa = $2, modelo = $3, identificacao = $4, situacao = $5, km_atual = $6,
                proxima_revisao_km = $7, proxima_revisao_data = $8
          WHERE id = $1`,
        [id, input.plate, input.model, input.identification, input.status, input.currentKm, input.nextReviewKm, input.nextReviewDate],
      )
      if (updated.rowCount === 0) throw notFound()
      await audit(client, actor, 'vehicle_changed', id, { operation: 'updated', status: input.status })
    })
  }

  async vehicleDetail(id: string, page: number) {
    const pool = this.poolProvider()
    const found = await pool.query<VehicleRow>(`SELECT ${vehicleColumns} FROM public.vehicles WHERE id = $1`, [id])
    if (!found.rows[0]) return null

    const [logs, totals] = await Promise.all([
      pool.query<{
        id: string
        tipo: string
        data_registro: Date
        km_inicial: number | null
        km_final: number | null
        litros: string | null
        valor: string | null
        descricao: string
        registrado_por: string
        protocolo: string | null
        request_id: string | null
      }>(
        `SELECT l.id::text AS id, l.tipo, l.data_registro, l.km_inicial, l.km_final, l.litros, l.valor, l.descricao,
                u.full_name AS registrado_por, ${protocolSql('r')} AS protocolo, r.id::text AS request_id
           FROM public.vehicle_logs l
           JOIN public.auth_users u ON u.id = l.registrado_por
           LEFT JOIN public.service_requests r ON r.id = l.request_id
          WHERE l.vehicle_id = $1
          ORDER BY l.data_registro DESC, l.id DESC
          LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        [id],
      ),
      pool.query<{
        total: number
        km_rodados: number
        abastecimentos: number
        litros: string
        gasto: string
        ocorrencias: number
        manutencoes: number
      }>(
        `SELECT count(*)::int AS total,
                coalesce(sum(km_final - km_inicial) FILTER (WHERE tipo = 'utilizacao'), 0)::int AS km_rodados,
                count(*) FILTER (WHERE tipo = 'abastecimento')::int AS abastecimentos,
                coalesce(sum(litros), 0)::text AS litros,
                coalesce(sum(valor), 0)::text AS gasto,
                count(*) FILTER (WHERE tipo = 'ocorrencia')::int AS ocorrencias,
                count(*) FILTER (WHERE tipo = 'manutencao')::int AS manutencoes
           FROM public.vehicle_logs WHERE vehicle_id = $1`,
        [id],
      ),
    ])
    const summary = totals.rows[0]
    return {
      vehicle: presentVehicle(found.rows[0]),
      logs: logs.rows.map((row) => ({
        id: row.id,
        type: row.tipo,
        at: row.data_registro,
        startKm: row.km_inicial,
        endKm: row.km_final,
        liters: row.litros === null ? null : Number(row.litros),
        value: row.valor === null ? null : Number(row.valor),
        description: row.descricao,
        registeredBy: row.registrado_por,
        protocol: row.protocolo,
        requestId: row.request_id,
      })),
      summary: {
        kmDriven: summary.km_rodados,
        fuelings: summary.abastecimentos,
        liters: Number(summary.litros),
        spent: Number(summary.gasto),
        occurrences: summary.ocorrencias,
        interventions: summary.manutencoes,
      },
      total: summary.total,
      page,
      pageSize,
    }
  }

  async addVehicleLog(actor: AuthenticatedIdentity, vehicleId: string, input: VehicleLogInput) {
    return withTransaction(this.poolProvider(), async (client) => {
      const found = await client.query<{ km_atual: number }>(
        `SELECT km_atual FROM public.vehicles WHERE id = $1 FOR UPDATE`,
        [vehicleId],
      )
      if (!found.rows[0]) throw notFound()

      let requestId: string | null = null
      if (input.requestProtocol) {
        const request = await client.query<{ id: string }>(
          `SELECT r.id::text AS id FROM public.service_requests r
            WHERE r.tipo = 'frota' AND ${protocolSql('r')} = $1`,
          [input.requestProtocol],
        )
        if (!request.rows[0]) throw new ModuleError('Protocolo de Frota não encontrado.', 400)
        requestId = request.rows[0].id
      }

      const created = await client.query<{ id: string }>(
        `INSERT INTO public.vehicle_logs
          (vehicle_id, request_id, tipo, data_registro, km_inicial, km_final, litros, valor, descricao, registrado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id::text AS id`,
        [
          vehicleId,
          requestId,
          input.type,
          input.at,
          input.startKm,
          input.endKm,
          input.liters,
          input.value,
          redactValidCpf(input.description),
          actor.userId,
        ],
      )
      // A quilometragem do cadastro só avança: lançar uma viagem antiga não a faz recuar.
      const reached = Math.max(input.endKm ?? 0, input.startKm ?? 0)
      if (reached > found.rows[0].km_atual) {
        await client.query(`UPDATE public.vehicles SET km_atual = $2 WHERE id = $1`, [vehicleId, reached])
      }
      await audit(client, actor, 'vehicle_log_added', vehicleId, { type: input.type })
      return created.rows[0].id
    })
  }

  // -------------------------------------------------------------------------
  // Equipamentos e execução
  // -------------------------------------------------------------------------
  async listEquipments(includeInactive: boolean) {
    const result = await this.poolProvider().query<{
      id: string
      nome: string
      identificacao: string | null
      local: string | null
      ativo: boolean
      execucoes: number
      ultima_execucao: Date | null
    }>(
      `SELECT e.id::text AS id, e.nome, e.identificacao, e.local, e.ativo,
              count(x.id)::int AS execucoes, max(x.executado_em) AS ultima_execucao
         FROM public.equipments e
         LEFT JOIN public.maintenance_executions x ON x.equipment_id = e.id
        ${includeInactive ? '' : 'WHERE e.ativo'}
        GROUP BY e.id
        ORDER BY lower(e.nome)`,
    )
    return result.rows.map((row) => ({
      id: row.id,
      name: row.nome,
      identification: row.identificacao,
      location: row.local,
      active: row.ativo,
      executions: row.execucoes,
      lastExecution: row.ultima_execucao,
    }))
  }

  async saveEquipment(
    actor: AuthenticatedIdentity,
    id: string | null,
    input: { name: string; identification: string | null; location: string | null; active: boolean },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const values = [input.name, input.identification, input.location, input.active]
      const saved = id
        ? await client.query<{ id: string }>(
            `UPDATE public.equipments SET nome = $1, identificacao = $2, local = $3, ativo = $4
              WHERE id = $5 RETURNING id::text AS id`,
            [...values, id],
          )
        : await client.query<{ id: string }>(
            `INSERT INTO public.equipments (nome, identificacao, local, ativo)
             VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
            values,
          )
      if (!saved.rows[0]) throw notFound()
      await audit(client, actor, 'equipment_changed', saved.rows[0].id, { operation: id ? 'updated' : 'created' })
      return saved.rows[0].id
    })
  }

  async equipmentHistory(id: string) {
    const result = await this.poolProvider().query<ExecutionRow>(
      `${executionSelect} WHERE x.equipment_id = $1 ORDER BY x.executado_em DESC LIMIT 100`,
      [id],
    )
    return result.rows.map(presentExecution)
  }

  async executionsOf(requestId: string) {
    const result = await this.poolProvider().query<ExecutionRow>(
      `${executionSelect} WHERE x.request_id = $1 ORDER BY x.executado_em, x.id`,
      [requestId],
    )
    return result.rows.map(presentExecution)
  }

  async addExecution(
    actor: AuthenticatedIdentity,
    requestId: string,
    input: { equipmentId: string | null; executedBy: string; executedAt: Date; service: string; pending: string | null },
  ) {
    await withTransaction(this.poolProvider(), async (client) => {
      const found = await client.query<{ status: string }>(
        `SELECT status FROM public.service_requests WHERE id = $1 AND tipo = 'manutencao' FOR UPDATE`,
        [requestId],
      )
      const current = found.rows[0]
      if (!current) throw notFound()
      if (input.equipmentId) {
        const equipment = await client.query(`SELECT 1 FROM public.equipments WHERE id = $1 AND ativo`, [input.equipmentId])
        if (equipment.rows.length === 0) throw new ModuleError('Selecione um equipamento ativo.', 400)
      }

      await client.query(
        `INSERT INTO public.maintenance_executions
          (request_id, equipment_id, executado_por, executado_em, servico_realizado, pendencias, registrado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          requestId,
          input.equipmentId,
          input.executedBy,
          input.executedAt,
          redactValidCpf(input.service),
          redactOptional(input.pending),
          actor.userId,
        ],
      )
      await recordHistory(client, {
        requestId,
        userId: actor.userId,
        action: 'execucao_registrada',
        from: current.status,
        to: current.status,
        details: { executadoEm: input.executedAt.toISOString(), comPendencias: Boolean(input.pending) },
      })
    })
  }

  // -------------------------------------------------------------------------
  // Cotações de passagens
  // -------------------------------------------------------------------------
  async quotesOf(requestId: string) {
    const result = await this.poolProvider().query<{
      id: string
      companhia: string
      voos: string
      valor: string
      condicoes: string | null
      validade: Date | null
      selecionada: boolean
      registrado_por: string
      created_at: Date
    }>(
      `SELECT q.id::text AS id, q.companhia, q.voos, q.valor, q.condicoes, q.validade, q.selecionada,
              u.full_name AS registrado_por, q.created_at
         FROM public.flight_quotes q
         JOIN public.auth_users u ON u.id = q.registrado_por
        WHERE q.request_id = $1
        ORDER BY q.valor, q.created_at`,
      [requestId],
    )
    return result.rows.map((row) => ({
      id: row.id,
      company: row.companhia,
      flights: row.voos,
      value: Number(row.valor),
      conditions: row.condicoes,
      validUntil: row.validade,
      selected: row.selecionada,
      registeredBy: row.registrado_por,
      at: row.created_at,
    }))
  }

  private async lockOpenFlight(client: Client, requestId: string) {
    const found = await client.query<{ status: string; solicitante_id: string }>(
      `SELECT status, solicitante_id::text AS solicitante_id
         FROM public.service_requests WHERE id = $1 AND tipo = 'passagem' FOR UPDATE`,
      [requestId],
    )
    const current = found.rows[0]
    if (!current) throw notFound()
    if (['emitida', 'cancelada', 'concluida', 'rejeitada'].includes(current.status)) {
      throw conflict('Solicitações encerradas não recebem novas cotações.')
    }
    return current
  }

  async addQuote(
    actor: AuthenticatedIdentity,
    requestId: string,
    input: { company: string; flights: string; value: number; conditions: string | null; validUntil: Date | null },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lockOpenFlight(client, requestId)
      const created = await client.query<{ id: string }>(
        `INSERT INTO public.flight_quotes (request_id, companhia, voos, valor, condicoes, validade, registrado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
        [
          requestId,
          input.company,
          redactValidCpf(input.flights),
          input.value,
          redactOptional(input.conditions),
          input.validUntil,
          actor.userId,
        ],
      )
      await recordHistory(client, {
        requestId,
        userId: actor.userId,
        action: 'cotacao_registrada',
        from: current.status,
        to: current.status,
        details: { companhia: input.company, valor: input.value },
      })
      await audit(client, actor, 'flight_quote_changed', requestId, { operation: 'added' })
      return created.rows[0].id
    })
  }

  async selectQuote(actor: AuthenticatedIdentity, requestId: string, quoteId: string, justification: string) {
    await withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lockOpenFlight(client, requestId)
      const found = await client.query<{ companhia: string; valor: string; selecionada: boolean }>(
        `SELECT companhia, valor, selecionada FROM public.flight_quotes WHERE id = $1 AND request_id = $2`,
        [quoteId, requestId],
      )
      const quote = found.rows[0]
      if (!quote) throw notFound()
      if (quote.selecionada) return

      await client.query(
        `UPDATE public.flight_quotes SET selecionada = false WHERE request_id = $1 AND selecionada`,
        [requestId],
      )
      await client.query(`UPDATE public.flight_quotes SET selecionada = true WHERE id = $1`, [quoteId])
      await recordHistory(client, {
        requestId,
        userId: actor.userId,
        action: 'cotacao_selecionada',
        from: current.status,
        to: current.status,
        comment: justification,
        details: { companhia: quote.companhia, valor: Number(quote.valor) },
      })
      await audit(client, actor, 'flight_quote_changed', requestId, { operation: 'selected' })
    })
  }

  // -------------------------------------------------------------------------
  // Estoque interno. Não substitui o sistema governamental.
  // -------------------------------------------------------------------------
  /** withValues: só para quem tem warehouse:finance. Sem a 020, os valores vêm nulos. */
  async stock(filters: { search: string; belowMinimum: boolean; withValues?: boolean }) {
    const parameters: unknown[] = []
    const conditions = ['m.ativo']
    if (filters.search) {
      parameters.push(`%${filters.search.replace(/[\\%_]/g, '\\$&')}%`)
      conditions.push(`(m.nome ILIKE $1 OR m.codigo ILIKE $1)`)
    }
    if (filters.belowMinimum) conditions.push('m.estoque_minimo > 0 AND m.estoque_atual < m.estoque_minimo')

    const result = await this.poolProvider().query<{
      id: string
      codigo: string | null
      nome: string
      unidade: string
      estoque_atual: string
      estoque_minimo: string
      ultima_movimentacao: Date | null
      reservada: string | null
      fornecida: string | null
      consumo_janela: string | null
      primeira_entrega: Date | null
      valor_estoque: string | null
    }>(
      `SELECT m.id::text AS id, m.codigo, m.nome, m.unidade, m.estoque_atual, m.estoque_minimo,
              to_jsonb(m)->>'valor_estoque' AS valor_estoque,
              to_jsonb(m)->>'quantidade_reservada' AS reservada,
              (SELECT sum(i.quantidade_atendida) FROM public.material_request_items i
                 JOIN public.material_requests r ON r.id = i.material_request_id
                WHERE i.material_id = m.id AND r.status = 'entregue') AS fornecida,
              -- Consumo médio mensal (warehouseConsumption.ts): entregas dos últimos 12 meses e a primeira.
              (SELECT sum(i.quantidade_atendida) FROM public.material_request_items i
                 JOIN public.material_requests r ON r.id = i.material_request_id
                WHERE i.material_id = m.id AND r.status = 'entregue'
                  AND COALESCE(r.entregue_em, r.updated_at) >= now() - interval '${consumptionWindowMonths} months') AS consumo_janela,
              (SELECT min(COALESCE(r.entregue_em, r.updated_at)) FROM public.material_request_items i
                 JOIN public.material_requests r ON r.id = i.material_request_id
                WHERE i.material_id = m.id AND r.status = 'entregue' AND i.quantidade_atendida > 0) AS primeira_entrega,
              (SELECT max(s.created_at) FROM public.stock_movements s WHERE s.material_id = m.id) AS ultima_movimentacao
         FROM public.materials m
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.estoque_minimo > 0 AND m.estoque_atual < m.estoque_minimo DESC, lower(m.nome)
        LIMIT 500`,
      parameters,
    )
    return result.rows.map((row) => ({
      id: row.id,
      code: row.codigo,
      name: row.nome,
      unit: row.unidade,
      current: Number(row.estoque_atual),
      minimum: Number(row.estoque_minimo),
      belowMinimum: Number(row.estoque_minimo) > 0 && Number(row.estoque_atual) < Number(row.estoque_minimo),
      // Físico, reservado, disponível e fornecido são coisas diferentes: ter saldo não obriga a fornecer.
      reserved: Number(row.reservada ?? 0),
      available: Math.max(0, Number(row.estoque_atual) - Number(row.reservada ?? 0)),
      provided: Number(row.fornecida ?? 0),
      monthlyConsumption: monthlyConsumption(Number(row.consumo_janela ?? 0), row.primeira_entrega),
      lastMovement: row.ultima_movimentacao,
      ...(filters.withValues
        ? {
            stockValue: row.valor_estoque === null ? null : Number(row.valor_estoque),
            averageCost: row.valor_estoque === null ? null : unitCost(Number(row.estoque_atual), Number(row.valor_estoque)),
          }
        : {}),
    }))
  }

  async setMinimum(actor: AuthenticatedIdentity, materialId: string, minimum: number) {
    await withTransaction(this.poolProvider(), async (client) => {
      const updated = await client.query(`UPDATE public.materials SET estoque_minimo = $2 WHERE id = $1`, [materialId, minimum])
      if (updated.rowCount === 0) throw notFound()
      await audit(client, actor, 'stock_movement_added', materialId, { type: 'minimum', minimum: String(minimum) })
    })
  }

  async setReserved(actor: AuthenticatedIdentity, materialId: string, reserved: number, justification: string) {
    await withTransaction(this.poolProvider(), async (client) => {
      const found = await client.query<{ quantidade_reservada: string }>(
        `SELECT quantidade_reservada FROM public.materials WHERE id = $1 FOR UPDATE`,
        [materialId],
      )
      if (!found.rows[0]) throw notFound()
      await client.query(`UPDATE public.materials SET quantidade_reservada = $2 WHERE id = $1`, [materialId, reserved])
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: null,
        sessionId: materialId,
        eventType: 'warehouse_reserve_changed',
        details: {
          from: String(Number(found.rows[0].quantidade_reservada)),
          to: String(reserved),
          justification: redactValidCpf(justification),
        },
      })
    })
  }

  async addMovement(
    actor: AuthenticatedIdentity,
    input: {
      materialId: string
      type: 'entrada' | 'saida'
      quantity: number
      reason: string
      finance?: MovementFinance
    },
  ) {
    await withTransaction(this.poolProvider(), async (client) => {
      // O gatilho trg_apply_stock_movement, da estrutura original, atualiza o saldo; o valor do
      // estoque (migração 020) é atualizado em recordStockMovement, sob o mesmo bloqueio.
      await recordStockMovement(client, {
        materialId: input.materialId,
        type: input.type,
        quantity: input.quantity,
        reason: redactValidCpf(input.reason),
        userId: actor.userId,
        finance: input.finance,
      })
      await audit(client, actor, 'stock_movement_added', input.materialId, {
        type: input.type,
        quantity: String(input.quantity),
      })
    })
  }

  async movements(filters: { materialId?: string; page: number; withValues?: boolean }) {
    const parameters: unknown[] = []
    const where = filters.materialId ? 'WHERE s.material_id = $1' : ''
    if (filters.materialId) parameters.push(filters.materialId)
    const pool = this.poolProvider()
    // Sem a 020 a tabela de atas não existe e a consulta não pode citá-la.
    const withAgreements = filters.withValues && (await financeSchemaExists(pool))
    const linked = withAgreements
      ? (await pool.query<{ ok: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                           AND table_name = 'stock_movements' AND column_name = 'instrumento_item_id') AS ok`,
        )).rows[0].ok
      : false
    // Ata do Almoxarifado (020) ou item de ata ou contrato do Controle de Demandas (022).
    const agreementSql = withAgreements
      ? `COALESCE((SELECT a.numero FROM public.warehouse_price_agreements a WHERE a.id = s.ata_id)${
          linked
            ? `, (SELECT CASE i.tipo WHEN 'ata' THEN 'Ata ' ELSE 'Contrato ' END || i.numero
                    FROM public.contract_instrument_items it JOIN public.contract_instruments i ON i.id = it.instrument_id
                   WHERE it.id = s.instrumento_item_id)`
            : ''
        })`
      : 'NULL::text'
    const [rows, total] = await Promise.all([
      pool.query<{
        id: string
        material: string
        unidade: string
        tipo: string
        quantidade: string
        motivo: string | null
        usuario: string
        created_at: Date
        valor_total: string | null
        valor_informado: string | null
        nota_fiscal: string | null
        empenho: string | null
        fornecedor: string | null
        ata: string | null
      }>(
        `SELECT s.id::text AS id, m.nome AS material, m.unidade, s.tipo, s.quantidade, s.motivo,
                u.full_name AS usuario, s.created_at,
                to_jsonb(s)->>'valor_total' AS valor_total, to_jsonb(s)->>'valor_informado' AS valor_informado,
                to_jsonb(s)->>'nota_fiscal' AS nota_fiscal, to_jsonb(s)->>'empenho' AS empenho,
                to_jsonb(s)->>'fornecedor' AS fornecedor,
                ${agreementSql} AS ata
           FROM public.stock_movements s
           JOIN public.materials m ON m.id = s.material_id
           JOIN public.auth_users u ON u.id = s.usuario_id
           ${where}
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT ${pageSize} OFFSET ${(filters.page - 1) * pageSize}`,
        parameters,
      ),
      pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM public.stock_movements s ${where}`,
        parameters,
      ),
    ])
    return {
      movements: rows.rows.map((row) => ({
        id: row.id,
        material: row.material,
        unit: row.unidade,
        type: row.tipo,
        quantity: Number(row.quantidade),
        reason: row.motivo,
        user: row.usuario,
        at: row.created_at,
        ...(filters.withValues
          ? {
              value: row.valor_total === null ? null : Number(row.valor_total),
              valueInformed: row.valor_informado === 'true',
              invoice: row.nota_fiscal,
              commitment: row.empenho,
              supplier: row.fornecedor,
              agreement: row.ata,
            }
          : {}),
      })),
      total: total.rows[0].total,
      page: filters.page,
      pageSize,
    }
  }
}

type ExecutionRow = {
  id: string
  request_id: string
  protocolo: string
  equipamento: string | null
  executado_por: string
  executado_em: Date
  servico_realizado: string
  pendencias: string | null
  registrado_por: string
  created_at: Date
}

const executionSelect = `
  SELECT x.id::text AS id, x.request_id::text AS request_id, ${protocolSql('r')} AS protocolo,
         e.nome AS equipamento, x.executado_por, x.executado_em, x.servico_realizado, x.pendencias,
         u.full_name AS registrado_por, x.created_at
    FROM public.maintenance_executions x
    JOIN public.service_requests r ON r.id = x.request_id
    JOIN public.auth_users u ON u.id = x.registrado_por
    LEFT JOIN public.equipments e ON e.id = x.equipment_id`

function presentExecution(row: ExecutionRow) {
  return {
    id: row.id,
    requestId: row.request_id,
    protocol: row.protocolo,
    equipment: row.equipamento,
    executedBy: row.executado_por,
    executedAt: row.executado_em,
    service: row.servico_realizado,
    pending: row.pendencias,
    registeredBy: row.registrado_por,
    at: row.created_at,
  }
}
