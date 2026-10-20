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
}

export type FormDefinitions = Record<FormKey, FormFieldDefinition[]>
export type FormDefinitionsSnapshot = {
  definitions: FormDefinitions
  error: string | null
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
      field('observacoes', 'Observações adicionais', 'longText'),
    ],
    fleet: [
      field('requester', 'Solicitante', 'shortText', true, true),
      field('vehicle', 'Veículo', 'shortText', true, true),
      field('serviceRequested', 'Serviço solicitado', 'shortText', true, true),
    ],
    airTravel: [
      field('requesterName', 'Nome do solicitante', 'shortText', true, true),
      field('requesterEmail', 'E-mail do solicitante', 'email', true, true),
      field('requesterSector', 'Setor', 'singleSelect', true, true),
      field('requesterFloor', 'Andar', 'singleSelect', true, true),
      field('requesterRoom', 'Sala', 'shortText'),
      field('passengerName', 'Nome completo', 'shortText', true, true),
      field('passengerCpf', 'CPF', 'shortText', true, true),
      field('tripType', 'Tipo de viagem', 'singleSelect', true, true, ['Somente ida', 'Ida e volta']),
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

function readInitialSnapshot(): FormDefinitionsSnapshot {
  if (typeof window === 'undefined') {
    return { definitions: createDefaultFormDefinitions(), error: null }
  }
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (!stored) {
      return { definitions: createDefaultFormDefinitions(), error: null }
    }
    const parsed: unknown = JSON.parse(stored)
    const storedRecord =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null
    if (
      !storedRecord ||
      ![1, 2].includes(storedRecord.version as number) ||
      !isDefinitions(storedRecord.definitions) ||
      !hasRequiredFields(storedRecord.definitions) ||
      !hasValidFieldValues(storedRecord.definitions)
    ) {
      return {
        definitions: createDefaultFormDefinitions(),
        error:
          'As personalizações salvas estão inválidas ou incompatíveis. Elas não foram aplicadas.',
      }
    }
    if (storedRecord.version === 1) {
      const migrated = {
        version: 2,
        definitions: storedRecord.definitions,
      }
      window.localStorage.setItem(storageKey, JSON.stringify(migrated))
    }
    return {
      definitions: storedRecord.definitions as FormDefinitions,
      error: null,
    }
  } catch {
    return {
      definitions: createDefaultFormDefinitions(),
      error: 'Não foi possível ler as personalizações neste navegador.',
    }
  }
}

let snapshot = readInitialSnapshot()
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((listener) => listener())
}

function onStorage(event: StorageEvent) {
  if (event.key !== storageKey && event.key !== null) return
  if (event.newValue === null) {
    snapshot = { definitions: createDefaultFormDefinitions(), error: null }
    notify()
    return
  }
  try {
    const parsed: unknown = JSON.parse(event.newValue)
    const record = parsed as Record<string, unknown>
    if (
      ![1, 2].includes(record.version as number) ||
      !isDefinitions(record.definitions) ||
      !hasRequiredFields(record.definitions) ||
      !hasValidFieldValues(record.definitions)
    ) {
      snapshot = { ...snapshot, error: 'As personalizações em outra aba são inválidas.' }
    } else {
      snapshot = { definitions: record.definitions, error: null }
    }
  } catch {
    snapshot = { ...snapshot, error: 'Não foi possível ler as personalizações em outra aba.' }
  }
  notify()
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', onStorage)
}

export function subscribeFormDefinitions(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getFormDefinitionsSnapshot() {
  return snapshot
}

export function saveFormDefinitions(definitions: FormDefinitions) {
  if (snapshot.error) {
    throw new Error('Resolva o problema de armazenamento antes de salvar.')
  }
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

  try {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ version: 2, definitions }),
    )
  } catch {
    throw new Error(
      'Não foi possível salvar no armazenamento deste navegador.',
    )
  }
  snapshot = { definitions, error: null }
  notify()
}
