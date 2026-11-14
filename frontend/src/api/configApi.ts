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

// ---------------------------------------------------------------------------
// Página inicial pública e Ajuda (Configurações → Página inicial)
// ---------------------------------------------------------------------------
export type PublicPageContent = {
  heroTitle: string
  heroText: string
  aboutOrgan: string
  aboutSlm: string
  serviceHours: string
  location: string
  contactEmail: string
  faq: { question: string; answer: string }[]
  news: { date: string; title: string; text: string }[]
}

export type PublicManual = { title: string; audience: string; fileName: string; sizeBytes: number; url: string }

export type PublicHome = {
  page: PublicPageContent & { team: { name: string; role: string; photoUrl: string | null }[]; manuals?: PublicManual[] }
  modules: Record<string, boolean>
  loginMessage: string
  announcement: { text: string; tone: 'info' | 'warning'; until: string | null } | null
}

export const getPublicHome = () => apiRequest<Envelope & PublicHome>('/public/home')

export const uploadTeamPhoto = (photo: Blob) =>
  apiRequest<Envelope & { photoId: string; photoUrl: string }>('/settings/public-page/photos', {
    method: 'POST',
    body: photo,
    headers: { 'Content-Type': 'application/octet-stream' },
  })

/** Envia o PDF de um manual. Ele só fica público quando a página inicial é salva com ele. */
export const uploadManual = (file: File) =>
  apiRequest<Envelope & { fileId: string; fileName: string; sizeBytes: number }>(
    `/settings/public-page/manuals?nome=${encodeURIComponent(file.name)}`,
    { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } },
  )

// ---------------------------------------------------------------------------
// Limpeza dos dados de teste (só Administrador)
// ---------------------------------------------------------------------------
export type TestDataInfo = {
  environment: 'local' | 'homologacao' | 'principal'
  confirmation: string
  groups: { key: string; label: string }[]
  preview: { counts: Record<string, number>; total: number; fingerprint: string; files: number } | null
}

export const getTestDataInfo = (groups: readonly string[]) =>
  apiRequest<Envelope & TestDataInfo>(`/admin/test-data${groups.length ? `?groups=${encodeURIComponent(groups.join(','))}` : ''}`)

/** Baixa a cópia em JSON e devolve a impressão digital que autoriza a limpeza. */
export const downloadTestDataCopy = (groups: readonly string[]) =>
  downloadCopy(`/api/admin/test-data/copy?groups=${encodeURIComponent(groups.join(','))}`)

// Excluir uma solicitação ou um pedido de materiais (14/11/2026), só para o Administrador.
export type DeletableKind = 'solicitacao' | 'pedido-material'

export const getRecordDeletion = (kind: DeletableKind, id: string) =>
  apiRequest<Envelope & { environment: TestDataInfo['environment']; confirmation: string; preview: { total: number; files: number } }>(
    `/admin/test-data/record/${kind}/${id}`,
  )
export const downloadRecordCopy = (kind: DeletableKind, id: string) => downloadCopy(`/api/admin/test-data/record/${kind}/${id}/copy`)
export const deleteRecord = (kind: DeletableKind, id: string, body: { fingerprint: string; confirmation: string }) =>
  apiRequest<Envelope & { total: number; filesFailed: number }>(`/admin/test-data/record/${kind}/${id}/purge`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

async function downloadCopy(path: string) {
  const response = await fetch(path, { credentials: 'include' })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string }
    throw new Error(body.message ?? 'Não foi possível baixar a cópia.')
  }
  const fingerprint = response.headers.get('X-Copy-Fingerprint') ?? ''
  const blob = await response.blob()
  const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'copia-dados-de-teste.json'
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
  return fingerprint
}

export const purgeTestData = (body: { groups: readonly string[]; fingerprint: string; confirmation: string }) =>
  apiRequest<Envelope & { counts: Record<string, number>; total: number; filesRemoved: number; filesFailed: number; counters: { prefix: string; year: number; from: number; to: number }[] }>(
    '/admin/test-data/purge',
    { method: 'POST', body: JSON.stringify(body) },
  )
