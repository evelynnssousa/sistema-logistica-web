import type { RequestModule } from '../auth/requestPolicy.js'

/**
 * Status institucionais e transições permitidas. É a única fonte dessas regras: a
 * persistência recusa qualquer mudança que não saia daqui.
 */

export const moduleTypes: Record<RequestModule, 'manutencao' | 'frota' | 'passagem'> = {
  maintenance: 'manutencao',
  fleet: 'frota',
  flights: 'passagem',
}

export const operationalStatuses = [
  'aguardando_agendamento',
  'agendado',
  'reagendado',
  'em_andamento',
  'concluido',
  'cancelado',
] as const

export const flightStatuses = [
  'em_cotacao',
  'aguardando_aprovacao',
  'em_emissao',
  'emitida',
  'cancelada',
] as const

export type OperationalStatus = (typeof operationalStatuses)[number]
export type FlightStatus = (typeof flightStatuses)[number]
export type RequestStatus = OperationalStatus | FlightStatus

export function statusesOf(module: RequestModule): readonly RequestStatus[] {
  return module === 'flights' ? flightStatuses : operationalStatuses
}

export function initialStatusOf(module: RequestModule): RequestStatus {
  return module === 'flights' ? 'em_cotacao' : 'aguardando_agendamento'
}

// A migração 005 mantém os valores anteriores no banco; eles são traduzidos na leitura.
const legacyOperational: Record<string, OperationalStatus> = {
  pendente: 'aguardando_agendamento',
  em_analise: 'aguardando_agendamento',
  agendada: 'agendado',
  concluida: 'concluido',
  cancelada: 'cancelado',
  rejeitada: 'cancelado',
}

const legacyFlight: Record<string, FlightStatus> = {
  pendente: 'em_cotacao',
  em_analise: 'em_cotacao',
  agendada: 'em_emissao',
  concluida: 'emitida',
  rejeitada: 'cancelada',
}

export function normalizeStatus(module: RequestModule, stored: string): RequestStatus {
  const known = statusesOf(module) as readonly string[]
  if (known.includes(stored)) return stored as RequestStatus
  const translated = (module === 'flights' ? legacyFlight : legacyOperational)[stored]
  if (!translated) throw new Error('Status de solicitação desconhecido.')
  return translated
}

/** Valores gravados que equivalem a um status, para o filtro alcançar registros antigos. */
export function storedValuesFor(module: RequestModule, status: RequestStatus): string[] {
  const legacy = module === 'flights' ? legacyFlight : legacyOperational
  return [
    status,
    ...Object.entries(legacy)
      .filter(([stored, translated]) => translated === status && stored !== status)
      .map(([stored]) => stored),
  ]
}

/** O mesmo que normalizeStatus, em SQL, para filtrar e contar valores antigos e atuais juntos. */
export function normalizedStatusSql(alias: string) {
  const branch = (legacy: Record<string, string>) =>
    `CASE ${alias}.status ${Object.entries(legacy)
      .map(([stored, status]) => `WHEN '${stored}' THEN '${status}'`)
      .join(' ')} ELSE ${alias}.status END`
  return `CASE WHEN ${alias}.tipo = 'passagem' THEN ${branch(legacyFlight)} ELSE ${branch(legacyOperational)} END`
}

export type RequestAction = 'schedule' | 'start' | 'complete' | 'cancel' | 'advance'

const operationalTransitions: Partial<
  Record<RequestAction, Partial<Record<OperationalStatus, OperationalStatus>>>
> = {
  schedule: {
    aguardando_agendamento: 'agendado',
    agendado: 'reagendado',
    reagendado: 'reagendado',
  },
  start: { agendado: 'em_andamento', reagendado: 'em_andamento' },
  complete: { em_andamento: 'concluido' },
  cancel: {
    aguardando_agendamento: 'cancelado',
    agendado: 'cancelado',
    reagendado: 'cancelado',
    em_andamento: 'cancelado',
  },
}

const flightTransitions: Partial<
  Record<RequestAction, Partial<Record<FlightStatus, FlightStatus>>>
> = {
  advance: {
    em_cotacao: 'aguardando_aprovacao',
    aguardando_aprovacao: 'em_emissao',
    em_emissao: 'emitida',
  },
  cancel: {
    em_cotacao: 'cancelada',
    aguardando_aprovacao: 'cancelada',
    em_emissao: 'cancelada',
  },
}

/** Próximo status da ação, ou null quando a transição não é permitida. */
export function nextStatus(
  module: RequestModule,
  current: RequestStatus,
  action: RequestAction,
): RequestStatus | null {
  if (module === 'flights') {
    return flightTransitions[action]?.[current as FlightStatus] ?? null
  }
  return operationalTransitions[action]?.[current as OperationalStatus] ?? null
}

export function isTerminalStatus(status: RequestStatus) {
  return ['concluido', 'cancelado', 'emitida', 'cancelada'].includes(status)
}

// ---------------------------------------------------------------------------
// Almoxarifado
// ---------------------------------------------------------------------------

export const warehouseStatuses = [
  'pendente',
  'em_analise',
  'atendido_parcial',
  'atendido',
  'entregue',
  'rejeitado',
  'cancelado',
] as const

export type WarehouseStatus = (typeof warehouseStatuses)[number]

const warehouseTransitions: Record<WarehouseStatus, readonly WarehouseStatus[]> = {
  pendente: ['em_analise', 'atendido_parcial', 'atendido', 'rejeitado', 'cancelado'],
  em_analise: ['atendido_parcial', 'atendido', 'rejeitado', 'cancelado'],
  atendido_parcial: ['atendido', 'entregue', 'cancelado'],
  atendido: ['entregue'],
  entregue: [],
  rejeitado: [],
  cancelado: [],
}

export function canMoveWarehouseStatus(from: WarehouseStatus, to: WarehouseStatus) {
  return warehouseTransitions[from].includes(to)
}

export function isWarehouseStatus(value: unknown): value is WarehouseStatus {
  return typeof value === 'string' && (warehouseStatuses as readonly string[]).includes(value)
}

/** Status coerente com as quantidades: impede marcar como atendido o que não foi. */
export function warehouseStatusMatchesItems(
  status: WarehouseStatus,
  items: readonly { requested: number; fulfilled: number }[],
) {
  if (status === 'atendido') {
    return items.length > 0 && items.every((item) => item.fulfilled >= item.requested)
  }
  if (status === 'atendido_parcial') {
    return (
      items.some((item) => item.fulfilled > 0) &&
      items.some((item) => item.fulfilled < item.requested)
    )
  }
  return true
}

export function inventoryItemSituation(
  governmentQuantity: number,
  countedQuantity: number | null,
): 'pendente' | 'confere' | 'divergente' {
  if (countedQuantity === null) return 'pendente'
  return countedQuantity === governmentQuantity ? 'confere' : 'divergente'
}
