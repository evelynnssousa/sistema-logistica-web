import { apiRequest } from '../auth/apiClient'
import type { AttachmentResource } from './operationsApi'

type Envelope = { success: boolean; message?: string }

function send<Response extends Envelope>(path: string, body: unknown) {
  return apiRequest<Response>(path, { method: 'POST', body: JSON.stringify(body) })
}

export type EmailStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'not_configured'
export type TicketStatus = 'nao_enviado' | 'enviado' | 'falha' | 'pendente'

export const emailStatusLabels: Record<string, string> = {
  pending: 'Aguardando envio: resultado ainda não confirmado',
  sending: 'Em envio: resultado ainda não confirmado',
  sent: 'Enviado: aceito pelo serviço de e-mail',
  failed: 'Falha no envio',
  not_configured: 'Não enviado: serviço de e-mail não configurado',
}

export const ticketStatusLabels: Record<TicketStatus, string> = {
  nao_enviado: 'Bilhete não enviado',
  enviado: 'Bilhete enviado',
  falha: 'Falha no envio',
  pendente: 'Envio pendente de confirmação',
}

export type ManualEmail = {
  id: string
  kind: 'geral' | 'passagem'
  template: string | null
  recipients: string[]
  cc: string[]
  subject: string
  text: string
  html: string
  resentFrom: string | null
  status: EmailStatus
  attempts: number
  errorCode: string | null
  provider: string | null
  simulated: boolean
  providerMessageId: string | null
  sentAt: string | null
  createdAt: string
  operator: string | null
  attachments: { name: string; kind: string; category: string; sizeBytes: number }[]
}

export type CommunicationOverview = Envelope & {
  history: ManualEmail[]
  canSend: boolean
  service: 'nao_configurado' | 'simulado' | 'ativo'
  limits: { maxEmailMb: number; maxRecipients: number; allowExternalRecipients: boolean }
  attachmentLimits: { maxFileMb: number; allowedKinds: string[] }
  recipients: { label: string; email: string }[]
  templates: { key: string; name: string; event: string }[]
  passengers?: { id: string; name: string; cpfMasked: string }[]
  ticketStatus?: TicketStatus
}

const base = (type: AttachmentResource, id: string) => `/communications/${type}/${id}`

export const getCommunications = (type: AttachmentResource, id: string) =>
  apiRequest<CommunicationOverview>(base(type, id))

export const composeFromTemplate = (type: AttachmentResource, id: string, body: unknown) =>
  send<Envelope & { assunto: string; mensagem: string; destinatarioSugerido: string | null }>(`${base(type, id)}/compose`, body)

export const previewEmail = (type: AttachmentResource, id: string, body: unknown) =>
  send<Envelope & { subject: string; text: string; html: string }>(`${base(type, id)}/preview`, body)

export const sendEmail = (type: AttachmentResource, id: string, body: unknown) =>
  send<Envelope & { id: string; status: EmailStatus; repeated: boolean }>(`${base(type, id)}/send`, body)

export const resendEmail = (emailId: string, chave: string) =>
  send<Envelope & { id: string; status: EmailStatus }>(`/communications/emails/${emailId}/resend`, { confirmado: true, chave })
