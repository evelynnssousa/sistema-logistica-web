import { isValidCpf } from './cpfProtection.js'

/**
 * Validação dos dados enviados pelos formulários. Nunca aceita identidade, status ou
 * responsáveis por aqui: esses dados vêm da sessão e das rotas de cada ação.
 */

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestValidationError'
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value)
}

type Body = Record<string, unknown>

export function asBody(value: unknown): Body {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Body)
    : {}
}

export function requiredText(
  value: unknown,
  label: string,
  { min = 2, max = 200 }: { min?: number; max?: number } = {},
): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length < min) throw new RequestValidationError(`Informe ${label}.`)
  if (text.length > max) {
    throw new RequestValidationError(`${label} deve ter no máximo ${max} caracteres.`)
  }
  return text
}

export function optionalText(value: unknown, label: string, max = 2000): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new RequestValidationError(`${label} inválido.`)
  const text = value.trim()
  if (text.length > max) {
    throw new RequestValidationError(`${label} deve ter no máximo ${max} caracteres.`)
  }
  return text || null
}

export function optionalUuid(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (!isUuid(value)) throw new RequestValidationError(`${label} inválido.`)
  return value
}

export function requiredUuid(value: unknown, label: string): string {
  const id = optionalUuid(value, label)
  if (!id) throw new RequestValidationError(`Selecione ${label}.`)
  return id
}

// Fora deste intervalo, a data só pode ser erro de digitação.
function isPlausibleDate(date: Date) {
  const year = date.getUTCFullYear()
  return !Number.isNaN(date.getTime()) && year >= 1900 && year <= 2200
}

export function requiredDateTime(value: unknown, label: string): Date {
  const date = typeof value === 'string' ? new Date(value) : null
  if (!date || !isPlausibleDate(date)) {
    throw new RequestValidationError(`Informe ${label} válida.`)
  }
  return date
}

export function optionalDateTime(value: unknown, label: string): Date | null {
  return value === undefined || value === null || value === ''
    ? null
    : requiredDateTime(value, label)
}

export function readQuantity(value: unknown, label: string, { allowZero = false } = {}) {
  const quantity = typeof value === 'number' ? value : Number(value)
  if (
    value === '' ||
    value === null ||
    value === undefined ||
    !Number.isFinite(quantity) ||
    quantity < 0 ||
    (!allowZero && quantity === 0) ||
    quantity > 9_999_999
  ) {
    throw new RequestValidationError(`${label} inválida.`)
  }
  return Math.round(quantity * 100) / 100
}

const priorities = ['baixa', 'normal', 'alta', 'urgente']

function readPriority(value: unknown) {
  if (value === undefined || value === null || value === '') return 'normal'
  if (typeof value !== 'string' || !priorities.includes(value)) {
    throw new RequestValidationError('Prioridade inválida.')
  }
  return value
}

/** Campos criados na tela de personalização. Só texto curto, sem chaves reservadas. */
function readCustomFields(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  const entries = Object.entries(asBody(value))
  if (entries.length > 30) throw new RequestValidationError('Há campos adicionais demais.')

  const fields: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(key) || typeof raw !== 'string') {
      throw new RequestValidationError('Há um campo adicional inválido.')
    }
    if (raw.length > 2000) {
      throw new RequestValidationError('Um campo adicional é longo demais.')
    }
    if (raw.trim()) fields[key] = raw.trim()
  }
  return fields
}

export type ValidatedMaintenance = {
  title: string
  description: string
  priority: string
  floorId: string
  serviceTypeId: string
  details: { sala: string | null; localServico: string; dataPreferencial: string | null; observacoes: string | null; customFields: Record<string, string> }
}

export function validateMaintenance(body: Body): Omit<ValidatedMaintenance, 'title'> {
  return {
    description: requiredText(body.descricao, 'a descrição', { min: 3, max: 4000 }),
    priority: readPriority(body.prioridade),
    floorId: requiredUuid(body.andarId, 'o andar'),
    serviceTypeId: requiredUuid(body.tipoServicoId, 'o tipo de serviço'),
    details: {
      sala: optionalText(body.sala, 'Sala', 80),
      localServico: requiredText(body.localServico, 'o local do serviço', { max: 200 }),
      // Opcional: sem ela, não há data pedida para comparar com o agendamento.
      dataPreferencial: optionalDateTime(body.dataPreferencial, 'a data preferencial')?.toISOString() ?? null,
      observacoes: optionalText(body.observacoes, 'Observações'),
      customFields: readCustomFields(body.customFields),
    },
  }
}

export type FleetDetails = {
  origem: string
  destino: string
  dataHora: string
  dataHoraRetorno: string | null
  finalidade: string
  veiculo: string | null
  passageiros: { nome: string }[]
  observacoes: string | null
  customFields: Record<string, string>
}

export function validateFleet(body: Body) {
  const departure = requiredDateTime(body.dataHora, 'a data e o horário')
  const returning = optionalDateTime(body.dataHoraRetorno, 'a data e o horário de retorno')
  if (returning && returning < departure) {
    throw new RequestValidationError('O retorno não pode ser anterior à saída.')
  }

  const rawPassengers = body.passageiros ?? []
  if (!Array.isArray(rawPassengers) || rawPassengers.length > 60) {
    throw new RequestValidationError('Lista de passageiros inválida.')
  }

  const details: FleetDetails = {
    origem: requiredText(body.origem, 'a origem'),
    destino: requiredText(body.destino, 'o destino'),
    dataHora: departure.toISOString(),
    dataHoraRetorno: returning?.toISOString() ?? null,
    finalidade: requiredText(body.finalidade, 'o serviço solicitado', { max: 500 }),
    veiculo: optionalText(body.veiculo, 'Veículo', 120),
    passageiros: rawPassengers.map((passenger) => ({
      nome: requiredText(asBody(passenger).nome, 'o nome do passageiro', { max: 120 }),
    })),
    observacoes: optionalText(body.observacoes, 'Observações'),
    customFields: readCustomFields(body.customFields),
  }

  return {
    description: details.finalidade,
    priority: readPriority(body.prioridade),
    floorId: optionalUuid(body.andarId, 'Andar'),
    details,
  }
}

export const maxPassengers = 10
export const tripTypes = ['ida_volta', 'somente_ida', 'somente_volta'] as const
export type TripType = (typeof tripTypes)[number]

export type ValidatedPassenger = {
  id: string | null
  name: string
  cpf: string | null
}

function readPassengers(value: unknown, { allowKnownWithoutCpf = false } = {}) {
  if (!Array.isArray(value) || value.length < 1) {
    throw new RequestValidationError('Informe ao menos um passageiro.')
  }
  if (value.length > maxPassengers) {
    throw new RequestValidationError(`O limite é de ${maxPassengers} passageiros.`)
  }

  const seen = new Set<string>()
  return value.map<ValidatedPassenger>((raw) => {
    const passenger = asBody(raw)
    const name = requiredText(passenger.nome, 'o nome do passageiro', { max: 120 })
    const id = optionalUuid(passenger.id, 'Passageiro')
    const digits =
      typeof passenger.cpf === 'string' ? passenger.cpf.replace(/\D/g, '') : ''

    if (!digits && allowKnownWithoutCpf && id) return { id, name, cpf: null }
    if (!isValidCpf(digits)) {
      throw new RequestValidationError('Há um CPF inválido entre os passageiros.')
    }
    if (seen.has(digits)) {
      throw new RequestValidationError('O mesmo CPF foi informado mais de uma vez.')
    }
    seen.add(digits)
    return { id, name, cpf: digits }
  })
}

export function validatePassengerUpdate(body: Body) {
  return readPassengers(body.passageiros, { allowKnownWithoutCpf: true })
}

export type FlightDetails = {
  tipoViagem: TripType
  ida: { origem: string; destino: string; data: string; horario: string } | null
  volta: { origem: string; destino: string; data: string; horario: string } | null
  bagagem: string | null
  sala: string | null
  observacoes: string | null
  customFields: Record<string, string>
}

function readSegment(raw: unknown, label: string) {
  const segment = asBody(raw)
  const date = typeof segment.data === 'string' ? segment.data : ''
  const time = typeof segment.horario === 'string' ? segment.horario : ''
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^\d{2}:\d{2}$/.test(time) ||
    Number.isNaN(new Date(`${date}T${time}:00Z`).getTime())
  ) {
    throw new RequestValidationError(`Informe a data e o horário ${label}.`)
  }
  return {
    origem: requiredText(segment.origem, `a origem ${label}`),
    destino: requiredText(segment.destino, `o destino ${label}`),
    data: date,
    horario: time,
  }
}

export function validateFlightDetails(body: Body) {
  const tipoViagem = body.tipoViagem as TripType
  if (!tripTypes.includes(tipoViagem)) {
    throw new RequestValidationError('Selecione o tipo de viagem.')
  }

  const ida = tipoViagem === 'somente_volta' ? null : readSegment(body.ida, 'da ida')
  const volta = tipoViagem === 'somente_ida' ? null : readSegment(body.volta, 'da volta')

  if (ida && volta && `${volta.data}T${volta.horario}` < `${ida.data}T${ida.horario}`) {
    throw new RequestValidationError('A volta não pode ser anterior à ida.')
  }

  const details: FlightDetails = {
    tipoViagem,
    ida,
    volta,
    bagagem: optionalText(body.bagagem, 'Bagagem', 120),
    sala: optionalText(body.sala, 'Sala', 80),
    observacoes: optionalText(body.observacoes, 'Observações'),
    customFields: readCustomFields(body.customFields),
  }

  return {
    description: details.observacoes,
    priority: readPriority(body.prioridade),
    floorId: requiredUuid(body.andarId, 'o andar'),
    details,
  }
}

/** O aviso de privacidade informa, e não pede consentimento: enviar não depende de aceite. */
export function validateFlightCreation(body: Body) {
  return {
    ...validateFlightDetails(body),
    passengers: readPassengers(body.passageiros),
  }
}

export function validateSchedule(body: Body) {
  const scheduledAt = requiredDateTime(body.dataAgendada, 'a data do agendamento')
  const scheduledEnd = optionalDateTime(body.dataFim, 'a data de término previsto')
  if (scheduledEnd && scheduledEnd < scheduledAt) {
    throw new RequestValidationError('O término previsto não pode ser anterior ao início.')
  }
  return {
    scheduledAt,
    scheduledEnd,
    responsibleId: optionalUuid(body.responsavelId, 'Responsável'),
    comment: optionalText(body.comentario, 'Comentário'),
    reasonCode: body.motivoCodigo,
    conditions: optionalText(body.condicoesAlteradas, 'Condições do atendimento', 500),
    // Só vale depois de a pessoa ver os conflitos que a API apontou.
    confirmConflicts: body.confirmarConflito === true,
    // Versão vista na tela. Sem ela, a alteração simultânea não é detectada.
    expectedVersion: optionalDateTime(body.versao, 'a versão do registro'),
  }
}

/** Versão do aviso exibido no formulário. Valor desconhecido é ignorado, sem recusar o envio. */
export function readPrivacyNotice(body: Body, current: string): string | null {
  return body.avisoPrivacidade === current ? current : null
}

function notInFuture(date: Date, label: string, now: Date) {
  if (date.getTime() > now.getTime() + 60_000) {
    throw new RequestValidationError(`${label} não pode estar no futuro.`)
  }
}

export function validateStart(body: Body, now = new Date()) {
  const startedAt = optionalDateTime(body.inicioReal, 'a data de início real') ?? now
  notInFuture(startedAt, 'O início real', now)
  return { startedAt, comment: optionalText(body.comentario, 'Comentário') }
}

export function validateCompletion(body: Body, now = new Date()) {
  const finishedAt = optionalDateTime(body.fimReal, 'a data de término real') ?? now
  notInFuture(finishedAt, 'O término real', now)
  return { finishedAt, comment: optionalText(body.comentario, 'Comentário') }
}

export function validateOccurrence(body: Body) {
  const type = body.tipo
  if (type !== 'ocorrencia' && type !== 'atraso') {
    throw new RequestValidationError('Selecione o tipo de ocorrência.')
  }

  let delayMinutes: number | null = null
  if (type === 'atraso') {
    delayMinutes = Number(body.atrasoMinutos)
    if (!Number.isInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > 100000) {
      throw new RequestValidationError('Informe o atraso em minutos.')
    }
  }

  return {
    type,
    delayMinutes,
    description: requiredText(body.descricao, 'a descrição', { min: 3, max: 2000 }),
  }
}

export function validateReason(body: Body) {
  return requiredText(body.motivo, 'o motivo', { min: 3, max: 1000 })
}

// ---------------------------------------------------------------------------
// Filtros de listagens e relatórios
// ---------------------------------------------------------------------------

function readDateFilter(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null
  const date = new Date(value)
  if (!isPlausibleDate(date)) {
    throw new RequestValidationError('Período inválido.')
  }
  return date
}

export function readPeriod(query: Body) {
  const from = readDateFilter(query.from)
  const to = readDateFilter(query.to)
  if (from && to && to < from) {
    throw new RequestValidationError('O fim do período não pode ser anterior ao início.')
  }
  return { from, to }
}

export function readPage(value: unknown) {
  const page = Number(value)
  return Number.isSafeInteger(page) && page >= 1 ? page : 1
}

export function readSearch(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 120) : ''
}

/** Escapa os curingas do LIKE: a pesquisa é sempre por texto literal. */
export function likePattern(search: string) {
  return `%${search.replace(/[\\%_]/g, '\\$&')}%`
}
