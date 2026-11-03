import type { PoolClient } from 'pg'

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
  administrator_recovered: 'administrator.recovered',
  initial_administrator_created: 'administrator.bootstrap',
  registration_submitted: 'registration.requested',
  registration_approved: 'registration.approve',
  registration_rejected: 'registration.reject',
  account_blocked: 'account.blocked',
  permissions_changed: 'user.permissions_changed',
  password_recovery_completed: 'auth.password_recovery_completed',
  password_recovery_requested: 'auth.password_recovery_requested',
} as const

export type AuthAuditEventType = keyof typeof auditActions

export type AuthAuditEvent = {
  actorUserId: string | null
  actorKind: 'user' | 'system' | 'emergency_operator'
  actorReference?: string | null
  subjectUserId: string | null
  sessionId: string | null
  eventType: AuthAuditEventType
  requestId?: string | null
  details?: Record<string, string>
}

export async function insertAuthAuditEvent(
  client: PoolClient,
  event: AuthAuditEvent,
): Promise<void> {
  await client.query(
    `INSERT INTO public.auth_audit_events
      (actor_user_id, action, target_user_id, target_resource_id, result, details)
     VALUES ($1, $2, $3, $4, 'success', $5::jsonb)`,
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
    ],
  )
}
