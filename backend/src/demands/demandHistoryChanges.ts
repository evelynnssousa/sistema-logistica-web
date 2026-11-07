import { redactOptional } from '../integrations/redaction.js'
import type { Collaborator, DemandPatch } from './demandValidation.js'

/**
 * Cálculo do que realmente mudou em uma demanda, para o histórico. Só entram campos cujo
 * valor gravado muda: reenviar o mesmo valor não gera registro. Textos livres são comparados
 * já com a mesma redação aplicada na gravação (CPF mascarado), para não registrar uma
 * alteração que não aconteceu.
 */

export type FieldChange = {
  campo: string
  de: unknown
  para: unknown
  /** Campos que apontam para outro registro guardam também o identificador. */
  deId?: string | null
  paraId?: string | null
}

type Reference = 'category' | 'sector' | 'person'

type FieldSpec = { campo: string; column: string; text?: boolean; reference?: Reference }

/** Ordem de exibição; `column` é o nome da coluna em lockDemand. */
export const demandFieldSpecs: Record<keyof DemandPatch, FieldSpec> = {
  title: { campo: 'titulo', column: 'titulo', text: true },
  description: { campo: 'descricao', column: 'descricao', text: true },
  categoryId: { campo: 'categoria', column: 'categoria_id', reference: 'category' },
  originSectorId: { campo: 'setorOrigem', column: 'setor_origem_id', reference: 'sector' },
  responsibleSectorId: { campo: 'setorResponsavel', column: 'setor_responsavel_id', reference: 'sector' },
  startDate: { campo: 'inicioPrevisto', column: 'inicio_previsto' },
  dueDate: { campo: 'prazo', column: 'prazo' },
  priority: { campo: 'prioridade', column: 'prioridade' },
  restricted: { campo: 'restrita', column: 'restrita' },
  notes: { campo: 'observacoes', column: 'observacoes', text: true },
  references: { campo: 'referencias', column: 'referencias', text: true },
  reminderDays: { campo: 'lembreteDias', column: 'lembrete_dias' },
  followUpManagerId: { campo: 'gestor', column: 'gestor_id', reference: 'person' },
}

/** Campos de texto livre: o valor fica no histórico da demanda, mas não na auditoria geral. */
export const freeTextFields = new Set(['titulo', 'descricao', 'observacoes', 'referencias', 'atividade'])

/** Ação já existente para alguns campos; os demais usam `campo_alterado`. */
const actionByField: Record<string, string> = {
  descricao: 'descricao_alterada',
  prazo: 'prazo_alterado',
  prioridade: 'prioridade_alterada',
  restrita: 'restricao_alterada',
  gestor: 'gestor_alterado',
}

export function actionForField(campo: string) {
  return actionByField[campo] ?? 'campo_alterado'
}

const normalize = (value: unknown) => (value === undefined ? null : value)

/**
 * Diferenças entre a demanda gravada (`row`, como lockDemand devolve) e o que veio na edição.
 * Campos de referência saem com o identificador; os nomes são resolvidos por `nameReferences`.
 */
export function demandFieldChanges(row: Record<string, unknown>, patch: DemandPatch): (FieldChange & { reference?: Reference })[] {
  const changes: (FieldChange & { reference?: Reference })[] = []
  for (const key of Object.keys(demandFieldSpecs) as (keyof DemandPatch)[]) {
    if (!(key in patch) || patch[key] === undefined) continue
    const spec = demandFieldSpecs[key]
    const before = normalize(row[spec.column])
    const raw = normalize(patch[key])
    const after = spec.text ? redactOptional(raw as string | null) : raw
    if (before === after) continue
    if (spec.reference) {
      changes.push({ campo: spec.campo, de: null, para: null, deId: before as string | null, paraId: after as string | null, reference: spec.reference })
    } else {
      changes.push({ campo: spec.campo, de: before, para: after })
    }
  }
  return changes
}

export type CollaborationState = {
  collaborators: readonly Collaborator[]
  collaboratorSectorIds: readonly string[]
  authorizedUserIds: readonly string[]
}

export type CollaborationEvent =
  | { action: 'colaborador_adicionado' | 'colaborador_removido'; userId: string; atividade?: string | null; prazo?: string | null }
  | { action: 'colaborador_alterado'; userId: string; alteracoes: FieldChange[] }
  | { action: 'autorizado_adicionado' | 'autorizado_removido'; userId: string }
  | { action: 'setor_colaborador_adicionado' | 'setor_colaborador_removido'; sectorId: string }

/** Uma entrada por pessoa ou setor incluído, retirado ou com atividade/prazo alterados. */
export function collaborationChanges(before: CollaborationState, after: CollaborationState): CollaborationEvent[] {
  const events: CollaborationEvent[] = []
  const previous = new Map(before.collaborators.map((item) => [item.userId, item]))
  const next = new Map(after.collaborators.map((item) => [item.userId, { ...item, activity: redactOptional(item.activity ?? null) }]))

  for (const [userId, item] of next) {
    const old = previous.get(userId)
    if (!old) {
      events.push({ action: 'colaborador_adicionado', userId, atividade: item.activity ?? null, prazo: item.dueDate ?? null })
      continue
    }
    const alteracoes: FieldChange[] = []
    if (normalize(old.activity) !== normalize(item.activity)) alteracoes.push({ campo: 'atividade', de: normalize(old.activity), para: normalize(item.activity) })
    if (normalize(old.dueDate) !== normalize(item.dueDate)) alteracoes.push({ campo: 'prazoColaborador', de: normalize(old.dueDate), para: normalize(item.dueDate) })
    if (alteracoes.length > 0) events.push({ action: 'colaborador_alterado', userId, alteracoes })
  }
  for (const userId of previous.keys()) {
    if (!next.has(userId)) events.push({ action: 'colaborador_removido', userId })
  }

  const diff = (from: readonly string[], to: readonly string[]) => ({
    added: [...new Set(to)].filter((id) => !from.includes(id)),
    removed: [...new Set(from)].filter((id) => !to.includes(id)),
  })
  const sectors = diff(before.collaboratorSectorIds, after.collaboratorSectorIds)
  for (const sectorId of sectors.added) events.push({ action: 'setor_colaborador_adicionado', sectorId })
  for (const sectorId of sectors.removed) events.push({ action: 'setor_colaborador_removido', sectorId })
  const authorized = diff(before.authorizedUserIds, after.authorizedUserIds)
  for (const userId of authorized.added) events.push({ action: 'autorizado_adicionado', userId })
  for (const userId of authorized.removed) events.push({ action: 'autorizado_removido', userId })
  return events
}
