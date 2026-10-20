import type { PoolClient } from 'pg'

export const authAuditRetentionDays = 365

export type AuthAuditEventType =
  | 'user_created'
  | 'user_updated'
  | 'account_activated'
  | 'account_deactivated'
  | 'role_changed'
  | 'password_changed'
  | 'session_created'
  | 'session_revoked'
  | 'administrator_recovered'

export type AuthAuditEvent = {
  actorUserId: string | null
  actorKind: 'user' | 'system' | 'emergency_operator'
  actorReference?: string | null
  subjectUserId: string | null
  sessionId: string | null
  eventType: AuthAuditEventType
  requestId?: string | null
}

export async function insertAuthAuditEvent(
  client: PoolClient,
  event: AuthAuditEvent,
): Promise<void> {
  await client.query(
    `INSERT INTO app_private.auth_audit_events
      (actor_user_id, actor_kind, actor_reference, subject_user_id,
       session_id, event_type, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      event.actorUserId,
      event.actorKind,
      event.actorReference ?? null,
      event.subjectUserId,
      event.sessionId,
      event.eventType,
      event.requestId ?? null,
    ],
  )
}