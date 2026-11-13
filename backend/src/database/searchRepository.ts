import { loadDemandContextData } from './demandConfigRepository.js'
import { contextFromIdentity, hasDemandAccess, visibilityLevel, visibleDemandSql } from '../demands/demandPolicy.js'
import { visibleInstrumentSql } from '../demands/instrumentRules.js'
import { holdsPermission } from '../auth/permissions.js'
import type { Pool } from 'pg'
import type { RequestModule } from '../auth/requestPolicy.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { likePattern } from '../requests/validation.js'
import { moduleTypes, normalizedStatusSql, normalizeStatus } from '../requests/workflow.js'
import { getDatabasePool } from './pool.js'
import { protocolSql } from './protocolSql.js'

/**
 * Pesquisa global. Cada categoria aplica no SQL o mesmo alcance da tela correspondente: o que a
 * pessoa não pode abrir, não aparece. Nenhuma consulta lê passageiros, CPF, e-mail ou os dados
 * completos das solicitações, onde há nomes de passageiros de Frota.
 */

const requestModules: RequestModule[] = ['maintenance', 'fleet', 'flights']
const moduleByType = Object.fromEntries(
  Object.entries(moduleTypes).map(([module, type]) => [type, module]),
) as Record<string, RequestModule>

export const searchCategories = [
  'requests',
  'schedules',
  'history',
  'materials',
  'warehouseRequests',
  'inventoryChecks',
  'vehicles',
  // Controle de Demandas (13/11/2026): mesma visibilidade do módulo, por setor e compartilhamento.
  'demands',
  'instruments',
] as const
export type SearchCategory = (typeof searchCategories)[number]

export type SearchFilters = {
  term: string
  module?: RequestModule | 'warehouse' | 'demands'
  status?: string
  from?: Date | null
  to?: Date | null
  category?: SearchCategory
  page: number
}

export type SearchHit = {
  id: string
  title: string
  subtitle: string | null
  protocol: string | null
  module: RequestModule | 'warehouse' | 'demands'
  status: string | null
  at: Date | null
  link: string
}

export type CategoryResult = { hits: SearchHit[]; total: number; page: number; pageSize: number }

const previewSize = 5
const pageSize = 25

const paths: Record<RequestModule, string> = {
  maintenance: '/manutencao',
  fleet: '/frota',
  flights: '/passagens-aereas',
}

// Campos pesquisáveis: dados de Frota e Manutenção por nome, nunca a coluna "dados" inteira.
const requestText = (pattern: string) => `(
  ${protocolSql('r')} ILIKE ${pattern} OR r.protocolo::text ILIKE ${pattern}
  OR r.titulo ILIKE ${pattern} OR r.descricao ILIKE ${pattern}
  OR r.setor_nome ILIKE ${pattern} OR solicitante.full_name ILIKE ${pattern}
  OR responsavel.full_name ILIKE ${pattern}
  OR r.dados->>'veiculo' ILIKE ${pattern}
)`

const requestJoins = `
  JOIN public.auth_users solicitante ON solicitante.id = r.solicitante_id
  LEFT JOIN public.auth_users responsavel ON responsavel.id = r.responsavel_id`

export class SearchRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async search(identity: AuthenticatedIdentity, filters: SearchFilters) {
    const holds = (permission: string) => (identity.permissions as readonly string[]).includes(permission)
    const wants = (category: SearchCategory) => !filters.category || filters.category === category
    const limit = filters.category ? pageSize : previewSize
    const offset = filters.category ? (filters.page - 1) * pageSize : 0
    const tasks: Partial<Record<SearchCategory, Promise<CategoryResult>>> = {}
    const context = { identity, filters, limit, offset }

    const types = requestModules
      .filter((module) => holds(`${module}:read`) && (!filters.module || filters.module === module))
      .map((module) => moduleTypes[module])

    if (types.length > 0) {
      if (wants('requests')) tasks.requests = this.requests(context, types)
      if (wants('schedules') && holds('calendar:read')) {
        const scheduled = types.filter((type) => type !== moduleTypes.flights)
        if (scheduled.length > 0) tasks.schedules = this.schedules(context, scheduled)
      }
      // Histórico de atendimento: é de quem acompanha todos, e sem as ações internas de gestão.
      if (wants('history') && holds('requests:read_all')) tasks.history = this.history(context, types)
    }

    const warehouseAllowed = !filters.module || filters.module === 'warehouse'
    if (warehouseAllowed && holds('warehouse:read')) {
      if (wants('materials') && !filters.status) tasks.materials = this.materials(context)
      if (wants('warehouseRequests')) tasks.warehouseRequests = this.warehouseRequests(context)
    }
    if (warehouseAllowed && holdsPermission(identity, 'warehouse:manage') && wants('inventoryChecks')) {
      tasks.inventoryChecks = this.inventoryChecks(context)
    }
    if ((!filters.module || filters.module === 'fleet') && holds('fleet:update') && wants('vehicles') && !filters.status) {
      tasks.vehicles = this.vehicles(context)
    }
    if (!filters.module || filters.module === 'demands') {
      const demandViewer = await this.demandViewer(identity)
      if (demandViewer) {
        if (wants('demands')) tasks.demands = this.demands(context, demandViewer)
        if (wants('instruments') && !filters.status && demandViewer.instruments) {
          tasks.instruments = this.instruments(context, demandViewer)
        }
      }
    }

    const entries = await Promise.all(
      Object.entries(tasks).map(async ([category, task]) => [category, await task] as const),
    )
    return Object.fromEntries(entries.filter(([, result]) => result && result.total > 0)) as Partial<
      Record<SearchCategory, CategoryResult>
    >
  }

  private async page(
    context: Context,
    run: (paging: string) => { sql: string; countSql: string; parameters: unknown[]; map: (row: any) => SearchHit },
  ): Promise<CategoryResult> {
    const { sql, countSql, parameters, map } = run(`LIMIT ${context.limit} OFFSET ${context.offset}`)
    const pool = this.poolProvider()
    const [rows, total] = await Promise.all([
      pool.query(sql, parameters),
      pool.query<{ total: number }>(countSql, parameters),
    ])
    return {
      hits: rows.rows.map(map),
      total: total.rows[0].total,
      page: context.filters.page,
      pageSize: context.limit,
    }
  }

  private requestScope(context: Context, types: readonly string[]) {
    const { identity, filters } = context
    const parameters: unknown[] = [types, likePattern(filters.term)]
    const conditions = ['r.tipo = ANY($1)', requestText('$2')]
    const bind = (value: unknown) => {
      parameters.push(value)
      return `$${parameters.length}`
    }
    if (!identity.permissions.includes('requests:read_all')) {
      conditions.push(`r.solicitante_id = ${bind(identity.userId)}`)
    }
    if (filters.status) conditions.push(`(${normalizedStatusSql('r')}) = ${bind(filters.status)}`)
    if (filters.from) conditions.push(`r.created_at >= ${bind(filters.from)}`)
    if (filters.to) conditions.push(`r.created_at <= ${bind(filters.to)}`)
    return { parameters, where: conditions.join(' AND ') }
  }

  private requests(context: Context, types: readonly string[]) {
    return this.page(context, (paging) => {
      const { parameters, where } = this.requestScope(context, types)
      return {
        parameters,
        sql: `SELECT r.id::text AS id, ${protocolSql('r')} AS protocolo, r.tipo, r.status, r.titulo,
                     r.setor_nome, solicitante.full_name AS solicitante, r.created_at
                FROM public.service_requests r ${requestJoins}
               WHERE ${where}
               ORDER BY r.created_at DESC, r.id DESC ${paging}`,
        countSql: `SELECT count(*)::int AS total FROM public.service_requests r ${requestJoins} WHERE ${where}`,
        map: (row) => {
          const module = moduleByType[row.tipo]
          return {
            id: row.id,
            title: row.titulo,
            subtitle: [row.solicitante, row.setor_nome].filter(Boolean).join(' · '),
            protocol: row.protocolo,
            module,
            status: normalizeStatus(module, row.status),
            at: row.created_at,
            link: `${paths[module]}/${row.id}`,
          }
        },
      }
    })
  }

  private schedules(context: Context, types: readonly string[]) {
    return this.page(context, (paging) => {
      const { parameters, where } = this.requestScope(context, types)
      const scheduled = `${where} AND r.data_agendada IS NOT NULL`
      return {
        parameters,
        sql: `SELECT r.id::text AS id, ${protocolSql('r')} AS protocolo, r.tipo, r.status, r.titulo,
                     responsavel.full_name AS responsavel, r.data_agendada
                FROM public.service_requests r ${requestJoins}
               WHERE ${scheduled}
               ORDER BY r.data_agendada DESC, r.id DESC ${paging}`,
        countSql: `SELECT count(*)::int AS total FROM public.service_requests r ${requestJoins} WHERE ${scheduled}`,
        map: (row) => {
          const module = moduleByType[row.tipo]
          return {
            id: row.id,
            title: row.titulo,
            subtitle: row.responsavel,
            protocol: row.protocolo,
            module,
            status: normalizeStatus(module, row.status),
            at: row.data_agendada,
            link: `${paths[module]}/${row.id}`,
          }
        },
      }
    })
  }

  private history(context: Context, types: readonly string[]) {
    const { filters } = context
    return this.page(context, (paging) => {
      const parameters: unknown[] = [types, likePattern(filters.term)]
      const conditions = [
        'r.tipo = ANY($1)',
        'h.comentario ILIKE $2',
        `h.acao NOT IN ('nota_interna', 'prioridade_alterada', 'prazo_alterado', 'complexidade_alterada', 'cotacao_registrada', 'cotacao_selecionada')`,
      ]
      const bind = (value: unknown) => {
        parameters.push(value)
        return `$${parameters.length}`
      }
      if (filters.status) conditions.push(`(${normalizedStatusSql('r')}) = ${bind(filters.status)}`)
      if (filters.from) conditions.push(`h.created_at >= ${bind(filters.from)}`)
      if (filters.to) conditions.push(`h.created_at <= ${bind(filters.to)}`)
      const where = conditions.join(' AND ')
      const from = `FROM public.request_history h JOIN public.service_requests r ON r.id = h.request_id`
      return {
        parameters,
        sql: `SELECT h.id::text AS id, r.id::text AS request_id, ${protocolSql('r')} AS protocolo, r.tipo, r.status,
                     h.comentario, h.created_at
                ${from}
               WHERE ${where}
               ORDER BY h.created_at DESC, h.id DESC ${paging}`,
        countSql: `SELECT count(*)::int AS total ${from} WHERE ${where}`,
        map: (row) => {
          const module = moduleByType[row.tipo]
          return {
            id: row.id,
            title: row.comentario,
            subtitle: null,
            protocol: row.protocolo,
            module,
            status: normalizeStatus(module, row.status),
            at: row.created_at,
            link: `${paths[module]}/${row.request_id}`,
          }
        },
      }
    })
  }

  private materials(context: Context) {
    return this.page(context, (paging) => {
      const parameters = [likePattern(context.filters.term)]
      const where = `m.ativo AND (m.nome ILIKE $1 OR m.codigo ILIKE $1 OR m.categoria_nome ILIKE $1)`
      return {
        parameters,
        sql: `SELECT m.id::text AS id, m.nome, m.codigo, m.categoria_nome, m.unidade
                FROM public.materials m WHERE ${where}
               ORDER BY lower(m.nome) ${paging}`,
        countSql: `SELECT count(*)::int AS total FROM public.materials m WHERE ${where}`,
        map: (row) => ({
          id: row.id,
          title: row.nome,
          subtitle: [row.codigo, row.categoria_nome, row.unidade].filter(Boolean).join(' · '),
          protocol: null,
          module: 'warehouse',
          status: null,
          at: null,
          link: holdsPermission(context.identity, 'warehouse:manage')
            ? '/almoxarifado/materiais'
            : '/almoxarifado/nova',
        }),
      }
    })
  }

  private warehouseRequests(context: Context) {
    const { identity, filters } = context
    const seesAll =
      holdsPermission(identity, 'warehouse:manage') || identity.permissions.includes('requests:read_all')
    return this.page(context, (paging) => {
      const parameters: unknown[] = [likePattern(filters.term)]
      const conditions = [
        `(${protocolSql('r')} ILIKE $1 OR r.protocolo::text ILIKE $1 OR r.setor_nome ILIKE $1
          OR r.referencia_externa ILIKE $1 OR solicitante.full_name ILIKE $1)`,
      ]
      const bind = (value: unknown) => {
        parameters.push(value)
        return `$${parameters.length}`
      }
      if (!seesAll) conditions.push(`r.solicitante_id = ${bind(identity.userId)}`)
      if (filters.status) conditions.push(`r.status = ${bind(filters.status)}`)
      if (filters.from) conditions.push(`r.created_at >= ${bind(filters.from)}`)
      if (filters.to) conditions.push(`r.created_at <= ${bind(filters.to)}`)
      const where = conditions.join(' AND ')
      const from = `FROM public.material_requests r JOIN public.auth_users solicitante ON solicitante.id = r.solicitante_id`
      return {
        parameters,
        sql: `SELECT r.id::text AS id, ${protocolSql('r')} AS protocolo, r.status, r.setor_nome,
                     solicitante.full_name AS solicitante, r.created_at
                ${from} WHERE ${where}
               ORDER BY r.created_at DESC, r.id DESC ${paging}`,
        countSql: `SELECT count(*)::int AS total ${from} WHERE ${where}`,
        map: (row) => ({
          id: row.id,
          title: 'Pedido de materiais',
          subtitle: [row.solicitante, row.setor_nome].filter(Boolean).join(' · '),
          protocol: row.protocolo,
          module: 'warehouse',
          status: row.status,
          at: row.created_at,
          link: `/almoxarifado/pedidos/${row.id}`,
        }),
      }
    })
  }

  private inventoryChecks(context: Context) {
    const { filters } = context
    return this.page(context, (paging) => {
      const parameters: unknown[] = [likePattern(filters.term)]
      const conditions = [`(${protocolSql('c')} ILIKE $1 OR c.protocolo::text ILIKE $1 OR c.titulo ILIKE $1)`]
      const bind = (value: unknown) => {
        parameters.push(value)
        return `$${parameters.length}`
      }
      if (filters.status) conditions.push(`c.status = ${bind(filters.status)}`)
      if (filters.from) conditions.push(`c.created_at >= ${bind(filters.from)}`)
      if (filters.to) conditions.push(`c.created_at <= ${bind(filters.to)}`)
      const where = conditions.join(' AND ')
      return {
        parameters,
        sql: `SELECT c.id::text AS id, ${protocolSql('c')} AS protocolo, c.titulo, c.status, c.created_at
                FROM public.inventory_checks c WHERE ${where}
               ORDER BY c.created_at DESC, c.id DESC ${paging}`,
        countSql: `SELECT count(*)::int AS total FROM public.inventory_checks c WHERE ${where}`,
        map: (row) => ({
          id: row.id,
          title: row.titulo,
          subtitle: 'Conferência de inventário',
          protocol: row.protocolo,
          module: 'warehouse',
          status: row.status,
          at: row.created_at,
          link: `/almoxarifado/conferencias/${row.id}`,
        }),
      }
    })
  }

  /** A tabela de veículos é da migração 009: antes dela, a categoria só não aparece. */
  private async vehicles(context: Context): Promise<CategoryResult> {
    const present = await this.poolProvider().query<{ present: boolean }>(
      `SELECT to_regclass('public.vehicles') IS NOT NULL AS present`,
    )
    if (!present.rows[0]?.present) {
      return { hits: [], total: 0, page: context.filters.page, pageSize: context.limit }
    }
    return this.page(context, (paging) => {
      const parameters = [likePattern(context.filters.term)]
      const where = `(v.placa ILIKE $1 OR v.modelo ILIKE $1 OR v.identificacao ILIKE $1)`
      return {
        parameters,
        sql: `SELECT v.id::text AS id, v.placa, v.modelo, v.situacao
                FROM public.vehicles v WHERE ${where}
               ORDER BY v.placa ${paging}`,
        countSql: `SELECT count(*)::int AS total FROM public.vehicles v WHERE ${where}`,
        map: (row) => ({
          id: row.id,
          title: `${row.placa} · ${row.modelo}`,
          subtitle: null,
          protocol: null,
          module: 'fleet',
          status: row.situacao,
          at: null,
          link: `/frota/veiculos/${row.id}`,
        }),
      }
    })
  }

  /** Quem tem acesso ao Controle de Demandas, com o alcance do módulo. Sem migração ou sem vínculo, nulo. */
  private async demandViewer(identity: AuthenticatedIdentity): Promise<DemandViewer | null> {
    const pool = this.poolProvider()
    const present = await pool.query<{ demands: boolean; members: boolean; instruments: boolean }>(
      `SELECT to_regclass('public.demands') IS NOT NULL AS demands,
              to_regclass('public.user_directorate_links') IS NOT NULL AS members,
              to_regclass('public.contract_instruments') IS NOT NULL AS instruments`,
    )
    if (!present.rows[0].demands || !present.rows[0].members) return null
    const context = contextFromIdentity(identity, await loadDemandContextData(pool, identity.userId))
    if (!hasDemandAccess(context)) return null
    return { userId: identity.userId, level: visibilityLevel(context), instruments: present.rows[0].instruments }
  }

  /** A mesma regra das listas do módulo (visibleDemandSql): setor, compartilhamento e restrição. */
  private demands(context: Context, viewer: DemandViewer) {
    return this.page(context, (paging) => {
      const { filters } = context
      const parameters: unknown[] = [likePattern(filters.term), viewer.userId, viewer.level]
      const conditions = [
        visibleDemandSql('d', '$2', '$3'),
        `(d.numero ILIKE $1 OR d.titulo ILIKE $1 OR d.descricao ILIKE $1 OR s.nome ILIKE $1)`,
      ]
      if (filters.status) {
        parameters.push(filters.status)
        conditions.push(`d.status = $${parameters.length}`)
      }
      if (filters.from) {
        parameters.push(filters.from)
        conditions.push(`d.data_abertura >= $${parameters.length}`)
      }
      if (filters.to) {
        parameters.push(filters.to)
        conditions.push(`d.data_abertura <= $${parameters.length}`)
      }
      const where = conditions.join(' AND ')
      const from = `FROM public.demands d LEFT JOIN public.demand_sectors s ON s.id = d.setor_responsavel_id`
      return {
        parameters,
        sql: `SELECT d.id::text AS id, d.numero, d.titulo, d.status, d.rascunho, s.nome AS setor, d.data_abertura
                ${from} WHERE ${where}
               ORDER BY d.data_abertura DESC, d.id ${paging}`,
        countSql: `SELECT count(*)::int AS total ${from} WHERE ${where}`,
        map: (row) => ({
          id: row.id,
          title: row.titulo,
          subtitle: [row.setor, row.rascunho ? 'Rascunho' : null].filter(Boolean).join(' · ') || null,
          protocol: row.numero,
          module: 'demands',
          status: row.status,
          at: row.data_abertura,
          link: `/demandas/${row.id}`,
        }),
      }
    })
  }

  /** Atas e contratos: setor responsável ou compartilhado (visibleInstrumentSql). */
  private instruments(context: Context, viewer: DemandViewer) {
    return this.page(context, (paging) => {
      const parameters: unknown[] = [likePattern(context.filters.term), viewer.userId, viewer.level]
      const where = `${visibleInstrumentSql('i', '$2', '$3')}
        AND (i.numero ILIKE $1 OR i.objeto ILIKE $1 OR i.fornecedor ILIKE $1 OR i.processo ILIKE $1)`
      return {
        parameters,
        sql: `SELECT i.id::text AS id, i.tipo, i.numero, i.objeto, i.fornecedor, i.encerrado, i.vigencia_fim
                FROM public.contract_instruments i WHERE ${where}
               ORDER BY i.encerrado, i.vigencia_fim NULLS LAST, lower(i.numero) ${paging}`,
        countSql: `SELECT count(*)::int AS total FROM public.contract_instruments i WHERE ${where}`,
        map: (row) => ({
          id: row.id,
          title: `${row.tipo === 'ata' ? 'Ata' : 'Contrato'} ${row.numero} · ${row.objeto}`,
          subtitle: row.fornecedor,
          protocol: null,
          module: 'demands',
          status: row.encerrado ? 'encerrado' : null,
          at: null,
          link: `/demandas/atas/${row.id}`,
        }),
      }
    })
  }
}

type DemandViewer = { userId: string; level: number; instruments: boolean }

type Context = {
  identity: AuthenticatedIdentity
  filters: SearchFilters
  limit: number
  offset: number
}
