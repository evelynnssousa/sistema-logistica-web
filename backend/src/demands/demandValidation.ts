import {
  asBody,
  isUuid,
  optionalText,
  optionalUuid,
  readSearch,
  RequestValidationError,
  requiredText,
  requiredUuid,
} from '../requests/validation.js'
import { directorateRoles } from './demandPolicy.js'
import type { DirectorateRole } from './demandPolicy.js'
import { isCalendarDate, readRecurrenceRule } from './recurrence.js'
import type { RecurrenceRule } from './recurrence.js'

/** Validação do que chega à API. Identidade, número, datas de abertura e autoria vêm do servidor. */

export const demandPriorities = ['baixa', 'media', 'alta', 'urgente'] as const
export const demandStatuses = [
  'nao_iniciada',
  'em_andamento',
  'aguardando_terceiros',
  'aguardando_autorizacao',
  'suspensa',
  'concluida',
  'cancelada',
] as const
export type DemandStatus = (typeof demandStatuses)[number]
export const terminalStatuses: readonly DemandStatus[] = ['concluida', 'cancelada']
export const subtaskStatuses = ['nao_iniciada', 'em_andamento', 'concluida', 'cancelada'] as const
export const commentKinds = ['comentario', 'providencia', 'andamento'] as const
export const linkModules = ['maintenance', 'fleet', 'flights', 'warehouse'] as const
export type LinkModule = (typeof linkModules)[number]
export const notificationKinds = [
  'atribuicao',
  'responsavel',
  'mencao',
  'comentario',
  'prazo_alterado',
  'prazo_proximo',
  'atraso',
  'status',
  'recorrencia',
  'providencia',
] as const
export type NotificationKind = (typeof notificationKinds)[number]

type Body = Record<string, unknown>

export function optionalDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (!isCalendarDate(value)) throw new RequestValidationError(`${label} inválida.`)
  return value
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new RequestValidationError(`${label} inválido.`)
  }
  return value as T
}

function uuidList(value: unknown, label: string, max = 100): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > max || !value.every(isUuid)) {
    throw new RequestValidationError(`${label} inválidos.`)
  }
  return [...new Set(value as string[])]
}

function reminder(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0 || number > 60) {
    throw new RequestValidationError('O lembrete deve ficar entre 0 e 60 dias antes do prazo.')
  }
  return number
}

export type Collaborator = { userId: string; activity: string | null; dueDate: string | null }

export function readCollaboration(body: Body) {
  const rawCollaborators = body.collaborators ?? []
  if (!Array.isArray(rawCollaborators) || rawCollaborators.length > 50) {
    throw new RequestValidationError('Lista de colaboradores inválida.')
  }
  const seen = new Set<string>()
  const collaborators: Collaborator[] = rawCollaborators.map((raw) => {
    const item = asBody(raw)
    const userId = requiredUuid(item.userId, 'o colaborador')
    if (seen.has(userId)) throw new RequestValidationError('O mesmo colaborador foi informado mais de uma vez.')
    seen.add(userId)
    return {
      userId,
      activity: optionalText(item.activity, 'Atividade do colaborador', 500),
      dueDate: optionalDate(item.dueDate, 'A data da atividade do colaborador'),
    }
  })
  return {
    collaborators,
    collaboratorSectorIds: uuidList(body.collaboratorSectorIds, 'Setores colaboradores', 20),
    authorizedUserIds: uuidList(body.authorizedUserIds, 'Autorizados'),
  }
}

export type WaitingDetails = {
  waitingFor: string | null
  suspensionReason: string | null
  resumeDate: string | null
}

/** Aguardando terceiros exige saber quem; suspensa exige a justificativa. */
export function readStatusDetails(status: DemandStatus, body: Body): WaitingDetails {
  const waitingFor = optionalText(body.waitingFor, 'Quem está sendo aguardado', 200)
  const suspensionReason = optionalText(body.suspensionReason, 'Justificativa da suspensão')
  if (status === 'aguardando_terceiros' && !waitingFor) {
    throw new RequestValidationError('Informe quem ou qual instituição está sendo aguardada.')
  }
  if (status === 'suspensa' && (!suspensionReason || suspensionReason.length < 3)) {
    throw new RequestValidationError('Informe a justificativa da suspensão.')
  }
  return {
    waitingFor: status === 'aguardando_terceiros' ? waitingFor : null,
    suspensionReason: status === 'suspensa' ? suspensionReason : null,
    resumeDate: status === 'suspensa' ? optionalDate(body.resumeDate, 'A previsão de retomada') : null,
  }
}

export type DemandInput = {
  draft: boolean
  title: string
  description: string | null
  categoryId: string | null
  originSectorId: string | null
  responsibleSectorId: string | null
  requesterId: string | null
  responsibleId: string | null
  followUpManagerId: string | null
  startDate: string | null
  dueDate: string | null
  priority: string
  status: DemandStatus
  statusDetails: WaitingDetails
  restricted: boolean
  notes: string | null
  references: string | null
  reminderDays: number | null
  recurrence: DemandRecurrenceInput | null
} & ReturnType<typeof readCollaboration>

export type DemandRecurrenceInput = {
  rule: RecurrenceRule
  leadDays: number
  startOffsetDays: number
}

export function readRecurrenceInput(value: unknown): DemandRecurrenceInput {
  const body = asBody(value)
  const small = (raw: unknown, label: string) => {
    if (raw === undefined || raw === null || raw === '') return 0
    const number = Number(raw)
    if (!Number.isInteger(number) || number < 0 || number > 60) {
      throw new RequestValidationError(`${label} deve ficar entre 0 e 60 dias.`)
    }
    return number
  }
  return {
    rule: readRecurrenceRule(body),
    leadDays: small(body.leadDays, 'A antecedência'),
    startOffsetDays: small(body.startOffsetDays, 'O início antes do prazo'),
  }
}

/** Rascunho só exige o título; o restante é conferido ao publicar. */
export function readDemandInput(body: Body): DemandInput {
  const draft = body.draft === true
  const initial = body.status === undefined || body.status === '' ? 'nao_iniciada' : oneOf(demandStatuses, body.status, 'Status')
  if (terminalStatuses.includes(initial)) {
    throw new RequestValidationError('Uma demanda nova não pode começar concluída nem cancelada.')
  }
  const startDate = optionalDate(body.startDate, 'A data de início prevista')
  const recurrence = body.recurrence ? readRecurrenceInput(body.recurrence) : null
  const dueDate = recurrence ? null : optionalDate(body.dueDate, 'O prazo')
  if (startDate && dueDate && dueDate < startDate) {
    throw new RequestValidationError('O prazo não pode ser anterior ao início previsto.')
  }

  const description = optionalText(body.description, 'Descrição', 8000)
  const input: DemandInput = {
    draft,
    title: requiredText(body.title, 'o título', { min: 3, max: 200 }),
    description,
    categoryId: optionalUuid(body.categoryId, 'Categoria'),
    originSectorId: optionalUuid(body.originSectorId, 'Setor de origem'),
    responsibleSectorId: optionalUuid(body.responsibleSectorId, 'Setor responsável'),
    requesterId: optionalUuid(body.requesterId, 'Solicitante'),
    responsibleId: optionalUuid(body.responsibleId, 'Responsável'),
    followUpManagerId: optionalUuid(body.followUpManagerId, 'Gestor responsável pelo acompanhamento'),
    startDate: recurrence ? null : startDate,
    dueDate,
    priority: body.priority === undefined || body.priority === '' ? 'media' : oneOf(demandPriorities, body.priority, 'Prioridade'),
    status: initial,
    statusDetails: readStatusDetails(initial, body),
    restricted: body.restricted === true,
    notes: optionalText(body.notes, 'Observações', 4000),
    references: optionalText(body.references, 'Referências', 2000),
    reminderDays: reminder(body.reminderDays),
    recurrence,
    ...readCollaboration(body),
  }
  if (!draft) requirePublishable(input)
  return input
}

export function requirePublishable(input: {
  description: string | null
  categoryId: string | null
  originSectorId: string | null
  responsibleSectorId: string | null
}) {
  if (!input.description || input.description.length < 3) throw new RequestValidationError('Informe a descrição.')
  if (!input.categoryId) throw new RequestValidationError('Selecione a categoria.')
  if (!input.originSectorId) throw new RequestValidationError('Selecione o setor de origem.')
  if (!input.responsibleSectorId) throw new RequestValidationError('Selecione o setor responsável.')
}

export type DemandPatch = Partial<{
  title: string
  description: string | null
  categoryId: string | null
  originSectorId: string | null
  responsibleSectorId: string | null
  startDate: string | null
  dueDate: string | null
  priority: string
  restricted: boolean
  notes: string | null
  references: string | null
  reminderDays: number | null
  followUpManagerId: string | null
}>

/** Só o que veio no corpo é alterado. Responsáveis e status têm rotas próprias. */
export function readDemandPatch(body: Body): DemandPatch {
  const patch: DemandPatch = {}
  if ('title' in body) patch.title = requiredText(body.title, 'o título', { min: 3, max: 200 })
  if ('description' in body) patch.description = optionalText(body.description, 'Descrição', 8000)
  if ('categoryId' in body) patch.categoryId = optionalUuid(body.categoryId, 'Categoria')
  if ('originSectorId' in body) patch.originSectorId = optionalUuid(body.originSectorId, 'Setor de origem')
  if ('responsibleSectorId' in body) patch.responsibleSectorId = optionalUuid(body.responsibleSectorId, 'Setor responsável')
  if ('startDate' in body) patch.startDate = optionalDate(body.startDate, 'A data de início prevista')
  if ('dueDate' in body) patch.dueDate = optionalDate(body.dueDate, 'O prazo')
  if ('priority' in body) patch.priority = oneOf(demandPriorities, body.priority, 'Prioridade')
  if ('restricted' in body) {
    if (typeof body.restricted !== 'boolean') throw new RequestValidationError('Restrição inválida.')
    patch.restricted = body.restricted
  }
  if ('notes' in body) patch.notes = optionalText(body.notes, 'Observações', 4000)
  if ('references' in body) patch.references = optionalText(body.references, 'Referências', 2000)
  if ('reminderDays' in body) patch.reminderDays = reminder(body.reminderDays)
  if ('followUpManagerId' in body) patch.followUpManagerId = optionalUuid(body.followUpManagerId, 'Gestor responsável pelo acompanhamento')
  return patch
}

export function readScope(body: Body): 'this' | 'future' {
  return body.scope === 'future' ? 'future' : 'this'
}

export function readVersion(body: Body): number | null {
  const version = body.version
  if (version === undefined || version === null) return null
  if (!Number.isInteger(version) || (version as number) < 1) {
    throw new RequestValidationError('Versão do registro inválida.')
  }
  return version as number
}

export function readSubtask(body: Body) {
  return {
    title: requiredText(body.title, 'o título da etapa', { max: 200 }),
    description: optionalText(body.description, 'Descrição da etapa', 4000),
    responsibleId: optionalUuid(body.responsibleId, 'Responsável pela etapa'),
    dueDate: optionalDate(body.dueDate, 'O prazo da etapa'),
    notes: optionalText(body.notes, 'Observações da etapa', 4000),
  }
}

export function readComment(body: Body) {
  return {
    kind: body.kind === undefined ? 'comentario' : oneOf(commentKinds, body.kind, 'Tipo de registro'),
    text: requiredText(body.text, 'o texto', { min: 1, max: 4000 }),
    mentions: uuidList(body.mentions, 'Menções', 30),
  }
}

export function readCompletion(body: Body) {
  return {
    done: requiredText(body.done, 'o que foi realizado', { min: 3, max: 4000 }),
    result: optionalText(body.result, 'Resultado obtido', 4000),
    notes: optionalText(body.notes, 'Observações finais', 4000),
  }
}

export function readReason(body: Body, label = 'a justificativa') {
  return requiredText(body.reason, label, { min: 3, max: 2000 })
}

export function readLink(body: Body) {
  return {
    module: oneOf(linkModules, body.module, 'Módulo'),
    protocol: requiredText(body.protocol, 'o protocolo do registro', { min: 1, max: 40 }),
  }
}

export function readAgendaEvent(body: Body) {
  const start = typeof body.start === 'string' ? new Date(body.start) : null
  if (!start || Number.isNaN(start.getTime())) throw new RequestValidationError('Informe a data e o horário.')
  const end = body.end ? new Date(String(body.end)) : null
  if (end && (Number.isNaN(end.getTime()) || end < start)) {
    throw new RequestValidationError('O término não pode ser anterior ao início.')
  }
  return {
    kind: oneOf(['reuniao', 'entrega', 'atividade'] as const, body.kind, 'Tipo de compromisso'),
    title: requiredText(body.title, 'o título', { min: 3, max: 200 }),
    description: optionalText(body.description, 'Descrição', 2000),
    start,
    end,
    sectorId: optionalUuid(body.sectorId, 'Setor'),
    demandId: optionalUuid(body.demandId, 'Demanda'),
  }
}

export type DemandFilters = {
  search: string
  number: string
  text: string
  requester: string
  statuses: string[]
  priority: string | null
  sectorId: string | null
  responsibleId: string | null
  categoryId: string | null
  from: Date | null
  to: Date | null
  dueFrom: string | null
  dueTo: string | null
  recurring: boolean | null
  shared: boolean | null
  overdue: boolean
  unassigned: boolean
  scope: 'all' | 'mine' | 'sector' | 'shared' | 'drafts'
}

function queryDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new RequestValidationError('Período inválido.')
  return date
}

function queryFlag(value: unknown): boolean | null {
  return value === 'true' ? true : value === 'false' ? false : null
}

/** Valor desconhecido nos filtros é erro, e não um filtro silenciosamente ignorado. */
export function readDemandFilters(query: Body): DemandFilters {
  const statuses = typeof query.status === 'string' && query.status ? query.status.split(',') : []
  for (const status of statuses) oneOf(demandStatuses, status, 'Status')
  const scopes = ['all', 'mine', 'sector', 'shared', 'drafts'] as const
  return {
    search: readSearch(query.q),
    number: readSearch(query.number),
    text: readSearch(query.text),
    requester: readSearch(query.requester),
    statuses,
    priority: query.priority ? oneOf(demandPriorities, query.priority, 'Prioridade') : null,
    sectorId: optionalUuid(query.sectorId, 'Setor'),
    responsibleId: optionalUuid(query.responsibleId, 'Responsável'),
    categoryId: optionalUuid(query.categoryId, 'Categoria'),
    from: queryDate(query.from),
    to: queryDate(query.to),
    dueFrom: optionalDate(query.dueFrom, 'O início do prazo'),
    dueTo: optionalDate(query.dueTo, 'O fim do prazo'),
    recurring: queryFlag(query.recurring),
    shared: queryFlag(query.shared),
    overdue: query.overdue === 'true',
    unassigned: query.unassigned === 'true',
    scope: query.scope ? oneOf(scopes, query.scope, 'Visão') : 'all',
  }
}

export function readPreferences(body: Body) {
  const days = Number(body.reminderDays)
  if (!Number.isInteger(days) || days < 0 || days > 60) {
    throw new RequestValidationError('O lembrete deve ficar entre 0 e 60 dias antes do prazo.')
  }
  const muted = body.muted ?? []
  if (!Array.isArray(muted)) throw new RequestValidationError('Preferências inválidas.')
  for (const kind of muted) oneOf(notificationKinds, kind, 'Tipo de notificação')
  return { reminderDays: days, muted: [...new Set(muted as string[])], email: body.email === true }
}

export function readDirectorateLink(value: unknown): { role: DirectorateRole; function: string | null } | null {
  if (value === null || value === undefined) return null
  const body = asBody(value)
  return {
    role: oneOf(directorateRoles, body.role, 'Papel na Diretoria Administrativa'),
    function: optionalText(body.function, 'Função exercida', 120),
  }
}

/** Vínculos enviados pela tela. Quem pode alterá-los é conferido no repositório. */
export function readInstitutionalLinks(value: unknown) {
  const body = asBody(value)
  const rawSectors = body.sectors ?? []
  if (!Array.isArray(rawSectors) || rawSectors.length > 50) throw new RequestValidationError('Setores de atuação inválidos.')
  const seen = new Set<string>()
  const sectors = rawSectors.map((raw) => {
    const item = asBody(raw)
    const sectorId = requiredUuid(item.sectorId, 'o setor de atuação')
    if (seen.has(sectorId)) throw new RequestValidationError('O mesmo setor foi informado mais de uma vez.')
    seen.add(sectorId)
    return {
      sectorId,
      role: item.role === 'responsavel' ? ('responsavel' as const) : ('colaborador' as const),
      chefia: item.chefia === true,
      function: optionalText(item.function, 'Função no setor', 120),
      canCreate: item.canCreate !== false,
      seesSector: item.seesSector !== false,
    }
  })
  return { directorate: readDirectorateLink(body.directorate), sectors }
}
