import { defaultJourney, tripGroups } from '../auth/driverPolicy.js'
import type { Journey, TripGroup } from '../auth/driverPolicy.js'
import { RequestValidationError } from './validation.js'

/**
 * Parâmetros do Portal do Motorista, editáveis em Configurações: padrão, validação e o que o motorista
 * pode consultar. Os padrões reproduzem o portal como ele já funcionava. Nenhum parâmetro alcança o
 * isolamento de viagens por motorista ou a lista fechada de rotas (driverPolicy.ts): esses são código.
 * Veja docs/PORTAL_DO_MOTORISTA.md.
 */

// ---------------------------------------------------------------------------
// Opções oferecidas pela tela
// ---------------------------------------------------------------------------

export const outsideRules = ['identify', 'justify'] as const
export type OutsideRule = (typeof outsideRules)[number]

export const startFields = ['vehicle', 'odometer', 'notes'] as const
export const finishFields = ['odometer', 'notes'] as const
export type ExecutionField = (typeof startFields)[number]

/** Sem estas, o motorista não veria a viagem a iniciar nem a viagem a finalizar. */
export const requiredGroups: readonly TripGroup[] = ['proximas', 'em_andamento']

/**
 * Só o que o portal já pode mostrar. Nota interna, e-mail ou motivo de cancelamento não têm entrada
 * aqui, e por isso nenhuma configuração os expõe. Data, horário, situação e protocolo sempre aparecem.
 */
export const tripFields = [
  { key: 'origin', label: 'Saída' },
  { key: 'destination', label: 'Destino' },
  { key: 'purpose', label: 'Serviço' },
  { key: 'requester', label: 'Solicitante' },
  { key: 'sector', label: 'Setor' },
  { key: 'vehicle', label: 'Veículo' },
  { key: 'passengers', label: 'Passageiros' },
  { key: 'notes', label: 'Observações para o motorista' },
  { key: 'scheduledEnd', label: 'Término previsto' },
  { key: 'returnAt', label: 'Retorno pedido' },
] as const
export type TripField = (typeof tripFields)[number]['key']

export const fieldPlacements = ['card', 'details', 'hidden'] as const
export type FieldPlacement = (typeof fieldPlacements)[number]

/**
 * driver: o motorista recebe. team: a equipe da Frota recebe. Onde o motorista é quem registra, avisá-lo
 * do próprio ato não faria sentido, e a célula não existe.
 */
export const driverNotificationEvents = [
  { key: 'trip_assigned', label: 'Nova viagem atribuída', appliesToDriver: true },
  { key: 'time_changed', label: 'Alteração de horário', appliesToDriver: true },
  { key: 'destination_changed', label: 'Alteração de destino', appliesToDriver: true },
  { key: 'other_changed', label: 'Outras alterações na viagem', appliesToDriver: true },
  { key: 'trip_rescheduled', label: 'Reagendamento', appliesToDriver: true },
  { key: 'trip_cancelled', label: 'Cancelamento', appliesToDriver: true },
  { key: 'trip_unassigned', label: 'Viagem retirada do motorista', appliesToDriver: true },
  { key: 'occurrence', label: 'Registro de ocorrência', appliesToDriver: false },
  { key: 'trip_started', label: 'Viagem iniciada', appliesToDriver: false },
  { key: 'trip_finished', label: 'Viagem finalizada', appliesToDriver: false },
] as const
export type DriverNotificationEvent = (typeof driverNotificationEvents)[number]['key']
export type NotificationRule = { driver: boolean; team: boolean }

/** Os tipos da migração 017, para quando o cadastro ainda não existe no banco. */
export type OccurrenceType = {
  key: string
  label: string
  active: boolean
  requiresJustification: boolean
  allowsAttachments: boolean
  asksDelay: boolean
}

export const defaultOccurrenceTypes: readonly OccurrenceType[] = [
  { key: 'atraso', label: 'Atraso', active: true, requiresJustification: false, allowsAttachments: true, asksDelay: true },
  { key: 'veiculo', label: 'Problema mecânico', active: true, requiresJustification: false, allowsAttachments: true, asksDelay: false },
  { key: 'percurso', label: 'Alteração de percurso', active: true, requiresJustification: false, allowsAttachments: true, asksDelay: false },
  { key: 'impedimento', label: 'Impedimento de realização da viagem', active: true, requiresJustification: false, allowsAttachments: true, asksDelay: false },
  { key: 'atendimento', label: 'Problema no local de destino', active: true, requiresJustification: false, allowsAttachments: true, asksDelay: false },
  { key: 'outra', label: 'Outros', active: true, requiresJustification: false, allowsAttachments: true, asksDelay: false },
]

// ---------------------------------------------------------------------------
// Padrões
// ---------------------------------------------------------------------------

export const defaultDriverSettings = {
  driverJourney: {
    ...defaultJourney,
    outsideStart: 'identify' as OutsideRule,
    outsideFinish: 'identify' as OutsideRule,
    allowOutsideStart: true,
  },
  driverExecution: {
    startFields: [] as ExecutionField[],
    finishFields: [] as ExecutionField[],
    upcomingDays: 7,
    visibleGroups: [...tripGroups] as TripGroup[],
  },
  driverAccess: {
    portalEnabled: true,
    occurrencesEnabled: true,
    attachmentsEnabled: true,
    allowDocuments: true,
    allowPhotos: true,
  },
  driverNotifications: {
    rules: {
      trip_assigned: { driver: true, team: false },
      time_changed: { driver: true, team: false },
      destination_changed: { driver: true, team: false },
      other_changed: { driver: true, team: false },
      trip_rescheduled: { driver: true, team: false },
      trip_cancelled: { driver: true, team: false },
      trip_unassigned: { driver: true, team: false },
      occurrence: { driver: false, team: true },
      trip_started: { driver: false, team: false },
      trip_finished: { driver: false, team: false },
    } as Record<DriverNotificationEvent, NotificationRule>,
  },
  driverDisplay: {
    fields: {
      origin: 'card',
      destination: 'card',
      notes: 'card',
      purpose: 'details',
      requester: 'details',
      sector: 'details',
      vehicle: 'details',
      passengers: 'details',
      scheduledEnd: 'details',
      returnAt: 'details',
    } as Record<TripField, FieldPlacement>,
    notices: [] as { text: string; active: boolean }[],
    guidance: { active: false, text: '' },
    contact: { active: false, name: '', phone: '', email: '', hours: '' },
  },
}

export type DriverSettings = typeof defaultDriverSettings
export type DriverSettingsSection = keyof DriverSettings

export function isDriverSettingsSection(value: string): value is DriverSettingsSection {
  return Object.prototype.hasOwnProperty.call(defaultDriverSettings, value)
}

/** Seção do histórico que reúne os parâmetros do portal e o cadastro de tipos. */
export const occurrenceTypesHistorySection = 'driverOccurrenceTypes'
export const driverHistorySections = [...Object.keys(defaultDriverSettings), occurrenceTypesHistorySection]

// ---------------------------------------------------------------------------
// Validação. Só aceita o que a tela oferece: o resto é descartado, nunca gravado.
// ---------------------------------------------------------------------------

function record(value: unknown, label: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestValidationError(`${label} inválido.`)
  }
  return value as Record<string, unknown>
}

function flag(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new RequestValidationError(`${label} inválido.`)
  return value
}

function integer(value: unknown, label: string, min: number, max: number) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
    throw new RequestValidationError(`${label} deve ser um número inteiro de ${min} a ${max}.`)
  }
  return number
}

function hour(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new RequestValidationError(`${label} deve estar no formato HH:MM.`)
  }
  return value
}

function oneOf<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (!options.includes(value as T)) throw new RequestValidationError(`${label} inválido.`)
  return value as T
}

function subset<T extends string>(value: unknown, options: readonly T[], label: string): T[] {
  if (!Array.isArray(value)) throw new RequestValidationError(`${label} inválido.`)
  return options.filter((option) => value.includes(option))
}

/** Texto exibido ao motorista. O React escapa tudo; os caracteres recusados são os dos demais modelos. */
function message(value: unknown, label: string, max: number) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new RequestValidationError(`${label} inválido.`)
  const text = value.trim()
  if (text.length > max) throw new RequestValidationError(`${label} deve ter no máximo ${max} caracteres.`)
  if (/[<>{}]/.test(text)) throw new RequestValidationError(`${label} não pode conter os caracteres < > { }.`)
  return text
}

const minutesOf = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))

function readJourney(body: Record<string, unknown>): DriverSettings['driverJourney'] {
  const start = hour(body.start, 'O início da jornada')
  const end = hour(body.end, 'O término da jornada')
  if (end <= start) throw new RequestValidationError('O término da jornada deve ser depois do início.')
  if (!Array.isArray(body.weekdays)) throw new RequestValidationError('Dias de funcionamento inválidos.')
  const weekdays = [0, 1, 2, 3, 4, 5, 6].filter((day) => (body.weekdays as unknown[]).includes(day))
  if (weekdays.length === 0) throw new RequestValidationError('Selecione ao menos um dia de funcionamento.')

  const window = minutesOf(end) - minutesOf(start)
  const breakMinutes = integer(body.breakMinutes ?? 0, 'O intervalo', 0, 240)
  const expectedMinutes =
    body.expectedMinutes === null || body.expectedMinutes === undefined || body.expectedMinutes === ''
      ? null
      : integer(body.expectedMinutes, 'A duração prevista', 1, 1440)
  if (breakMinutes >= window) throw new RequestValidationError('O intervalo deve ser menor que a jornada.')
  if (expectedMinutes !== null && expectedMinutes + breakMinutes > window) {
    throw new RequestValidationError('A duração prevista, somada ao intervalo, não cabe entre o início e o término da jornada.')
  }
  return {
    start,
    end,
    weekdays,
    breakMinutes,
    expectedMinutes,
    outsideStart: oneOf(body.outsideStart, outsideRules, 'A regra de início fora da jornada'),
    outsideFinish: oneOf(body.outsideFinish, outsideRules, 'A regra de término fora da jornada'),
    allowOutsideStart: flag(body.allowOutsideStart, 'A permissão de registros fora da jornada'),
  }
}

function readDisplay(body: Record<string, unknown>): DriverSettings['driverDisplay'] {
  const rawFields = record(body.fields, 'Informações dos cartões')
  const fields = Object.fromEntries(
    tripFields.map(({ key, label }) => [key, oneOf(rawFields[key], fieldPlacements, `A exibição de ${label}`)]),
  ) as Record<TripField, FieldPlacement>
  if (fields.destination === 'hidden') {
    throw new RequestValidationError('O destino precisa continuar visível: sem ele, o motorista não executa a viagem.')
  }

  if (!Array.isArray(body.notices) || body.notices.length > 10) {
    throw new RequestValidationError('Mantenha no máximo 10 avisos operacionais.')
  }
  const notices = body.notices.map((item) => {
    const notice = record(item, 'Aviso')
    const text = message(notice.text, 'O aviso', 500)
    if (text.length < 3) throw new RequestValidationError('Escreva o texto de todos os avisos.')
    return { text, active: flag(notice.active, 'A situação do aviso') }
  })

  const rawGuidance = record(body.guidance, 'Orientação')
  const guidance = { active: flag(rawGuidance.active, 'A situação da orientação'), text: message(rawGuidance.text, 'A orientação', 1000) }
  if (guidance.active && !guidance.text) throw new RequestValidationError('Escreva a orientação antes de ativá-la.')

  const rawContact = record(body.contact, 'Contato')
  const contact = {
    active: flag(rawContact.active, 'A situação do contato'),
    name: message(rawContact.name, 'O nome do contato', 120),
    phone: message(rawContact.phone, 'O telefone do contato', 40),
    email: message(rawContact.email, 'O e-mail do contato', 160),
    hours: message(rawContact.hours, 'O horário do contato', 120),
  }
  if (contact.phone && !/^[0-9+()\s.-]+$/.test(contact.phone)) throw new RequestValidationError('Telefone do contato inválido.')
  if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw new RequestValidationError('E-mail do contato inválido.')
  if (contact.active && !contact.phone && !contact.email) {
    throw new RequestValidationError('Informe o telefone ou o e-mail antes de ativar o contato.')
  }
  return { fields, notices, guidance, contact }
}

export function validateDriverSettings(section: DriverSettingsSection, body: Record<string, unknown>): DriverSettings[DriverSettingsSection] {
  if (section === 'driverJourney') return readJourney(body)

  if (section === 'driverExecution') {
    const visible = subset(body.visibleGroups, tripGroups, 'Situações exibidas')
    return {
      startFields: subset(body.startFields, startFields, 'Informações para iniciar'),
      finishFields: subset(body.finishFields, finishFields, 'Informações para finalizar'),
      upcomingDays: integer(body.upcomingDays, 'O período de próximas viagens', 1, 60),
      visibleGroups: tripGroups.filter((group) => visible.includes(group) || requiredGroups.includes(group)),
    }
  }

  if (section === 'driverAccess') {
    return {
      portalEnabled: flag(body.portalEnabled, 'O acesso ao portal'),
      occurrencesEnabled: flag(body.occurrencesEnabled, 'O registro de ocorrências'),
      attachmentsEnabled: flag(body.attachmentsEnabled, 'O envio de anexos'),
      allowDocuments: flag(body.allowDocuments, 'O envio de documentos'),
      allowPhotos: flag(body.allowPhotos, 'O envio de fotografias'),
    }
  }

  if (section === 'driverNotifications') {
    const rules = record(body.rules, 'Regras de notificação')
    return {
      rules: Object.fromEntries(
        driverNotificationEvents.map(({ key, label, appliesToDriver }) => {
          const rule = record(rules[key], `A regra de ${label}`)
          return [key, { driver: appliesToDriver && flag(rule.driver, `A regra de ${label}`), team: flag(rule.team, `A regra de ${label}`) }]
        }),
      ) as Record<DriverNotificationEvent, NotificationRule>,
    }
  }

  return readDisplay(body)
}

/** Cadastro de tipo de ocorrência. A chave é gerada na criação e não muda depois. */
export function readOccurrenceType(raw: unknown) {
  const body = record(raw, 'Tipo de ocorrência')
  const label = message(body.label, 'O nome do tipo', 80)
  if (label.length < 2) throw new RequestValidationError('Informe o nome do tipo de ocorrência.')
  return {
    label,
    active: flag(body.active ?? true, 'A situação do tipo'),
    requiresJustification: flag(body.requiresJustification ?? false, 'A justificativa do tipo'),
    allowsAttachments: flag(body.allowsAttachments ?? true, 'Os anexos do tipo'),
    asksDelay: flag(body.asksDelay ?? false, 'O atraso do tipo'),
  }
}

export function occurrenceTypeKey(label: string) {
  return (
    label
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 50) || 'tipo'
  )
}

// ---------------------------------------------------------------------------
// Execução: o que o motorista informa ao iniciar e ao finalizar
// ---------------------------------------------------------------------------

export type ExecutionRecord = { hodometro?: number; observacao?: string; veiculo?: string; justificativa?: string }

const fieldNames: Record<ExecutionField, string> = { vehicle: 'o veículo', odometer: 'o hodômetro', notes: 'a observação' }

function requiredInput(value: unknown, field: ExecutionField, max: number) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length < 2 || text.length > max) {
    throw new RequestValidationError(`Informe ${fieldNames[field]}, com até ${max} caracteres.`)
  }
  return text
}

/** Só grava o que a configuração pede: o restante do corpo, inclusive horários, é ignorado. */
export function readExecutionRecord(
  body: Record<string, unknown>,
  fields: readonly ExecutionField[],
  options: { tripHasVehicle?: boolean } = {},
): ExecutionRecord {
  const found: ExecutionRecord = {}
  if (fields.includes('odometer')) {
    const value = body.hodometro
    found.hodometro = integer(typeof value === 'string' || typeof value === 'number' ? value : undefined, 'O hodômetro', 0, 9_999_999)
  }
  if (fields.includes('notes')) found.observacao = requiredInput(body.observacao, 'notes', 1000)
  if (fields.includes('vehicle') && !options.tripHasVehicle) found.veiculo = requiredInput(body.veiculo, 'vehicle', 120)
  return found
}

export function readJustification(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length < 3 || text.length > 1000) return null
  return text
}

// ---------------------------------------------------------------------------
// O que o motorista consulta. Regras de notificação e tipos inativos não saem daqui.
// ---------------------------------------------------------------------------

export function journeyOf(settings: Pick<DriverSettings, 'driverJourney'>): Journey {
  const { start, end, weekdays, breakMinutes, expectedMinutes } = settings.driverJourney
  return { start, end, weekdays, breakMinutes, expectedMinutes }
}

const photoKinds = new Set(['png', 'jpeg', 'webp'])

/** Formatos aceitos no portal: os gerais do sistema, dentro do que a configuração do portal libera. */
export function portalAttachmentKinds(access: DriverSettings['driverAccess'], allowedKinds: readonly string[]) {
  if (!access.attachmentsEnabled || !access.occurrencesEnabled) return []
  return allowedKinds.filter((kind) => (photoKinds.has(kind) ? access.allowPhotos : access.allowDocuments))
}

export function driverPortalView(settings: DriverSettings, types: readonly OccurrenceType[]) {
  const journey = settings.driverJourney
  const display = settings.driverDisplay
  return {
    enabled: settings.driverAccess.portalEnabled,
    journey: {
      ...journeyOf(settings),
      outsideStart: journey.outsideStart,
      outsideFinish: journey.outsideFinish,
      allowOutsideStart: journey.allowOutsideStart,
    },
    execution: {
      startFields: settings.driverExecution.startFields,
      finishFields: settings.driverExecution.finishFields,
      visibleGroups: settings.driverExecution.visibleGroups,
    },
    occurrences: {
      enabled: settings.driverAccess.occurrencesEnabled,
      types: settings.driverAccess.occurrencesEnabled
        ? types
            .filter((type) => type.active)
            .map(({ key, label, requiresJustification, allowsAttachments, asksDelay }) => ({ key, label, requiresJustification, allowsAttachments, asksDelay }))
        : [],
    },
    display: {
      fields: display.fields,
      notices: display.notices.filter((notice) => notice.active).map((notice) => notice.text),
      guidance: display.guidance.active ? display.guidance.text : null,
      contact: display.contact.active
        ? { name: display.contact.name, phone: display.contact.phone, email: display.contact.email, hours: display.contact.hours }
        : null,
    },
  }
}
