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
  // Envio do e-mail de recuperação: só canal, tentativas e código do erro. Nunca código, token ou link.
  password_recovery_email_sent: 'auth.password_recovery_email_sent',
  password_recovery_email_failed: 'auth.password_recovery_email_failed',
  slm_member_added: 'user.slm_added',
  slm_member_removed: 'user.slm_removed',
  cpf_access_granted: 'user.cpf_access_granted',
  cpf_access_revoked: 'user.cpf_access_revoked',
  cpf_read: 'flights.cpf_read',
  cpf_read_denied: 'flights.cpf_read_denied',
  // Tentativa recusada de operação sensível (agendar, atribuir motorista, previsão de entrega).
  sensitive_operation_denied: 'access.denied',
  sessions_revoked: 'auth.sessions_revoked',
  request_created: 'request.created',
  request_updated: 'request.updated',
  request_scheduled: 'request.scheduled',
  request_rescheduled: 'request.rescheduled',
  request_started: 'request.started',
  request_completed: 'request.completed',
  request_cancelled: 'request.cancelled',
  request_status_changed: 'request.status_changed',
  request_occurrence: 'request.occurrence',
  flight_passengers_changed: 'flights.passengers_changed',
  settings_created: 'settings.created',
  settings_updated: 'settings.updated',
  settings_activated: 'settings.activated',
  settings_deactivated: 'settings.deactivated',
  material_created: 'warehouse.material_created',
  material_updated: 'warehouse.material_updated',
  warehouse_request_created: 'warehouse.request_created',
  warehouse_request_updated: 'warehouse.request_updated',
  warehouse_status_changed: 'warehouse.status_changed',
  warehouse_delivered: 'warehouse.delivered',
  warehouse_forecast_set: 'warehouse.forecast_set',
  warehouse_forecast_changed: 'warehouse.forecast_changed',
  inventory_created: 'warehouse.inventory_created',
  inventory_item_updated: 'warehouse.inventory_item_updated',
  inventory_closed: 'warehouse.inventory_closed',
  integration_retry: 'integrations.retry',
  request_assigned: 'request.assigned',
  request_priority_changed: 'request.priority_changed',
  request_deadline_changed: 'request.deadline_changed',
  request_complexity_changed: 'request.complexity_changed',
  request_note_added: 'request.note_added',
  attachment_uploaded: 'attachment.uploaded',
  attachment_downloaded: 'attachment.downloaded',
  attachment_removed: 'attachment.removed',
  access_reviewed: 'user.access_reviewed',
  session_revoked_individually: 'auth.session_revoked',
  vehicle_changed: 'fleet.vehicle_changed',
  vehicle_log_added: 'fleet.vehicle_log_added',
  equipment_changed: 'maintenance.equipment_changed',
  flight_quote_changed: 'flights.quote_changed',
  stock_movement_added: 'warehouse.stock_movement',
  request_schedule_changed: 'request.schedule_changed',
  request_returned: 'request.returned',
  request_corrected: 'request.corrected',
  request_return_closed: 'request.return_closed',
  request_report_exported: 'request.report_exported',
  warehouse_quantity_changed: 'warehouse.quantity_changed',
  warehouse_reserve_changed: 'warehouse.reserve_changed',
  // Valores do Almoxarifado (020). Sem valores nos detalhes.
  warehouse_agreement_saved: 'warehouse.agreement_saved',
  warehouse_value_set: 'warehouse.value_set',
  warehouse_control_recorded: 'warehouse.control_recorded',
  warehouse_report_exported: 'warehouse.report_exported',
  warehouse_spreadsheet_exported: 'warehouse.spreadsheet_exported',
  fleet_spreadsheet_exported: 'fleet.spreadsheet_exported',
  maintenance_spreadsheet_exported: 'maintenance.spreadsheet_exported',
  flights_spreadsheet_exported: 'flights.spreadsheet_exported',
  general_spreadsheet_exported: 'reports.spreadsheet_exported',
  manual_email_queued: 'communication.email_queued',
  manual_email_resent: 'communication.email_resent',
  config_draft_saved: 'config.draft_saved',
  config_published: 'config.published',
  config_restored: 'config.restored',
  email_template_test_sent: 'config.email_test_sent',
  email_template_test_failed: 'config.email_test_failed',
  // Lista de destinatários permitidos (homologação): só canal, modelo e domínios, nunca o endereço.
  email_recipient_blocked: 'email.recipient_blocked',
  demand_created: 'demand.created',
  demand_changed: 'demand.changed',
  demand_restriction_changed: 'demand.restriction_changed',
  demand_config_changed: 'demand.config_changed',
  demand_report_exported: 'demand.report_exported',
  demand_admin_access: 'demand.admin_access',
  // Atas e contratos (021). Sem valores nos detalhes.
  contract_instrument_changed: 'demand.instrument_changed',
  institutional_link_changed: 'user.institutional_link_changed',
  fleet_driver_changed: 'fleet.driver_changed',
  trip_driver_assigned: 'fleet.trip_driver_assigned',
  trip_execution_corrected: 'fleet.execution_corrected',
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
  auditActions.access_reviewed,
  auditActions.institutional_link_changed,
  auditActions.demand_config_changed,
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
