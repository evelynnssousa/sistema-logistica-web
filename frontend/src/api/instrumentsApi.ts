import { apiRequest } from '../auth/apiClient'

/** Atas e contratos do Controle de Demandas (migração 021). */

type Envelope = { success: boolean; message?: string }

function send<Response extends Envelope>(path: string, method: string, body?: unknown) {
  return apiRequest<Response>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
}

function queryString(values: Record<string, string | undefined | null>) {
  const parameters = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value) parameters.set(key, value)
  const text = parameters.toString()
  return text ? `?${text}` : ''
}

export type InstrumentSituation = 'vigente' | 'vencendo' | 'vencido' | 'futuro' | 'encerrado'

export const instrumentTypeLabels: Record<string, string> = { ata: 'Ata de registro de preços', contrato: 'Contrato' }
export const instrumentShortLabels: Record<string, string> = { ata: 'Ata', contrato: 'Contrato' }
export const instrumentCategoryLabels: Record<string, string> = {
  material: 'Materiais',
  servico: 'Serviços',
  curso: 'Cursos',
  outro: 'Outros',
}
export const situationLabels: Record<InstrumentSituation, string> = {
  vigente: 'Vigente',
  vencendo: 'Vencendo',
  vencido: 'Vencido',
  futuro: 'Ainda não vigente',
  encerrado: 'Encerrado',
}
export const amendmentTypeLabels: Record<string, string> = {
  prorrogacao: 'Prorrogação de prazo',
  acrescimo: 'Acréscimo de valor',
  supressao: 'Supressão de valor',
  reajuste: 'Reajuste',
  outro: 'Outro',
}

export type InstrumentSummary = {
  id: string
  type: 'ata' | 'contrato'
  number: string
  subject: string
  category: string
  supplier: string | null
  process: string | null
  total: number
  spent: number
  balance: number
  usedPercent: number | null
  validFrom: string | null
  validUntil: string | null
  situation: InstrumentSituation
  daysLeft: number | null
  responsibleSector: { id: string; name: string }
  sharedSectors: { id: string; name: string }[]
  manager: { id: string; name: string | null } | null
  noticeDays: number
  renewalDemand: { id: string; number: string | null } | null
  closed: boolean
  notes: string | null
}

export type InstrumentItem = {
  id: string
  itemNumber: string | null
  description: string
  unit: string
  registered: number
  used: number
  unitPrice: number
  active: boolean
  balance: number
  registeredValue: number
  usedValue: number
}

export type InstrumentDetail = InstrumentSummary & {
  items: InstrumentItem[]
  usages: {
    id: string
    item: string
    unit: string
    quantity: number
    value: number
    date: string
    document: string | null
    note: string | null
    demand: { id: string; number: string | null } | null
    registeredBy: string
  }[]
  amendments: {
    id: string
    type: string
    number: string | null
    signedAt: string | null
    previousEnd: string | null
    newEnd: string | null
    previousValue: number
    newValue: number
    description: string
    registeredBy: string
    at: string
  }[]
  attachments: { id: string; name: string; kind: string; sizeBytes: number; uploadedBy: string; at: string; amendmentId: string | null }[]
  demands: { id: string; number: string; title: string; status: string; dueDate: string | null }[]
  customFields?: { id: string; label: string; value: string }[]
}

export type InstrumentInput = {
  type: string
  number: string
  subject: string
  category: string
  supplier: string
  process: string
  total: string
  validFrom: string
  validUntil: string
  responsibleSectorId: string
  sharedSectorIds: string[]
  managerId: string
  noticeDays: string
  closed: boolean
  notes: string
  customFields?: Record<string, string>
}

export const listInstruments = (filters: { search?: string; type?: string; category?: string; situation?: string; sectorId?: string }) =>
  apiRequest<Envelope & { instruments: InstrumentSummary[] }>(`/demand-instruments${queryString(filters)}`)
export const instrumentOptions = () =>
  apiRequest<Envelope & { instruments: { id: string; type: string; number: string; subject: string }[] }>('/demand-instruments/options')
export const fetchInstrument = (id: string) =>
  apiRequest<
    Envelope & {
      instrument: InstrumentDetail
      access: { read: boolean; edit: boolean }
      attachmentLimits: { maxFileMb: number; allowedKinds: string[] }
      storageConfigured: boolean
    }
  >(`/demand-instruments/${id}`)
export const createInstrument = (body: InstrumentInput) => send<Envelope & { id: string }>('/demand-instruments', 'POST', body)
export const updateInstrument = (id: string, body: InstrumentInput) => send<Envelope>(`/demand-instruments/${id}`, 'PUT', body)
export const saveInstrumentItem = (
  id: string,
  itemId: string | null,
  body: { itemNumber: string; description: string; unit: string; registered: string; unitPrice: string; active: boolean },
) => (itemId ? send<Envelope>(`/demand-instruments/${id}/items/${itemId}`, 'PUT', body) : send<Envelope>(`/demand-instruments/${id}/items`, 'POST', body))
export const addInstrumentUsage = (
  id: string,
  body: { itemId: string; quantity: string; date: string; document: string; note: string },
) => send<Envelope>(`/demand-instruments/${id}/usages`, 'POST', body)
export const addInstrumentAmendment = (
  id: string,
  body: { type: string; number: string; signedAt: string; newEnd: string; newValue: string; description: string },
) => send<Envelope & { id: string }>(`/demand-instruments/${id}/amendments`, 'POST', body)
export const uploadInstrumentAttachment = (id: string, file: File, amendmentId?: string) =>
  apiRequest<Envelope & { id: string }>(`/demand-instruments/${id}/attachments${queryString({ aditivo: amendmentId })}`, {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
  })
export const removeInstrumentAttachment = (id: string, attachmentId: string, reason: string) =>
  send<Envelope>(`/demand-instruments/${id}/attachments/${attachmentId}/remove`, 'POST', { reason })
export const instrumentAttachmentUrl = (id: string, attachmentId: string, inline = false) =>
  `/api/demand-instruments/${id}/attachments/${attachmentId}${inline ? '?inline=1' : ''}`
export const linkDemandInstrument = (demandId: string, instrumentId: string | null) =>
  send<Envelope>(`/demands/${demandId}/instrument`, 'PUT', { instrumentId })

export const formatBRL = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
export const formatDay = (value: string | null | undefined) => (value ? value.split('-').reverse().join('/') : '—')

// ---------------------------------------------------------------------------
// Robô de atas pelo Excel (14/11/2026)
// ---------------------------------------------------------------------------
export type ImportedItem = {
  row: number
  itemNumber: string | null
  description: string
  unit: string
  registered: number
  unitPrice: number
}

export type ImportedSheet = {
  fields: {
    type: 'ata' | 'contrato' | null
    number: string | null
    subject: string | null
    category: string | null
    supplier: string | null
    process: string | null
    total: number | null
    validFrom: string | null
    validUntil: string | null
    sectorName: string | null
    noticeDays: number | null
  }
  items: ImportedItem[]
  itemsTotal: number
  warnings: string[]
}

export const instrumentTemplateUrl = '/api/demand-instruments/template'

export const previewInstrumentSheet = (file: File) =>
  apiRequest<Envelope & ImportedSheet>('/demand-instruments/import/preview', {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
  })

export const addInstrumentItems = (id: string, items: readonly ImportedItem[]) =>
  send<Envelope & { created: number }>(`/demand-instruments/${id}/items/bulk`, 'POST', {
    items: items.map((item) => ({
      itemNumber: item.itemNumber ?? '',
      description: item.description,
      unit: item.unit,
      registered: String(item.registered),
      unitPrice: String(item.unitPrice),
    })),
  })
