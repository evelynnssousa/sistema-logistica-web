import { apiRequest } from '../auth/apiClient'

type Envelope = { success: boolean; message?: string }

function send<Response extends Envelope>(path: string, method: string, body?: unknown) {
  return apiRequest<Response>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
}

export type TripGroup = 'proximas' | 'agendadas' | 'em_andamento' | 'concluidas' | 'canceladas'

export const tripGroupLabels: Record<TripGroup, string> = {
  proximas: 'Próximas',
  agendadas: 'Agendadas',
  em_andamento: 'Em andamento',
  concluidas: 'Concluídas',
  canceladas: 'Canceladas',
}

export const tripGroupOrder = Object.keys(tripGroupLabels) as TripGroup[]

export type ExecutionField = 'vehicle' | 'odometer' | 'notes'
export type TripField = 'origin' | 'destination' | 'purpose' | 'requester' | 'sector' | 'vehicle' | 'passengers' | 'notes' | 'scheduledEnd' | 'returnAt'
export type FieldPlacement = 'card' | 'details' | 'hidden'
export type OutsideRule = 'identify' | 'justify'

export type PortalOccurrenceType = {
  key: string
  label: string
  requiresJustification: boolean
  allowsAttachments: boolean
  asksDelay: boolean
}

/** Só o que o portal precisa, vindo de Configurações. Nenhum valor operacional fica fixo na tela. */
export type PortalConfiguration = {
  enabled: boolean
  journey: {
    start: string
    end: string
    weekdays: number[]
    breakMinutes: number
    expectedMinutes: number | null
    outsideStart: OutsideRule
    outsideFinish: OutsideRule
    allowOutsideStart: boolean
  }
  execution: { startFields: ExecutionField[]; finishFields: ExecutionField[]; visibleGroups: TripGroup[] }
  occurrences: { enabled: boolean; types: PortalOccurrenceType[] }
  display: {
    fields: Record<TripField, FieldPlacement>
    notices: string[]
    guidance: string | null
    contact: { name: string; phone: string; email: string; hours: string } | null
  }
}

export type DriverProfile = Envelope & {
  linked: boolean
  driver: { name: string; registration: string | null } | null
  portal: PortalConfiguration
  attachments: { enabled: boolean; maxFileMb?: number; allowedKinds?: string[] }
}

export type ExecutionInput = { hodometro?: string; observacao?: string; veiculo?: string; justificativa?: string }

export type Trip = {
  id: string
  protocol: string
  status: string
  title: string
  scheduledAt: string | null
  scheduledEnd: string | null
  origin: string | null
  destination: string | null
  returnAt: string | null
  purpose: string | null
  vehicle: string | null
  passengers: string[]
  requester: string | null
  sector: string | null
  notes: string | null
  startedAt: string | null
  finishedAt: string | null
  durationMinutes: number | null
  exceedsJourney: boolean
  journeyReference: { start: string; end: string }
  outsideJourneyNow: boolean
  canStart: boolean
  startBlockedByJourney: boolean
  startNeedsVehicle: boolean
  canFinish: boolean
  canReportOccurrence: boolean
}

export type TripOccurrence = {
  id: string
  customFields?: { id: string; label: string; value: string }[]
  category: string | null
  /** O nome do tipo na data do registro: editar o cadastro não muda o que já foi registrado. */
  categoryLabel: string | null
  justification: string | null
  description: string
  delayMinutes: number | null
  at: string
  attachments: { id: string; name: string }[]
}

export type HistoryTrip = Trip & { occurrences: { category: string | null; categoryLabel: string | null; description: string; at: string }[] }

export const fetchDriverProfile = () => apiRequest<DriverProfile>('/driver/me')
export const listTrips = (group: TripGroup, page: number) =>
  apiRequest<Envelope & { trips: Trip[]; counts: Partial<Record<TripGroup, number>>; page: number; pageSize: number }>(
    `/driver/trips?group=${group}&page=${page}`,
  )
export const fetchTrip = (id: string) => apiRequest<Envelope & { trip: Trip; occurrences: TripOccurrence[] }>(`/driver/trips/${id}`)
export const fetchDriverHistory = (page: number) =>
  apiRequest<Envelope & { trips: HistoryTrip[]; total: number; page: number; pageSize: number }>(`/driver/history?page=${page}`)
export const startTrip = (id: string, body: ExecutionInput = {}) => send<Envelope & { startedAt: string }>(`/driver/trips/${id}/start`, 'POST', body)
export const finishTrip = (id: string, body: ExecutionInput = {}) =>
  send<Envelope & { finishedAt: string; durationMinutes: number | null }>(`/driver/trips/${id}/finish`, 'POST', body)
export const addTripOccurrence = (id: string, body: { categoria: string; descricao: string; justificativa?: string; atrasoMinutos?: number; customFields?: Record<string, string> }) =>
  send<Envelope & { id: string }>(`/driver/trips/${id}/occurrences`, 'POST', body)
export const uploadOccurrenceAttachment = (tripId: string, occurrenceId: string, file: File) =>
  apiRequest<Envelope & { id: string }>(`/driver/trips/${tripId}/occurrences/${occurrenceId}/attachments`, {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
  })

// ---------------------------------------------------------------------------
// Equipe da Frota
// ---------------------------------------------------------------------------
export type FleetDriver = {
  customFields?: { id: string; label: string; value: string }[]
  id: string
  name: string
  registration: string | null
  active: boolean
  userId: string | null
  accountName: string | null
  accountEmail: string | null
  canReceiveTrips: boolean
  openTrips: number
}

export type DriverInput = { name: string; registration: string | null; active: boolean; userId: string | null }

export const listFleetDrivers = () =>
  apiRequest<Envelope & { drivers: FleetDriver[]; accounts: { id: string; name: string; email: string }[] }>('/fleet/drivers')
export const listAssignableDrivers = () =>
  apiRequest<Envelope & { drivers: { id: string; name: string; registration: string | null }[] }>('/fleet/drivers/assignable')
export const createFleetDriver = (body: DriverInput) => send<Envelope & { id: string }>('/fleet/drivers', 'POST', body)
export const updateFleetDriver = (id: string, body: DriverInput) => send<Envelope>(`/fleet/drivers/${id}`, 'PATCH', body)

export type ExecutionRecord = { hodometro?: number; observacao?: string; veiculo?: string; justificativa?: string }

export type TripExecution = Envelope & {
  driver: { id: string; name: string; registration: string | null } | null
  notes: string | null
  startedAt: string | null
  finishedAt: string | null
  durationMinutes: number | null
  exceedsJourney: boolean
  journeyReference: { start: string; end: string }
  startRecord: ExecutionRecord | null
  finishRecord: ExecutionRecord | null
  occurrences: (TripOccurrence & { driver: string })[]
  corrections: {
    id: string
    previousStart: string | null
    previousEnd: string | null
    newStart: string | null
    newEnd: string | null
    reason: string
    user: string
    at: string
  }[]
}

export const fetchTripExecution = (requestId: string) => apiRequest<TripExecution>(`/fleet/requests/${requestId}/execution`)
export const assignTripDriver = (requestId: string, body: { driverId: string | null; notes: string | null; confirmConflicts?: boolean }) =>
  send<Envelope>(`/fleet/requests/${requestId}/driver`, 'POST', body)
export const correctTripExecution = (requestId: string, body: { start?: string; end?: string; reason: string }) =>
  send<Envelope>(`/fleet/requests/${requestId}/execution-correction`, 'POST', body)

// ---------------------------------------------------------------------------
// Apresentação. O registro é sempre no horário de São Paulo, de onde quer que se consulte.
// ---------------------------------------------------------------------------
const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })
const dayFormat = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })
const hourFormat = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short', timeZone: 'America/Sao_Paulo' })

export const formatTripMoment = (value: string | null | undefined) => (value ? dateTimeFormat.format(new Date(value)) : '—')
export const formatTripDay = (value: string | null | undefined) => (value ? dayFormat.format(new Date(value)) : 'Sem data')
export const formatTripHour = (value: string | null | undefined) => (value ? hourFormat.format(new Date(value)) : '—')

export function formatDuration(minutes: number | null | undefined) {
  if (minutes === null || minutes === undefined) return '—'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours > 0 ? `${hours}h${String(rest).padStart(2, '0')}` : `${rest} min`
}

/** Resumo do mês da Frota: km por carro e, para quem administra a Frota, horas a mais e a menos. */
export type VehicleKilometers = {
  vehicle: string
  model: string | null
  registered: boolean
  trips: number
  tripsWithoutOdometer: number
  tripKm: number
  logUses: number
  logKm: number
  totalKm: number
}

export type DriverMonthHours = {
  driverId: string
  driverName: string
  days: number
  trips: number
  tripMinutes: number
  outsideJourneyMinutes: number
  workedMinutes: number
  expectedMinutes: number
  extraMinutes: number
  missingMinutes: number
  balanceMinutes: number
}

export type FleetMonthlySummary = {
  month: string
  vehicles: VehicleKilometers[]
  drivers: DriverMonthHours[] | null
  journey: { weekdays: number[]; start: string; end: string; breakMinutes: number; dailyMinutes: number } | null
}

export const fetchFleetMonthlySummary = (month: string) =>
  apiRequest<Envelope & FleetMonthlySummary>(`/fleet/monthly-summary?month=${encodeURIComponent(month)}`)
