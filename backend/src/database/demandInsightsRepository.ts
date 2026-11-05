import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { canCreateAgendaEvents, visibilityLevel, visibleDemandSql } from '../demands/demandPolicy.js'
import type { DemandContext } from '../demands/demandPolicy.js'
import { notifyDemand } from '../demands/demandNotifications.js'
import type { DemandFilters } from '../demands/demandValidation.js'
import { describeRule } from '../demands/recurrence.js'
import { resourcePath } from '../integrations/catalog.js'
import { redactOptional } from '../integrations/redaction.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import {
  applyDemandFilters,
  FilterBuilder,
  overdueSql,
  presentSummary,
  todaySql,
} from './demandRepository.js'
import { projectDates, ruleOf, seriesColumns, todayInSaoPaulo } from './demandSeriesRepository.js'
import type { SeriesRow } from './demandSeriesRepository.js'
import { ModuleError } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'

type Client = Pick<PoolClient, 'query'>

/** Painel, relatórios, agenda e alertas. Tudo parte do mesmo filtro de visibilidade das listas. */

const listSelect = `
  SELECT d.id::text AS id, d.numero, d.titulo, d.categoria_id::text AS categoria_id, c.nome AS categoria_nome,
         d.setor_origem_id::text AS setor_origem_id, so.nome AS setor_origem_nome,
         d.setor_responsavel_id::text AS setor_responsavel_id, sr.nome AS setor_responsavel_nome,
         d.solicitante_id::text AS solicitante_id, us.full_name AS solicitante_nome,
         d.responsavel_id::text AS responsavel_id, ur.full_name AS responsavel_nome,
         d.data_abertura, d.inicio_previsto::text AS inicio_previsto, d.prazo::text AS prazo, d.prioridade, d.status,
         d.rascunho, d.restrita, d.series_id::text AS series_id, d.data_ocorrencia::text AS data_ocorrencia,
         d.versao, d.ultima_atividade_em, d.aguardando_quem,
         ${overdueSql('d')} AS atrasada,
         (SELECT count(*)::int FROM public.demand_sector_links l WHERE l.demand_id = d.id) AS setores_colaboradores,
         (SELECT count(*) FILTER (WHERE t.status <> 'cancelada')::int FROM public.demand_subtasks t WHERE t.demand_id = d.id) AS etapas,
         (SELECT count(*) FILTER (WHERE t.status = 'concluida')::int FROM public.demand_subtasks t WHERE t.demand_id = d.id) AS etapas_concluidas
    FROM public.demands d
    LEFT JOIN public.demand_categories c ON c.id = d.categoria_id
    LEFT JOIN public.demand_sectors so ON so.id = d.setor_origem_id
    LEFT JOIN public.demand_sectors sr ON sr.id = d.setor_responsavel_id
    LEFT JOIN public.auth_users us ON us.id = d.solicitante_id
    LEFT JOIN public.auth_users ur ON ur.id = d.responsavel_id`

const emptyFilters: DemandFilters = {
  search: '',
  number: '',
  text: '',
  requester: '',
  statuses: [],
  priority: null,
  sectorId: null,
  responsibleId: null,
  categoryId: null,
  from: null,
  to: null,
  dueFrom: null,
  dueTo: null,
  recurring: null,
  shared: null,
  overdue: false,
  unassigned: false,
  scope: 'all',
}

const groupedRow = (row: { rotulo: string | null; total: number }, fallback: string) => ({
  label: row.rotulo ?? fallback,
  value: row.total,
})

export class DemandInsightsRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  private built(context: DemandContext, filters: Partial<DemandFilters>) {
    const builder = new FilterBuilder(context)
    applyDemandFilters(builder, { ...emptyFilters, ...filters }, context)
    return builder
  }

  private async counts(context: DemandContext, filters: Partial<DemandFilters>) {
    const builder = this.built(context, filters)
    const { rows } = await this.poolProvider().query<Record<string, number>>(
      `SELECT count(*) FILTER (WHERE d.status NOT IN ('concluida', 'cancelada'))::int AS abertas,
              count(*) FILTER (WHERE d.status = 'nao_iniciada')::int AS nao_iniciadas,
              count(*) FILTER (WHERE d.status = 'em_andamento')::int AS em_andamento,
              count(*) FILTER (WHERE d.status = 'aguardando_terceiros')::int AS aguardando_terceiros,
              count(*) FILTER (WHERE d.status = 'aguardando_autorizacao')::int AS aguardando_autorizacao,
              count(*) FILTER (WHERE d.status = 'suspensa')::int AS suspensas,
              count(*) FILTER (WHERE ${overdueSql('d')})::int AS atrasadas,
              count(*) FILTER (WHERE d.status = 'concluida')::int AS concluidas,
              count(*) FILTER (WHERE d.status = 'concluida'
                AND date_trunc('month', d.concluida_em AT TIME ZONE 'America/Sao_Paulo') = date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo'))::int AS concluidas_no_mes,
              count(*) FILTER (WHERE d.status = 'cancelada')::int AS canceladas,
              count(*) FILTER (WHERE d.responsavel_id IS NULL AND d.status NOT IN ('concluida', 'cancelada'))::int AS sem_responsavel,
              count(*)::int AS total,
              round(avg(extract(epoch FROM (d.concluida_em - d.data_abertura)) / 86400) FILTER (WHERE d.status = 'concluida')::numeric, 1)::float AS tempo_medio_dias,
              count(*) FILTER (WHERE d.series_id IS NOT NULL)::int AS recorrentes,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.demand_sector_links l WHERE l.demand_id = d.id))::int AS compartilhadas
         FROM public.demands d
        WHERE ${builder.sql}`,
      builder.values,
    )
    return rows[0]
  }

  private async grouped(context: DemandContext, filters: Partial<DemandFilters>, column: string, join: string) {
    const builder = this.built(context, filters)
    const { rows } = await this.poolProvider().query<{ rotulo: string | null; total: number; atrasadas: number; abertas: number }>(
      `SELECT ${column} AS rotulo, count(*)::int AS total,
              count(*) FILTER (WHERE ${overdueSql('d')})::int AS atrasadas,
              count(*) FILTER (WHERE d.status NOT IN ('concluida', 'cancelada'))::int AS abertas
         FROM public.demands d ${join}
        WHERE ${builder.sql}
        GROUP BY 1 ORDER BY total DESC, 1 LIMIT 30`,
      builder.values,
    )
    return rows
  }

  private async monthly(context: DemandContext, filters: Partial<DemandFilters>) {
    const builder = this.built(context, filters)
    const { rows } = await this.poolProvider().query<{ mes: string; abertas: number; concluidas: number }>(
      `WITH visiveis AS (SELECT d.data_abertura, d.concluida_em, d.status FROM public.demands d WHERE ${builder.sql}),
            meses AS (
              SELECT to_char(data_abertura AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS mes FROM visiveis
              UNION
              SELECT to_char(concluida_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') FROM visiveis WHERE status = 'concluida'
            )
       SELECT m.mes,
              (SELECT count(*)::int FROM visiveis v WHERE to_char(v.data_abertura AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') = m.mes) AS abertas,
              (SELECT count(*)::int FROM visiveis v WHERE v.status = 'concluida' AND to_char(v.concluida_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') = m.mes) AS concluidas
         FROM meses m ORDER BY m.mes DESC LIMIT 24`,
      builder.values,
    )
    return rows.reverse()
  }

  private async sample(context: DemandContext, filters: Partial<DemandFilters>, condition: string, order: string, limit = 8) {
    const builder = this.built(context, filters)
    builder.where(condition)
    const { rows } = await this.poolProvider().query(
      `${listSelect} WHERE ${builder.sql} ORDER BY ${order}, d.id LIMIT ${limit}`,
      builder.values,
    )
    return rows.map((row) => presentSummary(row as never))
  }

  async dashboard(context: DemandContext, filters: Partial<DemandFilters>) {
    const open = `d.status NOT IN ('concluida', 'cancelada')`
    const [totals, bySector, byResponsible, byStatus, monthly, dueSoon, overdue, priority, unassigned, waiting, updates, recurring] =
      await Promise.all([
        this.counts(context, filters),
        this.grouped(context, filters, 'sr.nome', 'LEFT JOIN public.demand_sectors sr ON sr.id = d.setor_responsavel_id'),
        this.grouped(context, filters, 'ur.full_name', 'LEFT JOIN public.auth_users ur ON ur.id = d.responsavel_id'),
        this.grouped(context, filters, 'd.status', ''),
        this.monthly(context, filters),
        this.sample(
          context,
          filters,
          `${open} AND d.status <> 'suspensa' AND d.prazo BETWEEN ${todaySql} AND ${todaySql} + 7`,
          'd.prazo',
        ),
        this.sample(context, filters, overdueSql('d'), 'd.prazo'),
        this.sample(context, filters, `${open} AND d.prioridade IN ('alta', 'urgente')`, `CASE d.prioridade WHEN 'urgente' THEN 0 ELSE 1 END, d.prazo ASC NULLS LAST`),
        this.sample(context, filters, `${open} AND d.responsavel_id IS NULL`, 'd.data_abertura DESC'),
        this.sample(context, filters, `d.status IN ('aguardando_terceiros', 'aguardando_autorizacao')`, 'd.prazo ASC NULLS LAST'),
        this.recentUpdates(context, filters),
        this.nextRecurring(context),
      ])
    return {
      totals,
      bySector: bySector.map((row) => groupedRow(row, 'Sem setor')),
      byResponsible: byResponsible.map((row) => groupedRow(row, 'Sem responsável')),
      byStatus: byStatus.map((row) => ({ status: row.rotulo, value: row.total })),
      monthly,
      dueSoon,
      overdue,
      priority,
      unassigned,
      waiting,
      updates,
      recurring,
    }
  }

  private async recentUpdates(context: DemandContext, filters: Partial<DemandFilters>) {
    const builder = this.built(context, filters)
    const { rows } = await this.poolProvider().query<{
      id: string
      acao: string
      created_at: Date
      usuario: string | null
      demand_id: string
      numero: string
      titulo: string
    }>(
      `SELECT h.id::text AS id, h.acao, h.created_at, u.full_name AS usuario,
              d.id::text AS demand_id, d.numero, d.titulo
         FROM public.demand_history h
         JOIN public.demands d ON d.id = h.demand_id
         LEFT JOIN public.auth_users u ON u.id = h.usuario_id
        WHERE ${builder.sql}
        ORDER BY h.created_at DESC, h.id DESC LIMIT 10`,
      builder.values,
    )
    return rows.map((row) => ({
      id: row.id,
      action: row.acao,
      at: row.created_at,
      user: row.usuario,
      demandId: row.demand_id,
      number: row.numero,
      title: row.titulo,
    }))
  }

  /** Só séries de que a pessoa vê ao menos uma ocorrência. */
  private async visibleSeries(context: DemandContext) {
    const visible = visibleDemandSql('vd', '$1::uuid', '$2')
    const { rows } = await this.poolProvider().query<SeriesRow>(
      `SELECT ${seriesColumns} FROM public.demand_series s
        WHERE s.status = 'ativa' AND s.proxima_execucao IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.demands vd WHERE vd.series_id = s.id AND ${visible})
        ORDER BY s.proxima_execucao`,
      [context.userId, visibilityLevel(context)],
    )
    return rows
  }

  private async nextRecurring(context: DemandContext) {
    const series = await this.visibleSeries(context)
    return series.slice(0, 8).map((row) => ({
      seriesId: row.id,
      title: row.modelo.title,
      nextDate: row.proxima_execucao as string,
      description: describeRule(ruleOf(row)),
      restricted: row.modelo.restricted,
    }))
  }

  async report(context: DemandContext, filters: DemandFilters) {
    const [totals, bySector, byResponsible, byCategory, byPriority, byStatus, monthly] = await Promise.all([
      this.counts(context, filters),
      this.grouped(context, filters, 'sr.nome', 'LEFT JOIN public.demand_sectors sr ON sr.id = d.setor_responsavel_id'),
      this.grouped(context, filters, 'ur.full_name', 'LEFT JOIN public.auth_users ur ON ur.id = d.responsavel_id'),
      this.grouped(context, filters, 'c.nome', 'LEFT JOIN public.demand_categories c ON c.id = d.categoria_id'),
      this.grouped(context, filters, 'd.prioridade', ''),
      this.grouped(context, filters, 'd.status', ''),
      this.monthly(context, filters),
    ])
    const present = (rows: Awaited<ReturnType<typeof this.grouped>>, fallback: string) =>
      rows.map((row) => ({ label: row.rotulo ?? fallback, total: row.total, open: row.abertas, overdue: row.atrasadas }))
    return {
      totals,
      bySector: present(bySector, 'Sem setor'),
      byResponsible: present(byResponsible, 'Sem responsável'),
      byCategory: present(byCategory, 'Sem categoria'),
      byPriority: present(byPriority, '—'),
      byStatus: present(byStatus, '—'),
      monthly,
    }
  }

  /** Linhas da exportação, com o mesmo filtro da tela. */
  async reportRows(context: DemandContext, filters: DemandFilters) {
    const builder = this.built(context, filters)
    const { rows } = await this.poolProvider().query(
      `${listSelect} WHERE ${builder.sql} ORDER BY d.data_abertura DESC, d.id LIMIT 5000`,
      builder.values,
    )
    return rows.map((row) => presentSummary(row as never))
  }

  async recordExport(identity: AuthenticatedIdentity, format: string) {
    await insertAuthAuditEvent(this.poolProvider(), {
      actorUserId: identity.userId,
      actorKind: 'user',
      subjectUserId: null,
      sessionId: null,
      eventType: 'demand_report_exported',
      details: { format },
    })
  }

  /**
   * Agenda: prazos, inícios previstos, etapas, datas futuras das séries e compromissos.
   * As datas futuras são uma previsão calculada, marcadas como tal.
   */
  async agenda(
    context: DemandContext,
    identity: AuthenticatedIdentity,
    input: { from: string; to: string; scope: 'individual' | 'sector' | 'all'; sectorId: string | null; responsibleId: string | null },
  ) {
    const pool = this.poolProvider()
    const filters: Partial<DemandFilters> = {
      sectorId: input.sectorId,
      responsibleId: input.responsibleId,
      scope: input.scope === 'individual' ? 'mine' : input.scope === 'sector' && !input.sectorId ? 'sector' : 'all',
    }
    const builder = this.built(context, filters)
    const fromParam = builder.add(input.from)
    const toParam = builder.add(input.to)

    const [demands, subtasks, events, series] = await Promise.all([
      pool.query<{
        id: string
        numero: string
        titulo: string
        status: string
        prazo: string | null
        inicio_previsto: string | null
        atrasada: boolean
        setor: string | null
        responsavel: string | null
        series_id: string | null
      }>(
        `SELECT d.id::text AS id, d.numero, d.titulo, d.status, d.prazo::text AS prazo,
                d.inicio_previsto::text AS inicio_previsto, ${overdueSql('d')} AS atrasada,
                sr.nome AS setor, ur.full_name AS responsavel, d.series_id::text AS series_id
           FROM public.demands d
           LEFT JOIN public.demand_sectors sr ON sr.id = d.setor_responsavel_id
           LEFT JOIN public.auth_users ur ON ur.id = d.responsavel_id
          WHERE ${builder.sql}
            AND (d.prazo BETWEEN ${fromParam}::date AND ${toParam}::date
                 OR d.inicio_previsto BETWEEN ${fromParam}::date AND ${toParam}::date)
          LIMIT 1000`,
        builder.values,
      ),
      pool.query<{ id: string; titulo: string; prazo: string; status: string; demand_id: string; numero: string; atrasada: boolean; setor: string | null; responsavel: string | null }>(
        `SELECT t.id::text AS id, t.titulo, t.prazo::text AS prazo, t.status, d.id::text AS demand_id, d.numero,
                t.prazo < ${todaySql} AND t.status NOT IN ('concluida', 'cancelada') AS atrasada,
                sr.nome AS setor, ut.full_name AS responsavel
           FROM public.demand_subtasks t
           JOIN public.demands d ON d.id = t.demand_id
           LEFT JOIN public.demand_sectors sr ON sr.id = d.setor_responsavel_id
           LEFT JOIN public.auth_users ut ON ut.id = t.responsavel_id
          WHERE ${builder.sql} AND t.prazo BETWEEN ${fromParam}::date AND ${toParam}::date
            AND d.status <> 'cancelada'
            ${input.scope === 'individual' ? 'AND t.responsavel_id = $1::uuid' : ''}
          LIMIT 1000`,
        builder.values,
      ),
      this.agendaEvents(context, input),
      this.visibleSeries(context),
    ])

    const registered = await pool.query<{ series_id: string; data: string }>(
      `SELECT series_id::text AS series_id, data_prevista::text AS data
         FROM public.demand_series_occurrences WHERE series_id = ANY($1::uuid[])`,
      [series.map((row) => row.id)],
    )
    const links = await pool.query<{ demand_id: string; modulo: string; recurso_id: string; protocolo: string }>(
      `SELECT demand_id::text AS demand_id, modulo, recurso_id::text AS recurso_id, protocolo
         FROM public.demand_links WHERE demand_id = ANY($1::uuid[]) AND removido_em IS NULL`,
      [demands.rows.map((row) => row.id)],
    )
    const originsOf = (demandId: string) =>
      links.rows
        .filter((link) => link.demand_id === demandId)
        .map((link) => ({
          module: link.modulo,
          protocol: link.protocolo,
          path: identity.permissions.includes(`${link.modulo}:read` as never)
            ? resourcePath(link.modulo as 'maintenance', link.recurso_id)
            : null,
        }))

    const today = todayInSaoPaulo()
    const soon = (date: string, closed: boolean) => !closed && date >= today && date <= shift(today, 3)

    const items = [
      ...demands.rows.flatMap((row) => {
        const closed = row.status === 'concluida' || row.status === 'cancelada'
        const common = {
          demandId: row.id,
          number: row.numero,
          title: row.titulo,
          status: row.status,
          sector: row.setor,
          responsible: row.responsavel,
          recurring: Boolean(row.series_id),
          origins: originsOf(row.id),
        }
        const entries = []
        if (row.prazo && row.prazo >= input.from && row.prazo <= input.to) {
          entries.push({ ...common, key: `prazo:${row.id}`, kind: 'prazo', date: row.prazo, overdue: row.atrasada === true, dueSoon: soon(row.prazo, closed), done: row.status === 'concluida' })
        }
        if (row.inicio_previsto && row.inicio_previsto >= input.from && row.inicio_previsto <= input.to) {
          entries.push({ ...common, key: `inicio:${row.id}`, kind: 'inicio', date: row.inicio_previsto, overdue: false, dueSoon: false, done: closed })
        }
        return entries
      }),
      ...subtasks.rows.map((row) => ({
        key: `etapa:${row.id}`,
        kind: 'etapa',
        date: row.prazo,
        demandId: row.demand_id,
        number: row.numero,
        title: row.titulo,
        status: row.status,
        sector: row.setor,
        responsible: row.responsavel,
        recurring: false,
        origins: [],
        overdue: row.atrasada === true,
        dueSoon: soon(row.prazo, row.status === 'concluida' || row.status === 'cancelada'),
        done: row.status === 'concluida',
      })),
      ...this.projected(series, registered.rows, context, input),
      ...events,
    ]
    items.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, 'pt-BR'))
    return items
  }

  private projected(
    series: readonly SeriesRow[],
    registered: readonly { series_id: string; data: string }[],
    context: DemandContext,
    input: { from: string; to: string; scope: string; sectorId: string | null; responsibleId: string | null },
  ) {
    return series.flatMap((row) => {
      const template = row.modelo
      if (input.sectorId && ![template.responsibleSectorId, template.originSectorId, ...template.collaboratorSectorIds].includes(input.sectorId)) {
        return []
      }
      if (input.responsibleId && template.responsibleId !== input.responsibleId) return []
      if (input.scope === 'individual' && template.responsibleId !== context.userId && !template.collaborators.some((item) => item.userId === context.userId)) {
        return []
      }
      // Só o que ainda vai acontecer: data gerada já aparece como prazo, e data pulada não existe mais.
      const known = registered.filter((item) => item.series_id === row.id).map((item) => item.data)
      return projectDates(row, known, 200, input.to)
        .filter((date) => date >= input.from)
        .map((date) => ({
          key: `recorrencia:${row.id}:${date}`,
          kind: 'recorrencia',
          date,
          demandId: null,
          number: null,
          title: template.title,
          status: 'prevista',
          sector: null,
          responsible: null,
          recurring: true,
          origins: [],
          overdue: false,
          dueSoon: false,
          done: false,
        }))
    })
  }

  private async agendaEvents(
    context: DemandContext,
    input: { from: string; to: string; scope: string; sectorId: string | null },
  ) {
    const visible = visibleDemandSql('vd', '$1::uuid', '$2')
    const { rows } = await this.poolProvider().query<{
      id: string
      tipo: string
      titulo: string
      descricao: string | null
      inicio: Date
      fim: Date | null
      data: string
      setor: string | null
      demand_id: string | null
      criado_por: string
      autor: string
    }>(
      `SELECT e.id::text AS id, e.tipo, e.titulo, e.descricao, e.inicio, e.fim,
              to_char(e.inicio AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS data,
              s.nome AS setor, e.demand_id::text AS demand_id, e.criado_por::text AS criado_por, u.full_name AS autor
         FROM public.demand_agenda_events e
         LEFT JOIN public.demand_sectors s ON s.id = e.setor_id
         JOIN public.auth_users u ON u.id = e.criado_por
        WHERE e.cancelado_em IS NULL
          AND (e.inicio AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $3::date AND $4::date
          AND ($5::uuid IS NULL OR e.setor_id = $5::uuid)
          AND ($6::boolean IS FALSE OR e.criado_por = $1::uuid)
          AND (
            (e.demand_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.demands vd WHERE vd.id = e.demand_id AND ${visible}))
            OR (e.demand_id IS NULL AND (
              e.criado_por = $1::uuid OR $2::int >= 1
              OR EXISTS (SELECT 1 FROM public.demand_sector_members m
                          WHERE m.user_id = $1::uuid AND m.ativo AND m.sector_id = e.setor_id)
            ))
          )
        LIMIT 1000`,
      [context.userId, visibilityLevel(context), input.from, input.to, input.sectorId, input.scope === 'individual'],
    )
    const led = new Set(context.memberships.filter((item) => item.role === 'responsavel').map((item) => item.sectorName))
    return rows.map((row) => ({
      key: `evento:${row.id}`,
      kind: row.tipo,
      eventId: row.id,
      date: row.data,
      start: row.inicio,
      end: row.fim,
      description: row.descricao,
      demandId: row.demand_id,
      number: null,
      title: row.titulo,
      status: 'programado',
      sector: row.setor,
      responsible: row.autor,
      recurring: false,
      origins: [],
      overdue: false,
      dueSoon: false,
      done: false,
      canCancel: canCreateAgendaEvents(context) && (row.criado_por === context.userId || context.directorate || (row.setor !== null && led.has(row.setor))),
    }))
  }

  async createEvent(
    identity: AuthenticatedIdentity,
    context: DemandContext,
    input: {
      kind: string
      title: string
      description: string | null
      start: Date
      end: Date | null
      sectorId: string | null
      demandId: string | null
    },
  ) {
    if (!canCreateAgendaEvents(context)) throw new ModuleError('Somente Chefe e Diretor criam compromissos.', 403)
    if (input.sectorId && !context.directorate && !context.memberships.some((item) => item.role === 'responsavel' && item.sectorId === input.sectorId)) {
      throw new ModuleError('Você só pode criar compromissos do setor que chefia.', 403)
    }
    return withTransaction(this.poolProvider(), async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO public.demand_agenda_events (tipo, titulo, descricao, inicio, fim, setor_id, demand_id, criado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text AS id`,
        [input.kind, redactOptional(input.title), redactOptional(input.description), input.start, input.end, input.sectorId, input.demandId, identity.userId],
      )
      await auditAgendaChange(client, identity.userId, rows[0].id, 'compromisso criado')
      return rows[0].id
    })
  }

  async cancelEvent(identity: AuthenticatedIdentity, context: DemandContext, eventId: string) {
    const led = context.memberships.filter((item) => item.role === 'responsavel').map((item) => item.sectorId)
    return withTransaction(this.poolProvider(), async (client) => {
      const { rowCount } = await client.query(
        `UPDATE public.demand_agenda_events SET cancelado_em = now(), cancelado_por = $2
          WHERE id = $1 AND cancelado_em IS NULL AND ($4::boolean OR criado_por = $2 OR setor_id = ANY($3::uuid[]))`,
        [eventId, identity.userId, led, context.directorate],
      )
      if (rowCount) await auditAgendaChange(client, identity.userId, eventId, 'compromisso cancelado')
      return Boolean(rowCount)
    })
  }
}

/** Na mesma transação da alteração, como nas demandas. O título é texto livre e não entra na auditoria. */
function auditAgendaChange(client: Client, userId: string, eventId: string, alteracao: string) {
  return insertAuthAuditEvent(client, {
    actorUserId: userId,
    actorKind: 'user',
    subjectUserId: null,
    sessionId: eventId,
    eventType: 'demand_changed',
    details: { alteracao },
  })
}

function shift(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Alertas de prazo. A chave inclui o prazo: alterar a data gera um novo aviso, e repetir não.
// ---------------------------------------------------------------------------
export async function publishDeadlineAlerts(poolProvider: () => Pool = getDatabasePool) {
  const pool = poolProvider()
  const { rows } = await pool.query<{
    id: string
    numero: string
    titulo: string
    restrita: boolean
    prazo: string
    dias: number
    lembrete_dias: number | null
    responsavel_id: string | null
    setor_responsavel_id: string | null
  }>(
    `SELECT d.id::text AS id, d.numero, d.titulo, d.restrita, d.prazo::text AS prazo,
            d.prazo - ${todaySql} AS dias, d.lembrete_dias, d.responsavel_id::text AS responsavel_id,
            d.setor_responsavel_id::text AS setor_responsavel_id
       FROM public.demands d
      WHERE d.excluida_em IS NULL AND NOT d.rascunho AND d.prazo IS NOT NULL
        AND d.status NOT IN ('concluida', 'cancelada', 'suspensa')
        AND d.prazo <= ${todaySql} + 60
      ORDER BY d.prazo
      LIMIT 2000`,
  )
  let sent = 0
  for (const row of rows) {
    await withTransaction(pool, async (client) => {
      const recipients = await deadlineRecipients(client, row)
      if (recipients.length === 0) return
      const demand = { id: row.id, number: row.numero, title: row.titulo, restricted: row.restrita }
      if (row.dias < 0) {
        await notifyDemand(client, {
          kind: 'atraso',
          key: `${row.id}:atraso:${row.prazo}`,
          demand,
          recipients: recipients.map((item) => item.id),
          actorId: null,
        })
        sent += 1
        return
      }
      const due = recipients.filter((item) => row.dias <= (row.lembrete_dias ?? item.reminderDays))
      if (due.length > 0) {
        await notifyDemand(client, {
          kind: 'prazo_proximo',
          key: `${row.id}:proximo:${row.prazo}`,
          demand,
          recipients: due.map((item) => item.id),
          actorId: null,
        })
        sent += 1
      }
    })
  }
  return sent
}

async function deadlineRecipients(
  client: Client,
  row: { id: string; responsavel_id: string | null; setor_responsavel_id: string | null },
) {
  const { rows } = await client.query<{ id: string; lembrete_dias: number | null }>(
    `WITH pessoas AS (
       SELECT $2::uuid AS id WHERE $2::uuid IS NOT NULL
       UNION SELECT p.user_id FROM public.demand_participants p WHERE p.demand_id = $1 AND p.tipo = 'colaborador'
       -- Sem responsável, quem precisa saber é quem distribui.
       UNION SELECT m.user_id FROM public.demand_sector_members m
              WHERE $2::uuid IS NULL AND m.sector_id = $3 AND m.ativo AND m.papel = 'responsavel'
     )
     SELECT pessoas.id::text AS id, pref.lembrete_dias
       FROM pessoas
       LEFT JOIN public.demand_notification_preferences pref ON pref.user_id = pessoas.id`,
    [row.id, row.responsavel_id, row.setor_responsavel_id],
  )
  return rows.map((item) => ({ id: item.id, reminderDays: item.lembrete_dias ?? 3 }))
}
