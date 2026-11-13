import { creationScope, isConsultationOnly } from './demandPolicy.js'
import type { DemandContext } from './demandPolicy.js'

/**
 * Atas e contratos no Controle de Demandas (12/11/2026). Mesma lógica de setor das demandas: cada
 * instrumento é do setor responsável e pode ser compartilhado com outros setores.
 *
 * - Ver: integrantes do setor responsável ou de um setor compartilhado, Diretor e Administrador.
 * - Alterar: os mesmos integrantes e o Diretor. O Administrador sem perfil de Diretor só consulta.
 * - Cadastrar: para um setor em que a pessoa pode cadastrar demandas (ou qualquer um, se Diretor).
 */

export const instrumentTypes = ['ata', 'contrato'] as const
export const instrumentCategories = ['material', 'servico', 'curso', 'outro'] as const
export const amendmentTypes = ['prorrogacao', 'acrescimo', 'supressao', 'reajuste', 'outro'] as const

export type InstrumentSectors = { responsibleSectorId: string; sharedSectorIds: readonly string[] }

export function instrumentAccess(context: DemandContext, instrument: InstrumentSectors) {
  const sectors = new Set([instrument.responsibleSectorId, ...instrument.sharedSectorIds])
  const member = context.memberships.some((item) => sectors.has(item.sectorId))
  const read = context.administrator || context.directorate || member
  const edit = read && !isConsultationOnly(context) && (context.directorate || member)
  return { read, edit }
}

export function canCreateInstrumentFor(context: DemandContext, sectorId: string) {
  const scope = creationScope(context)
  return scope.anywhere || scope.sectorIds.includes(sectorId)
}

/**
 * Filtro em SQL com o mesmo resultado de instrumentAccess(...).read. "levelParam" é 1 para Diretor e
 * Administrador (veem todos) e 0 para os demais.
 */
export function visibleInstrumentSql(alias: string, userParam: string, levelParam: string) {
  return `(${levelParam}::int >= 1 OR EXISTS (
    SELECT 1 FROM public.demand_sector_members vm
     WHERE vm.user_id = ${userParam} AND vm.ativo
       AND (vm.sector_id = ${alias}.setor_responsavel_id
            OR EXISTS (SELECT 1 FROM public.contract_instrument_sectors vs
                        WHERE vs.instrument_id = ${alias}.id AND vs.sector_id = vm.sector_id))
  ))`
}

const dayMs = 86_400_000
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs)

export type InstrumentSituation = 'encerrado' | 'futuro' | 'vigente' | 'vencendo' | 'vencido'

/** Situação na data (AAAA-MM-DD), e quantos dias faltam para o fim da vigência. */
export function instrumentSituation(
  instrument: { closed: boolean; validFrom: string | null; validUntil: string | null; noticeDays: number },
  today: string,
): { situation: InstrumentSituation; daysLeft: number | null } {
  const daysLeft = instrument.validUntil ? daysBetween(today, instrument.validUntil) : null
  if (instrument.closed) return { situation: 'encerrado', daysLeft }
  if (instrument.validFrom && today < instrument.validFrom) return { situation: 'futuro', daysLeft }
  if (daysLeft === null) return { situation: 'vigente', daysLeft }
  if (daysLeft < 0) return { situation: 'vencido', daysLeft }
  if (daysLeft <= instrument.noticeDays) return { situation: 'vencendo', daysLeft }
  return { situation: 'vigente', daysLeft }
}

/** A demanda de renovação é aberta quando entra no prazo de aviso, uma vez por vigência. */
export function renewalDue(
  instrument: { closed: boolean; validUntil: string | null; noticeDays: number; renewalDemandId: string | null },
  today: string,
) {
  if (instrument.closed || !instrument.validUntil || instrument.renewalDemandId) return false
  return daysBetween(today, instrument.validUntil) <= instrument.noticeDays
}

export const money = (value: number) => Math.round(value * 100) / 100

/** Saldo de um item e do instrumento. Utilização acima do registrado é recusada antes de chegar aqui. */
export function itemBalance(item: { registered: number; used: number; unitPrice: number }) {
  return {
    balance: money(item.registered - item.used),
    registeredValue: money(item.registered * item.unitPrice),
    usedValue: money(item.used * item.unitPrice),
  }
}

export function instrumentTotals(total: number, spent: number) {
  return {
    spent: money(spent),
    balance: money(total - spent),
    usedPercent: total > 0 ? Math.round((spent / total) * 1000) / 10 : null,
  }
}

/** Título da demanda de renovação: até 200 caracteres. */
export function renewalTitle(instrument: { type: string; number: string; subject: string }) {
  const label = instrument.type === 'ata' ? 'Renovar ata' : 'Renovar contrato'
  const title = `${label} ${instrument.number}: ${instrument.subject}`
  return title.length <= 200 ? title : `${title.slice(0, 197)}...`
}
