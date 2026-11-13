import { apiRequest } from '../auth/apiClient'

type Envelope = { success: boolean; message?: string }

function send<Response extends Envelope>(path: string, method: string, body?: unknown) {
  return apiRequest<Response>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
}

export type ConfigVersion<Content> = {
  id: string
  key: string
  version: number
  status: 'rascunho' | 'publicada'
  content: Content
  note: string | null
  user: string | null
  at: string
}

// ---------------------------------------------------------------------------
// Modelos de e-mail
// ---------------------------------------------------------------------------
export type TemplateContent = {
  name: string
  event: string
  active: boolean
  subject: string
  greeting: string
  body: string
  closing: string
  signature: string
  facts: string[]
}

export type TemplateEvent = {
  key: string
  label: string
  modules: string[]
  variables: string[]
  required: string[]
  published: number | null
  hasDraft: boolean
}

export type TemplateLibrary = Envelope & {
  events: TemplateEvent[]
  custom: { key: string; name: string; event: string; published: number | null; hasDraft: boolean }[]
  variables: { key: string; label: string; example: string }[]
  facts: { key: string; label: string }[]
}

const templates = '/config/email-templates'

export const getTemplateLibrary = () => apiRequest<TemplateLibrary>(templates)
export const getTemplate = (key: string) =>
  apiRequest<
    Envelope & {
      default: TemplateContent | null
      latest: ConfigVersion<TemplateContent> | null
      published: ConfigVersion<TemplateContent> | null
      history: ConfigVersion<TemplateContent>[]
    }
  >(`${templates}/${key}`)
export const saveTemplateDraft = (key: string, conteudo: TemplateContent, observacao: string) =>
  send<Envelope & { version: number }>(`${templates}/${key}/draft`, 'PUT', { conteudo, observacao })
export const publishTemplate = (key: string, conteudo: TemplateContent, observacao: string) =>
  send<Envelope & { version: number }>(`${templates}/${key}/publish`, 'POST', { conteudo, observacao })
export const restoreTemplate = (key: string, versao: number) =>
  send<Envelope & { version: number }>(`${templates}/${key}/restore`, 'POST', { versao })
export const previewTemplate = (key: string, conteudo: TemplateContent) =>
  send<Envelope & { subject: string; text: string; html: string; simulated: boolean }>(
    `${templates}/${key}/preview`,
    'POST',
    { conteudo },
  )
export const sendTemplateTest = (key: string, conteudo: TemplateContent) =>
  send<Envelope & { simulated: boolean }>(`${templates}/${key}/test`, 'POST', { conteudo })

// ---------------------------------------------------------------------------
// Formulários
// ---------------------------------------------------------------------------
export type ManagedField = {
  id: string
  label: string
  description: string
  help: string
  type: string
  required: boolean
  active: boolean
  protected: boolean
  options: string[]
  catalog: string | null
  section: string
  minLength: number | null
  maxLength: number | null
  min: number | null
  max: number | null
  validation: string
  visibleTo: 'all' | 'staff'
  visibleWhen: { field: string; equals: string } | null
}

export type FormContent = { sections: { id: string; title: string }[]; fields: ManagedField[] }

/** Formulário publicado (ou o padrão) de um formulário administrável, para quem o preenche. */
export const getManagedFormContent = (key: string) =>
  apiRequest<Envelope & { content: FormContent; version: number | null; fixedLayout: boolean }>(`/forms/managed/${key}`)

const forms = '/config/forms'

export const getFormLibrary = () =>
  apiRequest<
    Envelope & {
      forms: { key: string; label: string; published: number | null; hasDraft: boolean; fixedLayout?: boolean }[]
      fieldTypes: string[]
      catalogs: string[]
    }
  >(forms)
export const getManagedForm = (key: string) =>
  apiRequest<
    Envelope & {
      default: FormContent
      latest: ConfigVersion<FormContent> | null
      published: ConfigVersion<FormContent> | null
      history: ConfigVersion<FormContent>[]
    }
  >(`${forms}/${key}`)
export const validateForm = (key: string, conteudo: FormContent) =>
  send<Envelope & { content: FormContent }>(`${forms}/${key}/validate`, 'POST', { conteudo })
export const saveFormDraft = (key: string, conteudo: FormContent, observacao: string) =>
  send<Envelope & { version: number }>(`${forms}/${key}/draft`, 'PUT', { conteudo, observacao })
export const publishForm = (key: string, conteudo: FormContent, observacao: string) =>
  send<Envelope & { version: number }>(`${forms}/${key}/publish`, 'POST', { conteudo, observacao })
export const restoreForm = (key: string, versao: number) =>
  send<Envelope & { version: number }>(`${forms}/${key}/restore`, 'POST', { versao })

/** Mensagem da tela de entrada e aviso geral, definidos em Configurações. Abre sem sessão. */
export const getPublicScreen = () =>
  apiRequest<Envelope & { loginMessage: string; announcement: { text: string; tone: 'info' | 'warning'; until: string | null } | null }>(
    '/public/screen',
  )

export const getPublicRegistrationForm = () =>
  apiRequest<Envelope & { form: FormContent | null; version: number | null }>('/public/forms/registration')

// ---------------------------------------------------------------------------
// Controle interno do Almoxarifado
// ---------------------------------------------------------------------------
export type ControlRecord = {
  id: string
  reference: string | null
  sector: string | null
  material: string
  unit: string
  description: string | null
  referenceQuantity: number | null
  countedQuantity: number | null
  providedQuantity: number | null
  notes: string | null
  justification: string | null
  customFields: { valores?: Record<string, string>; nomes?: Record<string, string> }
  formVersion: number | null
  user: string | null
  at: string
}

export const getControlForm = () =>
  apiRequest<Envelope & { content: FormContent; version: number | null }>('/warehouse/control-form')
export const listControlRecords = (page: number) =>
  apiRequest<Envelope & { records: ControlRecord[]; page: number; hasMore: boolean }>(`/warehouse/control-records?page=${page}`)
export const createControlRecord = (body: unknown) =>
  send<Envelope & { id: string }>('/warehouse/control-records', 'POST', body)
