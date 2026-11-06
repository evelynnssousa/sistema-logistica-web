import { apiRequest } from '../auth/apiClient'

type Envelope = { success: boolean; message?: string }

function send<Response extends Envelope>(path: string, method: string, body?: unknown) {
  return apiRequest<Response>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
}

function queryString(values: Record<string, string | number | boolean | undefined | null>) {
  const parameters = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') parameters.set(key, String(value))
  }
  const text = parameters.toString()
  return text ? `?${text}` : ''
}

export type DemandStatus =
  | 'nao_iniciada'
  | 'em_andamento'
  | 'aguardando_terceiros'
  | 'aguardando_autorizacao'
  | 'suspensa'
  | 'concluida'
  | 'cancelada'

export const demandStatusLabels: Record<DemandStatus, string> = {
  nao_iniciada: 'Não iniciada',
  em_andamento: 'Em andamento',
  aguardando_terceiros: 'Aguardando terceiros',
  aguardando_autorizacao: 'Aguardando autorização',
  suspensa: 'Suspensa',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
}

export const demandStatusOrder = Object.keys(demandStatusLabels) as DemandStatus[]

export const demandPriorityLabels: Record<string, string> = {
  baixa: 'Baixa',
  media: 'Média',
  alta: 'Alta',
  urgente: 'Urgente',
}

export const subtaskStatusLabels: Record<string, string> = {
  nao_iniciada: 'Não iniciada',
  em_andamento: 'Em andamento',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
}

export const commentKindLabels: Record<string, string> = {
  comentario: 'Comentário',
  providencia: 'Providência',
  andamento: 'Andamento',
}

export const moduleLinkLabels: Record<string, string> = {
  maintenance: 'Manutenção',
  fleet: 'Frota',
  flights: 'Passagens aéreas',
  warehouse: 'Almoxarifado',
}

export const frequencyLabels: Record<string, string> = {
  diaria: 'Diariamente',
  semanal: 'Semanalmente',
  quinzenal: 'Quinzenalmente (a cada 15 dias)',
  mensal: 'Mensalmente',
  bimestral: 'Bimestralmente',
  trimestral: 'Trimestralmente',
  semestral: 'Semestralmente',
  anual: 'Anualmente',
  personalizada: 'Personalizado',
}

export const seriesStatusLabels: Record<string, string> = {
  ativa: 'Ativa',
  suspensa: 'Suspensa',
  cancelada: 'Cancelada',
  encerrada: 'Encerrada',
}

export const notificationKindLabels: Record<string, string> = {
  atribuicao: 'Nova demanda atribuída',
  responsavel: 'Alteração de responsável',
  mencao: 'Menção em comentário',
  comentario: 'Novo comentário em demanda acompanhada',
  prazo_alterado: 'Alteração de prazo',
  prazo_proximo: 'Prazo próximo',
  atraso: 'Demanda atrasada',
  status: 'Mudança de status',
  recorrencia: 'Nova ocorrência recorrente',
  providencia: 'Demanda aguardando providência',
}

export const historyLabels: Record<string, string> = {
  criada: 'Demanda criada',
  rascunho_criado: 'Rascunho criado',
  rascunho_descartado: 'Rascunho descartado',
  descricao_alterada: 'Descrição alterada',
  prazo_alterado: 'Prazo alterado',
  prioridade_alterada: 'Prioridade alterada',
  restricao_alterada: 'Restrição de acesso alterada',
  dados_alterados: 'Dados alterados',
  responsavel_alterado: 'Responsável alterado',
  gestor_alterado: 'Diretor do acompanhamento alterado',
  colaboracao_alterada: 'Colaboradores ou setores alterados',
  status_alterado: 'Status alterado',
  concluida: 'Demanda concluída',
  reaberta: 'Demanda reaberta',
  cancelada: 'Demanda cancelada',
  registro_incluido: 'Comentário ou providência registrada',
  etapa_criada: 'Etapa criada',
  etapa_alterada: 'Etapa alterada',
  anexo_incluido: 'Anexo incluído',
  anexo_removido: 'Anexo removido',
  vinculo_incluido: 'Vínculo com outro módulo incluído',
  vinculo_removido: 'Vínculo com outro módulo removido',
  ocorrencia_gerada: 'Ocorrência gerada automaticamente',
  ocorrencia_pulada: 'Ocorrência pulada',
  alterada_em_serie: 'Alterada junto com as demais ocorrências',
  recorrencia_criada: 'Recorrência criada',
  recorrencia_alterada: 'Recorrência alterada',
  recorrencia_suspensa: 'Recorrência suspensa',
  recorrencia_retomada: 'Recorrência retomada',
  recorrencia_cancelada: 'Recorrência cancelada',
  recorrencia_encerrada: 'Recorrência encerrada',
}

export type DemandMembership = {
  sectorId: string
  sectorName: string
  role: 'colaborador' | 'responsavel'
}

export type DemandProfile = 'servidor' | 'chefe' | 'diretor' | 'administrador'

export type DemandContext = Envelope & {
  migrated: boolean
  hasAccess: boolean
  administrator: boolean
  directorate: boolean
  consultationOnly: boolean
  profiles: DemandProfile[]
  canCreate: boolean
  createAnywhere: boolean
  creatableSectorIds: string[]
  canCreateEvents: boolean
  canSeeReports: boolean
  canConfigure: boolean
  memberships: DemandMembership[]
}

export type DemandOptions = Envelope & {
  sectors: { id: string; name: string; acronym: string | null }[]
  categories: { id: string; name: string; description: string | null }[]
  people: { id: string; name: string; sectorIds: string[]; isManager: boolean }[]
}

export type DemandSummary = {
  id: string
  number: string
  title: string
  category: string | null
  categoryId: string | null
  originSector: string | null
  originSectorId: string | null
  responsibleSector: string | null
  responsibleSectorId: string | null
  requester: string | null
  requesterId: string | null
  responsible: string | null
  responsibleId: string | null
  openedAt: string
  startDate: string | null
  dueDate: string | null
  priority: string
  status: DemandStatus
  draft: boolean
  restricted: boolean
  overdue: boolean
  dueSoon: boolean
  shared: boolean
  recurring: boolean
  occurrenceDate: string | null
  subtasks: number
  subtasksDone: number
  progress: number | null
  version: number
  updatedAt: string
}

export type DemandAccess = {
  read: boolean
  edit: boolean
  assign: boolean
  transfer: boolean
  comment: boolean
  attach: boolean
  subtasksManage: boolean
  follow: boolean
  readOnly: boolean
  administrativeRead: boolean
}

export type RecurrenceEnd =
  | { type: 'sem_fim' }
  | { type: 'quantidade'; count: number }
  | { type: 'data'; date: string }

export type RecurrenceInput = {
  frequency: string
  interval?: number
  unit?: string
  weekdays?: number[]
  monthDays?: number[]
  startDate: string
  end: RecurrenceEnd
  leadDays?: number
  startOffsetDays?: number
}

export type DemandSeries = {
  id: string
  status: string
  frequency: string
  interval: number
  unit: string
  weekdays: number[]
  monthDays: number[]
  startDate: string
  end: RecurrenceEnd
  leadDays: number
  startOffsetDays: number
  description: string
  nextExecution: string | null
  counted: number
  lastRunAt: string | null
  occurrences: { date: string; situation: string; reason: string | null; demandId: string | null; number: string | null; status: string | null }[]
  upcoming: string[]
}

export type DemandDetail = Envelope & {
  demand: DemandSummary & {
    description: string | null
    createdById: string
    createdBy: string
    followUpManagerId: string | null
    followUpManager: string | null
    notes: string | null
    references: string | null
    reminderDays: number | null
    waitingFor: string | null
    suspensionReason: string | null
    resumeDate: string | null
    completion: { done: string; result: string | null; notes: string | null; at: string; by: string } | null
    reopenings: number
    cancellation: { reason: string; at: string; by: string } | null
    customOccurrence: boolean
    draftRecurrence: RecurrenceInput | null
  }
  access: DemandAccess
  following: boolean
  participants: { userId: string; name: string; kind: string; activity: string | null; dueDate: string | null }[]
  collaboratorSectors: { id: string; name: string }[]
  subtasks: {
    id: string
    title: string
    description: string | null
    responsibleId: string | null
    responsible: string | null
    dueDate: string | null
    status: string
    notes: string | null
    completedAt: string | null
    overdue: boolean
    canUpdate: boolean
  }[]
  comments: { id: string; kind: string; text: string; at: string; author: string; mentions: string[] }[]
  history: { id: string; action: string; comment: string | null; details: Record<string, unknown>; at: string; user: string | null }[]
  attachments: {
    id: string
    name: string
    kind: string
    category: string
    sizeBytes: number
    subtaskId: string | null
    uploadedAt: string
    uploadedBy: string
    removedAt: string | null
    removedBy: string | null
    removalReason: string | null
    canRemove: boolean
  }[]
  links: { id: string; module: string; protocol: string; path: string | null }[]
  series: DemandSeries | null
}

export type DemandFilterValues = {
  q?: string
  number?: string
  text?: string
  requester?: string
  status?: string
  priority?: string
  sectorId?: string
  responsibleId?: string
  categoryId?: string
  from?: string
  to?: string
  dueFrom?: string
  dueTo?: string
  recurring?: string
  shared?: string
  overdue?: boolean
  unassigned?: boolean
  scope?: string
}

export type DemandDashboard = Envelope & {
  totals: Record<string, number>
  bySector: { label: string; value: number }[]
  byResponsible: { label: string; value: number }[]
  byStatus: { status: DemandStatus; value: number }[]
  monthly: { mes: string; abertas: number; concluidas: number }[]
  dueSoon: DemandSummary[]
  overdue: DemandSummary[]
  priority: DemandSummary[]
  unassigned: DemandSummary[]
  waiting: DemandSummary[]
  updates: { id: string; action: string; at: string; user: string | null; demandId: string; number: string; title: string }[]
  recurring: { seriesId: string; title: string; nextDate: string; description: string; restricted: boolean }[]
}

export type DemandReportGroup = { label: string; total: number; open: number; overdue: number }

export type DemandReport = Envelope & {
  totals: Record<string, number | null>
  bySector: DemandReportGroup[]
  byResponsible: DemandReportGroup[]
  byCategory: DemandReportGroup[]
  byPriority: DemandReportGroup[]
  byStatus: DemandReportGroup[]
  monthly: { mes: string; abertas: number; concluidas: number }[]
}

export type AgendaItem = {
  key: string
  kind: 'prazo' | 'inicio' | 'etapa' | 'recorrencia' | 'reuniao' | 'entrega' | 'atividade'
  date: string
  demandId: string | null
  number: string | null
  title: string
  status: string
  sector: string | null
  responsible: string | null
  recurring: boolean
  origins: { module: string; protocol: string; path: string | null }[]
  overdue: boolean
  dueSoon: boolean
  done: boolean
  eventId?: string
  start?: string
  end?: string | null
  description?: string | null
  canCancel?: boolean
}

export const agendaKindLabels: Record<AgendaItem['kind'], string> = {
  prazo: 'Prazo',
  inicio: 'Início previsto',
  etapa: 'Prazo de etapa',
  recorrencia: 'Recorrência prevista',
  reuniao: 'Reunião',
  entrega: 'Entrega',
  atividade: 'Atividade programada',
}

export type DemandSector = {
  id: string
  name: string
  acronym: string | null
  description: string | null
  active: boolean
  order: number
  isSlm: boolean
  members: {
    userId: string
    name: string
    email: string
    role: 'colaborador' | 'responsavel'
    canCreate: boolean
    seesSector: boolean
    chefia: boolean
    function: string | null
    accountActive: boolean
  }[]
}

export type DemandCategory = {
  id: string
  name: string
  description: string | null
  active: boolean
  order: number
  usage: number
}

export const fetchDemandContext = () => apiRequest<DemandContext>('/demands/context')
export const fetchDemandOptions = () => apiRequest<DemandOptions>('/demands/options')

export const listDemands = (filters: DemandFilterValues & { sort?: string; page?: number; pageSize?: number }) =>
  apiRequest<Envelope & { demands: DemandSummary[]; total: number; page: number; pageSize: number }>(
    `/demands${queryString(filters)}`,
  )

export const fetchDemand = (id: string) => apiRequest<DemandDetail>(`/demands/${id}`)
export const createDemand = (body: unknown) =>
  send<Envelope & { id: string; number: string; firstDate: string | null }>('/demands', 'POST', body)
export const updateDemand = (id: string, body: unknown) => send<Envelope>(`/demands/${id}`, 'PATCH', body)
export const publishDemand = (id: string) => send<Envelope>(`/demands/${id}/publish`, 'POST', {})
export const discardDemand = (id: string, reason: string) => send<Envelope>(`/demands/${id}/discard`, 'POST', { reason })
export const assignDemand = (id: string, body: { responsibleId: string | null; reason?: string; scope?: string; version?: number }) =>
  send<Envelope>(`/demands/${id}/assign`, 'POST', body)
export const setDemandCollaboration = (id: string, body: unknown) => send<Envelope>(`/demands/${id}/collaboration`, 'PUT', body)
export const followDemand = (id: string, following: boolean) => send<Envelope>(`/demands/${id}/follow`, 'POST', { following })
export const changeDemandStatus = (id: string, body: unknown) => send<Envelope>(`/demands/${id}/status`, 'POST', body)
export const completeDemand = (id: string, body: unknown) => send<Envelope>(`/demands/${id}/complete`, 'POST', body)
export const reopenDemand = (id: string, reason: string) => send<Envelope>(`/demands/${id}/reopen`, 'POST', { reason })
export const cancelDemand = (id: string, reason: string) => send<Envelope>(`/demands/${id}/cancel`, 'POST', { reason })
export const addDemandComment = (id: string, body: { kind: string; text: string; mentions: string[] }) =>
  send<Envelope>(`/demands/${id}/comments`, 'POST', body)
export const addDemandSubtask = (id: string, body: unknown) => send<Envelope>(`/demands/${id}/subtasks`, 'POST', body)
export const updateDemandSubtask = (id: string, subtaskId: string, body: unknown) =>
  send<Envelope>(`/demands/${id}/subtasks/${subtaskId}`, 'PATCH', body)
export const addDemandLink = (id: string, body: { module: string; protocol: string }) => send<Envelope>(`/demands/${id}/links`, 'POST', body)
export const removeDemandLink = (id: string, linkId: string) => send<Envelope>(`/demands/${id}/links/${linkId}/remove`, 'POST', {})

export const fetchDemandAttachmentLimits = (id: string) =>
  apiRequest<Envelope & { limits: { maxFileMb: number; allowedKinds: string[] }; storageConfigured: boolean }>(
    `/demands/${id}/attachment-limits`,
  )

export const uploadDemandAttachment = (
  id: string,
  file: File,
  category: 'documento' | 'comprovante' = 'documento',
  subtaskId?: string,
) =>
  apiRequest<Envelope & { id: string }>(`/demands/${id}/attachments${queryString({ categoria: category, etapa: subtaskId || undefined })}`, {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
  })

export const removeDemandAttachment = (attachmentId: string, reason: string) =>
  send<Envelope>(`/demands/attachments/${attachmentId}/remove`, 'POST', { reason })
export const demandAttachmentUrl = (attachmentId: string, inline = false) =>
  `/api/demands/attachments/${attachmentId}/content${inline ? '?inline=1' : ''}`

export const suspendSeries = (id: string, reason: string) => send<Envelope>(`/demands/${id}/series/suspend`, 'POST', { reason })
export const resumeSeries = (id: string) => send<Envelope>(`/demands/${id}/series/resume`, 'POST', {})
export const cancelSeries = (id: string, body: { reason: string; cancelFuture: boolean }) =>
  send<Envelope>(`/demands/${id}/series/cancel`, 'POST', body)
export const skipOccurrence = (id: string, body: { reason: string; date?: string }) =>
  send<Envelope>(`/demands/${id}/series/skip`, 'POST', body)
export const changeSeriesRule = (id: string, body: RecurrenceInput) => send<Envelope>(`/demands/${id}/series/rule`, 'POST', body)

export const fetchDemandDashboard = (filters: DemandFilterValues) =>
  apiRequest<DemandDashboard>(`/demands/dashboard${queryString(filters)}`)
export const fetchDemandReport = (filters: DemandFilterValues) =>
  apiRequest<DemandReport>(`/demands/reports${queryString(filters)}`)
export const demandReportUrl = (filters: DemandFilterValues, format: 'pdf' | 'xlsx') =>
  `/api/demands/reports/export${queryString({ ...filters, format })}`

export const fetchDemandAgenda = (filters: { from: string; to: string; scope?: string; sectorId?: string; responsibleId?: string }) =>
  apiRequest<Envelope & { items: AgendaItem[] }>(`/demands/agenda${queryString(filters)}`)
export const createAgendaEvent = (body: unknown) => send<Envelope & { id: string }>('/demands/agenda/events', 'POST', body)
export const cancelAgendaEvent = (eventId: string) => send<Envelope>(`/demands/agenda/events/${eventId}/cancel`, 'POST', {})

export const fetchDemandPreferences = () =>
  apiRequest<Envelope & { preferences: { reminderDays: number; muted: string[]; email: boolean } }>('/demands/preferences')
export const saveDemandPreferences = (body: { reminderDays: number; muted: string[]; email: boolean }) =>
  send<Envelope>('/demands/preferences', 'PUT', body)

export const listDemandSectors = () => apiRequest<Envelope & { sectors: DemandSector[] }>('/demands/settings/sectors')
export const createDemandSector = (body: { name: string; acronym?: string; order?: number; isSlm?: boolean }) =>
  send<Envelope & { id: string }>('/demands/settings/sectors', 'POST', body)
export const updateDemandSector = (id: string, body: { name: string; acronym?: string | null; order: number; active: boolean; isSlm: boolean }) =>
  send<Envelope>(`/demands/settings/sectors/${id}`, 'PATCH', body)
export const searchDemandUsers = (q: string) =>
  apiRequest<Envelope & { users: { id: string; name: string; email: string; sector: string | null }[] }>(
    `/demands/settings/users${queryString({ q })}`,
  )
export const setDemandMember = (
  sectorId: string,
  userId: string,
  body: { role: string; canCreate: boolean; seesSector: boolean; chefia?: boolean; function?: string | null },
) =>
  send<Envelope>(`/demands/settings/sectors/${sectorId}/members/${userId}`, 'PUT', body)
export const removeDemandMember = (sectorId: string, userId: string) =>
  send<Envelope>(`/demands/settings/sectors/${sectorId}/members/${userId}/remove`, 'POST', {})
export type DirectorateLink = {
  userId: string
  name: string
  email: string
  role: string
  function: string | null
  accountActive: boolean
}
export const listDirectorateLinks = () => apiRequest<Envelope & { links: DirectorateLink[] }>('/demands/settings/directorate')
export const setDirectorateLink = (userId: string, body: { role: string; function?: string | null }) =>
  send<Envelope>(`/demands/settings/directorate/${userId}`, 'PUT', body)
export const removeDirectorateLink = (userId: string) => send<Envelope>(`/demands/settings/directorate/${userId}/remove`, 'POST', {})
export const listDemandCategories = () => apiRequest<Envelope & { categories: DemandCategory[] }>('/demands/settings/categories')
export const createDemandCategory = (body: { name: string; order?: number }) =>
  send<Envelope & { id: string }>('/demands/settings/categories', 'POST', body)
export const updateDemandCategory = (id: string, body: { name: string; description?: string | null; order: number; active: boolean }) =>
  send<Envelope>(`/demands/settings/categories/${id}`, 'PATCH', body)
