import type { Pool, PoolClient } from 'pg'
import { describeError, logSecurityEvent } from '../security/logger.js'
import { isRealProvider } from './emailProvider.js'

/**
 * Cota diária do serviço de e-mail (achado A1). A recuperação de senha e a fila de notificações usam
 * a mesma conta do Resend; sem controle, avisos em massa poderiam esgotar o dia e impedir a entrega
 * dos códigos de recuperação.
 *
 * Regras:
 * - EMAIL_DAILY_LIMIT: total de mensagens por dia (UTC) que o sistema pode pedir ao provedor, somando
 *   todos os canais. Não é presumido: deve ser o limite contratado, ou menor.
 * - EMAIL_RECOVERY_DAILY_RESERVE: parte do total que a fila de notificações nunca usa. A recuperação
 *   de senha pode usar a reserva e o que sobrar das notificações; as notificações, só o restante.
 * - Cada destinatário conta como uma mensagem (para, outros destinatários e cópias), sem presumir como
 *   o provedor conta.
 * - O consumo fica em public.email_daily_usage (migração 019). A reserva é um UPDATE condicional sobre
 *   a linha do dia: o PostgreSQL trava a linha e reavalia a condição, então workers simultâneos nunca
 *   passam do limite. Uma mensagem reservada conta mesmo se o envio falhar depois: o provedor pode ter
 *   registrado a tentativa.
 */

export type QuotaChannel = 'notification' | 'recovery'

export type QuotaSettings = {
  /** Total diário. null: não configurado. */
  dailyLimit: number | null
  /** Reservado à recuperação de senha. */
  recoveryReserve: number
  /** Janela de agrupamento dos avisos administrativos, em minutos. 0: sem agrupamento. */
  adminGroupMinutes: number
}

type Environment = NodeJS.ProcessEnv

const DEFAULT_RESERVE_SHARE = 0.2
export const DEFAULT_ADMIN_GROUP_MINUTES = 30
const MAX_ADMIN_GROUP_MINUTES = 24 * 60

function positiveInteger(value: string | undefined) {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value.trim())
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : Number.NaN
}

export function quotaSettings(environment: Environment = process.env): QuotaSettings {
  const limit = positiveInteger(environment.EMAIL_DAILY_LIMIT)
  // Valor inválido não vira "sem limite": vira zero, e nada sai pela fila.
  const dailyLimit = limit === null ? null : Number.isNaN(limit) ? 0 : limit
  const reserveValue = positiveInteger(environment.EMAIL_RECOVERY_DAILY_RESERVE)
  const defaultReserve = dailyLimit === null ? 0 : Math.max(1, Math.ceil(dailyLimit * DEFAULT_RESERVE_SHARE))
  const recoveryReserve =
    reserveValue === null
      ? defaultReserve
      : Number.isNaN(reserveValue)
        ? (dailyLimit ?? 0)
        : reserveValue
  const groupValue = positiveInteger(environment.EMAIL_ADMIN_GROUP_MINUTES)
  const adminGroupMinutes =
    groupValue === null || Number.isNaN(groupValue)
      ? DEFAULT_ADMIN_GROUP_MINUTES
      : Math.min(groupValue, MAX_ADMIN_GROUP_MINUTES)
  return { dailyLimit, recoveryReserve, adminGroupMinutes }
}

/** Problemas de configuração, sem nenhum valor secreto. Usado por config:check. */
export function quotaSettingsProblems(environment: Environment = process.env): string[] {
  const problems: string[] = []
  const limit = positiveInteger(environment.EMAIL_DAILY_LIMIT)
  const reserve = positiveInteger(environment.EMAIL_RECOVERY_DAILY_RESERVE)
  const group = positiveInteger(environment.EMAIL_ADMIN_GROUP_MINUTES)
  if (Number.isNaN(limit)) problems.push('EMAIL_DAILY_LIMIT precisa ser um número inteiro maior ou igual a zero.')
  if (Number.isNaN(reserve)) problems.push('EMAIL_RECOVERY_DAILY_RESERVE precisa ser um número inteiro maior ou igual a zero.')
  if (Number.isNaN(group)) problems.push('EMAIL_ADMIN_GROUP_MINUTES precisa ser um número inteiro maior ou igual a zero.')
  const settings = quotaSettings(environment)
  if (settings.dailyLimit !== null && settings.recoveryReserve >= settings.dailyLimit) {
    problems.push('EMAIL_RECOVERY_DAILY_RESERVE ocupa todo o EMAIL_DAILY_LIMIT: nenhuma notificação sairá.')
  }
  return problems
}

/**
 * A fila só envia com controle de cota quando o provedor é real ou quando há limite configurado. Os
 * provedores falsos dos testes não consomem cota de ninguém.
 */
export function quotaEnforcedFor(provider: string, environment: Environment = process.env) {
  return isRealProvider(provider) || quotaSettings(environment).dailyLimit !== null
}

type Queryable = Pick<Pool | PoolClient, 'query'>

/**
 * Dia (UTC) da reserva, calculado UMA vez e enviado às duas instruções. Antes, cada instrução lia o
 * relógio do banco: perto da meia-noite, o INSERT podia criar a linha de um dia e o UPDATE procurar a
 * do dia seguinte, recusando a reserva por engano (inclusive a da recuperação de senha).
 */
export function quotaDay(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

export type QuotaReservation =
  | { allowed: true; enforced: boolean }
  | { allowed: false; code: 'DAILY_LIMIT_REACHED' | 'QUOTA_NOT_CONFIGURED' | 'QUOTA_UNAVAILABLE' }

/**
 * Reserva `units` mensagens do dia para o canal. Sem limite configurado: a fila de um provedor real
 * não envia (QUOTA_NOT_CONFIGURED), e a recuperação segue sem contagem, como antes.
 *
 * Se a contagem não puder ser feita (por exemplo, sem a migração 019), a fila não envia. A recuperação
 * envia mesmo assim: nesse estado a fila está parada, então ela não disputa a cota com nada, e a
 * recuperação de senha é a função que esta regra existe para proteger.
 */
export async function reserveEmailQuota(
  database: Queryable,
  channel: QuotaChannel,
  units: number,
  options: { enforced: boolean; environment?: Environment; now?: Date },
): Promise<QuotaReservation> {
  const environment = options.environment ?? process.env
  const { dailyLimit, recoveryReserve } = quotaSettings(environment)
  if (!options.enforced) return { allowed: true, enforced: false }
  if (dailyLimit === null) {
    if (channel === 'recovery') return { allowed: true, enforced: false }
    return { allowed: false, code: 'QUOTA_NOT_CONFIGURED' }
  }
  const amount = Math.max(1, Math.floor(units))
  const day = quotaDay(options.now)
  try {
    await database.query(
      `INSERT INTO public.email_daily_usage (day) VALUES ($1::date) ON CONFLICT (day) DO NOTHING`,
      [day],
    )
    const result =
      channel === 'notification'
        ? await database.query(
            `UPDATE public.email_daily_usage
                SET notifications_used = notifications_used + $1, updated_at = now()
              WHERE day = $4::date
                AND notifications_used + $1 <= $2
                AND notifications_used + recovery_used + $1 <= $3
              RETURNING day`,
            [amount, Math.max(0, dailyLimit - recoveryReserve), dailyLimit, day],
          )
        : await database.query(
            `UPDATE public.email_daily_usage
                SET recovery_used = recovery_used + $1, updated_at = now()
              WHERE day = $3::date
                AND notifications_used + recovery_used + $1 <= $2
              RETURNING day`,
            [amount, dailyLimit, day],
          )
    if (result.rows.length === 0) {
      logSecurityEvent('email_quota_reached', { channel })
      return { allowed: false, code: 'DAILY_LIMIT_REACHED' }
    }
    return { allowed: true, enforced: true }
  } catch (error) {
    logSecurityEvent('email_quota_unavailable', { channel, ...describeError(error) })
    if (channel === 'recovery') return { allowed: true, enforced: false }
    return { allowed: false, code: 'QUOTA_UNAVAILABLE' }
  }
}

/** Consumo do dia, para a tela de integrações. null: sem a migração 019 ou sem leitura possível. */
export async function quotaUsageToday(database: Queryable, environment: Environment = process.env, now = new Date()) {
  const settings = quotaSettings(environment)
  try {
    const result = await database.query<{ notifications_used: number; recovery_used: number }>(
      `SELECT notifications_used, recovery_used FROM public.email_daily_usage WHERE day = $1::date`,
      [quotaDay(now)],
    )
    const row = result.rows[0]
    return {
      dailyLimit: settings.dailyLimit,
      recoveryReserve: settings.recoveryReserve,
      adminGroupMinutes: settings.adminGroupMinutes,
      notificationsUsed: row?.notifications_used ?? 0,
      recoveryUsed: row?.recovery_used ?? 0,
    }
  } catch {
    return null
  }
}

/** Próximo início de dia em UTC: quando a cota volta. */
export function nextQuotaDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}
