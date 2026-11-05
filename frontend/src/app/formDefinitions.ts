import { saveParameters } from '../api/operationsApi'
import { apiRequest } from '../auth/apiClient'

export const formKeys = ['maintenance', 'fleet', 'airTravel'] as const
export type FormKey = (typeof formKeys)[number]

export const fieldTypes = [
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
  'phone',
  'checkbox',
] as const
export type FormFieldType = (typeof fieldTypes)[number]

export type FormFieldDefinition = {
  id: string
  label: string
  description: string
  type: FormFieldType
  required: boolean
  active: boolean
  protected: boolean
  options: string[]
  // Publicados pelo Gerenciador de formulários. Sem eles, vale o comportamento padrão.
  help?: string
  section?: string
  minLength?: number | null
  maxLength?: number | null
  min?: number | null
  max?: number | null
  visibleTo?: 'all' | 'staff'
  visibleWhen?: { field: string; equals: string } | null
}

export type FormDefinitions = Record<FormKey, FormFieldDefinition[]>
export type FormDefinitionsSnapshot = {
  definitions: FormDefinitions
  error: string | null
  /** Há personalização gravada no servidor. */
  onServer: boolean
}

const storageKey = 'jucesp.form-definitions.v1'

function field(
  id: string,
  label: string,
  type: FormFieldType,
  required = false,
  protectedField = false,
  options: string[] = [],
): FormFieldDefinition {
  return {
    id,
    label,
    description: '',
    type,
    required,
    active: true,
    protected: protectedField,
    options,
  }
}

export function createDefaultFormDefinitions(): FormDefinitions {
  return {
    maintenance: [
      field('solicitante', 'Solicitante', 'shortText', true, true),
      field('email', 'E-mail do solicitante', 'email', true, true),
      field('setor', 'Setor', 'singleSelect', true, true),
      field('andar', 'Andar', 'singleSelect', true, true),
      field('sala', 'Sala', 'shortText'),
      field('tipoSolicitacao', 'Tipo de serviço de manutenção', 'singleSelect', true, true),
      field('descricao', 'Descrição detalhada do problema ou serviço solicitado', 'longText', true, true),
      field('localServico', 'Local onde o serviço deverá ser realizado', 'shortText', true, true),
      {
        ...field('dataPreferencial', 'Data e horário preferenciais', 'dateTime'),
        description: 'Se houver preferência. A data poderá ser ajustada conforme a disponibilidade.',
      },
      field('observacoes', 'Observações adicionais', 'longText'),
    ],
    fleet: [
      field('requester', 'Solicitante', 'shortText', true, true),
      field('sector', 'Setor', 'singleSelect', true, true),
      field('floor', 'Andar', 'singleSelect'),
      field('origin', 'Origem', 'shortText', true, true),
      field('destination', 'Destino', 'shortText', true, true),
      field('departureAt', 'Data e horário de saída', 'dateTime', true, true),
      field('returnAt', 'Data e horário de retorno', 'dateTime'),
      field('serviceRequested', 'Serviço solicitado', 'shortText', true, true),
      field('vehicle', 'Veículo', 'shortText'),
      field('passengerNames', 'Passageiros (um nome por linha)', 'longText'),
      field('notes', 'Observações adicionais', 'longText'),
    ],
    airTravel: [
      field('requesterName', 'Nome do solicitante', 'shortText', true, true),
      field('requesterEmail', 'E-mail do solicitante', 'email', true, true),
      field('requesterSector', 'Setor', 'singleSelect', true, true),
      field('requesterFloor', 'Andar', 'singleSelect', true, true),
      field('requesterRoom', 'Sala', 'shortText'),
      field('passengerName', 'Nome completo', 'shortText', true, true),
      field('passengerCpf', 'CPF', 'shortText', true, true),
      field('tripType', 'Tipo de viagem', 'singleSelect', true, true, ['Somente ida', 'Ida e volta', 'Somente volta']),
      field('outboundOrigin', 'Origem', 'shortText', true, true),
      field('outboundDestination', 'Destino', 'shortText', true, true),
      field('departureDate', 'Data da ida', 'date', true, true),
      field('departureTime', 'Horário da ida', 'time', true, true),
      field('returnOrigin', 'Origem da volta', 'shortText', true, true),
      field('returnDestination', 'Destino da volta', 'shortText', true, true),
      field('returnDate', 'Data da volta', 'date', true, true),
      field('returnTime', 'Horário da volta', 'time', true, true),
      field('baggage', 'Bagagem', 'singleSelect', true, false, [
        'Sem bagagem adicional',
        'Bagagem de mão',
        'Bagagem despachada',
      ]),
      field('notes', 'Observações adicionais', 'longText'),
    ],
  }
}

/**
 * Personalizações salvas antes de uma mudança nos campos padrão continuam valendo: rótulos
 * e campos próprios são mantidos, e os campos protegidos voltam à definição atual.
 */
function mergeWithDefaults(definitions: FormDefinitions): FormDefinitions {
  const defaults = createDefaultFormDefinitions()
  const merged = {} as FormDefinitions

  for (const key of formKeys) {
    const current = defaults[key]
    const stored = definitions[key].map((item) => {
      const standard = current.find((candidate) => candidate.id === item.id)
      if (!standard) return { ...item, protected: false }
      return standard.protected
        ? {
            ...item,
            type: standard.type,
            options: standard.options,
            protected: true,
            active: true,
            required: true,
          }
        : { ...item, protected: false, type: standard.type }
    })
    const missing = current.filter(
      (item) => item.protected && !stored.some((candidate) => candidate.id === item.id),
    )
    merged[key] = [...stored, ...missing]
  }
  return merged
}

function isFieldType(value: unknown): value is FormFieldType {
  return typeof value === 'string' && fieldTypes.includes(value as FormFieldType)
}

function isFieldDefinition(value: unknown): value is FormFieldDefinition {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.description === 'string' &&
    isFieldType(candidate.type) &&
    typeof candidate.required === 'boolean' &&
    typeof candidate.active === 'boolean' &&
    typeof candidate.protected === 'boolean' &&
    Array.isArray(candidate.options) &&
    candidate.options.every((option) => typeof option === 'string')
  )
}

function isDefinitions(value: unknown): value is FormDefinitions {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return formKeys.every(
    (key) =>
      Array.isArray(candidate[key]) &&
      candidate[key].every(isFieldDefinition) &&
      new Set(candidate[key].map((item: FormFieldDefinition) => item.id)).size ===
        candidate[key].length,
  )
}

function hasRequiredFields(definitions: FormDefinitions) {
  const defaults = createDefaultFormDefinitions()
  return formKeys.every((key) =>
    defaults[key]
      .filter((field) => field.protected)
      .every((requiredField) => {
        const field = definitions[key].find(
          (candidate) => candidate.id === requiredField.id,
        )
        return (
          field?.protected === true &&
          field.active &&
          field.required &&
          field.type === requiredField.type &&
          JSON.stringify(field.options) === JSON.stringify(requiredField.options)
        )
      }),
  )
}

function hasValidFieldValues(definitions: FormDefinitions) {
  return formKeys.every((key) => {
    const fields = definitions[key]
    const labels = fields.map((field) =>
      field.label.trim().toLocaleLowerCase('pt-BR'),
    )
    if (labels.some((label) => !label) || new Set(labels).size !== labels.length) {
      return false
    }
    return fields.every((field) => {
      if (
        !['singleSelect', 'multiSelect'].includes(field.type) ||
        [
          'sector',
          'floor',
          'setor',
          'andar',
          'tipoSolicitacao',
          'requesterSector',
          'requesterFloor',
        ].includes(field.id)
      ) {
        return true
      }
      const options = field.options.map((option) =>
        option.trim().toLocaleLowerCase('pt-BR'),
      )
      return (
        options.length > 0 &&
        !options.some((option) => !option) &&
        new Set(options).size === options.length
      )
    })
  })
}

/** Personalização antiga deste navegador, só para oferecer a cópia ao servidor. Nunca é apagada. */
export function readLegacyLocalDefinitions(): FormDefinitions | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (!stored) return null
    const parsed = JSON.parse(stored) as Record<string, unknown>
    if (!isDefinitions(parsed.definitions)) return null
    const definitions = mergeWithDefaults(parsed.definitions)
    return hasRequiredFields(definitions) && hasValidFieldValues(definitions) ? definitions : null
  } catch {
    return null
  }
}

let formSections: Record<string, { id: string; title: string }[]> = {}

/** Título da seção publicada. Sem seções publicadas, o formulário não mostra títulos. */
export function sectionTitle(form: FormKey, field: FormFieldDefinition, previous: FormFieldDefinition | undefined) {
  const sections = formSections[form]
  if (!sections || sections.length < 2 || !field.section || field.section === previous?.section) return undefined
  return sections.find((section) => section.id === field.section)?.title
}

let snapshot: FormDefinitionsSnapshot = {
  definitions: createDefaultFormDefinitions(),
  error: null,
  onServer: false,
}
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((listener) => listener())
}

function publish(next: FormDefinitionsSnapshot) {
  // Sem mudança, a referência se mantém: quem está editando não perde o rascunho.
  if (JSON.stringify(next) === JSON.stringify(snapshot)) return
  snapshot = next
  notify()
}

/** Busca os campos no servidor. Sem resposta, os formulários seguem com os campos padrão. */
export async function loadFormDefinitions() {
  try {
    const data = await apiRequest<{
      success: boolean
      definitions: unknown
      sections?: Record<string, { id: string; title: string }[]>
    }>('/forms/definitions')
    formSections = data.sections ?? {}
    if (data.definitions === null) {
      publish({ definitions: createDefaultFormDefinitions(), error: null, onServer: false })
      return
    }
    const definitions = isDefinitions(data.definitions) ? mergeWithDefaults(data.definitions) : null
    if (!definitions || !hasRequiredFields(definitions) || !hasValidFieldValues(definitions)) {
      publish({
        definitions: createDefaultFormDefinitions(),
        error: 'As personalizações salvas estão inválidas. Os formulários usam os campos padrão.',
        onServer: true,
      })
      return
    }
    publish({ definitions, error: null, onServer: true })
  } catch {
    publish({
      ...snapshot,
      error: 'Não foi possível carregar as personalizações. Os formulários usam os últimos campos conhecidos.',
    })
  }
}

export function subscribeFormDefinitions(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getFormDefinitionsSnapshot() {
  return snapshot
}

export async function saveFormDefinitions(definitions: FormDefinitions) {
  if (
    !isDefinitions(definitions) ||
    !hasRequiredFields(definitions) ||
    !hasValidFieldValues(definitions)
  ) {
    throw new Error('A configuração dos formulários contém dados inválidos.')
  }

  const defaults = createDefaultFormDefinitions()
  for (const key of formKeys) {
    const nextFields = definitions[key]
    const originalProtected = defaults[key].filter((item) => item.protected)
    const normalizedLabels = nextFields.map((item) =>
      item.label.trim().toLocaleLowerCase('pt-BR'),
    )
    if (new Set(normalizedLabels).size !== normalizedLabels.length) {
      throw new Error('Cada campo precisa ter um nome diferente.')
    }
    for (const protectedField of originalProtected) {
      const candidate = nextFields.find((item) => item.id === protectedField.id)
      if (
        !candidate ||
        !candidate.protected ||
        !candidate.active ||
        !candidate.required ||
        candidate.type !== protectedField.type
      ) {
        throw new Error(
          `O campo protegido “${protectedField.label}” deve permanecer ativo, obrigatório e com seu tipo original.`,
        )
      }
    }
    for (const item of nextFields) {
      if (!item.label.trim()) {
        throw new Error('Informe um rótulo para todos os campos.')
      }
      if (
        ['singleSelect', 'multiSelect'].includes(item.type) &&
        ![
          'sector',
          'floor',
          'setor',
          'andar',
          'tipoSolicitacao',
          'requesterSector',
          'requesterFloor',
        ].includes(item.id)
      ) {
        const normalized = item.options.map((option) =>
          option.trim().toLocaleLowerCase('pt-BR'),
        )
        if (
          normalized.length === 0 ||
          normalized.some((option) => !option) ||
          new Set(normalized).size !== normalized.length
        ) {
          throw new Error(
            `Revise as opções do campo “${item.label}”: não podem estar vazias ou duplicadas.`,
          )
        }
      }
    }
  }

  await saveParameters('forms', { definitions })
  publish({ definitions, error: null, onServer: true })
}
