import { getDatabasePool } from '../database/pool.js'
import { describeError, logSecurityEvent } from '../security/logger.js'

/**
 * Registros técnicos de erro. Guarda só serviço, evento e código: nunca mensagens, parâmetros,
 * corpos de requisição ou identificação de pessoas, que poderiam conter dados sensíveis.
 */
export const monitoredServices = ['api', 'database', 'email', 'calendar', 'storage', 'worker'] as const
export type MonitoredService = (typeof monitoredServices)[number]

/** Nunca lança nem atrasa a resposta: sem a migração 010 ou sem banco, o evento fica só no log. */
export function recordTechnicalEvent(service: MonitoredService, event: string, error?: unknown) {
  const details = error === undefined ? { errorName: null, errorCode: null } : describeError(error)
  logSecurityEvent(event, { service, ...details })

  void Promise.resolve()
    .then(() =>
      getDatabasePool().query(
        `INSERT INTO public.technical_events (service, event, error_name, error_code)
         VALUES ($1, $2, $3, $4)`,
        [service, event, details.errorName, details.errorCode],
      ),
    )
    .catch(() => undefined)
}
