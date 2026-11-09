import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { eventCatalog, isEventType, maxAgeHoursOf, maxAgeTable, moduleNames } from '../integrations/catalog.js'
import type { EventContext, EventType, IntegrationModule } from '../integrations/catalog.js'
import { maskEmail } from '../integrations/redaction.js'
import { actionCategories } from '../requests/settingsRules.js'
import { likePattern } from '../requests/validation.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { conflict, notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { protocolSql } from './protocolSql.js'
import { readSystemSettings } from './settingsRepository.js'
import { withTransaction } from './withTransaction.js'
import { demandVisibleRecipients, withEmailPreference } from '../demands/demandNotifications.js'
import { accessSql, isAccessSchemaMigrated, resolveAccess } from './accessSchema.js'
import type { AccessRow } from './accessSchema.js'
import type { Permission } from '../auth/permissions.js'
import { quotaUsageToday } from '../integrations/emailQuota.js'

/**
 * Situação exigida da conta dona do aviso, no momento do envio. Diferente da regra de "conta
 * aprovada": a confirmação de cadastro vale para quem ainda está pendente, e a rejeição, para quem
 * foi rejeitado. Se a situação mudou, o aviso perdeu o sentido e não sai.
 */
const accountNoticeStatus: Record<string, 'pending' | 'approved' | 'rejected' | 'inactive'> = {
  account_registration_received: 'pending',
  account_approved: 'approved',
  account_rejected: 'rejected',
  account_activated: 'approved',
  account_deactivated: 'inactive',
  account_access_changed: 'approved',
  account_password_changed: 'approved',
  security_new_login: 'approved',
  security_login_blocked: 'approved',
  security_sessions_revoked: 'approved',
}

/** Avisos administrativos: o destinatário precisa continuar com a permissão que o tornou destinatário. */
const holderNoticePermission: Record<string, Permission> = {
  account_registration_pending: 'users:approve',
  security_login_blocked_admin: 'users:manage',
}

const responsibleNotices = ['request_assigned', 'request_unassigned', 'request_overdue']

/**
 * Nunca reprocessáveis: BLOCKED_BEFORE_ACTIVATION (fila selada pela migração 019, gerada antes da
 * proteção) e RECIPIENT_OUTSIDE_TEST_LIST (destinatário fora da lista de testes).
 */
export const permanentlyBlockedCodes = new Set(['BLOCKED_BEFORE_ACTIVATION', 'RECIPIENT_OUTSIDE_TEST_LIST'])
const closedRequestStatuses = ['concluido', 'concluida', 'cancelado', 'cancelada', 'rejeitada', 'emitida']

export type NoticeCheck =
  | { allowed: true; accountName?: string }
  | { allowed: false; code: 'RECIPIENT_ACCESS_REVOKED' | 'RECIPIENT_ADDRESS_CHANGED' | 'NOTICE_OBSOLETE' }

/** Fila, histórico de envio e notificações. O trabalho com os provedores fica no worker. */

const pageSize = 25
const leaseSeconds = 120

export const maxAttempts = 5
const retryDelaysMinutes = [1, 5, 30, 120]

/** Espera até a próxima tentativa, depois de `attempts` tentativas feitas. */
export function retryDelayMinutes(attempts: number) {
  return retryDelaysMinutes[Math.min(attempts, retryDelaysMinutes.length) - 1] ?? 1
}

export type ClaimedEmail = {
  id: string
  eventId: string
  templateKey: string
  recipient: string
  cc: string[]
  attempts: number
  module: IntegrationModule
  resourceId: string | null
  protocol: string
  context: EventContext
  /** Quando a mensagem entrou na fila: depois da validade do evento, ela não sai. */
  createdAt: Date
  /** Acontecimentos equivalentes reunidos nesta mensagem (migração 019). Sem ela, 1. */
  groupedCount: number
}

export type ClaimedCalendarItem = {
  id: string
  requestId: string
  module: 'maintenance' | 'fleet'
  action: 'upsert' | 'delete'
  revision: number
  attempts: number
}

type Outcome = { retryable: boolean; code: string }

export class IntegrationRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  private async recordAttempt(
    client: Pick<PoolClient, 'query'>,
    channel: 'email' | 'calendar',
    itemId: string,
    attempt: number,
    outcome: 'success' | 'retry' | 'failure',
    errorCode: string | null,
  ) {
    await client.query(
      `INSERT INTO public.integration_attempts (channel, item_id, attempt, outcome, error_code)
       VALUES ($1, $2, $3, $4, $5)`,
      [channel, itemId, attempt, outcome, errorCode],
    )
  }

  // -------------------------------------------------------------------------
  // Fila de e-mails
  // -------------------------------------------------------------------------

  /**
   * Reserva itens com prazo. SKIP LOCKED permite mais de uma instância, e o prazo devolve à
   * fila o que ficou preso se o processo cair durante o envio.
   */
  /**
   * Dados atuais para as variáveis dos modelos, lidos no envio e nunca gravados na fila. Passagens
   * não leva descrição, responsável nem nada dos passageiros.
   */
  async templateData(module: IntegrationModule, resourceId: string | null): Promise<Partial<EventContext>> {
    if (!resourceId || module === 'system' || module === 'demands') return {}
    const pool = getDatabasePool()
    if (module === 'warehouse') {
      const request = await pool.query<{ nome: string; setor: string | null; entregue_em: Date | null }>(
        `SELECT COALESCE(r.solicitante_externo, u.full_name) AS nome, r.setor_nome AS setor, r.entregue_em
           FROM public.material_requests r JOIN public.auth_users u ON u.id = r.solicitante_id
          WHERE r.id = $1`,
        [resourceId],
      )
      const items = await pool.query<{ nome: string; unidade: string; solicitada: string; atendida: string }>(
        `SELECT COALESCE(i.material_nome, m.nome) AS nome, COALESCE(i.unidade, m.unidade) AS unidade,
                i.quantidade_solicitada AS solicitada, i.quantidade_atendida AS atendida
           FROM public.material_request_items i JOIN public.materials m ON m.id = i.material_id
          WHERE i.material_request_id = $1 ORDER BY 1 LIMIT 50`,
        [resourceId],
      )
      const row = request.rows[0]
      if (!row) return {}
      const list = (pick: 'solicitada' | 'atendida') =>
        items.rows.map((item) => `${item.nome}: ${Number(item[pick])} ${item.unidade}`).join('; ') || null
      return {
        requesterName: row.nome,
        sector: row.setor,
        requestedQuantities: list('solicitada'),
        providedQuantities: list('atendida'),
        deliveredAt: row.entregue_em?.toISOString() ?? null,
      }
    }
    const found = await pool.query<{
      nome: string
      setor: string | null
      descricao: string | null
      responsavel: string | null
    }>(
      `SELECT u.full_name AS nome, r.setor_nome AS setor, r.descricao, resp.full_name AS responsavel
         FROM public.service_requests r
         JOIN public.auth_users u ON u.id = r.solicitante_id
         LEFT JOIN public.auth_users resp ON resp.id = r.responsavel_id
        WHERE r.id = $1`,
      [resourceId],
    )
    const row = found.rows[0]
    if (!row) return {}
    return {
      requesterName: row.nome,
      sector: row.setor,
      ...(module === 'flights' ? {} : { description: row.descricao, responsible: row.responsavel }),
    }
  }

  /**
   * Aviso de demanda, conferido no momento do envio pela mesma regra da publicação. A demanda que
   * deixou de existir ou o endereço que não é mais de uma conta aprovada não recebem nada.
   */
  async demandEmailCheck(resourceId: string | null, recipient: string, templateKey: string): Promise<
    | { allowed: true; restricted: boolean }
    | { allowed: false; restricted: boolean; code: 'NOTICE_OBSOLETE' | 'RECIPIENT_ACCESS_REVOKED' | 'RECIPIENT_PREFERENCE_DISABLED' }
  > {
    if (!resourceId) return { allowed: false, restricted: true, code: 'NOTICE_OBSOLETE' }
    const pool = this.poolProvider()
    const demand = await pool.query<{ restrita: boolean }>(
      `SELECT restrita FROM public.demands WHERE id = $1 AND excluida_em IS NULL`,
      [resourceId],
    )
    // Demanda excluída (só rascunho pode ser): o aviso perdeu o objeto.
    if (!demand.rows[0]) return { allowed: false, restricted: true, code: 'NOTICE_OBSOLETE' }
    const restricted = demand.rows[0].restrita
    const account = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM public.auth_users WHERE lower(trim(email)) = $1 AND status = 'approved'`,
      [recipient.trim().toLowerCase()],
    )
    if (account.rows.length !== 1) return { allowed: false, restricted, code: 'RECIPIENT_ACCESS_REVOKED' }
    const visible = await demandVisibleRecipients(pool, resourceId, [account.rows[0].id])
    if (visible.length !== 1) return { allowed: false, restricted, code: 'RECIPIENT_ACCESS_REVOKED' }
    const kind = templateKey.replace(/^demand_/, '')
    if ((await withEmailPreference(pool, visible, kind)).length !== 1) {
      return { allowed: false, restricted, code: 'RECIPIENT_PREFERENCE_DISABLED' }
    }
    return { allowed: true, restricted }
  }

  async claimEmails(limit: number): Promise<ClaimedEmail[]> {
    return withTransaction(this.poolProvider(), async (client) => {
      const result = await client.query<{
        id: string
        event_id: string
        template_key: string
        recipient: string
        cc: string[]
        attempts: number
        module: IntegrationModule
        resource_id: string | null
        protocol: string | null
        payload: EventContext
        created_at: Date
        grouped_count: number
      }>(
        `UPDATE public.email_deliveries d
            SET status = 'sending', locked_until = now() + make_interval(secs => $2)
           FROM public.integration_events e
          WHERE e.id = d.event_id
            AND d.id IN (
              SELECT id FROM public.email_deliveries
               WHERE next_attempt_at <= now()
                 AND (status = 'pending' OR (status = 'sending' AND locked_until < now()))
               ORDER BY next_attempt_at
               LIMIT $1
               FOR UPDATE SKIP LOCKED
            )
        RETURNING d.id::text AS id, d.event_id::text AS event_id, d.template_key, d.recipient, d.cc,
                  d.attempts, e.module, e.resource_id::text AS resource_id, e.protocol, e.payload,
                  d.created_at, COALESCE((to_jsonb(d)->>'grouped_count')::int, 1) AS grouped_count`,
        [limit, leaseSeconds],
      )
      return result.rows.map((row) => ({
        id: row.id,
        eventId: row.event_id,
        templateKey: row.template_key,
        recipient: row.recipient,
        cc: row.cc,
        attempts: row.attempts,
        module: row.module,
        resourceId: row.resource_id,
        protocol: row.protocol ?? '',
        context: row.payload,
        createdAt: row.created_at,
        groupedCount: row.grouped_count,
      }))
    })
  }

  /**
   * Devolve à fila sem contar tentativa: a cota do dia acabou ou não pôde ser conferida. O código fica
   * visível no histórico, e a mensagem sai quando houver capacidade, se ainda estiver na validade.
   */
  async deferEmail(item: Pick<ClaimedEmail, 'id'>, until: Date, code: string) {
    await this.poolProvider().query(
      `UPDATE public.email_deliveries
          SET status = 'pending', locked_until = NULL, next_attempt_at = $2, last_error_code = $3
        WHERE id = $1 AND status = 'sending'`,
      [item.id, until, code],
    )
  }

  /** Conta aprovada dona do endereço, com as permissões efetivas de agora. */
  private async approvedAccountByEmail(email: string) {
    const pool = this.poolProvider()
    const sql = accessSql(await isAccessSchemaMigrated(pool))
    const result = await pool.query<AccessRow & { id: string }>(
      `SELECT u.id::text AS id, ${sql.columns}
         FROM public.auth_users u
         ${sql.join}
        WHERE lower(trim(u.email)) = $1 AND u.status = 'approved'`,
      [email.trim().toLowerCase()],
    )
    if (result.rows.length !== 1) return null
    const access = resolveAccess(result.rows[0])
    return access ? { id: result.rows[0].id, permissions: access.permissions } : null
  }

  /**
   * Revalidação no envio dos avisos de conta, segurança, administração e responsável, segundo o
   * significado de cada evento. Os demais eventos seguem como antes, e Demandas tem regra própria.
   */
  async noticeRecipientCheck(item: Pick<ClaimedEmail, 'templateKey' | 'recipient' | 'resourceId' | 'module'>): Promise<NoticeCheck> {
    const pool = this.poolProvider()
    const recipient = item.recipient.trim().toLowerCase()
    const requiredStatus = accountNoticeStatus[item.templateKey]
    if (requiredStatus) {
      if (!item.resourceId) return { allowed: false, code: 'NOTICE_OBSOLETE' }
      const account = await pool.query<{ status: string; email: string | null; full_name: string | null }>(
        `SELECT status, lower(trim(email)) AS email, full_name FROM public.auth_users WHERE id = $1`,
        [item.resourceId],
      )
      const row = account.rows[0]
      if (!row) return { allowed: false, code: 'NOTICE_OBSOLETE' }
      // O endereço mudou depois do aviso: o antigo não recebe nada sobre a conta.
      if (row.email !== recipient) return { allowed: false, code: 'RECIPIENT_ADDRESS_CHANGED' }
      if (row.status !== requiredStatus) return { allowed: false, code: 'NOTICE_OBSOLETE' }
      // O nome só vai à própria pessoa, que é a destinatária destes avisos.
      return { allowed: true, accountName: row.full_name?.trim() || undefined }
    }

    const holderPermission = holderNoticePermission[item.templateKey]
    if (holderPermission) {
      const holder = await this.approvedAccountByEmail(recipient)
      if (!holder || !holder.permissions.includes(holderPermission)) {
        return { allowed: false, code: 'RECIPIENT_ACCESS_REVOKED' }
      }
      if (item.templateKey === 'account_registration_pending') {
        const pending = await pool.query(`SELECT 1 FROM public.auth_users WHERE status = 'pending' LIMIT 1`)
        if (pending.rows.length === 0) return { allowed: false, code: 'NOTICE_OBSOLETE' }
      }
      return { allowed: true }
    }

    if (responsibleNotices.includes(item.templateKey)) {
      const module = item.module
      if (!item.resourceId || (module !== 'maintenance' && module !== 'fleet' && module !== 'flights')) {
        return { allowed: false, code: 'NOTICE_OBSOLETE' }
      }
      const person = await this.approvedAccountByEmail(recipient)
      const required: Permission[] = [`${module}:read` as Permission, `${module}:update` as Permission]
      if (!person || !required.every((permission) => person.permissions.includes(permission))) {
        return { allowed: false, code: 'RECIPIENT_ACCESS_REVOKED' }
      }
      const request = await pool.query<{ responsavel_id: string | null; status: string; overdue: boolean }>(
        `SELECT r.responsavel_id::text AS responsavel_id, r.status,
                COALESCE((to_jsonb(r)->>'prazo_em')::timestamptz < now(), false) AS overdue
           FROM public.service_requests r WHERE r.id = $1`,
        [item.resourceId],
      )
      const row = request.rows[0]
      if (!row) return { allowed: false, code: 'NOTICE_OBSOLETE' }
      const isResponsible = row.responsavel_id === person.id
      if (item.templateKey === 'request_assigned' && !isResponsible) return { allowed: false, code: 'NOTICE_OBSOLETE' }
      if (item.templateKey === 'request_unassigned' && isResponsible) return { allowed: false, code: 'NOTICE_OBSOLETE' }
      if (
        item.templateKey === 'request_overdue' &&
        (!isResponsible || !row.overdue || closedRequestStatuses.includes(row.status))
      ) {
        return { allowed: false, code: 'NOTICE_OBSOLETE' }
      }
      return { allowed: true }
    }
    return { allowed: true }
  }

  /**
   * Varredura da validade: "pendente" e "não configurado" que passaram do prazo do evento viram falha
   * EXPIRED, com registro em integration_attempts. Nada é apagado, nada é reenviado. Roda a cada ciclo
   * do worker, com ou sem serviço de e-mail ativo.
   */
  async expireStaleEmails(limit = 500) {
    const { types, hours } = maxAgeTable()
    const present = await this.poolProvider().query<{ present: boolean }>(
      `SELECT to_regclass('public.email_deliveries') IS NOT NULL AS present`,
    )
    if (!present.rows[0]?.present) return 0
    return withTransaction(this.poolProvider(), async (client) => {
      const expired = await client.query<{ id: string; attempts: number }>(
        `UPDATE public.email_deliveries d
            SET status = 'failed', last_error_code = 'EXPIRED', locked_until = NULL
          WHERE d.id IN (
            SELECT x.id FROM public.email_deliveries x
             WHERE x.status IN ('pending', 'not_configured')
               AND x.created_at < now() - make_interval(hours => COALESCE(
                     (SELECT l.hours FROM unnest($1::text[], $2::int[]) AS l(template_key, hours)
                       WHERE l.template_key = x.template_key),
                     $3))
             ORDER BY x.created_at
             LIMIT $4
             FOR UPDATE SKIP LOCKED
          )
        RETURNING d.id::text AS id, d.attempts`,
        [types, hours, maxAgeHoursOf(''), limit],
      )
      for (const row of expired.rows) {
        await this.recordAttempt(client, 'email', row.id, row.attempts + 1, 'failure', 'EXPIRED')
      }
      return expired.rows.length
    })
  }

  /**
   * Retrato da fila para decidir a ativação: o que está guardado sem serviço, o que já expirou e o
   * consumo do dia. Só totais e datas, sem destinatários.
   */
  async queueOverview() {
    const pool = this.poolProvider()
    const present = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.email_deliveries') IS NOT NULL AS present`,
    )
    if (!present.rows[0]?.present) return null
    const result = await pool.query<{ not_configured: number; pending: number; expired: number; blocked_by_list: number; sealed: number; oldest: Date | null }>(
      `SELECT count(*) FILTER (WHERE status = 'not_configured')::int AS not_configured,
              count(*) FILTER (WHERE status IN ('pending', 'sending'))::int AS pending,
              count(*) FILTER (WHERE status = 'failed' AND last_error_code = 'EXPIRED')::int AS expired,
              count(*) FILTER (WHERE status = 'failed' AND last_error_code = 'RECIPIENT_OUTSIDE_TEST_LIST')::int AS blocked_by_list,
              count(*) FILTER (WHERE status = 'failed' AND last_error_code = 'BLOCKED_BEFORE_ACTIVATION')::int AS sealed,
              min(created_at) FILTER (WHERE status IN ('not_configured', 'pending')) AS oldest
         FROM public.email_deliveries`,
    )
    const row = result.rows[0]
    return {
      notConfigured: row.not_configured,
      pending: row.pending,
      expired: row.expired,
      blockedByTestList: row.blocked_by_list,
      blockedBeforeActivation: row.sealed,
      oldestWaitingAt: row.oldest,
      quota: await quotaUsageToday(pool),
    }
  }

  async markEmailSent(
    item: ClaimedEmail,
    result: { provider: string; simulated: boolean; messageId: string | null },
  ) {
    await withTransaction(this.poolProvider(), async (client) => {
      await client.query(
        `UPDATE public.email_deliveries
            SET status = 'sent', attempts = attempts + 1, locked_until = NULL, last_error_code = NULL,
                provider = $2, simulated = $3, provider_message_id = $4, sent_at = now()
          WHERE id = $1`,
        [item.id, result.provider, result.simulated, result.messageId],
      )
      await this.recordAttempt(client, 'email', item.id, item.attempts + 1, 'success', null)
    })
  }

  /** Devolve true quando a falha é definitiva. */
  async markEmailFailed(item: ClaimedEmail, outcome: Outcome) {
    const attempts = item.attempts + 1
    const final = !outcome.retryable || attempts >= maxAttempts
    await withTransaction(this.poolProvider(), async (client) => {
      await client.query(
        `UPDATE public.email_deliveries
            SET status = $2, attempts = $3, locked_until = NULL, last_error_code = $4,
                next_attempt_at = now() + make_interval(mins => $5)
          WHERE id = $1`,
        [
          item.id,
          final ? 'failed' : 'pending',
          attempts,
          outcome.code,
          retryDelayMinutes(attempts),
        ],
      )
      await this.recordAttempt(
        client,
        'email',
        item.id,
        attempts,
        final ? 'failure' : 'retry',
        outcome.code,
      )
    })
    return final
  }

  async emailsAwaitingDeliveryStatus(limit: number) {
    const result = await this.poolProvider().query<{ id: string; provider_message_id: string }>(
      `SELECT id::text AS id, provider_message_id
         FROM public.email_deliveries
        WHERE status = 'sent' AND NOT simulated AND provider_message_id IS NOT NULL
          AND sent_at > now() - interval '3 days'
          AND (delivery_status IS NULL OR delivery_status NOT IN ('delivered', 'bounced', 'complained', 'failed'))
          AND (delivery_checked_at IS NULL OR delivery_checked_at < now() - interval '30 minutes')
        ORDER BY delivery_checked_at NULLS FIRST
        LIMIT $1`,
      [limit],
    )
    return result.rows.map((row) => ({ id: row.id, messageId: row.provider_message_id }))
  }

  async saveDeliveryStatus(id: string, status: string | null) {
    await this.poolProvider().query(
      `UPDATE public.email_deliveries
          SET delivery_status = COALESCE($2, delivery_status), delivery_checked_at = now()
        WHERE id = $1`,
      [id, status],
    )
  }

  // -------------------------------------------------------------------------
  // Fila do calendário
  // -------------------------------------------------------------------------
  async claimCalendarItems(limit: number): Promise<ClaimedCalendarItem[]> {
    return withTransaction(this.poolProvider(), async (client) => {
      const result = await client.query<{
        id: string
        request_id: string
        module: 'maintenance' | 'fleet'
        desired_action: 'upsert' | 'delete'
        revision: number
        attempts: number
      }>(
        `UPDATE public.calendar_sync_items
            SET status = 'syncing', locked_until = now() + make_interval(secs => $2)
          WHERE id IN (
            SELECT id FROM public.calendar_sync_items
             WHERE next_attempt_at <= now()
               AND (status = 'pending' OR (status = 'syncing' AND locked_until < now()))
             ORDER BY next_attempt_at
             LIMIT $1
             FOR UPDATE SKIP LOCKED
          )
        RETURNING id::text AS id, request_id::text AS request_id, module, desired_action,
                  revision, attempts`,
        [limit, leaseSeconds],
      )
      return result.rows.map((row) => ({
        id: row.id,
        requestId: row.request_id,
        module: row.module,
        action: row.desired_action,
        revision: row.revision,
        attempts: row.attempts,
      }))
    })
  }

  /** Dados enviados ao calendário, lidos no momento do envio: o registro é sempre o atual. */
  async calendarEventData(requestId: string) {
    const result = await this.poolProvider().query<{
      protocolo: string
      status: string
      titulo: string
      setor_nome: string | null
      data_agendada: Date | null
      agendamento_fim: Date | null
    }>(
      `SELECT ${protocolSql('service_requests')} AS protocolo, status, titulo, setor_nome, data_agendada, agendamento_fim
         FROM public.service_requests WHERE id = $1`,
      [requestId],
    )
    return result.rows[0] ?? null
  }

  /**
   * Conclui a sincronização da revisão reservada. Se o agendamento mudou enquanto o envio
   * acontecia, o item volta para a fila, e a alteração mais recente é a que prevalece.
   */
  async markCalendarSynced(
    item: ClaimedCalendarItem,
    result: { simulated: boolean; externalEventId: string | null },
  ) {
    await withTransaction(this.poolProvider(), async (client) => {
      await client.query(
        `UPDATE public.calendar_sync_items
            SET status = CASE WHEN revision = $2 THEN 'synced' ELSE 'pending' END,
                synced_revision = $2,
                attempts = CASE WHEN revision = $2 THEN attempts + 1 ELSE 0 END,
                locked_until = NULL, last_error_code = NULL, last_synced_at = now(),
                simulated = $3, external_event_id = $4
          WHERE id = $1`,
        [item.id, item.revision, result.simulated, result.externalEventId],
      )
      await this.recordAttempt(client, 'calendar', item.id, item.attempts + 1, 'success', null)
    })
  }

  async markCalendarFailed(item: ClaimedCalendarItem, outcome: Outcome) {
    const attempts = item.attempts + 1
    const final = !outcome.retryable || attempts >= maxAttempts
    await withTransaction(this.poolProvider(), async (client) => {
      await client.query(
        `UPDATE public.calendar_sync_items
            SET status = CASE
                  WHEN revision <> $6 THEN 'pending'
                  ELSE $2
                END,
                attempts = CASE WHEN revision <> $6 THEN 0 ELSE $3 END,
                locked_until = NULL, last_error_code = $4,
                next_attempt_at = now() + make_interval(mins => $5)
          WHERE id = $1`,
        [
          item.id,
          final ? 'failed' : 'pending',
          attempts,
          outcome.code,
          retryDelayMinutes(attempts),
          item.revision,
        ],
      )
      await this.recordAttempt(
        client,
        'calendar',
        item.id,
        attempts,
        final ? 'failure' : 'retry',
        outcome.code,
      )
    })
    return final
  }

  // -------------------------------------------------------------------------
  // Pendências
  // -------------------------------------------------------------------------

  /** Quantidade de solicitações em aberto, sem nenhuma atualização há mais de `days` dias. */
  async stalePendingCounts(days: number) {
    const result = await this.poolProvider().query<{ modulo: string; total: number }>(
      `SELECT CASE tipo WHEN 'manutencao' THEN 'maintenance' WHEN 'frota' THEN 'fleet'
                        ELSE 'flights' END AS modulo,
              count(*)::int AS total
         FROM public.service_requests
        WHERE status IN ('pendente', 'em_analise', 'aguardando_agendamento',
                         'em_cotacao', 'aguardando_aprovacao')
          AND updated_at < now() - make_interval(days => $1)
        GROUP BY 1
       UNION ALL
       SELECT 'warehouse', count(*)::int
         FROM public.material_requests
        WHERE status IN ('pendente', 'em_analise')
          AND updated_at < now() - make_interval(days => $1)
       HAVING count(*) > 0`,
      [days],
    )
    return result.rows as { modulo: 'maintenance' | 'fleet' | 'flights' | 'warehouse'; total: number }[]
  }

  /**
   * Solicitações com prazo vencido e responsável definido. Sem responsável, a pendência aparece
   * na Central. Cada prazo gera um único aviso: a chave do evento inclui o próprio prazo.
   */
  async overdueRequests(limit: number) {
    const present = await this.poolProvider().query<{ present: boolean }>(
      `SELECT to_regclass('public.system_settings') IS NOT NULL AS present`,
    )
    if (!present.rows[0]?.present) return []

    const result = await this.poolProvider().query<{
      id: string
      tipo: string
      protocolo: string
      responsavel_id: string
      prazo_em: Date
    }>(
      `SELECT r.id::text AS id, r.tipo, ${protocolSql('r')} AS protocolo,
              r.responsavel_id::text AS responsavel_id, (to_jsonb(r)->>'prazo_em')::timestamptz AS prazo_em
         FROM public.service_requests r
        WHERE (to_jsonb(r)->>'prazo_em')::timestamptz < now()
          AND r.responsavel_id IS NOT NULL
          AND r.status NOT IN ('concluido', 'concluida', 'cancelado', 'cancelada', 'rejeitada', 'emitida')
          AND NOT EXISTS (
            SELECT 1 FROM public.integration_events e
             WHERE e.event_key = r.id::text || ':overdue:' || to_char((to_jsonb(r)->>'prazo_em')::timestamptz AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI')
          )
        ORDER BY 5
        LIMIT $1`,
      [limit],
    )
    return result.rows
  }

  // -------------------------------------------------------------------------
  // Consulta administrativa e reprocessamento
  // -------------------------------------------------------------------------
  async listEmails(filters: { status?: string; module?: string; search?: string; page: number }) {
    const parameters: unknown[] = []
    const conditions: string[] = []
    const bind = (value: unknown) => {
      parameters.push(value)
      return `$${parameters.length}`
    }
    if (filters.status) conditions.push(`d.status = ${bind(filters.status)}`)
    if (filters.module) conditions.push(`e.module = ${bind(filters.module)}`)
    if (filters.search) conditions.push(`e.protocol ILIKE ${bind(likePattern(filters.search))}`)
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const pool = this.poolProvider()
    const [rows, total] = await Promise.all([
      pool.query<{
        id: string
        template_key: string
        audience: string
        recipient: string
        cc_total: number
        subject: string
        status: string
        simulated: boolean
        attempts: number
        next_attempt_at: Date
        last_error_code: string | null
        provider: string | null
        delivery_status: string | null
        sent_at: Date | null
        created_at: Date
        module: IntegrationModule
        resource_id: string | null
        protocol: string | null
      }>(
        `SELECT d.id::text AS id, d.template_key, d.audience, d.recipient,
                coalesce(array_length(d.cc, 1), 0) AS cc_total, d.subject, d.status, d.simulated,
                d.attempts, d.next_attempt_at, d.last_error_code, d.provider, d.delivery_status,
                d.sent_at, d.created_at, e.module, e.resource_id::text AS resource_id, e.protocol
           FROM public.email_deliveries d
           JOIN public.integration_events e ON e.id = d.event_id
           ${where}
          ORDER BY d.created_at DESC, d.id DESC
          LIMIT ${pageSize} OFFSET ${(filters.page - 1) * pageSize}`,
        parameters,
      ),
      pool.query<{ total: number }>(
        `SELECT count(*)::int AS total
           FROM public.email_deliveries d
           JOIN public.integration_events e ON e.id = d.event_id
           ${where}`,
        parameters,
      ),
    ])

    return {
      emails: rows.rows.map((row) => ({
        id: row.id,
        template: isEventType(row.template_key)
          ? eventCatalog[row.template_key as EventType].label
          : row.template_key,
        audience: row.audience,
        // O endereço completo não é necessário para administrar a fila.
        recipient: maskEmail(row.recipient),
        ccTotal: row.cc_total,
        subject: row.subject,
        status: row.status,
        simulated: row.simulated,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        errorCode: row.last_error_code,
        provider: row.provider,
        deliveryStatus: row.delivery_status,
        sentAt: row.sent_at,
        createdAt: row.created_at,
        module: row.module,
        moduleLabel: moduleNames[row.module],
        resourceId: row.resource_id,
        protocol: row.protocol,
      })),
      total: total.rows[0].total,
      page: filters.page,
      pageSize,
    }
  }

  async listCalendarItems(filters: { status?: string; page: number }) {
    const parameters: unknown[] = []
    const where = filters.status ? 'WHERE c.status = $1' : ''
    if (filters.status) parameters.push(filters.status)

    const pool = this.poolProvider()
    const [rows, total] = await Promise.all([
      pool.query<{
        id: string
        request_id: string
        module: 'maintenance' | 'fleet'
        desired_action: string
        status: string
        simulated: boolean
        attempts: number
        next_attempt_at: Date
        last_error_code: string | null
        last_synced_at: Date | null
        external_event_id: string | null
        protocolo: string
        data_agendada: Date | null
      }>(
        `SELECT c.id::text AS id, c.request_id::text AS request_id, c.module, c.desired_action,
                c.status, c.simulated, c.attempts, c.next_attempt_at, c.last_error_code,
                c.last_synced_at, c.external_event_id, ${protocolSql('r')} AS protocolo, r.data_agendada
           FROM public.calendar_sync_items c
           JOIN public.service_requests r ON r.id = c.request_id
           ${where}
          ORDER BY c.updated_at DESC, c.id DESC
          LIMIT ${pageSize} OFFSET ${(filters.page - 1) * pageSize}`,
        parameters,
      ),
      pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM public.calendar_sync_items c ${where}`,
        parameters,
      ),
    ])

    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        requestId: row.request_id,
        module: row.module,
        moduleLabel: moduleNames[row.module],
        action: row.desired_action,
        status: row.status,
        simulated: row.simulated,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        errorCode: row.last_error_code,
        syncedAt: row.last_synced_at,
        externalEventId: row.external_event_id,
        protocol: row.protocolo,
        scheduledAt: row.data_agendada,
      })),
      total: total.rows[0].total,
      page: filters.page,
      pageSize,
    }
  }

  async attemptsOf(channel: 'email' | 'calendar', itemId: string) {
    const result = await this.poolProvider().query<{
      attempt: number
      outcome: string
      error_code: string | null
      created_at: Date
    }>(
      `SELECT attempt, outcome, error_code, created_at
         FROM public.integration_attempts
        WHERE channel = $1 AND item_id = $2
        ORDER BY id`,
      [channel, itemId],
    )
    return result.rows.map((row) => ({
      attempt: row.attempt,
      outcome: row.outcome,
      errorCode: row.error_code,
      at: row.created_at,
    }))
  }

  /** Reprocessamento autorizado. Reinicia as tentativas e fica registrado na auditoria. */
  async retry(actor: AuthenticatedIdentity, channel: 'email' | 'calendar', id: string) {
    const table = channel === 'email' ? 'public.email_deliveries' : 'public.calendar_sync_items'

    await withTransaction(this.poolProvider(), async (client) => {
      const found = await client.query<{ status: string; last_error_code: string | null; template_key: string | null; created_at: Date }>(
        channel === 'email'
          ? `SELECT status, last_error_code, template_key, created_at FROM ${table} WHERE id = $1 FOR UPDATE`
          : `SELECT status, last_error_code, NULL::text AS template_key, created_at FROM ${table} WHERE id = $1 FOR UPDATE`,
        [id],
      )
      const current = found.rows[0]
      if (!current) throw notFound()
      if (current.status !== 'failed' && current.status !== 'not_configured') {
        throw conflict('Só é possível reprocessar itens com falha ou gerados sem o serviço ativo.')
      }
      // Bloqueio definitivo: gerada antes da ativação ou fora da lista de testes. Nem a remoção futura
      // da lista libera, porque o destinatário nunca foi autorizado para este envio.
      if (channel === 'email' && permanentlyBlockedCodes.has(current.last_error_code ?? '')) {
        throw conflict('Esta mensagem foi bloqueada de forma definitiva e não pode ser reprocessada.')
      }
      // Mensagem vencida não volta: o aviso perdeu o sentido, e o histórico fica como está.
      if (
        channel === 'email' &&
        (current.last_error_code === 'EXPIRED' ||
          Date.now() - current.created_at.getTime() > maxAgeHoursOf(current.template_key ?? '') * 3_600_000)
      ) {
        throw conflict('Esta mensagem passou da validade e não pode ser reprocessada.')
      }

      await client.query(
        `UPDATE ${table}
            SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL,
                last_error_code = NULL
          WHERE id = $1`,
        [id],
      )
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: null,
        sessionId: id,
        eventType: 'integration_retry',
        details: { channel, previousStatus: current.status },
      })
    })
  }

  // -------------------------------------------------------------------------
  // Notificações internas
  // -------------------------------------------------------------------------

  // A permissão e a configuração do perfil são conferidas a cada leitura: quem perdeu a permissão
  // deixa de ver a notificação, e reativar uma categoria devolve o que já havia.
  private visibleCondition = `n.user_id = $1 AND n.required_permissions <@ $2::text[] AND NOT (n.category = ANY($3::text[]))`

  private async visibilityParameters(identity: AuthenticatedIdentity) {
    const settings = await readSystemSettings(this.poolProvider())
    return [identity.userId, [...identity.permissions], settings.notifications.disabled[identity.role as keyof typeof settings.notifications.disabled] ?? []]
  }

  async listNotifications(
    identity: AuthenticatedIdentity,
    filters: { unreadOnly: boolean; pendingOnly?: boolean; page: number },
  ) {
    const parameters: unknown[] = await this.visibilityParameters(identity)
    const unread = [
      filters.unreadOnly ? 'AND n.read_at IS NULL' : '',
      filters.pendingOnly ? `AND n.read_at IS NULL AND n.category IN (${actionCategories.map((item) => `'${item}'`).join(', ')})` : '',
    ].join(' ')
    const pool = this.poolProvider()
    const [rows, totals] = await Promise.all([
      pool.query<{
        id: string
        category: string
        title: string
        message: string
        link: string | null
        read_at: Date | null
        created_at: Date
      }>(
        `SELECT n.id::text AS id, n.category, n.title, n.message, n.link, n.read_at, n.created_at
           FROM public.user_notifications n
          WHERE ${this.visibleCondition} ${unread}
          ORDER BY n.created_at DESC, n.id DESC
          LIMIT ${pageSize} OFFSET ${(filters.page - 1) * pageSize}`,
        parameters,
      ),
      pool.query<{ total: number; unread: number }>(
        `SELECT count(*) FILTER (WHERE TRUE ${unread})::int AS total,
                count(*) FILTER (WHERE n.read_at IS NULL)::int AS unread
           FROM public.user_notifications n
          WHERE ${this.visibleCondition}`,
        parameters,
      ),
    ])

    return {
      notifications: rows.rows.map((row) => ({
        id: row.id,
        category: row.category,
        requiresAction: actionCategories.includes(row.category),
        title: row.title,
        message: row.message,
        link: row.link,
        readAt: row.read_at,
        createdAt: row.created_at,
      })),
      total: totals.rows[0].total,
      unread: totals.rows[0].unread,
      page: filters.page,
      pageSize,
    }
  }

  async unreadCount(identity: AuthenticatedIdentity) {
    const result = await this.poolProvider().query<{ unread: number }>(
      `SELECT count(*)::int AS unread
         FROM public.user_notifications n
        WHERE ${this.visibleCondition} AND n.read_at IS NULL`,
      await this.visibilityParameters(identity),
    )
    return result.rows[0].unread
  }

  /** Só altera notificações da própria pessoa. A de outra responde como inexistente. */
  async markRead(identity: AuthenticatedIdentity, id: string) {
    const result = await this.poolProvider().query(
      `UPDATE public.user_notifications
          SET read_at = COALESCE(read_at, now())
        WHERE id = $1 AND user_id = $2`,
      [id, identity.userId],
    )
    if (result.rowCount === 0) throw notFound()
  }

  async markAllRead(identity: AuthenticatedIdentity) {
    await this.poolProvider().query(
      `UPDATE public.user_notifications SET read_at = now()
        WHERE user_id = $1 AND read_at IS NULL`,
      [identity.userId],
    )
  }
}
