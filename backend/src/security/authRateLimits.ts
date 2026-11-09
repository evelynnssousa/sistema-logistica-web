import { RateLimiter } from './rateLimiter.js'

const fifteenMinutes = 15 * 60 * 1000
const oneHour = 60 * 60 * 1000

/** Janela dos limites de login: também separa um aviso de bloqueio do seguinte. */
export const loginBlockWindowMs = fifteenMinutes

/**
 * Os limites por IP são folgados porque toda a JUCESP pode sair pelo mesmo
 * endereço público. A proteção mais rígida fica na combinação IP + conta.
 */
export const authRateLimits = {
  loginPair: new RateLimiter({ limit: 5, windowMs: fifteenMinutes }),
  loginAccount: new RateLimiter({ limit: 20, windowMs: fifteenMinutes }),
  loginIp: new RateLimiter({ limit: 100, windowMs: fifteenMinutes }),
  registerIp: new RateLimiter({ limit: 20, windowMs: oneHour }),
  registerGlobal: new RateLimiter({ limit: 200, windowMs: oneHour }),
  recoveryRequestIp: new RateLimiter({ limit: 30, windowMs: fifteenMinutes }),
  recoveryRequestEmail: new RateLimiter({ limit: 3, windowMs: fifteenMinutes }),
  recoveryResetIp: new RateLimiter({ limit: 30, windowMs: fifteenMinutes }),
  recoveryResetEmail: new RateLimiter({ limit: 10, windowMs: fifteenMinutes }),
}
