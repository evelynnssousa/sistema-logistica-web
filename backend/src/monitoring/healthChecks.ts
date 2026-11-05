import { existsSync, readFileSync } from 'node:fs'
import { resolveAttachmentStorage } from '../attachments/storage.js'
import { calendarMode, emailMode } from '../integrations/config.js'
import { getDatabasePool } from '../database/pool.js'
import { describeError, logSecurityEvent } from '../security/logger.js'
import { recordTechnicalEvent } from './technicalEvents.js'
import type { MonitoredService } from './technicalEvents.js'

/**
 * Verificações dos serviços essenciais. "not_configured" não é falha: o serviço ainda não foi
 * ativado, e isso não entra na conta de disponibilidade. Nenhuma chama provedor externo: a
 * situação de e-mail e calendário vem das filas, que registram a resposta de cada envio.
 */

export type CheckStatus = 'up' | 'down' | 'not_configured'
export type CheckResult = {
  service: MonitoredService
  status: CheckStatus
  detail: string | null
  responseMs: number | null
}

async function checkDatabase(): Promise<CheckResult> {
  const started = Date.now()
  try {
    await getDatabasePool().query('SELECT 1')
    return { service: 'database', status: 'up', detail: null, responseMs: Date.now() - started }
  } catch (error) {
    return { service: 'database', status: 'down', detail: describeError(error).errorCode, responseMs: null }
  }
}

async function failedInLastHour(table: string): Promise<number | null> {
  try {
    const present = await getDatabasePool().query<{ present: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [`public.${table}`],
    )
    if (!present.rows[0]?.present) return null
    const result = await getDatabasePool().query<{ total: number }>(
      `SELECT count(*)::int AS total FROM public.${table}
        WHERE status = 'failed' AND updated_at > now() - interval '1 hour'`,
    )
    return result.rows[0].total
  } catch {
    return null
  }
}

async function checkQueue(
  service: 'email' | 'calendar',
  table: string,
  configured: boolean,
): Promise<CheckResult> {
  if (!configured) return { service, status: 'not_configured', detail: null, responseMs: null }
  const failed = await failedInLastHour(table)
  if (failed === null) return { service, status: 'not_configured', detail: 'migration_pending', responseMs: null }
  return failed > 0
    ? { service, status: 'down', detail: `failed_last_hour:${failed}`, responseMs: null }
    : { service, status: 'up', detail: null, responseMs: null }
}

async function checkStorage(): Promise<CheckResult> {
  const storage = resolveAttachmentStorage()
  if (!storage) return { service: 'storage', status: 'not_configured', detail: null, responseMs: null }
  const started = Date.now()
  try {
    await storage.check()
    return { service: 'storage', status: 'up', detail: null, responseMs: Date.now() - started }
  } catch (error) {
    return { service: 'storage', status: 'down', detail: describeError(error).errorCode, responseMs: null }
  }
}

export async function runHealthChecks(): Promise<CheckResult[]> {
  const [database, email, calendar, storage] = await Promise.all([
    checkDatabase(),
    checkQueue('email', 'email_deliveries', emailMode() !== 'none'),
    checkQueue(
      'calendar',
      'calendar_sync_items',
      calendarMode('maintenance') !== 'none' || calendarMode('fleet') !== 'none',
    ),
    checkStorage(),
  ])
  // Quem responde esta verificação é a própria API.
  return [{ service: 'api', status: 'up', detail: null, responseMs: 0 }, database, email, calendar, storage]
}

/** Grava só as mudanças de estado e o último horário visto. Um intervalo sem registro é "unknown". */
export async function recordAvailability(results: readonly CheckResult[], intervalMs: number) {
  const pool = getDatabasePool()
  const gapLimitMs = intervalMs * 3

  for (const result of results) {
    if (result.status === 'not_configured') continue

    const latest = await pool.query<{ id: string; status: string; last_seen_at: Date }>(
      `SELECT id::text AS id, status, last_seen_at FROM public.availability_periods
        WHERE service = $1 ORDER BY started_at DESC, id DESC LIMIT 1`,
      [result.service],
    )
    const previous = latest.rows[0]
    const now = new Date()

    if (previous && now.getTime() - previous.last_seen_at.getTime() > gapLimitMs) {
      await pool.query(
        `INSERT INTO public.availability_periods (service, status, started_at, last_seen_at, detail)
         VALUES ($1, 'unknown', $2, $3, 'sem_verificacao')`,
        [result.service, previous.last_seen_at, now],
      )
    } else if (previous?.status === result.status) {
      await pool.query(`UPDATE public.availability_periods SET last_seen_at = $2 WHERE id = $1`, [previous.id, now])
      continue
    }

    await pool.query(
      `INSERT INTO public.availability_periods (service, status, started_at, last_seen_at, detail)
       VALUES ($1, $2, $3, $3, $4)`,
      [result.service, result.status, now, result.detail?.slice(0, 80) ?? null],
    )
    if (result.status === 'down') recordTechnicalEvent(result.service, 'service_unavailable')
  }
}

const eventRetentionDays = 180

export async function pruneTechnicalEvents() {
  await getDatabasePool().query(
    `DELETE FROM public.technical_events WHERE created_at < now() - make_interval(days => $1)`,
    [eventRetentionDays],
  )
}

/** Último registro de backup. O arquivo fica fora do banco, com quem executa as cópias. */
export function readBackupStatus(environment: NodeJS.ProcessEnv = process.env) {
  const path = environment.BACKUP_LOG_PATH?.trim()
  if (!path) return { configured: false as const }
  if (!existsSync(path)) return { configured: true as const, last: null, lastVerified: null }
  try {
    const entries = readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; at: string; ok: boolean; file?: string; sizeBytes?: number })
    const pick = (type: string) => {
      const entry = [...entries].reverse().find((item) => item.type === type)
      return entry ? { at: entry.at, ok: entry.ok, sizeBytes: entry.sizeBytes ?? null } : null
    }
    return { configured: true as const, last: pick('backup'), lastVerified: pick('restore_test') }
  } catch {
    return { configured: true as const, last: null, lastVerified: null, unreadable: true }
  }
}

const defaultIntervalMs = 60_000

export function shouldRunMonitoring(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.NODE_ENV === 'test') return false
  return environment.MONITORING_ENABLED === 'true'
}

export function startMonitoring(intervalMs = defaultIntervalMs) {
  let tick = 0
  const run = async () => {
    try {
      await recordAvailability(await runHealthChecks(), intervalMs)
      if (tick % 1440 === 0) await pruneTechnicalEvents()
    } catch (error) {
      logSecurityEvent('monitoring_cycle_failed', describeError(error))
    } finally {
      tick += 1
    }
  }
  void run()
  const timer = setInterval(() => void run(), intervalMs)
  timer.unref()
  return timer
}
