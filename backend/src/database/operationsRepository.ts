import type { Pool } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import type { RequestModule } from '../auth/requestPolicy.js'
import { eventCatalog, isEventType } from '../integrations/catalog.js'
import { publishIntegrationEvent } from '../integrations/publisher.js'
import { maskCpfLike } from '../requests/changeRules.js'
import { likePattern } from '../requests/validation.js'
import { moduleTypes, normalizedStatusSql, normalizeStatus } from '../requests/workflow.js'
import type { RequestStatus } from '../requests/workflow.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { conflict, ModuleError, notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { protocolSql } from './protocolSql.js'
import { assertAssignable, assignableCondition, recordHistory } from './serviceRequestRepository.js'
import { readSystemSettings } from './settingsRepository.js'
import { withTransaction } from './withTransaction.js'

/**
 * Central de Operações da SLM. As rotas exigem a permissão da Central e requests:read_all; aqui,
 * cada consulta fica restrita aos módulos que a pessoa pode ler. Nenhuma lê passageiros ou CPF.
 */

const pageSize = 25
const requestModules: RequestModule[] = ['maintenance', 'fleet', 'flights']
const moduleByType = Object.fromEntries(
  Object.entries(moduleTypes).map(([module, type]) => [type, module]),
) as Record<string, RequestModule>

const status = normalizedStatusSql('r')
const closed = `(${status}) IN ('concluido', 'cancelado', 'emitida', 'cancelada')`
const open = `NOT ${closed}`
// Aguardando o solicitante, com a condição registrada, não é atraso interno. O tempo dessa espera
// também é somado ao prazo. Por to_jsonb, a consulta funciona em um banco sem a migração 012.
const waitingRequester = `((to_jsonb(r)->>'aguardando_externo_desde') IS NOT NULL)`
const effectiveDeadline = `(r.prazo_em + make_interval(secs => COALESCE((to_jsonb(r)->>'espera_externa_segundos')::int, 0)))`
const late = `(${open} AND NOT ${waitingRequester} AND (${effectiveDeadline} < now() OR ((${status}) IN ('agendado', 'reagendado') AND r.data_agendada < now())))`
const nearDue = `(${open} AND NOT ${waitingRequester} AND ${effectiveDeadline} >= now() AND ${effectiveDeadline} < now() + make_interval(days => $NEAR))`

// Os mesmos critérios nos indicadores e na lista: o número do cartão é o que a lista mostra.
const today = `(${open} AND r.data_agendada >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
  AND r.data_agendada < (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') + interval '1 day') AT TIME ZONE 'America/Sao_Paulo')`

export const queues = {
  awaiting_service: `(${status}) IN ('agendado', 'reagendado', 'em_cotacao')`,
  awaiting_schedule: `(${status}) = 'aguardando_agendamento'`,
  today,
  late,
  approval: `(${status}) = 'aguardando_aprovacao'`,
  unassigned: `(${open} AND r.responsavel_id IS NULL)`,
  in_progress: `(${status}) IN ('em_andamento', 'em_emissao')`,
  concluded: `(${status}) IN ('concluido', 'emitida')`,
  cancelled: `(${status}) IN ('cancelado', 'cancelada')`,
  stale: `(${open} AND NOT ${waitingRequester} AND r.updated_at < now() - make_interval(days => $STALE))`,
  near_due: nearDue,
  awaiting_requester: `(${open} AND ${waitingRequester})`,
  awaiting_internal: `(${open} AND NOT ${waitingRequester})`,
} as const

/** Os limites entram como parâmetros fixos: $2 para parada e $3 para a antecedência do alerta. */
function withLimits(condition: string) {
  return condition.replace('$STALE', '$2').replace('$NEAR', '$3')
}

export type QueueKey = keyof typeof queues

export function isQueueKey(value: unknown): value is QueueKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(queues, value)
}

const priorityOrder = `CASE r.prioridade WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`

export type CentralFilters = {
  queue?: QueueKey
  module?: RequestModule
  sectorId?: string
  responsibleId?: string
  status?: RequestStatus
  from?: Date | null
  to?: Date | null
  search?: string
  page: number
}

function readableTypes(identity: AuthenticatedIdentity, module?: RequestModule) {
  return requestModules
    .filter((item) => identity.permissions.includes(`${item}:read`) && (!module || module === item))
    .map((item) => moduleTypes[item])
}

function moduleFromTipo(tipo: string): RequestModule {
  return moduleByType[tipo]
}

export class OperationsRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  private async staleDays() {
    return (await readSystemSettings(this.poolProvider())).operations.staleDays
  }

  async overview(identity: AuthenticatedIdentity) {
    const pool = this.poolProvider()
    const staleDays = await this.staleDays()
    const warningDays = (await readSystemSettings(pool)).deadlines.warningDays
    const types = readableTypes(identity)

    const counts = await pool.query<Record<QueueKey, number>>(
      `SELECT ${Object.entries(queues)
        .map(([key, condition]) => `count(*) FILTER (WHERE ${withLimits(condition)})::int AS ${key}`)
        .join(', ')}
         FROM public.service_requests r
        WHERE r.tipo = ANY($1)`,
      [types, staleDays, warningDays],
    )

    // Tempos separados, das solicitações concluídas nos últimos 90 dias.
    const paused = `COALESCE((to_jsonb(r)->>'espera_externa_segundos')::int, 0)`
    const total = `extract(epoch FROM r.concluida_em - r.created_at)`
    const timing = await pool.query<{ espera: string | null; interno: string | null; total: string | null; base: number }>(
      `SELECT avg(${paused}) AS espera, avg(GREATEST(0, ${total} - ${paused})) AS interno,
              avg(${total}) AS total, count(*)::int AS base
         FROM public.service_requests r
        WHERE r.tipo = ANY($1) AND r.concluida_em IS NOT NULL
          AND r.concluida_em > now() - interval '90 days'`,
      [types],
    )

    const byModule = await pool.query<{ tipo: string; abertas: number; total: number }>(
      `SELECT r.tipo, count(*) FILTER (WHERE ${open})::int AS abertas, count(*)::int AS total
         FROM public.service_requests r
        WHERE r.tipo = ANY($1)
        GROUP BY r.tipo`,
      [types],
    )
    const bySector = await pool.query<{ setor: string | null; abertas: number }>(
      `SELECT r.setor_nome AS setor, count(*)::int AS abertas
         FROM public.service_requests r
        WHERE r.tipo = ANY($1) AND ${open}
        GROUP BY 1
        ORDER BY 2 DESC, 1
        LIMIT 15`,
      [types],
    )

    return {
      counts: counts.rows[0],
      staleDays,
      warningDays,
      timing: {
        basedOn: timing.rows[0].base,
        requesterWaitSeconds: timing.rows[0].espera === null ? null : Math.round(Number(timing.rows[0].espera)),
        internalSeconds: timing.rows[0].interno === null ? null : Math.round(Number(timing.rows[0].interno)),
        totalSeconds: timing.rows[0].total === null ? null : Math.round(Number(timing.rows[0].total)),
      },
      byModule: byModule.rows.map((row) => ({
        module: moduleFromTipo(row.tipo),
        open: row.abertas,
        total: row.total,
      })),
      bySector: bySector.rows.map((row) => ({ sector: row.setor ?? 'Não informado', open: row.abertas })),
      communications: await this.communicationAlerts(),
      warehouse: identity.permissions.includes('warehouse:read') ? await this.warehouseCounts() : null,
    }
  }

  /** Só totais: quem precisa dos detalhes abre a tela de Integrações, com permissão própria. */
  private async communicationAlerts() {
    const pool = this.poolProvider()
    const present = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.email_deliveries') IS NOT NULL AS present`,
    )
    if (!present.rows[0]?.present) return null

    const result = await pool.query<{
      emails_pendentes: number
      emails_falhos: number
      emails_sem_servico: number
      agenda_falhas: number
    }>(
      `SELECT (SELECT count(*)::int FROM public.email_deliveries WHERE status IN ('pending', 'sending')) AS emails_pendentes,
              (SELECT count(*)::int FROM public.email_deliveries WHERE status = 'failed') AS emails_falhos,
              (SELECT count(*)::int FROM public.email_deliveries WHERE status = 'not_configured') AS emails_sem_servico,
              (SELECT count(*)::int FROM public.calendar_sync_items WHERE status = 'failed') AS agenda_falhas`,
    )
    const row = result.rows[0]
    return {
      emailsPending: row.emails_pendentes,
      emailsFailed: row.emails_falhos,
      emailsNotConfigured: row.emails_sem_servico,
      calendarFailed: row.agenda_falhas,
    }
  }

  private async warehouseCounts() {
    const result = await this.poolProvider().query<{ abertos: number }>(
      `SELECT count(*)::int AS abertos FROM public.material_requests
        WHERE status IN ('pendente', 'em_analise', 'atendido_parcial', 'atendido')`,
    )
    return { openRequests: result.rows[0].abertos }
  }

  async list(identity: AuthenticatedIdentity, filters: CentralFilters) {
    const staleDays = await this.staleDays()
    const warningDays = (await readSystemSettings(this.poolProvider())).deadlines.warningDays
    const parameters: unknown[] = [readableTypes(identity, filters.module), staleDays, warningDays]
    // $2 e $3 entram sempre: a contagem usa a mesma lista de parâmetros, com ou sem esses filtros.
    const conditions = ['r.tipo = ANY($1)', '$2::int IS NOT NULL', '$3::int IS NOT NULL']
    const bind = (value: unknown) => {
      parameters.push(value)
      return `$${parameters.length}`
    }

    if (filters.queue) conditions.push(withLimits(queues[filters.queue]))
    if (filters.sectorId) conditions.push(`r.setor_id = ${bind(filters.sectorId)}`)
    if (filters.responsibleId) conditions.push(`r.responsavel_id = ${bind(filters.responsibleId)}`)
    if (filters.status) {
      conditions.push(`(${status}) = ${bind(filters.status)}`)
    }
    if (filters.from) conditions.push(`r.created_at >= ${bind(filters.from)}`)
    if (filters.to) conditions.push(`r.created_at <= ${bind(filters.to)}`)
    if (filters.search) {
      const pattern = bind(likePattern(filters.search))
      conditions.push(
        `(${protocolSql('r')} ILIKE ${pattern} OR r.protocolo::text ILIKE ${pattern}
          OR r.titulo ILIKE ${pattern} OR solicitante.full_name ILIKE ${pattern}
          OR r.setor_nome ILIKE ${pattern})`,
      )
    }

    const from = `FROM public.service_requests r
      JOIN public.auth_users solicitante ON solicitante.id = r.solicitante_id
      LEFT JOIN public.auth_users responsavel ON responsavel.id = r.responsavel_id
      WHERE ${conditions.join(' AND ')}`

    const pool = this.poolProvider()
    const [rows, total] = await Promise.all([
      pool.query<{
        id: string
        protocolo: string
        tipo: string
        status: string
        titulo: string
        solicitante: string
        setor_nome: string | null
        responsavel_id: string | null
        responsavel: string | null
        prioridade: string
        complexidade: string | null
        prazo_em: Date | null
        data_agendada: Date | null
        created_at: Date
        updated_at: Date
        atrasada: boolean
        parada: boolean
        proxima: boolean
        aguardando: boolean
      }>(
        `SELECT r.id::text AS id, ${protocolSql('r')} AS protocolo, r.tipo, r.status, r.titulo,
                solicitante.full_name AS solicitante, r.setor_nome,
                r.responsavel_id::text AS responsavel_id, responsavel.full_name AS responsavel,
                r.prioridade, r.complexidade, r.prazo_em, r.data_agendada, r.created_at, r.updated_at,
                ${late} AS atrasada,
                ${withLimits(queues.stale)} AS parada,
                ${withLimits(nearDue)} AS proxima,
                ${waitingRequester} AS aguardando
           ${from}
          ORDER BY ${open} DESC, ${late} DESC, ${priorityOrder}, r.prazo_em NULLS LAST, r.created_at
          LIMIT ${pageSize} OFFSET ${(filters.page - 1) * pageSize}`,
        parameters,
      ),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total ${from}`, parameters),
    ])

    return {
      requests: rows.rows.map((row) => {
        const module = moduleFromTipo(row.tipo)
        return {
          id: row.id,
          protocol: row.protocolo,
          module,
          status: normalizeStatus(module, row.status),
          title: row.titulo,
          requester: row.solicitante,
          sector: row.setor_nome,
          responsibleId: row.responsavel_id,
          responsible: row.responsavel,
          priority: row.prioridade,
          complexity: row.complexidade,
          deadline: row.prazo_em,
          scheduledAt: row.data_agendada,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          late: row.atrasada,
          stale: row.parada,
          nearDue: row.proxima,
          waitingRequester: row.aguardando,
        }
      }),
      total: total.rows[0].total,
      page: filters.page,
      pageSize,
    }
  }

  /**
   * Carga da equipe. Mostra volume e complexidade lado a lado, sem nota nem classificação:
   * um atendimento complexo não vale o mesmo que um simples, e o painel não finge que vale.
   */
  async team(identity: AuthenticatedIdentity) {
    const types = readableTypes(identity)
    const result = await this.poolProvider().query<{
      id: string
      full_name: string
      abertas: number
      atrasadas: number
      em_andamento: number
      urgentes: number
      concluidas_30d: number
      simples: number
      media: number
      complexa: number
      sem_classificacao: number
    }>(
      `SELECT u.id::text AS id, u.full_name,
              count(r.id) FILTER (WHERE ${open})::int AS abertas,
              count(r.id) FILTER (WHERE ${late})::int AS atrasadas,
              count(r.id) FILTER (WHERE (${status}) IN ('em_andamento', 'em_emissao'))::int AS em_andamento,
              count(r.id) FILTER (WHERE ${open} AND r.prioridade = 'urgente')::int AS urgentes,
              count(r.id) FILTER (WHERE (${status}) IN ('concluido', 'emitida')
                                    AND r.concluida_em >= now() - interval '30 days')::int AS concluidas_30d,
              count(r.id) FILTER (WHERE ${open} AND r.complexidade = 'simples')::int AS simples,
              count(r.id) FILTER (WHERE ${open} AND r.complexidade = 'media')::int AS media,
              count(r.id) FILTER (WHERE ${open} AND r.complexidade = 'complexa')::int AS complexa,
              count(r.id) FILTER (WHERE ${open} AND r.complexidade IS NULL)::int AS sem_classificacao
         FROM public.auth_users u
         LEFT JOIN public.auth_user_access a ON a.user_id = u.id
         LEFT JOIN public.service_requests r ON r.responsavel_id = u.id AND r.tipo = ANY($1)
        WHERE ${assignableCondition}
        GROUP BY u.id, u.full_name
        ORDER BY lower(u.full_name)`,
      [types],
    )
    return result.rows.map((row) => ({
      id: row.id,
      name: row.full_name,
      open: row.abertas,
      late: row.atrasadas,
      inProgress: row.em_andamento,
      urgent: row.urgentes,
      concluded30d: row.concluidas_30d,
      complexity: {
        simple: row.simples,
        medium: row.media,
        complex: row.complexa,
        unclassified: row.sem_classificacao,
      },
    }))
  }

  /** Bloqueia a linha, para duas pessoas não redistribuírem a partir do mesmo estado. */
  private async lock(
    client: Parameters<Parameters<typeof withTransaction>[1]>[0],
    identity: AuthenticatedIdentity,
    id: string,
  ) {
    const result = await client.query<{
      tipo: string
      status: string
      solicitante_id: string
      titulo: string
      protocolo: string
      responsavel_id: string | null
      prioridade: string
      prazo_em: Date | null
      complexidade: string | null
    }>(
      `SELECT r.tipo, r.status, r.solicitante_id::text AS solicitante_id, r.titulo,
              ${protocolSql('r')} AS protocolo, r.responsavel_id::text AS responsavel_id,
              r.prioridade, r.prazo_em, r.complexidade
         FROM public.service_requests r
        WHERE r.id = $1 AND r.tipo = ANY($2)
        FOR UPDATE`,
      [id, readableTypes(identity)],
    )
    const row = result.rows[0]
    if (!row) throw notFound()
    const module = moduleFromTipo(row.tipo)
    const normalized = normalizeStatus(module, row.status)
    if (['concluido', 'cancelado', 'emitida', 'cancelada'].includes(normalized)) {
      throw conflict('Solicitações encerradas não podem ser alteradas.')
    }
    return { ...row, module, status: normalized }
  }

  async assign(
    actor: AuthenticatedIdentity,
    id: string,
    input: { responsibleId: string | null; justification: string | null },
  ) {
    await withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lock(client, actor, id)
      if (current.responsavel_id === input.responsibleId) return

      // A primeira atribuição é rotina; transferir ou retirar precisa de motivo.
      if (current.responsavel_id && !input.justification) {
        throw new ModuleError('Informe a justificativa da mudança de responsável.', 400)
      }
      if (input.responsibleId) await assertAssignable(client, input.responsibleId)

      const names = await client.query<{ id: string; full_name: string }>(
        `SELECT id::text AS id, full_name FROM public.auth_users WHERE id = ANY($1::uuid[])`,
        [[current.responsavel_id, input.responsibleId].filter(Boolean)],
      )
      const nameOf = (userId: string | null) =>
        names.rows.find((row) => row.id === userId)?.full_name ?? null

      await client.query(
        `UPDATE public.service_requests SET responsavel_id = $2, atribuida_em = now() WHERE id = $1`,
        [id, input.responsibleId],
      )
      const entry = {
        requestId: id,
        userId: actor.userId,
        action: 'responsavel_alterado',
        from: current.status,
        to: current.status,
        comment: input.justification,
        details: {
          alteracoes: [
            { campo: 'Responsável', de: nameOf(current.responsavel_id), para: nameOf(input.responsibleId) },
          ],
        },
      }
      await recordHistory(client, entry)
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: input.responsibleId,
        sessionId: id,
        eventType: 'request_assigned',
        details: { module: current.module, transfer: current.responsavel_id ? 'true' : 'false' },
      })
      if (input.responsibleId) {
        await publishIntegrationEvent(client, {
          type: 'request_assigned',
          key: `${id}:assign:${input.responsibleId}:${Date.now()}`,
          module: current.module,
          resourceId: id,
          protocol: current.protocolo,
          actorId: actor.userId,
          responsibleId: input.responsibleId,
        })
      }
      // Transferência ou retirada: quem deixou de ser responsável também é avisado.
      if (current.responsavel_id) {
        await publishIntegrationEvent(client, {
          type: 'request_unassigned',
          key: `${id}:unassign:${current.responsavel_id}:${Date.now()}`,
          module: current.module,
          resourceId: id,
          protocol: current.protocolo,
          actorId: actor.userId,
          responsibleId: current.responsavel_id,
        })
      }
    })
  }

  async setPriority(actor: AuthenticatedIdentity, id: string, priority: string, justification: string) {
    await withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lock(client, actor, id)
      if (current.prioridade === priority) return

      await client.query(`UPDATE public.service_requests SET prioridade = $2 WHERE id = $1`, [id, priority])
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'prioridade_alterada',
        from: current.status,
        to: current.status,
        comment: justification,
        details: { alteracoes: [{ campo: 'Prioridade', de: current.prioridade, para: priority }] },
      })
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: current.solicitante_id,
        sessionId: id,
        eventType: 'request_priority_changed',
        details: { module: current.module, from: current.prioridade, to: priority },
      })
    })
  }

  async setDeadline(
    actor: AuthenticatedIdentity,
    id: string,
    deadline: Date | null,
    justification: string | null,
  ) {
    await withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lock(client, actor, id)
      if ((current.prazo_em?.getTime() ?? null) === (deadline?.getTime() ?? null)) return
      if (current.prazo_em && !justification) {
        throw new ModuleError('Informe a justificativa da mudança de prazo.', 400)
      }

      await client.query(`UPDATE public.service_requests SET prazo_em = $2 WHERE id = $1`, [id, deadline])
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'prazo_alterado',
        from: current.status,
        to: current.status,
        comment: justification,
        details: {
          alteracoes: [
            { campo: 'Prazo', de: current.prazo_em?.toISOString() ?? null, para: deadline?.toISOString() ?? null },
          ],
        },
      })
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: current.solicitante_id,
        sessionId: id,
        eventType: 'request_deadline_changed',
        details: { module: current.module },
      })
    })
  }

  async setComplexity(actor: AuthenticatedIdentity, id: string, complexity: string | null) {
    await withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lock(client, actor, id)
      if (current.complexidade === complexity) return

      await client.query(`UPDATE public.service_requests SET complexidade = $2 WHERE id = $1`, [id, complexity])
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'complexidade_alterada',
        from: current.status,
        to: current.status,
        details: { alteracoes: [{ campo: 'Complexidade', de: current.complexidade, para: complexity }] },
      })
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: current.solicitante_id,
        sessionId: id,
        eventType: 'request_complexity_changed',
        details: { module: current.module },
      })
    })
  }

  // -------------------------------------------------------------------------
  // Observações internas
  // -------------------------------------------------------------------------
  async addNote(actor: AuthenticatedIdentity, id: string, text: string) {
    await withTransaction(this.poolProvider(), async (client) => {
      const found = await client.query<{ tipo: string; status: string; solicitante_id: string }>(
        `SELECT tipo, status, solicitante_id::text AS solicitante_id
           FROM public.service_requests WHERE id = $1 AND tipo = ANY($2) FOR UPDATE`,
        [id, readableTypes(actor)],
      )
      const current = found.rows[0]
      if (!current) throw notFound()

      await client.query(
        `INSERT INTO public.request_internal_notes (request_id, autor_id, texto) VALUES ($1, $2, $3)`,
        [id, actor.userId, maskCpfLike(text)],
      )
      // A linha do tempo registra o fato. O texto fica só na observação, com acesso restrito.
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'nota_interna',
        from: current.status,
        to: current.status,
      })
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: current.solicitante_id,
        sessionId: id,
        eventType: 'request_note_added',
        details: { module: moduleFromTipo(current.tipo) },
      })
    })
  }

  async notes(id: string) {
    const result = await this.poolProvider().query<{
      id: string
      texto: string
      autor: string
      created_at: Date
    }>(
      `SELECT n.id::text AS id, n.texto, u.full_name AS autor, n.created_at
         FROM public.request_internal_notes n
         JOIN public.auth_users u ON u.id = n.autor_id
        WHERE n.request_id = $1
        ORDER BY n.created_at, n.id`,
      [id],
    )
    return result.rows.map((row) => ({
      id: row.id,
      text: row.texto,
      author: row.autor,
      at: row.created_at,
    }))
  }

  /**
   * E-mails e sincronizações ligados à solicitação, para a linha do tempo. Só a situação de cada
   * envio: nem destinatário, nem conteúdo. "Enviado" exige a confirmação do provedor.
   */
  async communications(id: string) {
    const pool = this.poolProvider()
    const present = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.email_deliveries') IS NOT NULL AS present`,
    )
    if (!present.rows[0]?.present) return []

    const manual = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.manual_emails') IS NOT NULL AS present`,
    )
    const result = await pool.query<{
      id: string
      canal: string
      modelo: string | null
      situacao: string
      simulado: boolean
      momento: Date
    }>(
      `SELECT d.id::text AS id, 'email' AS canal, d.template_key AS modelo, d.status AS situacao,
              d.simulated AS simulado, COALESCE(d.sent_at, d.created_at) AS momento
         FROM public.email_deliveries d
         JOIN public.integration_events e ON e.id = d.event_id
        WHERE e.resource_id = $1
       UNION ALL
       SELECT c.id::text, 'calendar', c.desired_action, c.status, c.simulated,
              COALESCE(c.last_synced_at, c.updated_at)
         FROM public.calendar_sync_items c
        WHERE c.request_id = $1
       ${manual.rows[0]?.present ? `UNION ALL
       SELECT m.id::text, 'email', COALESCE(m.modelo, 'manual'), m.status, m.simulado,
              COALESCE(m.enviado_em, m.created_at)
         FROM public.manual_emails m
        WHERE m.request_id = $1` : ''}
       ORDER BY momento`,
      [id],
    )
    return result.rows.map((row) => ({
      id: row.id,
      channel: row.canal,
      template: row.modelo,
      label: row.modelo && isEventType(row.modelo) ? eventCatalog[row.modelo].label : null,
      status: row.situacao,
      simulated: row.simulado,
      at: row.momento,
    }))
  }
}
