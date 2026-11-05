import { optionalText, RequestValidationError } from './validation.js'
import type { RequestModule } from '../auth/requestPolicy.js'

/**
 * O que precisa de justificativa, o que foi pedido e quanto tempo a solicitação esperou por quem.
 * Regras puras, para valerem igual em toda rota e serem testadas sem banco.
 */

export type ReasonOption = { key: string; label: string; active: boolean }
export type ReasonGroup = 'scheduling' | 'cancellation' | 'warehouse'

/** Este motivo existe sempre, e com ele o texto livre é obrigatório. */
export const otherReasonKey = 'outro'

const option = (key: string, label: string): ReasonOption => ({ key, label, active: true })

export const defaultReasons: Record<ReasonGroup, ReasonOption[]> = {
  scheduling: [
    option('veiculo_indisponivel', 'Indisponibilidade de veículo'),
    option('equipe_indisponivel', 'Indisponibilidade de equipe'),
    option('conflito_agenda', 'Conflito de agenda'),
    option('adequacao_operacional', 'Necessidade de adequação operacional'),
    option('prestador_indisponivel', 'Indisponibilidade de prestador ou serviço'),
    option('priorizacao', 'Necessidade de priorização de outra demanda'),
    option(otherReasonKey, 'Outras justificativas'),
  ],
  cancellation: [
    option('pedido_solicitante', 'A pedido do solicitante'),
    option('servico_desnecessario', 'Serviço não é mais necessário'),
    option('demanda_duplicada', 'Demanda duplicada'),
    option('veiculo_indisponivel', 'Indisponibilidade de veículo'),
    option('equipe_indisponivel', 'Indisponibilidade de equipe'),
    option('prestador_indisponivel', 'Indisponibilidade de prestador ou serviço'),
    option(otherReasonKey, 'Outros motivos'),
  ],
  warehouse: [
    option('quantidade_incompativel', 'Quantidade incompatível com a necessidade apresentada'),
    option('reserva_prioritaria', 'Material reservado para necessidade prioritária'),
    option('indisponivel_distribuicao', 'Indisponibilidade para distribuição'),
    option('criterios_internos', 'Material não disponibilizado conforme critérios internos'),
    option('avaliacao_complementar', 'Necessidade de avaliação complementar'),
    option(otherReasonKey, 'Outros motivos'),
  ],
}

export type ResolvedJustification = {
  code: string
  label: string
  text: string | null
  /** Forma única de exibir: é o que vai para o histórico, para o e-mail e para a tela. */
  summary: string
}

/**
 * Motivo padronizado com complemento livre. Texto sem motivo conta como "outros", para quem usa a
 * API sem o seletor. Motivo desativado é recusado: a tela não o oferece mais.
 */
export function resolveJustification(
  options: readonly ReasonOption[],
  input: { code: unknown; text: unknown },
  { required, missingMessage }: { required: boolean; missingMessage: string },
): ResolvedJustification | null {
  const text = optionalText(input.text, 'Justificativa', 1000)
  const rawCode = typeof input.code === 'string' ? input.code.trim() : ''

  if (!rawCode && !text) {
    if (required) throw new RequestValidationError(missingMessage)
    return null
  }

  const code = rawCode || otherReasonKey
  const chosen = options.find((item) => item.key === code && item.active)
  if (!chosen && rawCode) throw new RequestValidationError('Selecione um motivo válido.')
  if (code === otherReasonKey && (text?.length ?? 0) < 3) {
    throw new RequestValidationError('Descreva o motivo no campo de complemento.')
  }

  const label = chosen?.label ?? 'Outros motivos'
  return {
    code,
    label,
    text,
    summary: code === otherReasonKey ? (text as string) : text ? `${label}: ${text}` : label,
  }
}

// ---------------------------------------------------------------------------
// O que foi pedido, comparado com o que foi agendado
// ---------------------------------------------------------------------------

export type RequestedSchedule = { start: string | null; end: string | null }

type Details = Record<string, unknown>

const asText = (value: unknown) => (typeof value === 'string' && value ? value : null)

function requestedOf(module: RequestModule, details: Details): RequestedSchedule {
  if (module === 'fleet') return { start: asText(details.dataHora), end: asText(details.dataHoraRetorno) }
  if (module === 'maintenance') return { start: asText(details.dataPreferencial), end: null }
  return { start: null, end: null }
}

/** O pedido original, mesmo que a equipe tenha editado a data depois. */
export function requestedSchedule(module: RequestModule, details: Details): RequestedSchedule {
  const original = details.solicitacaoOriginal
  if (original && typeof original === 'object') {
    const stored = original as Details
    return { start: asText(stored.inicio), end: asText(stored.fim) }
  }
  return requestedOf(module, details)
}

/**
 * Guarda o pedido original na primeira vez que a equipe muda a data pedida. Assim, editar o campo
 * não apaga o que foi solicitado nem dispensa a justificativa do agendamento diferente.
 */
export function preserveOriginalRequest(
  module: RequestModule,
  previous: Details,
  next: Details,
): Details {
  if (previous.solicitacaoOriginal) return { ...next, solicitacaoOriginal: previous.solicitacaoOriginal }
  const before = requestedOf(module, previous)
  const after = requestedOf(module, next)
  if (before.start === after.start && before.end === after.end) return next
  if (!before.start && !before.end) return next
  return { ...next, solicitacaoOriginal: { inicio: before.start, fim: before.end } }
}

const minuteOf = (value: Date | string) => Math.floor(new Date(value).getTime() / 60_000)

export function sameMinute(first: Date | string | null, second: Date | string | null) {
  if (!first || !second) return first === second || (!first && !second)
  return minuteOf(first) === minuteOf(second)
}

/** Sem data pedida, ou sem término informado, não há o que comparar: nada é presumido. */
export function differsFromRequest(
  requested: RequestedSchedule,
  scheduled: { start: Date; end: Date | null },
) {
  const startDiffers = requested.start !== null && !sameMinute(requested.start, scheduled.start)
  const endDiffers =
    requested.end !== null && scheduled.end !== null && !sameMinute(requested.end, scheduled.end)
  return startDiffers || endDiffers
}

export type ScheduleChangeKind = 'schedule' | 'reschedule' | 'adjust' | 'none'

/** Mudou o início: reagendamento. Mudou outra condição: alteração. Igual: nada a registrar. */
export function classifyScheduleChange(
  previous: { start: Date | null; end: Date | null; responsibleId: string | null },
  next: { start: Date; end: Date | null; responsibleId: string; conditions: string | null },
): ScheduleChangeKind {
  if (!previous.start) return 'schedule'
  if (!sameMinute(previous.start, next.start)) return 'reschedule'
  const adjusted =
    !sameMinute(previous.end, next.end) ||
    previous.responsibleId !== next.responsibleId ||
    Boolean(next.conditions)
  return adjusted ? 'adjust' : 'none'
}

// ---------------------------------------------------------------------------
// Devolução para correção
// ---------------------------------------------------------------------------

export const returnTypes = ['correcao', 'complementacao'] as const
export type ReturnType_ = (typeof returnTypes)[number]

/** Campos que a pessoa solicitante pode corrigir em cada módulo. Nada de identidade ou status. */
export const correctableFields: Record<RequestModule, Record<string, string>> = {
  maintenance: {
    andarId: 'Andar',
    tipoServicoId: 'Tipo de serviço',
    localServico: 'Local do serviço',
    sala: 'Sala',
    descricao: 'Descrição',
    dataPreferencial: 'Data e horário preferenciais',
    observacoes: 'Observações',
  },
  fleet: {
    andarId: 'Andar',
    origem: 'Origem',
    destino: 'Destino',
    dataHora: 'Data e horário de saída',
    dataHoraRetorno: 'Data e horário de retorno',
    finalidade: 'Serviço solicitado',
    passageiros: 'Passageiros',
    observacoes: 'Observações',
  },
  flights: {
    andarId: 'Andar',
    sala: 'Sala',
    ida: 'Trecho de ida',
    volta: 'Trecho de volta',
    bagagem: 'Bagagem',
    passageiros: 'Passageiros',
    observacoes: 'Observações',
  },
}

export function validateReturn(module: RequestModule, body: Record<string, unknown>) {
  const type = body.tipo as ReturnType_
  if (type !== 'correcao' && type !== 'complementacao') {
    throw new RequestValidationError('Selecione o tipo de devolução.')
  }
  const reason = typeof body.motivo === 'string' ? body.motivo.trim() : ''
  if (reason.length < 3) throw new RequestValidationError('Informe o motivo da devolução.')
  if (reason.length > 2000) {
    throw new RequestValidationError('O motivo deve ter no máximo 2000 caracteres.')
  }
  const raw = body.campos ?? []
  if (!Array.isArray(raw)) throw new RequestValidationError('Lista de campos inválida.')
  const known = correctableFields[module]
  const fields = [...new Set(raw.map(String))]
  if (fields.some((field) => !Object.prototype.hasOwnProperty.call(known, field))) {
    throw new RequestValidationError('Há um campo que não pode ser devolvido para correção.')
  }
  if (type === 'correcao' && fields.length === 0) {
    throw new RequestValidationError('Indique os campos que precisam de correção.')
  }
  return { type, reason, fields }
}

/** Só os campos indicados na devolução passam. O restante do envio é descartado. */
export function pickCorrections(allowed: readonly string[], raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => allowed.includes(key)),
  )
}

const returnableStatuses = [
  'aguardando_agendamento',
  'agendado',
  'reagendado',
  'em_cotacao',
  'aguardando_aprovacao',
]

/** Em execução ou encerrada, não cabe devolver: o atendimento já passou desse ponto. */
export function canReturnFromStatus(status: string) {
  return returnableStatuses.includes(status)
}

// ---------------------------------------------------------------------------
// Tempo: de quem foi a vez
// ---------------------------------------------------------------------------

export function requestTiming(
  input: {
    createdAt: Date
    closedAt: Date | null
    pausedSeconds: number
    waitingSince: Date | null
  },
  now = new Date(),
) {
  const end = input.closedAt ?? now
  const total = Math.max(0, Math.round((end.getTime() - input.createdAt.getTime()) / 1000))
  const open = input.waitingSince
    ? Math.max(0, Math.round((end.getTime() - input.waitingSince.getTime()) / 1000))
    : 0
  const requesterWait = Math.min(total, input.pausedSeconds + open)
  return {
    requesterWaitSeconds: requesterWait,
    internalSeconds: total - requesterWait,
    totalSeconds: total,
  }
}
