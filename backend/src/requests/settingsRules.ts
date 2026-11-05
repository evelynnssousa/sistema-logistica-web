import { defaultDriverSettings, isDriverSettingsSection, validateDriverSettings } from './driverPortalRules.js'
import { defaultReasons, otherReasonKey } from './justificationRules.js'
import type { ReasonGroup, ReasonOption } from './justificationRules.js'
import { RequestValidationError } from './validation.js'

/**
 * Parâmetros administráveis pela tela, com o padrão de cada um e sua validação. Valores que
 * dependem de decisão institucional começam vazios: sem prazo padrão, nada é presumido.
 */

export const priorities = ['baixa', 'normal', 'alta', 'urgente'] as const
export type Priority = (typeof priorities)[number]

export const notificationCategories = [
  { key: 'nova_solicitacao', label: 'Nova solicitação registrada', requiresAction: false },
  { key: 'agendamento', label: 'Agendamento', requiresAction: false },
  { key: 'reagendamento', label: 'Reagendamento', requiresAction: false },
  { key: 'status', label: 'Andamento e conclusão', requiresAction: false },
  { key: 'cancelamento', label: 'Cancelamento', requiresAction: false },
  { key: 'execucao', label: 'Ocorrência ou atraso na execução', requiresAction: false },
  { key: 'atribuicao', label: 'Atribuição de responsável', requiresAction: true },
  { key: 'aprovacao', label: 'Aprovação pendente', requiresAction: true },
  { key: 'pendencia', label: 'Pendência que exige providência', requiresAction: true },
  { key: 'falha_operacional', label: 'Falha de e-mail ou de agenda', requiresAction: true },
  { key: 'previsao_entrega', label: 'Previsão de entrega de materiais', requiresAction: false },
  { key: 'devolucao', label: 'Devolução para correção ou complementação', requiresAction: true },
] as const

export const actionCategories: readonly string[] = notificationCategories
  .filter((category) => category.requiresAction)
  .map((category) => category.key)

const profiles = ['administrator', 'slm_operator', 'requester'] as const

export const attachmentKinds = ['pdf', 'png', 'jpeg', 'webp', 'docx', 'xlsx', 'txt'] as const
export type AttachmentKind = (typeof attachmentKinds)[number]

export const defaultSettings = {
  operations: {
    staleDays: 5,
    deadlineDays: { baixa: null, normal: null, alta: null, urgente: null } as Record<
      Priority,
      number | null
    >,
  },
  notifications: {
    disabled: { administrator: [], slm_operator: [], requester: [] } as Record<
      (typeof profiles)[number],
      string[]
    >,
    // Dias sem andamento para avisar a equipe. Sem valor definido, nenhum prazo é presumido.
    pendingReminderDays: null as number | null,
  },
  attachments: {
    maxFileMb: 10,
    maxTotalMb: 2048,
    allowedKinds: [...attachmentKinds] as AttachmentKind[],
  },
  calendar: { workdayStart: '08:00', workdayEnd: '18:00' },
  emailTemplates: { overrides: {} as Record<string, { subject?: string; intro?: string }> },
  // Sem personalização gravada, valem os campos padrão de cada formulário.
  forms: { definitions: null as FormDefinitions | null },
  reasons: structuredClone(defaultReasons) as Record<ReasonGroup, ReasonOption[]>,
  // Limites da central de comunicação. Os formatos aceitos são os mesmos dos anexos.
  communications: {
    maxEmailMb: 25,
    maxRecipients: 10,
    allowExternalRecipients: false,
  },
  // Prazos por módulo e por tipo de serviço. Sem valor, nada é presumido.
  deadlines: {
    warningDays: 2,
    byModule: { maintenance: null, fleet: null, flights: null } as Record<DeadlineModule, number | null>,
    byServiceType: {} as Record<string, number>,
  },
  // Portal do Motorista: uma seção por grupo da tela. Ver driverPortalRules.ts.
  ...defaultDriverSettings,
}

type DeadlineModule = 'maintenance' | 'fleet' | 'flights'
const deadlineModules: readonly DeadlineModule[] = ['maintenance', 'fleet', 'flights']

export type SystemSettings = typeof defaultSettings

export const formKeys = ['maintenance', 'fleet', 'airTravel'] as const
export type FormKey = (typeof formKeys)[number]

const formFieldTypes = [
  'shortText',
  'longText',
  'number',
  'email',
  'date',
  'time',
  'dateTime',
  'singleSelect',
  'multiSelect',
  'boolean',
]

export type FormField = {
  id: string
  label: string
  description: string
  type: string
  required: boolean
  active: boolean
  protected: boolean
  options: string[]
}
export type FormDefinitions = Record<FormKey, FormField[]>

const customFieldPrefix = 'custom-'

function readFormField(raw: unknown): FormField {
  const field = record(raw, 'Campo')
  const id = typeof field.id === 'string' ? field.id : ''
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new RequestValidationError('Há um campo inválido.')
  const label = typeof field.label === 'string' ? field.label.trim() : ''
  if (label.length < 1 || label.length > 120) {
    throw new RequestValidationError('Informe um rótulo de até 120 caracteres para todos os campos.')
  }
  const description = typeof field.description === 'string' ? field.description.trim() : ''
  if (description.length > 500) {
    throw new RequestValidationError('A descrição de um campo deve ter no máximo 500 caracteres.')
  }
  if (typeof field.type !== 'string' || !formFieldTypes.includes(field.type)) {
    throw new RequestValidationError('Há um campo com tipo inválido.')
  }
  const options = field.options === undefined ? [] : field.options
  if (
    !Array.isArray(options) ||
    options.length > 100 ||
    options.some((option) => typeof option !== 'string' || option.length > 120)
  ) {
    throw new RequestValidationError('Há um campo com opções inválidas.')
  }
  const isProtected = field.protected === true
  // Um campo protegido sustenta o fluxo da solicitação: não pode sair do formulário.
  if (isProtected && (field.active !== true || field.required !== true)) {
    throw new RequestValidationError(`O campo protegido "${label}" deve permanecer ativo e obrigatório.`)
  }
  return {
    id,
    label,
    description,
    type: field.type,
    required: field.required === true,
    active: field.active === true,
    protected: isProtected,
    options: options as string[],
  }
}

function readFormDefinitions(raw: unknown): FormDefinitions | null {
  if (raw === null || raw === undefined) return null
  const definitions = record(raw, 'Formulários')
  return Object.fromEntries(
    formKeys.map((key) => {
      const list = definitions[key]
      if (!Array.isArray(list) || list.length === 0 || list.length > 60) {
        throw new RequestValidationError('Há um formulário sem campos ou com campos demais.')
      }
      const fields = list.map(readFormField)
      if (new Set(fields.map((field) => field.id)).size !== fields.length) {
        throw new RequestValidationError('Há campos repetidos em um formulário.')
      }
      if (new Set(fields.map((field) => field.label.toLowerCase())).size !== fields.length) {
        throw new RequestValidationError('Cada campo precisa ter um nome diferente.')
      }
      return [key, fields]
    }),
  ) as FormDefinitions
}

/**
 * Primeiro campo criado na personalização que é obrigatório e veio vazio. Os campos próprios de
 * cada formulário já são conferidos pela validação do módulo.
 */
export function missingRequiredCustomField(
  definitions: FormDefinitions | null,
  form: FormKey,
  customFields: unknown,
) {
  const values =
    typeof customFields === 'object' && customFields !== null
      ? (customFields as Record<string, unknown>)
      : {}
  return (definitions?.[form] ?? []).find((field) => {
    if (!field.id.startsWith(customFieldPrefix) || !field.active || !field.required) return false
    const value = values[field.id]
    return typeof value !== 'string' || !value.trim()
  })
}
export type SettingsSection = keyof SystemSettings

export function isSettingsSection(value: string): value is SettingsSection {
  return Object.prototype.hasOwnProperty.call(defaultSettings, value)
}

function record(value: unknown, label: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestValidationError(`${label} inválido.`)
  }
  return value as Record<string, unknown>
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

function shortText(value: unknown, label: string, max: number) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new RequestValidationError(`${label} inválido.`)
  const text = value.trim()
  if (text.length > max) {
    throw new RequestValidationError(`${label} deve ter no máximo ${max} caracteres.`)
  }
  // Modelos não aceitam marcação nem campos de dados: o texto vai como está.
  if (/[<>{}]/.test(text)) {
    throw new RequestValidationError(`${label} não pode conter os caracteres < > { }.`)
  }
  return text || undefined
}

function readReasons(raw: unknown, group: ReasonGroup): ReasonOption[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 40) {
    throw new RequestValidationError('Lista de motivos inválida.')
  }
  const list = raw.map((entry) => {
    const item = record(entry, 'Motivo')
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    if (label.length < 2 || label.length > 120 || /[<>{}]/.test(label)) {
      throw new RequestValidationError('Cada motivo precisa de um nome de 2 a 120 caracteres, sem < > { }.')
    }
    const slug = label
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 50)
    const key = typeof item.key === 'string' && /^[a-z0-9_]{1,60}$/.test(item.key) ? item.key : slug
    return { key, label, active: item.active !== false }
  })
  if (new Set(list.map((item) => item.key)).size !== list.length) {
    throw new RequestValidationError('Há motivos repetidos na lista.')
  }
  // "Outros" sustenta o texto livre: sem ele, uma situação não prevista não teria como ser registrada.
  const other = list.find((item) => item.key === otherReasonKey)
  if (!other) return [...list, ...defaultReasons[group].filter((item) => item.key === otherReasonKey)]
  return list.map((item) => (item.key === otherReasonKey ? { ...item, active: true } : item))
}

/** Só aceita o que a tela oferece. Campos desconhecidos são descartados, nunca gravados. */
export function validateSettings(
  section: SettingsSection,
  raw: unknown,
  knownTemplates: readonly string[] = [],
): SystemSettings[SettingsSection] {
  const body = record(raw, 'Parâmetro')

  if (isDriverSettingsSection(section)) return validateDriverSettings(section, body)

  if (section === 'operations') {
    const deadlines = record(body.deadlineDays ?? {}, 'Prazo')
    return {
      staleDays: integer(body.staleDays, 'O período sem movimentação', 1, 365),
      deadlineDays: Object.fromEntries(
        priorities.map((priority) => [
          priority,
          deadlines[priority] === null || deadlines[priority] === undefined || deadlines[priority] === ''
            ? null
            : integer(deadlines[priority], 'O prazo', 1, 365),
        ]),
      ) as Record<Priority, number | null>,
    }
  }

  if (section === 'notifications') {
    const disabled = record(body.disabled ?? {}, 'Notificações')
    const known = new Set<string>(notificationCategories.map((category) => category.key))
    return {
      disabled: Object.fromEntries(
        profiles.map((profile) => {
          const list = disabled[profile] ?? []
          if (!Array.isArray(list)) throw new RequestValidationError('Notificações inválidas.')
          return [profile, [...new Set(list.filter((item): item is string => known.has(String(item))))]]
        }),
      ) as Record<(typeof profiles)[number], string[]>,
      pendingReminderDays:
        body.pendingReminderDays === null ||
        body.pendingReminderDays === undefined ||
        body.pendingReminderDays === ''
          ? null
          : integer(body.pendingReminderDays, 'O aviso de solicitações paradas', 1, 365),
    }
  }

  if (section === 'forms') {
    return { definitions: readFormDefinitions(body.definitions) }
  }

  if (section === 'reasons') {
    return Object.fromEntries(
      (Object.keys(defaultReasons) as ReasonGroup[]).map((group) => [group, readReasons(body[group], group)]),
    ) as Record<ReasonGroup, ReasonOption[]>
  }

  if (section === 'communications') {
    return {
      // O provedor atual recusa mensagens acima de 40 MB, contando a codificação dos anexos.
      maxEmailMb: integer(body.maxEmailMb, 'O tamanho total dos anexos', 1, 30),
      maxRecipients: integer(body.maxRecipients, 'O limite de destinatários', 1, 50),
      allowExternalRecipients: body.allowExternalRecipients === true,
    }
  }

  if (section === 'deadlines') {
    const byModule = record(body.byModule ?? {}, 'Prazo por módulo')
    const byServiceType = record(body.byServiceType ?? {}, 'Prazo por tipo de serviço')
    const optionalDays = (value: unknown) =>
      value === null || value === undefined || value === '' ? null : integer(value, 'O prazo', 1, 365)
    const types = Object.entries(byServiceType).filter(([, value]) => optionalDays(value) !== null)
    if (types.some(([key]) => !/^[0-9a-f-]{36}$/i.test(key))) {
      throw new RequestValidationError('Há um tipo de serviço inválido nos prazos.')
    }
    return {
      warningDays: integer(body.warningDays, 'A antecedência do alerta', 1, 60),
      byModule: Object.fromEntries(
        deadlineModules.map((module) => [module, optionalDays(byModule[module])]),
      ) as Record<DeadlineModule, number | null>,
      byServiceType: Object.fromEntries(types.map(([key, value]) => [key, optionalDays(value) as number])),
    }
  }

  if (section === 'attachments') {
    const kinds = Array.isArray(body.allowedKinds) ? body.allowedKinds : []
    const allowedKinds = attachmentKinds.filter((kind) => kinds.includes(kind))
    if (allowedKinds.length === 0) {
      throw new RequestValidationError('Mantenha ao menos um tipo de arquivo permitido.')
    }
    const maxFileMb = integer(body.maxFileMb, 'O tamanho por arquivo', 1, 100)
    const maxTotalMb = integer(body.maxTotalMb, 'A capacidade total', 1, 1_000_000)
    if (maxTotalMb < maxFileMb) {
      throw new RequestValidationError('A capacidade total não pode ser menor que o limite por arquivo.')
    }
    return { maxFileMb, maxTotalMb, allowedKinds }
  }

  if (section === 'calendar') {
    const workdayStart = hour(body.workdayStart, 'O início do expediente')
    const workdayEnd = hour(body.workdayEnd, 'O fim do expediente')
    if (workdayEnd <= workdayStart) {
      throw new RequestValidationError('O fim do expediente deve ser depois do início.')
    }
    return { workdayStart, workdayEnd }
  }

  const overrides = record(body.overrides ?? {}, 'Modelos')
  const clean: Record<string, { subject?: string; intro?: string }> = {}
  for (const [key, value] of Object.entries(overrides)) {
    if (!knownTemplates.includes(key)) {
      throw new RequestValidationError('Modelo de e-mail desconhecido.')
    }
    const template = record(value, 'Modelo')
    const subject = shortText(template.subject, 'O assunto', 150)
    const intro = shortText(template.intro, 'O texto de abertura', 600)
    if (subject || intro) clean[key] = { ...(subject ? { subject } : {}), ...(intro ? { intro } : {}) }
  }
  return { overrides: clean }
}

/** Junta o que está gravado com o padrão, para um campo novo nunca ficar indefinido. */
export function mergeSettings(rows: readonly { secao: string; valor: unknown }[]): SystemSettings {
  const merged = structuredClone(defaultSettings) as SystemSettings
  for (const row of rows) {
    if (isSettingsSection(row.secao)) {
      Object.assign(merged[row.secao], row.valor)
    }
  }
  return merged
}

/** Prazo padrão de uma nova solicitação, ou null quando o parâmetro não foi definido. */
export function defaultDeadline(
  settings: Pick<SystemSettings, 'operations'> & Partial<Pick<SystemSettings, 'deadlines'>>,
  priority: string,
  now = new Date(),
  scope: { module?: DeadlineModule; serviceTypeId?: string | null } = {},
) {
  // Vale o mais curto entre os definidos: uma urgência nunca fica com o prazo folgado do módulo.
  const candidates = [
    settings.operations.deadlineDays[priority as Priority],
    scope.module ? settings.deadlines?.byModule?.[scope.module] : null,
    scope.serviceTypeId ? settings.deadlines?.byServiceType?.[scope.serviceTypeId] : null,
  ].filter((value): value is number => typeof value === 'number' && value > 0)
  return candidates.length > 0 ? new Date(now.getTime() + Math.min(...candidates) * 86_400_000) : null
}
