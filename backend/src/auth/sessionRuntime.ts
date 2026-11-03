import { PostgresSessionStore } from '../database/postgresSessionStore.js'
import { requireAuthentication } from '../middleware/requireAuthentication.js'
import { describeError, logSecurityEvent } from '../security/logger.js'
import { SessionService } from './session.js'

// O pool só é criado na primeira consulta; importar este módulo não abre conexão.
export const sessions = new SessionService(new PostgresSessionStore())
export const requireAuth = requireAuthentication(sessions)

const defaultCleanupIntervalMs = 60 * 60 * 1000

export function startSessionCleanup(
  service: Pick<SessionService, 'purgeExpired'> = sessions,
  intervalMs = defaultCleanupIntervalMs,
) {
  const run = async () => {
    try {
      const removed = await service.purgeExpired()
      if (removed > 0) logSecurityEvent('sessions_purged', { removed })
    } catch (error) {
      logSecurityEvent('session_purge_failed', describeError(error))
    }
  }

  void run()
  const timer = setInterval(() => void run(), intervalMs)
  timer.unref()
  return timer
}
