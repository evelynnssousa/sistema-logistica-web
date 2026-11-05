import { apiRequest } from '../auth/apiClient'

type Envelope = { success: boolean; message?: string }

function queryString(values: Record<string, string | number | undefined | null>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  }
  const text = query.toString()
  return text ? `?${text}` : ''
}

// ---------------------------------------------------------------------------
// Notificações
// ---------------------------------------------------------------------------
export type UserNotification = {
  id: string
  category: string
  requiresAction: boolean
  title: string
  message: string
  link: string | null
  readAt: string | null
  createdAt: string
}

export const listNotifications = (filters: { unread?: boolean; pending?: boolean; page: number }) =>
  apiRequest<
    Envelope & {
      notifications: UserNotification[]
      total: number
      unread: number
      page: number
      pageSize: number
    }
  >(`/notifications${queryString({
    unread: filters.unread ? 'true' : undefined,
    pending: filters.pending ? 'true' : undefined,
    page: filters.page,
  })}`)

export const getUnreadCount = () =>
  apiRequest<Envelope & { unread: number }>('/notifications/unread-count')

export const markNotificationRead = (id: string) =>
  apiRequest<Envelope>(`/notifications/${id}/read`, { method: 'POST', body: '{}' })

export const markAllNotificationsRead = () =>
  apiRequest<Envelope>('/notifications/read-all', { method: 'POST', body: '{}' })

/** Avisa o contador do menu superior quando a leitura muda em outra tela. */
export const notificationsChangedEvent = 'slm:notifications-changed'

// ---------------------------------------------------------------------------
// Administração das integrações
// ---------------------------------------------------------------------------
export type ChannelMode = 'none' | 'simulated' | 'provider'

export type IntegrationStatus = {
  email: {
    mode: ChannelMode
    provider: string
    flagEnabled: boolean
    credentialsPresent: boolean
    publicUrlPresent: boolean
    internalRecipients: Record<string, number>
  }
  calendar: {
    mode: ChannelMode
    provider: string
    flagEnabled: boolean
    credentialsPresent: boolean
    maintenanceCalendarPresent: boolean
    fleetCalendarPresent: boolean
  }
  worker: { enabled: boolean }
  pendingReminderDays: number | null
}

export const getIntegrationStatus = () =>
  apiRequest<Envelope & { status: IntegrationStatus }>('/integrations/status')

export type EmailTemplate = {
  key: string
  label: string
  modules: string[]
  audience: { requester: boolean; team: boolean; responsible: boolean }
  subject: string
  body: string
}

export const listEmailTemplates = () =>
  apiRequest<Envelope & { templates: EmailTemplate[] }>('/integrations/templates')

export type EmailDelivery = {
  id: string
  template: string
  audience: 'requester' | 'internal'
  recipient: string
  ccTotal: number
  subject: string
  status: string
  simulated: boolean
  attempts: number
  nextAttemptAt: string
  errorCode: string | null
  provider: string | null
  deliveryStatus: string | null
  sentAt: string | null
  createdAt: string
  module: string
  moduleLabel: string
  resourceId: string | null
  protocol: string | null
}

export const listEmailDeliveries = (filters: {
  status?: string
  module?: string
  search?: string
  page: number
}) =>
  apiRequest<Envelope & { emails: EmailDelivery[]; total: number; page: number; pageSize: number }>(
    `/integrations/emails${queryString(filters)}`,
  )

export const retryEmail = (id: string) =>
  apiRequest<Envelope>(`/integrations/emails/${id}/retry`, { method: 'POST', body: '{}' })

export type CalendarSyncItem = {
  id: string
  requestId: string
  module: 'maintenance' | 'fleet'
  moduleLabel: string
  action: 'upsert' | 'delete'
  status: string
  simulated: boolean
  attempts: number
  nextAttemptAt: string
  errorCode: string | null
  syncedAt: string | null
  externalEventId: string | null
  protocol: string
  scheduledAt: string | null
}

export const listCalendarSync = (filters: { status?: string; page: number }) =>
  apiRequest<Envelope & { items: CalendarSyncItem[]; total: number; page: number; pageSize: number }>(
    `/integrations/calendar${queryString(filters)}`,
  )

export const retryCalendarSync = (id: string) =>
  apiRequest<Envelope>(`/integrations/calendar/${id}/retry`, { method: 'POST', body: '{}' })
