import { apiRequest } from '../auth/apiClient'

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

// ---------------------------------------------------------------------------
// Rótulos
// ---------------------------------------------------------------------------
export const statusLabels: Record<string, string> = {
  aguardando_agendamento: 'Aguardando agendamento',
  agendado: 'Agendado',
  reagendado: 'Reagendado',
  em_andamento: 'Em andamento',
  concluido: 'Concluído',
  cancelado: 'Cancelado',
  em_cotacao: 'Em cotação',
  aguardando_aprovacao: 'Aguardando aprovação',
  em_emissao: 'Em emissão',
  emitida: 'Emitida',
  cancelada: 'Cancelada',
}

export const warehouseStatusLabels: Record<string, string> = {
  pendente: 'Pendente',
  em_analise: 'Em análise',
  atendido_parcial: 'Atendido parcialmente',
  atendido: 'Atendido',
  entregue: 'Entregue',
  rejeitado: 'Rejeitado',
  cancelado: 'Cancelado',
}

export const originLabels: Record<string, string> = {
  interna: 'Sistema JUCESP',
  governamental: 'Sistema governamental',
}

export const historyActionLabels: Record<string, string> = {
  criada: 'Solicitação criada',
  editada: 'Dados alterados',
  agendada: 'Agendamento realizado',
  reagendada: 'Reagendamento',
  iniciada: 'Atendimento iniciado',
  concluida: 'Atendimento concluído',
  cancelada: 'Solicitação cancelada',
  status_alterado: 'Status alterado',
  ocorrencia_registrada: 'Ocorrência registrada',
  atraso_registrado: 'Atraso registrado',
  motorista_atribuido: 'Motorista atribuído',
  motorista_removido: 'Motorista retirado',
  motorista_orientacao_alterada: 'Observações para o motorista alteradas',
  ocorrencia_motorista: 'Ocorrência registrada pelo motorista',
  execucao_dados_motorista: 'Dados informados pelo motorista',
  execucao_corrigida: 'Horários de execução corrigidos',
  responsavel_alterado: 'Responsável alterado',
  prioridade_alterada: 'Prioridade alterada',
  prazo_alterado: 'Prazo alterado',
  complexidade_alterada: 'Complexidade alterada',
  nota_interna: 'Observação interna registrada',
  anexo_incluido: 'Anexo incluído',
  anexo_removido: 'Anexo removido',
  passageiros_alterados: 'Passageiros alterados',
  criado: 'Pedido criado',
  registrado_externo: 'Pedido externo registrado',
  editado: 'Registro local alterado',
  itens_alterados: 'Itens alterados',
  entregue: 'Entrega registrada',
  execucao_registrada: 'Execução registrada',
  cotacao_registrada: 'Cotação registrada',
  cotacao_selecionada: 'Cotação escolhida',
  agendamento_alterado: 'Agendamento alterado',
  devolvida_para_correcao: 'Devolvida para correção',
  informacoes_solicitadas: 'Informações complementares solicitadas',
  corrigida_pelo_solicitante: 'Dados corrigidos pelo solicitante',
  devolucao_respondida: 'Devolução respondida',
  devolucao_encerrada: 'Devolução encerrada pela equipe',
  email_registrado: 'E-mail registrado pela equipe',
  passagem_encaminhada: 'Passagem encaminhada por e-mail',
}

export const moduleLabels: Record<string, string> = {
  maintenance: 'Manutenção',
  fleet: 'Frota',
  flights: 'Passagens aéreas',
  warehouse: 'Almoxarifado',
}

export const modulePaths: Record<string, string> = {
  maintenance: '/manutencao',
  fleet: '/frota',
  flights: '/passagens-aereas',
}

/** Número antigo com "#"; o código novo (MAN-2026-00001) aparece como é. */
export function protocolLabel(protocol: string) {
  return /^\d+$/.test(protocol) ? `#${protocol}` : protocol
}

export function formatDateTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('pt-BR') : '—'
}

/** AAAA-MM-DD para DD/MM/AAAA, sem passar por Date: o dia não muda com o fuso. */
export function formatCalendarDate(value: string | null | undefined) {
  return value ? value.split('-').reverse().join('/') : '—'
}

/** Hoje, em AAAA-MM-DD, no fuso em que a equipe trabalha e que a API confere. */
export function todayCalendarDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
}

export function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleDateString('pt-BR') : '—'
}

/** Valor de um campo datetime-local a partir de uma data ISO, no fuso de quem usa. */
export function toLocalInput(value: string | null | undefined) {
  if (!value) return ''
  const date = new Date(value)
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function fromLocalInput(value: string) {
  return value ? new Date(value).toISOString() : undefined
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------
export type CatalogCategory =
  | 'sectors'
  | 'floors'
  | 'serviceTypes'
  | 'warehouseCategories'
  | 'measurementUnits'

export type CatalogOption = {
  id: string
  label: string
  acronym: string | null
  active: boolean
}

export type Catalog = Record<CatalogCategory, CatalogOption[]>

type CatalogResponse = Envelope & { catalog: Catalog }
type OptionResponse = Envelope & { option: CatalogOption }

export const fetchActiveCatalog = () => apiRequest<CatalogResponse>('/catalog')
export const fetchFullCatalog = () => apiRequest<CatalogResponse>('/settings/catalog')

export const createOption = (category: CatalogCategory, label: string, acronym?: string) =>
  send<OptionResponse>(`/settings/catalog/${category}`, 'POST', { label, acronym })

export const updateOption = (category: CatalogCategory, id: string, label: string, acronym?: string | null) =>
  send<OptionResponse>(`/settings/catalog/${category}/${id}`, 'PATCH', { label, acronym })

export const setOptionActive = (category: CatalogCategory, id: string, active: boolean) =>
  send<OptionResponse>(
    `/settings/catalog/${category}/${id}/${active ? 'activate' : 'deactivate'}`,
    'POST',
  )

// ---------------------------------------------------------------------------
// Solicitações
// ---------------------------------------------------------------------------
export type RequestModule = 'maintenance' | 'fleet' | 'flights'

export type ServiceRequest = {
  id: string
  protocol: string
  module: RequestModule
  status: string
  requester: { id: string; name: string; email: string }
  openedBy: string | null
  onBehalf: boolean
  sector: string | null
  floor: string | null
  serviceType: string | null
  title: string
  description: string | null
  priority: string
  deadline: string | null
  complexity: string | null
  details: Record<string, unknown>
  scheduledAt: string | null
  scheduledEnd: string | null
  scheduledBy: string | null
  responsibleId: string | null
  responsible: string | null
  operatorNote: string | null
  startedAt: string | null
  finishedAt: string | null
  concludedAt: string | null
  /** Só para quem atende Passagens. */
  ticketStatus?: 'nao_enviado' | 'enviado' | 'falha' | 'pendente'
  /** Só para quem atende a Frota. */
  driverName?: string | null
  cancelReason: string | null
  floorId: string | null
  serviceTypeId: string | null
  waitingSince: string | null
  timing: { requesterWaitSeconds: number; internalSeconds: number; totalSeconds: number }
  createdAt: string
  updatedAt: string
}

export type HistoryEntry = {
  id: string
  action: string
  from: string | null
  to: string | null
  comment: string | null
  details: Record<string, unknown>
  user: string | null
  at: string
}

export type Occurrence = {
  id: string
  type: string
  description: string
  delayMinutes: number | null
  user: string
  at: string
}

export type PassengerSummary = { id: string; name: string; cpfMasked: string }

export type RequestActions = {
  edit: boolean
  schedule: boolean
  start: boolean
  complete: boolean
  cancel: boolean
  advanceTo: string | null
  occurrence: boolean
  editPassengers: boolean
  upload: boolean
  removeAttachment: boolean
  returnForCorrection: boolean
  closeReturn: boolean
  respondReturn: boolean
}

export type RequestReturn = {
  id: string
  type: 'correcao' | 'complementacao'
  reason: string
  fields: string[]
  status: 'aberta' | 'atendida' | 'encerrada'
  response: string | null
  returnedAt: string
  finishedAt: string | null
  returnedBy?: string | null
}

export type PossibleDuplicate = {
  canOpen: boolean
  id?: string
  protocol?: string
  title?: string
  status: string
  createdAt: string
  reasons: string[]
}

export type ReasonOption = { key: string; label: string; active: boolean }

export type InternalNote = { id: string; text: string; author: string; at: string }

export type CommunicationEntry = {
  id: string
  channel: 'email' | 'calendar'
  template: string | null
  status: string
  simulated: boolean
  at: string
}

export type RequestDetail = Envelope & {
  request: ServiceRequest
  history: HistoryEntry[]
  occurrences: Occurrence[]
  passengers: PassengerSummary[]
  notes: InternalNote[]
  communications: CommunicationEntry[]
  returns: RequestReturn[]
  fieldNames: Record<string, string>
  actions: RequestActions
}

const requestBase = (module: RequestModule) => `/${module}/requests`

export function listRequests(
  module: RequestModule,
  filters: { status?: string; tripType?: string; search?: string; from?: string; to?: string; page: number },
) {
  return apiRequest<
    Envelope & { requests: ServiceRequest[]; total: number; page: number; pageSize: number }
  >(`${requestBase(module)}${queryString(filters)}`)
}

export const getRequest = (module: RequestModule, id: string) =>
  apiRequest<RequestDetail>(`${requestBase(module)}/${id}`)

export const createRequest = (module: RequestModule, body: unknown) =>
  send<Envelope & { id: string; protocol: string }>(requestBase(module), 'POST', body)

export const updateRequest = (module: RequestModule, id: string, body: unknown) =>
  send<Envelope>(`${requestBase(module)}/${id}`, 'PATCH', body)

export const requestAction = (
  module: RequestModule,
  id: string,
  action: 'schedule' | 'start' | 'complete' | 'cancel' | 'advance' | 'occurrences',
  body: unknown = {},
) => send<Envelope & { status?: string }>(`${requestBase(module)}/${id}/${action}`, 'POST', body)

export const checkDuplicates = (module: RequestModule, body: unknown) =>
  send<Envelope & { duplicates: PossibleDuplicate[] }>(`${requestBase(module)}/duplicates`, 'POST', body)

export const openRequestReturn = (module: RequestModule, id: string, body: unknown) =>
  send<Envelope>(`${requestBase(module)}/${id}/return`, 'POST', body)

export const respondRequestReturn = (module: RequestModule, id: string, body: unknown) =>
  send<Envelope>(`${requestBase(module)}/${id}/return/respond`, 'POST', body)

export const closeRequestReturn = (module: RequestModule, id: string, motivo: string) =>
  send<Envelope>(`${requestBase(module)}/${id}/return/close`, 'POST', { motivo })

export const replacePassengers = (id: string, passageiros: unknown[]) =>
  send<Envelope & { passengers: PassengerSummary[] }>(
    `/flights/requests/${id}/passengers`,
    'PUT',
    { passageiros },
  )

export const readFullCpf = (passengerId: string) =>
  apiRequest<Envelope & { cpf: string }>(`/flights/passengers/${passengerId}/cpf`)

export const listAssignees = () =>
  apiRequest<Envelope & { assignees: { id: string; name: string }[] }>('/operations/assignees')

export const getCapabilities = () =>
  apiRequest<
    Envelope & {
      canActOnBehalf: boolean
      workday?: { workdayStart: string; workdayEnd: string }
      reasons?: { scheduling: ReasonOption[]; cancellation: ReasonOption[]; warehouse: ReasonOption[] }
    }
  >(
    '/operations/capabilities',
  )

// ---------------------------------------------------------------------------
// Almoxarifado
// ---------------------------------------------------------------------------
export type Material = {
  id: string
  code: string | null
  name: string
  description: string | null
  unit: string
  categoryId: string | null
  category: string | null
  active: boolean
}

export type WarehouseRequest = {
  id: string
  protocol: string
  status: string
  origin: 'interna' | 'governamental'
  externalReference: string | null
  externalRequester: string | null
  requesterId: string
  requester: string
  registeredBy: string | null
  sector: string | null
  note: string | null
  attendedBy: string | null
  attendedAt: string | null
  deliveredAt: string | null
  deliveredBy: string | null
  receivedBy: string | null
  itemCount: number
  createdAt: string
  updatedAt: string
  /** Só o dia, em AAAA-MM-DD. */
  deliveryForecast: string | null
  deliveryStatus: string | null
  /** Visível só à equipe. */
  externalRequesterEmail?: string | null
  /** Pessoa identificada pelo e-mail em um pedido digitado: vê apenas o acompanhamento. */
  limitedView: boolean
}

export type DeliveryHistoryEntry = {
  id: string
  action: string
  previousForecast: string | null
  newForecast: string | null
  effectiveDate: string | null
  comment: string | null
  user: string | null
  at: string
}

export const communicationLabels: Record<string, string> = {
  pending: 'aguardando envio',
  sending: 'em envio',
  sent: 'envio confirmado pelo serviço',
  failed: 'falhou',
  not_configured: 'não enviado: serviço não configurado',
  syncing: 'em sincronização',
  synced: 'sincronização confirmada',
}

export type WarehouseCommunication = {
  id: string
  channel: string
  label: string | null
  status: string
  simulated: boolean
  at: string
}

export const deliveryStatusLabels: Record<string, string> = {
  aguardando_entrega: 'Aguardando entrega',
  entrega_reagendada: 'Entrega reagendada',
  entregue: 'Entregue',
}

export const deliveryHistoryLabels: Record<string, string> = {
  previsao_informada: 'Previsão informada',
  previsao_alterada: 'Previsão alterada',
  entrega_registrada: 'Entrega registrada',
}

export type WarehouseItem = {
  id: string
  materialId: string
  material: string
  unit: string
  requested: number
  fulfilled: number
  notProvided: number
  /** Motivo de disponibilizar menos que o solicitado. */
  reason?: string | null
  reasonCode?: string | null
  /** Interna: só a equipe recebe. */
  note?: string | null
}

export type ItemChange = {
  id: string
  material: string
  unit: string
  requested: number
  previous: number | null
  fulfilled: number
  reason: string | null
  note: string | null
  user: string | null
  at: string
}

export const listMaterials = (filters: { search?: string; inactive?: boolean } = {}) =>
  apiRequest<Envelope & { materials: Material[] }>(
    `/warehouse/materials${queryString({
      search: filters.search,
      inactive: filters.inactive ? 'true' : undefined,
    })}`,
  )

export type MaterialInput = {
  code: string
  name: string
  description: string
  unitId: string
  categoryId: string
  active: boolean
}

export const createMaterial = (body: MaterialInput) =>
  send<Envelope & { id: string }>('/warehouse/materials', 'POST', body)

export const updateMaterial = (id: string, body: MaterialInput) =>
  send<Envelope>(`/warehouse/materials/${id}`, 'PATCH', body)

export const listWarehouseRequests = (filters: {
  status?: string
  origin?: string
  search?: string
  from?: string
  to?: string
  page: number
}) =>
  apiRequest<Envelope & { requests: WarehouseRequest[]; total: number; page: number; pageSize: number }>(
    `/warehouse/requests${queryString(filters)}`,
  )

export const getWarehouseRequest = (id: string) =>
  apiRequest<
    Envelope & {
      request: WarehouseRequest
      items: WarehouseItem[]
      itemChanges: ItemChange[]
      history: HistoryEntry[]
      deliveryHistory: DeliveryHistoryEntry[]
      communications: WarehouseCommunication[]
    }
  >(
    `/warehouse/requests/${id}`,
  )

export type ItemPayload = {
  materialId: string
  requested: number | string
  fulfilled?: number | string
  reasonCode?: string
  note?: string
}

export const createInternalWarehouseRequest = (body: {
  note: string
  items: ItemPayload[]
  avisoPrivacidade?: string
}) =>
  send<Envelope & { id: string; protocol: string }>('/warehouse/requests', 'POST', body)

export const createExternalWarehouseRequest = (body: {
  externalReference: string
  externalRequester: string
  externalRequesterEmail: string
  sectorId: string
  note: string
  items: ItemPayload[]
}) => send<Envelope & { id: string; protocol: string }>('/warehouse/external-requests', 'POST', body)

export const updateWarehouseRequest = (
  id: string,
  body: {
    note: string
    externalReference: string | null
    externalRequester: string | null
    externalRequesterEmail?: string
  },
) => send<Envelope>(`/warehouse/requests/${id}`, 'PATCH', body)

export const replaceWarehouseItems = (id: string, items: ItemPayload[]) =>
  send<Envelope>(`/warehouse/requests/${id}/items`, 'PUT', { items })

export const changeWarehouseStatus = (id: string, status: string, comment: string) =>
  send<Envelope>(`/warehouse/requests/${id}/status`, 'POST', { status, comment })

export const deliverWarehouseRequest = (
  id: string,
  body: { receivedBy: string; comment: string; deliveredDate: string; deliveryNote: string },
) => send<Envelope>(`/warehouse/requests/${id}/deliver`, 'POST', body)

export const setDeliveryForecast = (id: string, body: { date: string; justification: string }) =>
  send<Envelope & { changed: boolean; requesterNotified: boolean }>(
    `/warehouse/requests/${id}/delivery-forecast`,
    'PUT',
    body,
  )

export type InventoryCheckSummary = {
  id: string
  protocol: string
  title: string
  referenceDate: string
  status: string
  createdBy: string
  closedBy: string | null
  closedAt: string | null
  total: number
  counted: number
  divergent: number
  createdAt: string
}

export type InventoryCheck = {
  id: string
  protocol: string
  title: string
  referenceDate: string
  note: string | null
  status: string
  items: Array<{
    materialId: string
    material: string
    unit: string
    governmentQuantity: number
    countedQuantity: number | null
    difference: number | null
    situation: 'pendente' | 'confere' | 'divergente'
    note: string | null
    updatedBy: string | null
    updatedAt: string
  }>
}

export const listInventoryChecks = (page: number) =>
  apiRequest<Envelope & { checks: InventoryCheckSummary[]; page: number; hasMore: boolean }>(
    `/warehouse/inventory-checks?page=${page}`,
  )

export const getInventoryCheck = (id: string) =>
  apiRequest<Envelope & { check: InventoryCheck }>(`/warehouse/inventory-checks/${id}`)

export const createInventoryCheck = (body: {
  title: string
  referenceDate: string
  note: string
  items: { materialId: string; governmentQuantity: number | string }[]
}) => send<Envelope & { id: string }>('/warehouse/inventory-checks', 'POST', body)

export const updateInventoryItem = (
  checkId: string,
  materialId: string,
  body: { governmentQuantity: number | string; countedQuantity: number | string | null; note: string },
) => send<Envelope>(`/warehouse/inventory-checks/${checkId}/items/${materialId}`, 'PUT', body)

export const closeInventoryCheck = (id: string, outcome: 'concluida' | 'cancelada', comment: string) =>
  send<Envelope>(`/warehouse/inventory-checks/${id}/close`, 'POST', { outcome, comment })

// ---------------------------------------------------------------------------
// Painel, relatórios, agenda e sessões
// ---------------------------------------------------------------------------
export type RecentRequest = {
  id: string
  protocol: string
  module: RequestModule
  status: string
  title: string
  requester: string
  sector: string | null
  createdAt: string
}

export type SummaryResponse = Envelope & {
  totals: {
    requests: number
    open: number
    concluded: number
    inProgress: number
    awaitingSchedule: number
  }
  byModule: Record<string, Record<string, number>>
  warehouse: Record<string, number> | null
  /** Taxas de desempenho; porcentagem nula quando não há base. */
  rates?: {
    onTime: Rate
    cancelled: Rate
    warehouseComplete: Rate | null
  }
}

export type Rate = { eligible: number; value: number; percent: number | null }

export type InsightFilters = {
  from?: string
  to?: string
  module?: string
  sectorId?: string
}

export type DashboardResponse = SummaryResponse & {
  recent: RecentRequest[]
  byPeriod: { month: string; total: number }[]
}

export const getDashboard = (filters: InsightFilters) =>
  apiRequest<DashboardResponse>(
    `/dashboard/summary${queryString(filters)}`,
  )

export const getReport = (filters: InsightFilters) =>
  apiRequest<
    SummaryResponse & {
      byPeriod: { month: string; total: number }[]
      bySector: { sector: string; total: number }[]
      materials: { material: string; unit: string; requested: number; fulfilled: number }[]
    }
  >(`/reports/summary${queryString(filters)}`)

export type OperationalReport = Envelope & {
  scheduling: { scheduled: number; rescheduled: number; cancelled: number }
  serviceTime: {
    module: RequestModule
    concluded: number
    withData: number
    averageMinutes: number | null
  }[]
  fleet: { executions: number; occurrences: number; delays: number; delayMinutes: number } | null
  warehouse: { byOrigin: { origin: string; total: number }[]; partial: number } | null
  inventory: {
    checks: number
    concluded: number
    items: number
    counted: number
    divergent: number
  } | null
  fleetUsage:
    | {
        vehicle: string
        uses: number
        occurrences: number
        fuelings: number
        maintenances: number
        kilometers: number | null
        liters: number | null
        cost: number | null
      }[]
    | null
  stockFlow: { material: string; unit: string; entries: number; exits: number }[] | null
}

export const getOperationalReport = (filters: InsightFilters) =>
  apiRequest<OperationalReport>(`/reports/operational${queryString(filters)}`)

export type ScheduleConflict = {
  id: string
  protocol: string
  module: RequestModule
  reason: 'responsible' | 'vehicle' | 'driver'
  start: string
  end: string | null
}

export type CalendarEvent = {
  id: string
  protocol: string
  module: RequestModule
  status: string
  title: string
  start: string
  end: string | null
  sector: string | null
  responsibleId: string | null
  responsible: string | null
  /** Só em Passagens: o compromisso é o trecho de ida ou o de volta. */
  leg?: 'ida' | 'volta' | null
}

export const getCalendarEvents = (
  from: Date,
  to: Date,
  modules: string[],
  filters: { status?: string; responsibleId?: string } = {},
) =>
  apiRequest<Envelope & { events: CalendarEvent[] }>(
    `/calendar/events${queryString({
      from: from.toISOString(),
      to: to.toISOString(),
      modules: modules.join(','),
      statuses: filters.status,
      responsibleId: filters.responsibleId,
    })}`,
  )

export const listOwnSessions = () =>
  apiRequest<
    Envelope & {
      sessions: { id: string; createdAt: string; lastSeenAt: string; expiresAt: string; current: boolean }[]
    }
  >('/auth/sessions')

export const revokeOwnSession = (id: string) => send<Envelope>(`/auth/sessions/${id}/revoke`, 'POST')

export const revokeOtherSessions = () =>
  send<Envelope & { total: number }>('/auth/sessions/revoke-others', 'POST')

export const revokeUserSessions = (userId: string) =>
  send<Envelope & { total: number }>(`/admin/users/${encodeURIComponent(userId)}/sessions/revoke`, 'POST')

export const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback
