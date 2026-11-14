import { RequestValidationError } from './validation.js'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/passwordPolicy.js'

/**
 * Formulários administráveis. O que sustenta o funcionamento do módulo fica protegido aqui, no
 * servidor: a tela pode renomear e reordenar esses campos, nunca retirá-los ou mudar o tipo. A
 * validação de cada módulo continua valendo, e nenhum texto vira código ou expressão.
 */

export const managedForms = {
  registration: 'Criação de conta',
  maintenance: 'Manutenção',
  fleet: 'Frota',
  airTravel: 'Passagens aéreas',
  warehouseControl: 'Controle interno do Almoxarifado',
  // 13/11/2026: os campos existentes podem ser renomeados; campos novos são gravados junto do registro.
  warehouseRequest: 'Pedido de materiais (Almoxarifado)',
  warehouseExternal: 'Pedido externo (Almoxarifado)',
  warehouseDelivery: 'Registro de entrega (Almoxarifado)',
  material: 'Cadastro de material (Almoxarifado)',
  demand: 'Nova demanda (Controle de Demandas)',
  contractInstrument: 'Ata ou contrato (Controle de Demandas)',
  vehicle: 'Cadastro de veículo (Frota)',
  driver: 'Cadastro de motorista (Frota)',
  driverOccurrence: 'Ocorrência do motorista (Portal do Motorista)',
  equipment: 'Cadastro de equipamento (Manutenção)',
  maintenanceExecution: 'Registro de execução (Manutenção)',
  flightQuote: 'Cotação de passagem (Passagens aéreas)',
} as const

/**
 * Formulários em que só os campos novos e os nomes mudam: a ordem e o tipo dos campos existentes
 * seguem a tela, e os campos novos aparecem ao final, em "Informações adicionais".
 */
export const fixedLayoutForms: readonly ManagedForm[] = [
  'warehouseRequest', 'warehouseExternal', 'warehouseDelivery', 'material', 'demand', 'contractInstrument',
  'vehicle', 'driver', 'driverOccurrence', 'equipment', 'maintenanceExecution', 'flightQuote',
]

export type ManagedForm = keyof typeof managedForms

export function isManagedForm(value: string): value is ManagedForm {
  return Object.prototype.hasOwnProperty.call(managedForms, value)
}

export const managedFieldTypes = [
  'shortText', 'longText', 'number', 'email', 'phone', 'date', 'time', 'dateTime',
  'singleSelect', 'multiSelect', 'boolean', 'checkbox', 'attachment',
] as const
export type ManagedFieldType = (typeof managedFieldTypes)[number]

/**
 * Campo "Anexo" (13/11/2026): só nos formulários cujo registro tem a lista de anexos das
 * solicitações (request_attachments). O arquivo vai para essa lista logo depois do envio, com as
 * mesmas permissões, limites e conferências; o campo guarda o nome do arquivo no registro.
 */
export const attachmentFieldForms: readonly ManagedForm[] = [
  'maintenance', 'fleet', 'airTravel', 'warehouseRequest', 'warehouseExternal',
]

const validationRules = ['none', 'digits', 'letters', 'phone', 'email'] as const
export type ValidationRule = (typeof validationRules)[number]

export const catalogSources = ['sectors', 'floors', 'serviceTypes', 'warehouseCategories', 'measurementUnits', 'materials'] as const
export type CatalogSource = (typeof catalogSources)[number]

export type ManagedField = {
  id: string
  label: string
  description: string
  help: string
  type: ManagedFieldType
  required: boolean
  active: boolean
  protected: boolean
  options: string[]
  /** Lista vinda de um cadastro central. Nunca se mantém uma cópia das opções aqui. */
  catalog: CatalogSource | null
  section: string
  minLength: number | null
  maxLength: number | null
  min: number | null
  max: number | null
  validation: ValidationRule
  visibleTo: 'all' | 'staff'
  visibleWhen: { field: string; equals: string } | null
}

export type ManagedFormContent = {
  sections: { id: string; title: string }[]
  fields: ManagedField[]
}

const blank = {
  description: '', help: '', options: [] as string[], catalog: null, section: 'principal',
  minLength: null, maxLength: null, min: null, max: null, validation: 'none' as ValidationRule,
  visibleTo: 'all' as const, visibleWhen: null, active: true,
}

function fixed(
  id: string,
  label: string,
  type: ManagedFieldType,
  extra: Partial<ManagedField> = {},
): ManagedField {
  return { ...blank, id, label, type, required: true, protected: true, ...extra }
}

function free(id: string, label: string, type: ManagedFieldType, extra: Partial<ManagedField> = {}): ManagedField {
  return { ...blank, id, label, type, required: false, protected: false, ...extra }
}

const principal = [{ id: 'principal', title: 'Dados da solicitação' }]

/** Campo existente de um formulário de leiaute fixo: renomeável, nunca removido nem alterado. */
function standard(id: string, label: string, type: ManagedFieldType, required = false, extra: Partial<ManagedField> = {}): ManagedField {
  return { ...blank, id, label, type, required, protected: true, ...extra }
}

const fixedSections = [{ id: 'principal', title: 'Dados' }, { id: 'adicionais', title: 'Informações adicionais' }]

/** Campos padrão, na mesma ordem de frontend/src/app/formDefinitions.ts. */
export const defaultForms: Record<ManagedForm, ManagedFormContent> = {
  registration: {
    sections: [{ id: 'principal', title: 'Dados cadastrais' }, { id: 'acesso', title: 'Acesso' }],
    fields: [
      fixed('fullName', 'Nome completo', 'shortText', { minLength: 2, maxLength: 120 }),
      fixed('email', 'E-mail institucional', 'email', { maxLength: 254, validation: 'email' }),
      fixed('sector', 'Setor', 'shortText', { minLength: 2, maxLength: 120 }),
      fixed('password', 'Senha', 'shortText', { section: 'acesso', minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH }),
      fixed('passwordConfirmation', 'Confirme a senha', 'shortText', { section: 'acesso', minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH }),
    ],
  },
  maintenance: {
    sections: principal,
    fields: [
      fixed('solicitante', 'Solicitante', 'shortText'),
      fixed('email', 'E-mail do solicitante', 'email'),
      fixed('setor', 'Setor', 'singleSelect', { catalog: 'sectors' }),
      fixed('andar', 'Andar', 'singleSelect', { catalog: 'floors' }),
      free('sala', 'Sala', 'shortText'),
      fixed('tipoSolicitacao', 'Tipo de serviço de manutenção', 'singleSelect', { catalog: 'serviceTypes' }),
      fixed('descricao', 'Descrição detalhada do problema ou serviço solicitado', 'longText'),
      fixed('localServico', 'Local onde o serviço deverá ser realizado', 'shortText'),
      free('dataPreferencial', 'Data e horário preferenciais', 'dateTime', {
        description: 'Se houver preferência. A data poderá ser ajustada conforme a disponibilidade.',
      }),
      free('observacoes', 'Observações adicionais', 'longText'),
    ],
  },
  fleet: {
    sections: principal,
    fields: [
      fixed('requester', 'Solicitante', 'shortText'),
      fixed('sector', 'Setor', 'singleSelect', { catalog: 'sectors' }),
      free('floor', 'Andar', 'singleSelect', { catalog: 'floors' }),
      fixed('origin', 'Origem', 'shortText'),
      fixed('destination', 'Destino', 'shortText'),
      fixed('departureAt', 'Data e horário de saída', 'dateTime'),
      free('returnAt', 'Data e horário de retorno', 'dateTime'),
      fixed('serviceRequested', 'Serviço solicitado', 'shortText'),
      free('vehicle', 'Veículo', 'shortText'),
      free('passengerNames', 'Passageiros (um nome por linha)', 'longText'),
      free('notes', 'Observações adicionais', 'longText'),
    ],
  },
  airTravel: {
    sections: principal,
    fields: [
      fixed('requesterName', 'Nome do solicitante', 'shortText'),
      fixed('requesterEmail', 'E-mail do solicitante', 'email'),
      fixed('requesterSector', 'Setor', 'singleSelect', { catalog: 'sectors' }),
      fixed('requesterFloor', 'Andar', 'singleSelect', { catalog: 'floors' }),
      free('requesterRoom', 'Sala', 'shortText'),
      fixed('passengerName', 'Nome completo', 'shortText'),
      fixed('passengerCpf', 'CPF', 'shortText'),
      fixed('tripType', 'Tipo de viagem', 'singleSelect', { options: ['Somente ida', 'Ida e volta', 'Somente volta'] }),
      fixed('outboundOrigin', 'Origem', 'shortText'),
      fixed('outboundDestination', 'Destino', 'shortText'),
      fixed('departureDate', 'Data da ida', 'date'),
      fixed('departureTime', 'Horário da ida', 'time'),
      fixed('returnOrigin', 'Origem da volta', 'shortText'),
      fixed('returnDestination', 'Destino da volta', 'shortText'),
      fixed('returnDate', 'Data da volta', 'date'),
      fixed('returnTime', 'Horário da volta', 'time'),
      free('baggage', 'Bagagem', 'singleSelect', {
        required: true,
        options: ['Sem bagagem adicional', 'Bagagem de mão', 'Bagagem despachada'],
      }),
      free('notes', 'Observações adicionais', 'longText'),
    ],
  },
  warehouseControl: {
    sections: [
      { id: 'principal', title: 'Identificação' },
      { id: 'quantidades', title: 'Quantidades' },
      { id: 'registro', title: 'Registro' },
    ],
    fields: [
      free('reference', 'Referência da solicitação governamental', 'shortText', { maxLength: 120 }),
      free('sector', 'Setor', 'singleSelect', { catalog: 'sectors' }),
      fixed('material', 'Material', 'singleSelect', { catalog: 'materials' }),
      free('description', 'Descrição', 'longText', { maxLength: 2000 }),
      free('referenceQuantity', 'Quantidade de referência', 'number', { section: 'quantidades', min: 0 }),
      free('countedQuantity', 'Quantidade conferida', 'number', { section: 'quantidades', min: 0 }),
      free('providedQuantity', 'Quantidade disponibilizada', 'number', { section: 'quantidades', min: 0 }),
      free('notes', 'Observações', 'longText', { section: 'registro', maxLength: 2000 }),
      free('divergenceJustification', 'Justificativa de divergências', 'longText', { section: 'registro', maxLength: 2000 }),
    ],
  },
  warehouseRequest: {
    sections: fixedSections,
    fields: [
      standard('items', 'Materiais e quantidades', 'longText', true),
      standard('note', 'Observação', 'longText'),
    ],
  },
  warehouseExternal: {
    sections: fixedSections,
    fields: [
      standard('externalReference', 'Número de referência no sistema governamental', 'shortText'),
      standard('externalRequester', 'Solicitante informado no pedido', 'shortText'),
      standard('externalRequesterEmail', 'E-mail institucional do solicitante', 'email'),
      standard('sector', 'Setor', 'singleSelect', true, { catalog: 'sectors' }),
      standard('note', 'Observação', 'longText'),
      standard('items', 'Materiais e quantidades', 'longText', true),
    ],
  },
  warehouseDelivery: {
    sections: fixedSections,
    fields: [
      standard('receivedBy', 'Recebido por', 'shortText', true),
      standard('deliveredDate', 'Data da entrega', 'date'),
      standard('deliveryNote', 'Observação interna da entrega', 'longText'),
    ],
  },
  material: {
    sections: fixedSections,
    fields: [
      standard('name', 'Nome', 'shortText', true),
      standard('code', 'Código', 'shortText'),
      standard('unit', 'Unidade de medida', 'singleSelect', true, { catalog: 'measurementUnits' }),
      standard('category', 'Categoria', 'singleSelect', false, { catalog: 'warehouseCategories' }),
      standard('location', 'Localização (armário, prateleira)', 'shortText'),
      standard('description', 'Descrição', 'longText'),
    ],
  },
  demand: {
    sections: fixedSections,
    fields: [
      standard('title', 'Título', 'shortText', true),
      standard('description', 'Descrição detalhada', 'longText', true),
      standard('category', 'Categoria', 'singleSelect', true),
      standard('originSector', 'Setor de origem', 'singleSelect', true),
      standard('responsibleSector', 'Setor responsável', 'singleSelect', true),
      standard('followUpManager', 'Diretor responsável pelo acompanhamento', 'singleSelect'),
      standard('requester', 'Solicitante', 'singleSelect'),
      standard('responsible', 'Responsável principal', 'singleSelect'),
      standard('startDate', 'Início previsto', 'date'),
      standard('dueDate', 'Prazo para conclusão', 'date'),
      standard('priority', 'Prioridade', 'singleSelect', true),
      standard('notes', 'Observações', 'longText'),
      standard('references', 'Referências ou documentos relacionados', 'longText'),
    ],
  },
  contractInstrument: {
    sections: fixedSections,
    fields: [
      standard('type', 'Tipo', 'singleSelect', true),
      standard('number', 'Número', 'shortText', true),
      standard('category', 'Categoria', 'singleSelect', true),
      standard('process', 'Processo', 'shortText'),
      standard('subject', 'Objeto', 'longText', true),
      standard('supplier', 'Fornecedor', 'shortText'),
      standard('total', 'Valor total (R$)', 'number', true),
      standard('validFrom', 'Início da vigência', 'date'),
      standard('validUntil', 'Fim da vigência', 'date'),
      standard('responsibleSector', 'Setor responsável', 'singleSelect', true),
      standard('manager', 'Gestor ou fiscal', 'singleSelect'),
      standard('noticeDays', 'Avisar quantos dias antes do fim', 'number', true),
      standard('notes', 'Observações', 'longText'),
    ],
  },
  vehicle: {
    sections: fixedSections,
    fields: [
      standard('plate', 'Placa', 'shortText', true),
      standard('model', 'Modelo', 'shortText', true),
      standard('internalId', 'Identificação interna', 'shortText'),
      standard('status', 'Situação', 'singleSelect'),
      standard('mileage', 'Quilometragem atual', 'number'),
      standard('nextReviewKm', 'Próxima revisão (km)', 'number'),
      standard('nextReviewDate', 'Próxima revisão (data)', 'date'),
    ],
  },
  driver: {
    sections: fixedSections,
    fields: [
      standard('name', 'Nome', 'shortText', true),
      standard('registration', 'Matrícula (opcional)', 'shortText'),
      standard('account', 'Conta de acesso', 'singleSelect'),
    ],
  },
  driverOccurrence: {
    sections: fixedSections,
    fields: [
      standard('category', 'O que aconteceu?', 'singleSelect', true),
      standard('delay', 'Atraso, em minutos', 'number'),
      standard('description', 'Descrição', 'longText', true),
      standard('justification', 'Justificativa', 'longText'),
    ],
  },
  equipment: {
    sections: fixedSections,
    fields: [
      standard('name', 'Nome', 'shortText', true),
      standard('identification', 'Identificação', 'shortText'),
      standard('location', 'Local', 'shortText'),
    ],
  },
  maintenanceExecution: {
    sections: fixedSections,
    fields: [
      standard('executedBy', 'Quem realizou', 'shortText', true),
      standard('executedAt', 'Data e horário', 'dateTime', true),
      standard('equipment', 'Equipamento (opcional)', 'singleSelect'),
      standard('service', 'Serviço realizado', 'longText', true),
      standard('pending', 'Pendências', 'longText'),
    ],
  },
  flightQuote: {
    sections: fixedSections,
    fields: [
      standard('company', 'Companhia', 'shortText', true),
      standard('flights', 'Voos', 'longText', true),
      standard('value', 'Valor (R$)', 'number', true),
      standard('validUntil', 'Validade', 'dateTime'),
      standard('conditions', 'Condições', 'longText'),
    ],
  },
}

const centralLists: { pattern: RegExp; source: string }[] = [
  { pattern: /^setor(es)?$/, source: 'Setores' },
  { pattern: /^andar(es)?$/, source: 'Andares' },
  { pattern: /^tipos? de servico/, source: 'Tipos de serviços' },
  { pattern: /^unidades?( de medida)?$/, source: 'Unidades de medida' },
  { pattern: /^categorias?$/, source: 'Categorias do Almoxarifado' },
]

function normalized(text: string) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
}

function fail(message: string): never {
  throw new RequestValidationError(message)
}

function plain(value: unknown, label: string, max: number) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') fail(`${label} inválido.`)
  const text = value.trim()
  if (text.length > max) fail(`${label} deve ter no máximo ${max} caracteres.`)
  // O texto vai para a tela como texto. Marcação nunca é aceita.
  if (/[<>]/.test(text)) fail(`${label} não pode conter os caracteres < >.`)
  return text
}

function limit(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number) || Math.abs(number) > 9_999_999) fail(`${label} inválido.`)
  return number
}

function readField(raw: unknown, known: Map<string, ManagedField>, sections: readonly string[]): ManagedField {
  const field = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const id = String(field.id ?? '')
  const standard = known.get(id)
  if (!standard && !/^custom-[A-Za-z0-9_-]{1,70}$/.test(id)) fail('Há um campo com identificação inválida.')

  const label = plain(field.label, 'O nome do campo', 120)
  if (!label) fail('Informe o nome de todos os campos.')
  const type = (standard?.type ?? field.type) as ManagedFieldType
  if (!managedFieldTypes.includes(type)) fail(`O campo "${label}" tem um tipo inválido.`)
  const validation = (field.validation ?? 'none') as ValidationRule
  if (!validationRules.includes(validation)) fail(`O campo "${label}" tem uma validação inválida.`)
  const section = String(field.section ?? 'principal')
  if (!sections.includes(section)) fail(`O campo "${label}" está em uma seção inexistente.`)

  const source = standard ? standard.catalog : ((field.catalog ?? null) as CatalogSource | null)
  if (source !== null && !catalogSources.includes(source)) fail(`O campo "${label}" usa uma lista inválida.`)
  // Campo protegido: as opções são as da tela (ou de um cadastro do módulo) e nunca vêm do editor.
  const options = source || standard?.protected ? (standard?.options ?? []) : field.options ?? []
  if (!Array.isArray(options) || options.length > 100) fail(`O campo "${label}" tem opções inválidas.`)
  const cleanOptions = options.map((option) => plain(option, `Uma opção de "${label}"`, 120))

  if (['singleSelect', 'multiSelect'].includes(type) && !standard?.protected) {
    if (!source) {
      if (cleanOptions.length === 0 || cleanOptions.some((option) => !option)) {
        fail(`Informe as opções do campo "${label}".`)
      }
      if (new Set(cleanOptions.map(normalized)).size !== cleanOptions.length) {
        fail(`O campo "${label}" tem opções repetidas.`)
      }
      const central = centralLists.find((item) => item.pattern.test(normalized(label)))
      if (central) {
        fail(`"${label}" já tem cadastro central. Use a lista de ${central.source} em vez de criar outra.`)
      }
    }
  } else if (cleanOptions.length > 0 && !['singleSelect', 'multiSelect'].includes(type)) {
    fail(`O campo "${label}" não usa lista de opções.`)
  }

  const minLength = limit(field.minLength, `O tamanho mínimo de "${label}"`)
  const maxLength = limit(field.maxLength, `O tamanho máximo de "${label}"`)
  const min = limit(field.min, `O valor mínimo de "${label}"`)
  const max = limit(field.max, `O valor máximo de "${label}"`)
  if (minLength !== null && maxLength !== null && minLength > maxLength) fail(`O tamanho mínimo de "${label}" supera o máximo.`)
  if (min !== null && max !== null && min > max) fail(`O valor mínimo de "${label}" supera o máximo.`)

  const when = field.visibleWhen as { field?: unknown; equals?: unknown } | null | undefined
  const visibleWhen = when && when.field ? { field: String(when.field), equals: plain(when.equals, 'O valor da regra', 120) } : null

  const content: ManagedField = {
    id,
    label,
    description: plain(field.description, `A descrição de "${label}"`, 500),
    help: plain(field.help, `A orientação de "${label}"`, 500),
    type,
    required: field.required === true,
    active: field.active !== false,
    protected: standard?.protected ?? false,
    options: cleanOptions,
    catalog: source,
    section,
    minLength,
    maxLength,
    min,
    max,
    validation,
    visibleTo: field.visibleTo === 'staff' ? 'staff' : 'all',
    visibleWhen,
  }

  if (standard?.protected) {
    // Limites de segurança, como o tamanho da senha, nunca ficam mais frouxos.
    return {
      ...content,
      required: standard.required,
      active: true,
      visibleTo: 'all',
      visibleWhen: null,
      minLength: standard.minLength ?? content.minLength,
      maxLength: standard.maxLength ?? content.maxLength,
      validation: standard.validation === 'none' ? content.validation : standard.validation,
    }
  }
  return content
}

/** Só aceita o que a tela oferece. Campos protegidos ausentes reprovam a publicação. */
export function validateFormContent(form: ManagedForm, raw: unknown): ManagedFormContent {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const defaults = defaultForms[form]
  const known = new Map(defaults.fields.map((field) => [field.id, field]))

  if (!Array.isArray(body.sections) || body.sections.length === 0 || body.sections.length > 20) {
    fail('Mantenha ao menos uma seção no formulário.')
  }
  const sections = body.sections.map((entry) => {
    const section = (entry ?? {}) as Record<string, unknown>
    const id = String(section.id ?? '')
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) fail('Há uma seção com identificação inválida.')
    const title = plain(section.title, 'O título da seção', 120)
    if (!title) fail('Informe o título de todas as seções.')
    return { id, title }
  })
  if (new Set(sections.map((section) => section.id)).size !== sections.length) fail('Há seções repetidas.')

  if (!Array.isArray(body.fields) || body.fields.length === 0 || body.fields.length > 80) {
    fail('O formulário precisa ter de 1 a 80 campos.')
  }
  const ids = sections.map((section) => section.id)
  const fields = body.fields.map((entry) => readField(entry, known, ids))
  const attachment = fields.find((field) => field.type === 'attachment')
  if (attachment && !attachmentFieldForms.includes(form)) {
    fail(`O campo "${attachment.label}" é do tipo Anexo, que este formulário não aceita.`)
  }

  if (new Set(fields.map((field) => field.id)).size !== fields.length) fail('Há campos repetidos no formulário.')
  if (new Set(fields.map((field) => normalized(field.label))).size !== fields.length) {
    fail('Cada campo precisa ter um nome diferente.')
  }

  for (const standard of defaults.fields.filter((field) => field.protected)) {
    if (!fields.some((field) => field.id === standard.id)) {
      fail(`O campo protegido "${standard.label}" não pode ser removido.`)
    }
  }

  // Regra condicional só olha para trás: assim não há ciclo, nem campo que dependa de si mesmo.
  fields.forEach((field, index) => {
    if (!field.visibleWhen) return
    const source = fields.slice(0, index).find((candidate) => candidate.id === field.visibleWhen?.field)
    if (!source) fail(`A regra de "${field.label}" precisa depender de um campo anterior.`)
    if (!source.active) fail(`A regra de "${field.label}" depende de um campo desativado.`)
    if (!field.visibleWhen.equals) fail(`Informe o valor da regra de "${field.label}".`)
    if (source.options.length > 0 && !source.options.includes(field.visibleWhen.equals)) {
      fail(`A regra de "${field.label}" usa um valor que "${source.label}" não oferece.`)
    }
    if (field.required && field.visibleTo === 'staff') fail(`"${field.label}" não pode ser obrigatório e oculto ao solicitante.`)
  })

  return { sections, fields }
}

function isVisible(field: ManagedField, values: Record<string, unknown>, staff: boolean) {
  if (!field.active || (field.visibleTo === 'staff' && !staff)) return false
  if (!field.visibleWhen) return true
  return String(values[field.visibleWhen.field] ?? '') === field.visibleWhen.equals
}

const rulePatterns: Record<Exclude<ValidationRule, 'none'>, { pattern: RegExp; message: string }> = {
  digits: { pattern: /^\d+$/, message: 'deve ter somente números' },
  letters: { pattern: /^[\p{L} '-]+$/u, message: 'deve ter somente letras' },
  phone: { pattern: /^\+?[\d\s()-]{8,20}$/, message: 'deve ser um telefone válido' },
  email: { pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'deve ser um e-mail válido' },
}

function checkValue(field: ManagedField, value: string): void {
  const name = field.label
  if (field.minLength !== null && value.length < field.minLength) fail(`"${name}" deve ter ao menos ${field.minLength} caracteres.`)
  if (field.maxLength !== null && value.length > field.maxLength) fail(`"${name}" deve ter no máximo ${field.maxLength} caracteres.`)
  if (field.type === 'attachment') {
    // Só o nome do arquivo: o conteúdo é validado no envio do anexo.
    if (value.length > 180 || /[\\/\u0000-\u001f]/.test(value)) fail(`"${name}" tem um nome de arquivo inválido.`)
    return
  }
  if (field.type === 'number') {
    const number = Number(value)
    if (!Number.isFinite(number)) fail(`"${name}" deve ser um número.`)
    if (field.min !== null && number < field.min) fail(`"${name}" deve ser no mínimo ${field.min}.`)
    if (field.max !== null && number > field.max) fail(`"${name}" deve ser no máximo ${field.max}.`)
  }
  const rule = field.type === 'phone' ? 'phone' : field.type === 'email' ? 'email' : field.validation
  if (rule !== 'none' && !rulePatterns[rule].pattern.test(value)) fail(`"${name}" ${rulePatterns[rule].message}.`)
  if (field.type === 'singleSelect' && !field.catalog && !field.options.includes(value)) fail(`"${name}" tem uma opção inválida.`)
  if (field.type === 'multiSelect' && !field.catalog && value.split('|').some((item) => !field.options.includes(item))) {
    fail(`"${name}" tem uma opção inválida.`)
  }
}

/**
 * Confere os campos criados na personalização, com as mesmas regras em toda entrada. Devolve só os
 * valores de campos visíveis e os nomes usados, que ficam junto do registro para o histórico.
 */
export function validateCustomValues(
  content: ManagedFormContent,
  rawValues: unknown,
  { staff = false, context = {} }: { staff?: boolean; context?: Record<string, unknown> } = {},
) {
  const values = typeof rawValues === 'object' && rawValues !== null ? (rawValues as Record<string, unknown>) : {}
  const all = { ...context, ...values }
  const clean: Record<string, string> = {}
  const labels: Record<string, string> = {}

  for (const field of content.fields.filter((item) => item.id.startsWith('custom-'))) {
    if (!isVisible(field, all, staff)) continue
    const raw = values[field.id]
    const value = typeof raw === 'string' ? raw.trim() : raw === true ? 'true' : ''
    const empty = !value || (field.type === 'checkbox' && value !== 'true')
    if (empty) {
      if (field.required) fail(`Preencha o campo "${field.label}".`)
      continue
    }
    checkValue(field, value)
    clean[field.id] = value
    labels[field.id] = field.label
  }
  return { values: clean, labels }
}

// Campos padrão que o gerenciador pode tornar obrigatórios, e o nome de cada um no envio.
const standardBodyKeys: Partial<Record<ManagedForm, Record<string, string>>> = {
  maintenance: { sala: 'sala', dataPreferencial: 'dataPreferencial', observacoes: 'observacoes' },
  fleet: { floor: 'andarId', returnAt: 'dataHoraRetorno', vehicle: 'veiculo', passengerNames: 'passageiros', notes: 'observacoes' },
  airTravel: { requesterRoom: 'sala', baggage: 'bagagem', notes: 'observacoes' },
}

/** Obrigatoriedade definida na tela vale também no servidor, e não só na aparência do formulário. */
export function missingStandardField(form: ManagedForm, content: ManagedFormContent, body: Record<string, unknown>) {
  const keys = standardBodyKeys[form] ?? {}
  return content.fields.find((field) => {
    const key = keys[field.id]
    if (!key || !field.required || !field.active || field.visibleTo === 'staff' || field.visibleWhen) return false
    const value = body[key]
    return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
  })
}
