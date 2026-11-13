import type { ExecutionField, FieldPlacement, PortalConfiguration, PortalOccurrenceType, TripField, TripGroup } from './driverApi'
import { apiRequest } from '../auth/apiClient'
import type { RequestModule } from './modulesApi'

type Envelope = { success: boolean; message?: string }

function send<Response extends Envelope>(path: string, method: string, body?: unknown) {
  return apiRequest<Response>(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function queryString(values: Record<string, string | number | undefined | null>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  }
  const text = query.toString()
  return text ? `?${text}` : ''
}

export const priorityLabels: Record<string, string> = {
  baixa: 'Baixa',
  normal: 'Normal',
  alta: 'Alta',
  urgente: 'Urgente',
}

export const complexityLabels: Record<string, string> = {
  simples: 'Simples',
  media: 'Média',
  complexa: 'Complexa',
}

// ---------------------------------------------------------------------------
// Central de Operações
// ---------------------------------------------------------------------------
export type QueueKey =
  | 'awaiting_service'
  | 'awaiting_schedule'
  | 'today'
  | 'late'
  | 'approval'
  | 'unassigned'
  | 'in_progress'
  | 'concluded'
  | 'cancelled'
  | 'stale'
  | 'near_due'
  | 'awaiting_requester'
  | 'awaiting_internal'

export type CentralOverview = Envelope & {
  counts: Record<QueueKey, number>
  staleDays: number
  warningDays: number
  timing: {
    basedOn: number
    requesterWaitSeconds: number | null
    internalSeconds: number | null
    totalSeconds: number | null
  }
  byModule: { module: RequestModule; open: number; total: number }[]
  bySector: { sector: string; open: number }[]
  communications: {
    emailsPending: number
    emailsFailed: number
    emailsNotConfigured: number
    calendarFailed: number
  } | null
  warehouse: { openRequests: number } | null
}

export type CentralRequest = {
  id: string
  protocol: string
  module: RequestModule
  status: string
  title: string
  requester: string
  sector: string | null
  responsibleId: string | null
  responsible: string | null
  priority: string
  complexity: string | null
  deadline: string | null
  scheduledAt: string | null
  createdAt: string
  updatedAt: string
  late: boolean
  stale: boolean
  nearDue: boolean
  waitingRequester: boolean
}

export type TeamMember = {
  id: string
  name: string
  open: number
  late: number
  inProgress: number
  urgent: number
  concluded30d: number
  complexity: { simple: number; medium: number; complex: number; unclassified: number }
}

export type CentralFilters = {
  queue?: string
  module?: string
  sectorId?: string
  responsibleId?: string
  status?: string
  from?: string
  to?: string
  search?: string
  page: number
}

export const getCentralOverview = () => apiRequest<CentralOverview>('/slm/overview')

export const listCentralRequests = (filters: CentralFilters) =>
  apiRequest<Envelope & { requests: CentralRequest[]; total: number; page: number; pageSize: number }>(
    `/slm/requests${queryString(filters)}`,
  )

export const getCentralTeam = () => apiRequest<Envelope & { team: TeamMember[] }>('/slm/team')

const central = (id: string, action: string) => `/slm/requests/${id}/${action}`

export const assignRequest = (id: string, responsavelId: string | null, justificativa: string) =>
  send<Envelope>(central(id, 'assign'), 'POST', { responsavelId, justificativa })

export const setRequestPriority = (id: string, prioridade: string, justificativa: string) =>
  send<Envelope>(central(id, 'priority'), 'POST', { prioridade, justificativa })

export const setRequestDeadline = (id: string, prazo: string | null, justificativa: string) =>
  send<Envelope>(central(id, 'deadline'), 'POST', { prazo, justificativa })

export const setRequestComplexity = (id: string, complexidade: string | null) =>
  send<Envelope>(central(id, 'complexity'), 'POST', { complexidade })

export const addRequestNote = (id: string, texto: string) =>
  send<Envelope>(central(id, 'notes'), 'POST', { texto })

// ---------------------------------------------------------------------------
// Anexos
// ---------------------------------------------------------------------------
export type AttachmentResource = 'service_request' | 'material_request'

export type Attachment = {
  id: string
  category: string
  name: string
  kind: string
  sizeBytes: number
  sha256: string
  restricted: boolean
  uploadedBy: string
  uploadedAt: string
  removedAt: string | null
  removedBy: string | null
  removalReason: string | null
}

export const attachmentCategoryLabels: Record<string, string> = {
  orcamento: 'Orçamento',
  comprovante: 'Comprovante',
  fotografia_antes: 'Fotografia: antes',
  fotografia_depois: 'Fotografia: depois',
  fotografia: 'Fotografia',
  execucao: 'Documento de execução',
  bilhete: 'Bilhete aéreo',
  relatorio: 'Relatório',
  outro: 'Outro documento',
}

export function attachmentCategoriesFor(module: RequestModule | 'warehouse') {
  const common = ['comprovante', 'relatorio', 'outro']
  if (module === 'maintenance') return ['orcamento', 'fotografia_antes', 'fotografia_depois', 'execucao', ...common]
  if (module === 'fleet') return ['orcamento', 'fotografia', 'execucao', ...common]
  if (module === 'flights') return ['orcamento', 'bilhete', ...common]
  return ['fotografia', ...common]
}

export const listAttachments = (type: AttachmentResource, id: string) =>
  apiRequest<
    Envelope & {
      attachments: Attachment[]
      limits: { maxFileMb: number; allowedKinds: string[] }
      storageConfigured: boolean
    }
  >(`/attachments/resources/${type}/${id}`)

export const uploadAttachment = (
  type: AttachmentResource,
  id: string,
  file: File,
  options: { category: string; restricted?: boolean },
) =>
  apiRequest<Envelope & { id: string }>(
    `/attachments/resources/${type}/${id}${queryString({
      categoria: options.category,
      restrito: options.restricted === undefined ? undefined : String(options.restricted),
    })}`,
    {
      method: 'POST',
      body: file,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
      },
    },
  )

export const removeAttachment = (id: string, justificativa: string) =>
  send<Envelope>(`/attachments/files/${id}/remove`, 'POST', { justificativa })

export const attachmentUrl = (id: string, inline = false) =>
  `/api/attachments/files/${id}/content${inline ? '?inline=1' : ''}`

// ---------------------------------------------------------------------------
// Pesquisa global
// ---------------------------------------------------------------------------
export type SearchHit = {
  id: string
  title: string
  subtitle: string | null
  protocol: string | null
  module: string
  status: string | null
  at: string | null
  link: string
}

export type SearchCategoryResult = { hits: SearchHit[]; total: number; page: number; pageSize: number }

export const searchCategoryLabels: Record<string, string> = {
  requests: 'Solicitações',
  schedules: 'Agendamentos',
  history: 'Histórico de atendimento',
  materials: 'Materiais',
  warehouseRequests: 'Pedidos do Almoxarifado',
  inventoryChecks: 'Inventário',
  vehicles: 'Veículos',
}

export const globalSearch = (filters: {
  q: string
  module?: string
  status?: string
  from?: string
  to?: string
  category?: string
  page?: number
}) =>
  apiRequest<Envelope & { results: Record<string, SearchCategoryResult> }>(`/search${queryString(filters)}`)

// ---------------------------------------------------------------------------
// Frota
// ---------------------------------------------------------------------------
export const vehicleStatusLabels: Record<string, string> = {
  disponivel: 'Disponível',
  em_uso: 'Em uso',
  em_manutencao: 'Em manutenção',
  inativo: 'Inativo',
}

export const vehicleLogLabels: Record<string, string> = {
  utilizacao: 'Utilização',
  ocorrencia: 'Ocorrência',
  abastecimento: 'Abastecimento',
  manutencao: 'Manutenção ou intervenção',
}

export type Vehicle = {
  id: string
  plate: string
  model: string
  identification: string | null
  status: string
  currentKm: number
  nextReviewKm: number | null
  nextReviewDate: string | null
  reviewAlert: 'vencida' | 'proxima' | null
}

export type VehicleLog = {
  id: string
  type: string
  at: string
  startKm: number | null
  endKm: number | null
  liters: number | null
  value: number | null
  description: string
  registeredBy: string
  protocol: string | null
  requestId: string | null
}

export type VehicleDetail = Envelope & {
  vehicle: Vehicle
  logs: VehicleLog[]
  summary: {
    kmDriven: number
    fuelings: number
    liters: number
    spent: number
    occurrences: number
    interventions: number
  }
  total: number
  page: number
  pageSize: number
}

export const listVehicles = () => apiRequest<Envelope & { vehicles: Vehicle[] }>('/fleet/vehicles')
export const getVehicle = (id: string, page: number) =>
  apiRequest<VehicleDetail>(`/fleet/vehicles/${id}?page=${page}`)
export const createVehicle = (body: unknown) => send<Envelope & { id: string }>('/fleet/vehicles', 'POST', body)
export const updateVehicle = (id: string, body: unknown) => send<Envelope>(`/fleet/vehicles/${id}`, 'PATCH', body)
export const addVehicleLog = (id: string, body: unknown) => send<Envelope>(`/fleet/vehicles/${id}/logs`, 'POST', body)

// ---------------------------------------------------------------------------
// Manutenção
// ---------------------------------------------------------------------------
export type Equipment = {
  id: string
  name: string
  identification: string | null
  location: string | null
  active: boolean
  executions: number
  lastExecution: string | null
}

export type Execution = {
  id: string
  requestId: string
  protocol: string
  equipment: string | null
  executedBy: string
  executedAt: string
  service: string
  pending: string | null
  registeredBy: string
  at: string
}

export const listEquipments = (inactive = false) =>
  apiRequest<Envelope & { equipments: Equipment[] }>(`/maintenance/equipments${inactive ? '?inactive=true' : ''}`)
export const createEquipment = (body: unknown) => send<Envelope>('/maintenance/equipments', 'POST', body)
export const updateEquipment = (id: string, body: unknown) =>
  send<Envelope>(`/maintenance/equipments/${id}`, 'PATCH', body)
export const getEquipmentHistory = (id: string) =>
  apiRequest<Envelope & { executions: Execution[] }>(`/maintenance/equipments/${id}/history`)
export const listExecutions = (requestId: string) =>
  apiRequest<Envelope & { executions: Execution[] }>(`/maintenance/requests/${requestId}/executions`)
export const addExecution = (requestId: string, body: unknown) =>
  send<Envelope>(`/maintenance/requests/${requestId}/executions`, 'POST', body)

// ---------------------------------------------------------------------------
// Passagens
// ---------------------------------------------------------------------------
export type FlightQuote = {
  id: string
  company: string
  flights: string
  value: number
  conditions: string | null
  validUntil: string | null
  selected: boolean
  registeredBy: string
  at: string
}

export const listQuotes = (requestId: string) =>
  apiRequest<Envelope & { quotes: FlightQuote[] }>(`/flights/requests/${requestId}/quotes`)
export const addQuote = (requestId: string, body: unknown) =>
  send<Envelope>(`/flights/requests/${requestId}/quotes`, 'POST', body)
export const selectQuote = (requestId: string, quoteId: string, justificativa: string) =>
  send<Envelope>(`/flights/requests/${requestId}/quotes/${quoteId}/select`, 'POST', { justificativa })

// ---------------------------------------------------------------------------
// Estoque interno
// ---------------------------------------------------------------------------
export type StockItem = {
  id: string
  code: string | null
  name: string
  unit: string
  current: number
  minimum: number
  belowMinimum: boolean
  reserved: number
  available: number
  provided: number
  /** Pedidos entregues nos últimos 12 meses, ou desde a primeira entrega, se for mais recente. */
  monthlyConsumption?: { average: number | null; total: number; months: number | null }
  lastMovement: string | null
  /** Só para quem vê valores (warehouse:finance). Nulo sem a migração 020. */
  stockValue?: number | null
  averageCost?: number | null
}

export type StockMovement = {
  id: string
  material: string
  unit: string
  type: string
  quantity: number
  reason: string | null
  user: string
  at: string
  value?: number | null
  valueInformed?: boolean
  invoice?: string | null
  commitment?: string | null
  supplier?: string | null
  agreement?: string | null
}

export const listStock = (filters: { search?: string; belowMinimum?: boolean }) =>
  apiRequest<Envelope & { items: StockItem[] }>(
    `/warehouse/stock${queryString({ search: filters.search, belowMinimum: filters.belowMinimum ? 'true' : undefined })}`,
  )
export const setStockMinimum = (id: string, minimo: number | string) =>
  send<Envelope>(`/warehouse/stock/${id}/minimum`, 'PUT', { minimo })
export const setStockReserved = (id: string, reservada: number | string, justificativa: string) =>
  send<Envelope>(`/warehouse/stock/${id}/reserved`, 'PUT', { reservada, justificativa })
export const listStockMovements = (filters: { materialId?: string; page: number }) =>
  apiRequest<Envelope & { movements: StockMovement[]; total: number; page: number; pageSize: number }>(
    `/warehouse/stock-movements${queryString(filters)}`,
  )
export const addStockMovement = (body: {
  materialId: string
  tipo: string
  quantidade: number | string
  justificativa: string
  valorPago?: string
  notaFiscal?: string
  empenho?: string
  fornecedor?: string
  ataId?: string
  itemAtaId?: string
}) => send<Envelope>('/warehouse/stock-movements', 'POST', body)

// ---------------------------------------------------------------------------
// Valores do Almoxarifado (warehouse:finance)
// ---------------------------------------------------------------------------
export type PriceAgreement = {
  id: string
  number: string
  supplier: string | null
  subject: string | null
  total: number
  spent: number
  balance: number
  usedPercent: number | null
  entries: number
  validFrom: string | null
  validUntil: string | null
  active: boolean
  situation: 'vigente' | 'futura' | 'vencida' | 'encerrada'
}

/** Ata ou contrato de materiais do Controle de Demandas, com o saldo de cada item. */
export type MaterialInstrument = {
  id: string
  type: string
  number: string
  subject: string
  supplier: string | null
  sector: string
  total: number
  spent: number
  balance: number
  usedPercent: number | null
  validUntil: string | null
  expired: boolean
  items: { id: string; description: string; unit: string; unitPrice: number; balance: number }[]
}

export const listMaterialInstruments = () =>
  apiRequest<Envelope & { instruments: MaterialInstrument[] }>('/warehouse/finance/instruments')

export type FinanceMaterial = {
  id: string
  code: string | null
  name: string
  unit: string
  quantity: number
  stockValue: number
  averageCost: number | null
  lastPrice: number | null
}

export type WarehouseFinanceSummary = {
  period: { from: string; to: string }
  stockValue: number
  materialsInStock: number
  materialsWithoutValue: number
  purchases: number
  consumption: number
  agreementsTotal: number
  agreementsSpent: number
  agreementsBalance: number
  monthly: { month: string; purchases: number; consumption: number }[]
  mostExpensive: FinanceMaterial[]
  highestStockValue: FinanceMaterial[]
  topSpend: { name: string; unit: string; quantity: number; value: number }[]
  bySector: { sector: string; value: number; requests: number }[]
  agreements: PriceAgreement[]
  instruments?: MaterialInstrument[]
  withoutValue: { id: string; code: string | null; name: string; unit: string; quantity: number }[]
}

export type PriceAgreementInput = {
  numero: string
  fornecedor: string
  objeto: string
  valorTotal: string
  vigenciaInicio: string
  vigenciaFim: string
  ativo: boolean
}

export const getWarehouseFinance = (filters: { from?: string; to?: string }) =>
  apiRequest<Envelope & { summary: WarehouseFinanceSummary }>(`/warehouse/finance${queryString(filters)}`)
export const listPriceAgreements = () =>
  apiRequest<Envelope & { agreements: PriceAgreement[] }>('/warehouse/finance/agreements')
export const createPriceAgreement = (body: PriceAgreementInput) =>
  send<Envelope & { id: string }>('/warehouse/finance/agreements', 'POST', body)
export const updatePriceAgreement = (id: string, body: PriceAgreementInput) =>
  send<Envelope>(`/warehouse/finance/agreements/${id}`, 'PUT', body)
export const setStockValue = (id: string, valor: string, justificativa: string) =>
  send<Envelope>(`/warehouse/stock/${id}/value`, 'PUT', { valor, justificativa })

/** Reais no formato brasileiro. Nulo vira travessão. */
export const formatMoney = (value: number | null | undefined) =>
  value === null || value === undefined
    ? '—'
    : value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

// ---------------------------------------------------------------------------
// Indicadores
// ---------------------------------------------------------------------------
type Average = { minutes: number | null; basedOn: number }

export type PerformanceReport = Envelope & {
  received: number
  concluded: number
  pending: number
  late: number
  cancelled: number
  rescheduled: number
  times: {
    untilSchedule: Average
    waitUntilStart: Average
    effectiveService: Average
    totalResolution: Average
  }
  deadlines: { withDeadline: number; onTime: number; percent: number | null }
  byCategory: { category: string; total: number }[]
  monthly: { month: string; received: number; concluded: number }[]
  productivity:
    | {
        responsible: string
        concluded: number
        open: number
        complexity: { simple: number; medium: number; complex: number; unclassified: number }
        effectiveMinutes: number | null
        basedOn: number
      }[]
    | null
}

export const getPerformanceReport = (filters: Record<string, string | undefined>) =>
  apiRequest<PerformanceReport>(`/reports/performance${queryString(filters)}`)

// ---------------------------------------------------------------------------
// Monitoramento e revisão de acessos
// ---------------------------------------------------------------------------
export const serviceLabels: Record<string, string> = {
  api: 'API',
  database: 'Banco de dados',
  email: 'E-mail',
  calendar: 'Calendário',
  storage: 'Armazenamento de anexos',
  worker: 'Rotinas automáticas',
}

export type MonitoringStatus = Envelope & {
  checks: { service: string; status: 'up' | 'down' | 'not_configured'; detail: string | null; responseMs: number | null }[]
  availability: {
    service: string
    since: string
    availabilityPercent: number | null
    downMinutes: number
    unknownMinutes: number
  }[]
  incidents: { service: string; status: string; startedAt: string; endedAt: string; detail: string | null }[]
  errorsLast24h: number
  monitoringActive: boolean
  backup: {
    configured: boolean
    last?: { at: string; ok: boolean; sizeBytes: number | null } | null
    lastVerified?: { at: string; ok: boolean } | null
    unreadable?: boolean
  }
}

export const getMonitoringStatus = () => apiRequest<MonitoringStatus>('/monitoring/status')

export const listTechnicalEvents = (filters: { service?: string; page: number }) =>
  apiRequest<
    Envelope & {
      events: { id: string; service: string; event: string; errorName: string | null; errorCode: string | null; at: string }[]
      total: number
      page: number
      pageSize: number
    }
  >(`/monitoring/events${queryString(filters)}`)

export type ReviewedUser = {
  id: string
  name: string
  email: string
  sector: string
  status: string
  role: string | null
  slmMember: boolean
  administrator: boolean
  restrictedPermissions: string[]
  lastAccess: string | null
  lastReview: string | null
  lastReviewBy: string | null
  lastReviewResult: string | null
  reasons: string[]
}

export const getAccessReview = () =>
  apiRequest<Envelope & { users: ReviewedUser[]; criteria: { reviewIntervalDays: number; inactivityDays: number } }>(
    '/admin/access-review',
  )
export const addAccessReview = (userId: string, resultado: string, observacao: string) =>
  send<Envelope>(`/admin/access-review/${userId}`, 'POST', { resultado, observacao })
export const listUserSessions = (userId: string) =>
  apiRequest<Envelope & { sessions: { id: string; createdAt: string; lastSeenAt: string; expiresAt: string }[] }>(
    `/admin/users/${userId}/sessions`,
  )

// ---------------------------------------------------------------------------
// Parâmetros
// ---------------------------------------------------------------------------
export type SecurityEmails = {
  newLogin: boolean
  lockout: boolean
  sessionsRevoked: boolean
  adminAlerts: boolean
}

export type SystemSettings = {
  operations: { staleDays: number; deadlineDays: Record<string, number | null> }
  notifications: {
    disabled: Record<string, string[]>
    pendingReminderDays: number | null
    /** E-mails de segurança. Ausente em respostas antigas: valem os padrões do servidor. */
    securityEmails?: SecurityEmails
  }
  attachments: { maxFileMb: number; maxTotalMb: number; allowedKinds: string[] }
  calendar: { workdayStart: string; workdayEnd: string }
  emailTemplates: { overrides: Record<string, { subject?: string; intro?: string }> }
  forms: { definitions: unknown }
  communications: { maxEmailMb: number; maxRecipients: number; allowExternalRecipients: boolean }
  reasons: Record<string, { key: string; label: string; active: boolean }[]>
  deadlines: {
    warningDays: number
    byModule: Record<string, number | null>
    byServiceType: Record<string, number>
  }
  driverJourney: PortalConfiguration['journey']
  driverExecution: { startFields: ExecutionField[]; finishFields: ExecutionField[]; upcomingDays: number; visibleGroups: TripGroup[] }
  driverAccess: { portalEnabled: boolean; occurrencesEnabled: boolean; attachmentsEnabled: boolean; allowDocuments: boolean; allowPhotos: boolean }
  driverNotifications: { rules: Record<string, { driver: boolean; team: boolean }> }
  driverDisplay: {
    fields: Record<TripField, FieldPlacement>
    notices: { text: string; active: boolean }[]
    guidance: { active: boolean; text: string }
    contact: { active: boolean; name: string; phone: string; email: string; hours: string }
  }
  // Administração do sistema (13/11/2026).
  registration: { allowedDomains: string[] }
  holidays: { list: { date: string; name: string }[] }
  announcement: { active: boolean; text: string; tone: 'info' | 'warning'; until: string | null }
  modules: Record<'maintenance' | 'fleet' | 'flights' | 'warehouse' | 'demands', boolean>
  contracts: { defaultNoticeDays: number; lowBalancePercent: number }
  texts: { loginMessage: string; homeMessage: string }
  profileDefaults: Record<'requester' | 'slm_operator', { add: string[]; remove: string[] }>
}

export type OccurrenceType = PortalOccurrenceType & { active: boolean }
export type SettingsChange = { id: string; section: string; before: unknown; after: unknown; user: string | null; at: string }

export const listOccurrenceTypes = () => apiRequest<Envelope & { types: OccurrenceType[] }>('/settings/driver-occurrence-types')
export const createOccurrenceType = (body: Omit<OccurrenceType, 'key'>) =>
  send<Envelope & { type: OccurrenceType }>('/settings/driver-occurrence-types', 'POST', body)
export const updateOccurrenceType = (key: string, body: Omit<OccurrenceType, 'key'>) =>
  send<Envelope & { type: OccurrenceType }>(`/settings/driver-occurrence-types/${key}`, 'PATCH', body)
export const getDriverPortalHistory = () => apiRequest<Envelope & { history: SettingsChange[] }>('/settings/history?section=driverPortal')

export type ParametersResponse = Envelope & {
  settings: SystemSettings
  options: {
    notificationCategories: { key: string; label: string; requiresAction: boolean }[]
    attachmentKinds: string[]
    templates: { key: string; label: string }[]
    reasonGroups: { key: string; label: string }[]
    driverPortal: {
      notificationEvents: { key: string; label: string; appliesToDriver: boolean }[]
      tripFields: { key: TripField; label: string }[]
    }
    profileDefaults?: {
      adjustable: { key: string; label: string }[]
      base: Record<'requester' | 'slm_operator', string[]>
    }
  }
}

export const getParameters = () => apiRequest<ParametersResponse>('/settings/parameters')
export const saveParameters = (section: keyof SystemSettings, value: unknown) =>
  send<Envelope & { value: unknown }>(`/settings/parameters/${section}`, 'PUT', value)
export const getAttachmentCapacity = () =>
  apiRequest<Envelope & { configured: boolean; usedBytes: number; files: number; maxTotalBytes: number }>(
    '/attachments/capacity',
  )
