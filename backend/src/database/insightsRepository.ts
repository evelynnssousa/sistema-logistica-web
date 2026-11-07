import { holdsPermission } from '../auth/permissions.js'
import type { Pool } from 'pg'
import type { RequestModule } from '../auth/requestPolicy.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { moduleTypes, normalizedStatusSql, normalizeStatus, storedValuesFor } from '../requests/workflow.js'
import type { RequestStatus } from '../requests/workflow.js'
import { getDatabasePool } from './pool.js'
import { optionalColumnSql, protocolSql } from './protocolSql.js'

/**
 * Indicadores calculados diretamente dos registros dos módulos, sempre no alcance da
 * pessoa: módulos que ela pode ler e, sem requests:read_all, apenas as próprias solicitações.
 */

const requestModules: RequestModule[] = ['maintenance', 'fleet', 'flights']
const moduleByType = Object.fromEntries(
  Object.entries(moduleTypes).map(([module, type]) => [type, module]),
) as Record<string, RequestModule>

export type InsightFilters = {
  from?: Date | null
  to?: Date | null
  module?: RequestModule | 'warehouse' | null
  sectorId?: string | null
  responsibleId?: string | null
  status?: string | null
}

function readableModules(identity: AuthenticatedIdentity, filter?: InsightFilters['module']) {
  return requestModules.filter(
    (module) =>
      identity.permissions.includes(`${module}:read`) && (!filter || filter === module),
  )
}

function buildScope(identity: AuthenticatedIdentity, filters: InsightFilters) {
  const types = readableModules(identity, filters.module).map((module) => moduleTypes[module])
  const parameters: unknown[] = [types]
  const conditions = ['r.tipo = ANY($1)']
  const bind = (value: unknown) => {
    parameters.push(value)
    return `$${parameters.length}`
  }

  if (!identity.permissions.includes('requests:read_all')) {
    conditions.push(`r.solicitante_id = ${bind(identity.userId)}`)
  }
  if (filters.from) conditions.push(`r.created_at >= ${bind(filters.from)}`)
  if (filters.to) conditions.push(`r.created_at <= ${bind(filters.to)}`)
  if (filters.sectorId) conditions.push(`r.setor_id = ${bind(filters.sectorId)}`)
  if (filters.responsibleId) conditions.push(`r.responsavel_id = ${bind(filters.responsibleId)}`)
  if (filters.status) conditions.push(`(${normalizedStatusSql('r')}) = ${bind(filters.status)}`)

  return { where: `WHERE ${conditions.join(' AND ')}`, parameters }
}

function buildWarehouseScope(identity: AuthenticatedIdentity, filters: InsightFilters) {
  const parameters: unknown[] = []
  const conditions: string[] = []
  const bind = (value: unknown) => {
    parameters.push(value)
    return `$${parameters.length}`
  }
  const seesAll =
    holdsPermission(identity, 'warehouse:manage') ||
    identity.permissions.includes('requests:read_all')

  if (!seesAll) conditions.push(`r.solicitante_id = ${bind(identity.userId)}`)
  if (filters.from) conditions.push(`r.created_at >= ${bind(filters.from)}`)
  if (filters.to) conditions.push(`r.created_at <= ${bind(filters.to)}`)
  if (filters.sectorId) conditions.push(`r.setor_id = ${bind(filters.sectorId)}`)

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    parameters,
  }
}

function readsWarehouse(identity: AuthenticatedIdentity, filter?: InsightFilters['module']) {
  return identity.permissions.includes('warehouse:read') && (!filter || filter === 'warehouse')
}

const closedStatuses = new Set(['concluido', 'cancelado', 'emitida', 'cancelada'])

export class InsightsRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async summary(identity: AuthenticatedIdentity, filters: InsightFilters) {
    const pool = this.poolProvider()
    const scope = buildScope(identity, filters)

    const counts = await pool.query<{ tipo: string; status: string; total: number }>(
      `SELECT r.tipo, r.status, count(*)::int AS total
         FROM public.service_requests r
         ${scope.where}
        GROUP BY r.tipo, r.status`,
      scope.parameters,
    )

    const byModule: Record<string, Record<string, number>> = {}
    for (const module of readableModules(identity, filters.module)) byModule[module] = {}
    for (const row of counts.rows) {
      const module = moduleByType[row.tipo]
      const status = normalizeStatus(module, row.status)
      byModule[module][status] = (byModule[module][status] ?? 0) + row.total
    }

    let warehouse: Record<string, number> | null = null
    if (readsWarehouse(identity, filters.module)) {
      const warehouseScope = buildWarehouseScope(identity, filters)
      const rows = await pool.query<{ status: string; total: number }>(
        `SELECT r.status, count(*)::int AS total
           FROM public.material_requests r ${warehouseScope.where}
          GROUP BY r.status`,
        warehouseScope.parameters,
      )
      warehouse = Object.fromEntries(rows.rows.map((row) => [row.status, row.total]))
    }

    const requestTotals = Object.values(byModule).flatMap((statuses) => Object.entries(statuses))
    const total = requestTotals.reduce((sum, [, count]) => sum + count, 0)
    const closed = requestTotals
      .filter(([status]) => closedStatuses.has(status))
      .reduce((sum, [, count]) => sum + count, 0)
    const concluded = requestTotals
      .filter(([status]) => status === 'concluido' || status === 'emitida')
      .reduce((sum, [, count]) => sum + count, 0)

    return {
      totals: {
        requests: total,
        open: total - closed,
        concluded,
        inProgress: requestTotals
          .filter(([status]) => status === 'em_andamento')
          .reduce((sum, [, count]) => sum + count, 0),
        awaitingSchedule: requestTotals
          .filter(([status]) => status === 'aguardando_agendamento')
          .reduce((sum, [, count]) => sum + count, 0),
      },
      byModule,
      warehouse,
    }
  }

  async recent(identity: AuthenticatedIdentity, filters: InsightFilters, limit = 10) {
    const scope = buildScope(identity, filters)
    const result = await this.poolProvider().query<{
      id: string
      protocolo: string
      tipo: string
      status: string
      titulo: string
      solicitante: string
      setor_nome: string | null
      created_at: Date
    }>(
      `SELECT r.id::text AS id, ${protocolSql('r')} AS protocolo, r.tipo, r.status, r.titulo,
              u.full_name AS solicitante, r.setor_nome, r.created_at
         FROM public.service_requests r
         JOIN public.auth_users u ON u.id = r.solicitante_id
         ${scope.where}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${limit}`,
      scope.parameters,
    )
    return result.rows.map((row) => {
      const module = moduleByType[row.tipo]
      return {
        id: row.id,
        protocol: row.protocolo,
        module,
        status: normalizeStatus(module, row.status),
        title: row.titulo,
        requester: row.solicitante,
        sector: row.setor_nome,
        createdAt: row.created_at,
      }
    })
  }

  async byPeriod(identity: AuthenticatedIdentity, filters: InsightFilters) {
    const scope = buildScope(identity, filters)
    const result = await this.poolProvider().query<{ mes: string; total: number }>(
      `SELECT to_char(date_trunc('month', r.created_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS mes,
              count(*)::int AS total
         FROM public.service_requests r
         ${scope.where}
        GROUP BY 1
        ORDER BY 1`,
      scope.parameters,
    )
    return result.rows.map((row) => ({ month: row.mes, total: row.total }))
  }

  async bySector(identity: AuthenticatedIdentity, filters: InsightFilters) {
    const scope = buildScope(identity, filters)
    const result = await this.poolProvider().query<{ setor: string | null; total: number }>(
      `SELECT r.setor_nome AS setor, count(*)::int AS total
         FROM public.service_requests r
         ${scope.where}
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT 30`,
      scope.parameters,
    )
    return result.rows.map((row) => ({ sector: row.setor ?? 'Não informado', total: row.total }))
  }

  /** A agenda lê os próprios agendamentos dos módulos: não há cópia a sincronizar. */
  async calendarEvents(
    identity: AuthenticatedIdentity,
    period: {
      from: Date
      to: Date
      modules: RequestModule[]
      statuses?: readonly RequestStatus[]
      responsibleId?: string | null
    },
  ) {
    const types = period.modules
      .filter((module) => module !== 'flights' && identity.permissions.includes(`${module}:read`))
      .map((module) => moduleTypes[module])

    const parameters: unknown[] = [types, period.from, period.to]
    const bind = (value: unknown) => {
      parameters.push(value)
      return `$${parameters.length}`
    }
    const conditions: string[] = []
    if (!identity.permissions.includes('requests:read_all')) {
      conditions.push(`r.solicitante_id = ${bind(identity.userId)}`)
    }
    if (period.responsibleId) conditions.push(`r.responsavel_id = ${bind(period.responsibleId)}`)
    if (period.statuses?.length) {
      // Os dois módulos usam os mesmos status, e os valores antigos entram na mesma consulta.
      const stored = period.statuses.flatMap((status) => storedValuesFor('maintenance', status))
      conditions.push(`r.status = ANY(${bind(stored)}::text[])`)
    }

    const result = await this.poolProvider().query<{
      id: string
      protocolo: string
      tipo: string
      status: string
      titulo: string
      data_agendada: Date
      agendamento_fim: Date | null
      setor_nome: string | null
      responsavel_id: string | null
      responsavel: string | null
    }>(
      `SELECT r.id::text AS id, ${protocolSql('r')} AS protocolo, r.tipo, r.status, r.titulo,
              r.data_agendada, r.agendamento_fim, r.setor_nome,
              r.responsavel_id::text AS responsavel_id, u.full_name AS responsavel
         FROM public.service_requests r
         LEFT JOIN public.auth_users u ON u.id = r.responsavel_id
        WHERE r.tipo = ANY($1)
          AND r.data_agendada IS NOT NULL
          AND COALESCE(r.agendamento_fim, r.data_agendada) >= $2
          AND r.data_agendada < $3
          ${conditions.map((condition) => `AND ${condition}`).join(' ')}
        ORDER BY r.data_agendada, r.id`,
      parameters,
    )
    return result.rows.map((row) => {
      const module = moduleByType[row.tipo]
      return {
        id: row.id,
        protocol: row.protocolo,
        module,
        status: normalizeStatus(module, row.status),
        title: row.titulo,
        start: row.data_agendada,
        end: row.agendamento_fim,
        sector: row.setor_nome,
        responsibleId: row.responsavel_id,
        responsible: row.responsavel,
      }
    })
  }

  /**
   * Indicadores operacionais. Cada um informa quantos registros entraram no cálculo: registros
   * sem os dados necessários, como os anteriores à execução real, não são estimados.
   */
  async operational(identity: AuthenticatedIdentity, filters: InsightFilters) {
    const pool = this.poolProvider()
    const scope = buildScope(identity, filters)

    const scheduling = await pool.query<{ acao: string; total: number }>(
      `SELECT h.acao, count(*)::int AS total
         FROM public.request_history h
         JOIN public.service_requests r ON r.id = h.request_id
         ${scope.where}
          AND h.acao IN ('agendada', 'reagendada', 'cancelada')
        GROUP BY h.acao`,
      scope.parameters,
    )
    const totals = Object.fromEntries(scheduling.rows.map((row) => [row.acao, row.total]))

    const serviceTime = await pool.query<{
      tipo: string
      concluidas: number
      com_dados: number
      media_minutos: string | null
    }>(
      `SELECT r.tipo,
              count(*)::int AS concluidas,
              count(*) FILTER (WHERE r.execucao_inicio IS NOT NULL AND r.execucao_fim IS NOT NULL)::int AS com_dados,
              avg(extract(epoch FROM r.execucao_fim - r.execucao_inicio) / 60)
                FILTER (WHERE r.execucao_inicio IS NOT NULL AND r.execucao_fim IS NOT NULL) AS media_minutos
         FROM public.service_requests r
         ${scope.where}
          AND r.tipo IN ('manutencao', 'frota')
          AND r.status IN ('concluido', 'concluida')
        GROUP BY r.tipo`,
      scope.parameters,
    )

    const fleet = await pool.query<{
      ocorrencias: number
      atrasos: number
      minutos_atraso: number
      execucoes: number
    }>(
      `SELECT (SELECT count(*)::int FROM public.request_occurrences o
                 JOIN public.service_requests r ON r.id = o.request_id
                 ${scope.where} AND r.tipo = 'frota' AND o.tipo = 'ocorrencia') AS ocorrencias,
              (SELECT count(*)::int FROM public.request_occurrences o
                 JOIN public.service_requests r ON r.id = o.request_id
                 ${scope.where} AND r.tipo = 'frota' AND o.tipo = 'atraso') AS atrasos,
              (SELECT coalesce(sum(o.atraso_minutos), 0)::int FROM public.request_occurrences o
                 JOIN public.service_requests r ON r.id = o.request_id
                 ${scope.where} AND r.tipo = 'frota' AND o.tipo = 'atraso') AS minutos_atraso,
              (SELECT count(*)::int FROM public.service_requests r
                 ${scope.where} AND r.tipo = 'frota' AND r.execucao_inicio IS NOT NULL) AS execucoes`,
      scope.parameters,
    )

    return {
      scheduling: {
        scheduled: totals.agendada ?? 0,
        rescheduled: totals.reagendada ?? 0,
        cancelled: totals.cancelada ?? 0,
      },
      serviceTime: serviceTime.rows.map((row) => ({
        module: moduleByType[row.tipo],
        concluded: row.concluidas,
        withData: row.com_dados,
        averageMinutes: row.media_minutos === null ? null : Math.round(Number(row.media_minutos)),
      })),
      fleet: readableModules(identity, filters.module).includes('fleet')
        ? {
            executions: fleet.rows[0].execucoes,
            occurrences: fleet.rows[0].ocorrencias,
            delays: fleet.rows[0].atrasos,
            delayMinutes: fleet.rows[0].minutos_atraso,
          }
        : null,
      warehouse: await this.warehouseOperational(identity, filters),
      inventory: await this.inventoryOperational(identity, filters),
      fleetUsage: await this.fleetUsage(identity, filters),
      stockFlow: await this.stockFlow(identity, filters),
    }
  }

  /**
   * Utilização por veículo, a partir dos registros de uso. Mesmo acesso das telas de veículos. Sem
   * a migração 009, a seção não aparece.
   */
  private async fleetUsage(identity: AuthenticatedIdentity, filters: InsightFilters) {
    if (filters.module && filters.module !== 'fleet') return null
    if (!identity.permissions.includes('fleet:read') || !identity.permissions.includes('fleet:update')) {
      return null
    }
    const pool = this.poolProvider()
    const present = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.vehicle_logs') IS NOT NULL AS present`,
    )
    if (!present.rows[0]?.present) return null

    const result = await pool.query<{
      identificacao: string
      usos: number
      ocorrencias: number
      abastecimentos: number
      manutencoes: number
      km: string | null
      litros: string | null
      valor: string | null
    }>(
      `SELECT v.placa AS identificacao,
              count(*) FILTER (WHERE l.tipo = 'utilizacao')::int AS usos,
              count(*) FILTER (WHERE l.tipo = 'ocorrencia')::int AS ocorrencias,
              count(*) FILTER (WHERE l.tipo = 'abastecimento')::int AS abastecimentos,
              count(*) FILTER (WHERE l.tipo = 'manutencao')::int AS manutencoes,
              sum(l.km_final - l.km_inicial) FILTER (WHERE l.tipo = 'utilizacao') AS km,
              sum(l.litros) AS litros,
              sum(l.valor) AS valor
         FROM public.vehicle_logs l
         JOIN public.vehicles v ON v.id = l.vehicle_id
        WHERE ($1::timestamptz IS NULL OR l.data_registro >= $1)
          AND ($2::timestamptz IS NULL OR l.data_registro <= $2)
        GROUP BY v.id, v.placa
        ORDER BY lower(v.placa)`,
      [filters.from ?? null, filters.to ?? null],
    )
    return result.rows.map((row) => ({
      vehicle: row.identificacao,
      uses: row.usos,
      occurrences: row.ocorrencias,
      fuelings: row.abastecimentos,
      maintenances: row.manutencoes,
      kilometers: row.km === null ? null : Number(row.km),
      liters: row.litros === null ? null : Number(row.litros),
      cost: row.valor === null ? null : Number(row.valor),
    }))
  }

  /** Entradas e saídas do estoque interno por material. Restrito como as telas de estoque. */
  private async stockFlow(identity: AuthenticatedIdentity, filters: InsightFilters) {
    if (!holdsPermission(identity, 'warehouse:manage')) return null
    if (filters.module && filters.module !== 'warehouse') return null

    const result = await this.poolProvider().query<{
      material: string
      unidade: string
      entradas: string
      saidas: string
    }>(
      `SELECT m.nome AS material, m.unidade,
              COALESCE(sum(s.quantidade) FILTER (WHERE s.tipo = 'entrada'), 0) AS entradas,
              COALESCE(sum(s.quantidade) FILTER (WHERE s.tipo = 'saida'), 0) AS saidas
         FROM public.stock_movements s
         JOIN public.materials m ON m.id = s.material_id
        WHERE ($1::timestamptz IS NULL OR s.created_at >= $1)
          AND ($2::timestamptz IS NULL OR s.created_at <= $2)
        GROUP BY m.id, m.nome, m.unidade
        ORDER BY sum(s.quantidade) FILTER (WHERE s.tipo = 'saida') DESC NULLS LAST, lower(m.nome)
        LIMIT 50`,
      [filters.from ?? null, filters.to ?? null],
    )
    return result.rows.map((row) => ({
      material: row.material,
      unit: row.unidade,
      entries: Number(row.entradas),
      exits: Number(row.saidas),
    }))
  }

  /**
   * Indicadores de desempenho, com dados reais. Espera, execução e resolução são medidas
   * separadas, e cada uma informa em quantos registros se baseia: o que não tem os horários
   * necessários fica de fora, sem estimativa.
   */
  async performance(identity: AuthenticatedIdentity, filters: InsightFilters, withProductivity: boolean) {
    const pool = this.poolProvider()
    const scope = buildScope(identity, filters)
    const status = normalizedStatusSql('r')
    const closed = `(${status}) IN ('concluido', 'emitida', 'cancelado', 'cancelada')`
    const concluded = `(${status}) IN ('concluido', 'emitida')`
    const deadline = `(${optionalColumnSql('r', 'prazo_em')})::timestamptz`
    // A espera registrada pelo solicitante não conta como atraso interno, como na Central.
    const waiting = `(${optionalColumnSql('r', 'aguardando_externo_desde')} IS NOT NULL)`
    const paused = `COALESCE((${optionalColumnSql('r', 'espera_externa_segundos')})::int, 0)`
    const late = `(NOT ${closed} AND NOT ${waiting} AND (${deadline} + make_interval(secs => ${paused}) < now() OR ((${status}) IN ('agendado', 'reagendado') AND r.data_agendada < now())))`
    const firstSchedule = `(SELECT min(h.created_at) FROM public.request_history h WHERE h.request_id = r.id AND h.acao = 'agendada')`
    const reschedules = `(SELECT count(*) FROM public.request_history h WHERE h.request_id = r.id AND h.acao = 'reagendada')`
    const minutes = (expression: string) => `extract(epoch FROM ${expression}) / 60`

    const totals = await pool.query<{
      recebidas: number
      concluidas: number
      pendentes: number
      atrasadas: number
      canceladas: number
      reagendamentos: number
      ate_agendar: string | null
      n_ate_agendar: number
      espera: string | null
      n_espera: number
      execucao: string | null
      n_execucao: number
      resolucao: string | null
      n_resolucao: number
      com_prazo: number
      no_prazo: number
    }>(
      `SELECT count(*)::int AS recebidas,
              count(*) FILTER (WHERE ${concluded})::int AS concluidas,
              count(*) FILTER (WHERE NOT ${closed})::int AS pendentes,
              count(*) FILTER (WHERE ${late})::int AS atrasadas,
              count(*) FILTER (WHERE (${status}) IN ('cancelado', 'cancelada'))::int AS canceladas,
              coalesce(sum(${reschedules}), 0)::int AS reagendamentos,
              avg(${minutes(`${firstSchedule} - r.created_at`)}) AS ate_agendar,
              count(${firstSchedule})::int AS n_ate_agendar,
              avg(${minutes('r.execucao_inicio - r.created_at')}) AS espera,
              count(r.execucao_inicio)::int AS n_espera,
              avg(${minutes('r.execucao_fim - r.execucao_inicio')}) AS execucao,
              count(*) FILTER (WHERE r.execucao_inicio IS NOT NULL AND r.execucao_fim IS NOT NULL)::int AS n_execucao,
              avg(${minutes('r.concluida_em - r.created_at')}) FILTER (WHERE ${concluded}) AS resolucao,
              count(*) FILTER (WHERE ${concluded} AND r.concluida_em IS NOT NULL)::int AS n_resolucao,
              count(*) FILTER (WHERE ${concluded} AND ${deadline} IS NOT NULL)::int AS com_prazo,
              count(*) FILTER (WHERE ${concluded} AND r.concluida_em <= ${deadline})::int AS no_prazo
         FROM public.service_requests r
         ${scope.where}`,
      scope.parameters,
    )

    const byCategory = await pool.query<{ categoria: string | null; total: number }>(
      `SELECT r.tipo_servico_nome AS categoria, count(*)::int AS total
         FROM public.service_requests r
         ${scope.where} AND r.tipo = 'manutencao'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
      scope.parameters,
    )

    const monthly = await pool.query<{ mes: string; recebidas: number; concluidas: number }>(
      `SELECT to_char(date_trunc('month', r.created_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS mes,
              count(*)::int AS recebidas,
              count(*) FILTER (WHERE ${concluded})::int AS concluidas
         FROM public.service_requests r
         ${scope.where}
        GROUP BY 1 ORDER BY 1`,
      scope.parameters,
    )

    const row = totals.rows[0]
    const average = (value: string | null, count: number) => ({
      minutes: value === null ? null : Math.round(Number(value)),
      basedOn: count,
    })

    return {
      received: row.recebidas,
      concluded: row.concluidas,
      pending: row.pendentes,
      late: row.atrasadas,
      cancelled: row.canceladas,
      rescheduled: row.reagendamentos,
      times: {
        untilSchedule: average(row.ate_agendar, row.n_ate_agendar),
        waitUntilStart: average(row.espera, row.n_espera),
        effectiveService: average(row.execucao, row.n_execucao),
        totalResolution: average(row.resolucao, row.n_resolucao),
      },
      deadlines: {
        withDeadline: row.com_prazo,
        onTime: row.no_prazo,
        percent: row.com_prazo === 0 ? null : Math.round((row.no_prazo / row.com_prazo) * 1000) / 10,
      },
      byCategory: byCategory.rows.map((item) => ({ category: item.categoria ?? 'Não informado', total: item.total })),
      monthly: monthly.rows.map((item) => ({
        month: item.mes,
        received: item.recebidas,
        concluded: item.concluidas,
      })),
      productivity: withProductivity ? await this.productivity(scope, concluded, closed) : null,
    }
  }

  /** Dado de gestão da equipe: só com a permissão da Central. Sem nota nem classificação. */
  private async productivity(scope: ReturnType<typeof buildScope>, concluded: string, closed: string) {
    const result = await this.poolProvider().query<{
      responsavel: string
      concluidas: number
      em_aberto: number
      simples: number
      media: number
      complexa: number
      sem_classificacao: number
      execucao: string | null
      n_execucao: number
    }>(
      `SELECT u.full_name AS responsavel,
              count(*) FILTER (WHERE ${concluded})::int AS concluidas,
              count(*) FILTER (WHERE NOT ${closed})::int AS em_aberto,
              count(*) FILTER (WHERE ${concluded} AND to_jsonb(r)->>'complexidade' = 'simples')::int AS simples,
              count(*) FILTER (WHERE ${concluded} AND to_jsonb(r)->>'complexidade' = 'media')::int AS media,
              count(*) FILTER (WHERE ${concluded} AND to_jsonb(r)->>'complexidade' = 'complexa')::int AS complexa,
              count(*) FILTER (WHERE ${concluded} AND to_jsonb(r)->>'complexidade' IS NULL)::int AS sem_classificacao,
              avg(extract(epoch FROM r.execucao_fim - r.execucao_inicio) / 60) AS execucao,
              count(*) FILTER (WHERE r.execucao_inicio IS NOT NULL AND r.execucao_fim IS NOT NULL)::int AS n_execucao
         FROM public.service_requests r
         JOIN public.auth_users u ON u.id = r.responsavel_id
         ${scope.where}
        GROUP BY u.id, u.full_name
        ORDER BY lower(u.full_name)`,
      scope.parameters,
    )
    return result.rows.map((row) => ({
      responsible: row.responsavel,
      concluded: row.concluidas,
      open: row.em_aberto,
      complexity: {
        simple: row.simples,
        medium: row.media,
        complex: row.complexa,
        unclassified: row.sem_classificacao,
      },
      effectiveMinutes: row.execucao === null ? null : Math.round(Number(row.execucao)),
      basedOn: row.n_execucao,
    }))
  }

  private async warehouseOperational(identity: AuthenticatedIdentity, filters: InsightFilters) {
    if (!readsWarehouse(identity, filters.module)) return null

    const scope = buildWarehouseScope(identity, filters)
    const result = await this.poolProvider().query<{ origem: string; total: number; parciais: number }>(
      `SELECT r.origem, count(*)::int AS total,
              count(*) FILTER (WHERE r.status = 'atendido_parcial')::int AS parciais
         FROM public.material_requests r
         ${scope.where}
        GROUP BY r.origem`,
      scope.parameters,
    )
    return {
      byOrigin: result.rows.map((row) => ({ origin: row.origem, total: row.total })),
      partial: result.rows.reduce((sum, row) => sum + row.parciais, 0),
    }
  }

  /** A conferência é restrita a quem administra o Almoxarifado, como nas rotas do módulo. */
  private async inventoryOperational(identity: AuthenticatedIdentity, filters: InsightFilters) {
    if (!holdsPermission(identity, 'warehouse:manage')) return null
    if (filters.module && filters.module !== 'warehouse') return null

    const result = await this.poolProvider().query<{
      conferencias: number
      concluidas: number
      itens: number
      contados: number
      divergentes: number
    }>(
      `SELECT count(DISTINCT c.id)::int AS conferencias,
              count(DISTINCT c.id) FILTER (WHERE c.status = 'concluida')::int AS concluidas,
              count(i.id)::int AS itens,
              count(i.id) FILTER (WHERE i.quantidade_contada IS NOT NULL)::int AS contados,
              count(i.id) FILTER (WHERE i.diferenca <> 0)::int AS divergentes
         FROM public.inventory_checks c
         LEFT JOIN public.inventory_check_items i ON i.check_id = c.id
        WHERE c.status <> 'cancelada'
          AND ($1::timestamptz IS NULL OR c.created_at >= $1)
          AND ($2::timestamptz IS NULL OR c.created_at <= $2)`,
      [filters.from ?? null, filters.to ?? null],
    )
    const row = result.rows[0]
    return {
      checks: row.conferencias,
      concluded: row.concluidas,
      items: row.itens,
      counted: row.contados,
      divergent: row.divergentes,
    }
  }
}
