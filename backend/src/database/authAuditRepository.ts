import type { Pool, PoolClient } from 'pg'
import { describeError, logSecurityEvent } from '../security/logger.js'
import { getDatabasePool } from './pool.js'

export const authAuditRetentionDays = 365

// Nomes gravados na coluna "action", no padrão já usado pelos registros do banco real.
const auditActions = {
  user_created: 'user.created',
  user_updated: 'user.updated',
  account_activated: 'account.activated',
  account_deactivated: 'account.inactive',
  role_changed: 'user.role_changed',
  password_changed: 'auth.password_changed',
  session_created: 'auth.login',
  session_revoked: 'auth.logout',
  login_failed: 'auth.login_failed',
  login_rate_limited: 'auth.login_rate_limited',
  administrator_recovered: 'administrator.recovered',
  initial_administrator_created: 'administrator.bootstrap',
  registration_submitted: 'registration.requested',
  registration_resubmitted: 'registration.resubmitted',
  registration_duplicate: 'registration.duplicate',
  registration_approved: 'registration.approve',
  registration_rejected: 'registration.reject',
  account_blocked: 'account.blocked',
  permissions_changed: 'user.permissions_changed',
  password_recovery_completed: 'auth.password_recovery_completed',
  password_recovery_requested: 'auth.password_recovery_requested',
  password_recovery_failed: 'auth.password_recovery_failed',
  slm_member_added: 'user.slm_added',
  slm_member_removed: 'user.slm_removed',
  cpf_access_granted: 'user.cpf_access_granted',
  cpf_access_revoked: 'user.cpf_access_revoked',
  cpf_read: 'flights.cpf_read',
  cpf_read_denied: 'flights.cpf_read_denied',
} as const

/** Ações exibidas no histórico de alterações de acesso de um usuário. */
export const accessHistoryActions: readonly string[] = [
  auditActions.registration_approved,
  auditActions.role_changed,
  auditActions.permissions_changed,
  auditActions.slm_member_added,
  auditActions.slm_member_removed,
  auditActions.cpf_access_granted,
  auditActions.cpf_access_revoked,
  auditActions.account_activated,
  auditActions.account_deactivated,
  auditActions.user_updated,
]

export type AuthAuditEventType = keyof typeof auditActions

export type AuthAuditEvent = {
  actorUserId: string | null
  actorKind: 'user' | 'system' | 'emergency_operator'
  actorReference?: string | null
  subjectUserId: string | null
  sessionId: string | null
  eventType: AuthAuditEventType
  result?: 'success' | 'failure' | 'denied'
  requestId?: string | null
  details?: Record<string, string | readonly string[]>
}

export async function insertAuthAuditEvent(
  client: Pick<PoolClient, 'query'>,
  event: AuthAuditEvent,
): Promise<void> {
  await client.query(
    `INSERT INTO public.auth_audit_events
      (actor_user_id, action, target_user_id, target_resource_id, result, details)
     VALUES ($1, $2, $3, $4, $6, $5::jsonb)`,
    [
      event.actorUserId,
      auditActions[event.eventType],
      event.subjectUserId,
      event.sessionId,
      JSON.stringify({
        ...event.details,
        actorKind: event.actorKind,
        ...(event.actorReference ? { actorReference: event.actorReference } : {}),
        ...(event.requestId ? { requestId: event.requestId } : {}),
      }),
      event.result ?? 'success',
    ],
  )
}

/**
 * Para eventos fora de transação, como tentativas de login recusadas. Uma falha
 * ao auditar fica no log e não muda a resposta dada ao usuário.
 */
export async function recordAuthAuditEvent(
  event: AuthAuditEvent,
  poolProvider: () => Pool = getDatabasePool,
): Promise<void> {
  try {
    await insertAuthAuditEvent(poolProvider(), event)
  } catch (error) {
    logSecurityEvent('audit_write_failed', {
      eventType: event.eventType,
      ...describeError(error),
    })
  }
}
