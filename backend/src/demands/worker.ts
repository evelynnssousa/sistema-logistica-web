import { publishDeadlineAlerts } from '../database/demandInsightsRepository.js'
import { generateDueOccurrences } from '../database/demandSeriesRepository.js'
import { openRenewalDemands } from '../database/instrumentRepository.js'
import { getDatabasePool } from '../database/pool.js'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'

/**
 * Gera as ocorrências e os alertas de prazo no servidor, sem depender de ninguém abrir a plataforma.
 * Como grava no banco, só roda sozinho em produção; fora dela, exige DEMANDS_WORKER_ENABLED=true.
 */

const defaultIntervalMs = 5 * 60_000
// Prazos mudam de dia em dia: conferir de hora em hora basta, e poupa o banco.
const alertIntervalTicks = 12

export function shouldRunDemandWorker(environment: NodeJS.ProcessEnv = process.env) {
  const configured = environment.DEMANDS_WORKER_ENABLED?.trim()
  if (configured === 'false') return false
  if (configured === 'true') return true
  return environment.NODE_ENV === 'production'
}

/** Sem a migração 014, cada ciclo só confere isso e termina, sem registrar erro. */
async function isMigrated() {
  const { rows } = await getDatabasePool().query<{ tabela: string | null }>(
    `SELECT to_regclass('public.demand_series')::text AS tabela`,
  )
  return rows[0].tabela !== null
}

export async function runDemandCycle({ withAlerts = true } = {}) {
  if (!(await isMigrated())) return { generated: 0, alerts: 0, renewals: 0 }
  const generated = await generateDueOccurrences()
  const alerts = withAlerts ? await publishDeadlineAlerts() : 0
  // Atas e contratos (021): demanda de renovação ao entrar no prazo de aviso. Sem a 021, nada.
  const renewals = withAlerts ? await openRenewalDemands() : 0
  return { generated, alerts, renewals }
}

export function startDemandWorker(intervalMs = defaultIntervalMs) {
  let running = false
  let tick = 0
  const run = async () => {
    if (running) return
    running = true
    try {
      await runDemandCycle({ withAlerts: tick % alertIntervalTicks === 0 })
    } catch (error) {
      recordTechnicalEvent('worker', 'demand_worker_cycle_failed', error)
    } finally {
      tick += 1
      running = false
    }
  }
  void run()
  const timer = setInterval(() => void run(), intervalMs)
  timer.unref()
  return timer
}
