import type { PoolClient } from 'pg'
import type { AuthRole } from '../auth/roles.js'
import { readSystemSettings } from '../database/settingsRepository.js'
import { getDatabasePool } from '../database/pool.js'
import { withTransaction } from '../database/withTransaction.js'
import { describeError, logSecurityEvent } from '../security/logger.js'
import type { EventContext, EventType } from './catalog.js'
import { publishIntegrationEvent } from './publisher.js'

type Client = Pick<PoolClient, 'query'>

/**
 * Avisos da conta de acesso e de segurança, pela mesma fila das solicitações. Nada aqui leva senha,
 * código, link de recuperação, endereço IP ou motivo interno de uma decisão.
 *
 * Como o publicador, roda em SAVEPOINT: uma falha aqui fica no log e nunca desfaz a mudança da conta.
 */

export const profileLabels: Record<AuthRole, string> = {
  administrator: 'Administrador',
  slm_operator: 'Operador SLM',
  requester: 'Solicitante',
  driver: 'Motorista',
}

export type AccountEventType = Extract<EventType, `account_${string}` | `security_${string}`>

export async function publishAccountEvent(
  client: Client,
  input: {
    type: AccountEventType
    /** Repetir a mesma chave não gera nova mensagem. */
    key: string
    userId: string
    /** Endereço lido pela própria transação. Ausente: só os avisos a administradores saem. */
    email: string | null
    actorId: string | null
    context?: Pick<EventContext, 'accountName' | 'profileLabel' | 'occurredAt' | 'blockScope'>
  },
) {
  await publishIntegrationEvent(client, {
    type: input.type,
    key: `account:${input.key}`.slice(0, 200),
    module: 'system',
    resourceId: input.userId,
    protocol: '',
    actorId: input.actorId,
    accountEmail: input.email,
    context: input.context,
  })
}

export type SecurityEmail = 'newLogin' | 'lockout' | 'sessionsRevoked' | 'adminAlerts'

/**
 * Preferência da instituição, em Parâmetros > Notificações. Sem a tabela, valem os padrões. Lida em
 * SAVEPOINT: um erro aqui não pode abortar a transação do login ou da administração que a chamou.
 */
export async function securityEmailEnabled(client: Client, kind: SecurityEmail) {
  await client.query('SAVEPOINT security_email_setting')
  try {
    const enabled = (await readSystemSettings(client)).notifications.securityEmails?.[kind] === true
    await client.query('RELEASE SAVEPOINT security_email_setting')
    return enabled
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT security_email_setting')
    await client.query('RELEASE SAVEPOINT security_email_setting')
    logSecurityEvent('account_notice_setting_failed', { kind, ...describeError(error) })
    return false
  }
}

/**
 * Bloqueio por tentativas: aviso à pessoa e, se ligado, aos administradores. Roda fora da resposta do
 * login (o chamador não espera), para que o tempo de resposta não revele se a conta existe. Uma
 * mensagem por conta a cada janela de bloqueio.
 */
export async function publishLoginBlocked(
  userId: string,
  windowMs: number,
  scope: 'account' | 'address' = 'account',
  now = Date.now(),
) {
  try {
    await withTransaction(getDatabasePool(), async (client) => {
      const account = await client.query<{ email: string | null }>(
        `SELECT email FROM public.auth_users WHERE id = $1 AND status = 'approved'`,
        [userId],
      )
      const email = account.rows[0]?.email ?? null
      if (account.rows.length === 0) return
      const window = Math.floor(now / windowMs)
      const occurredAt = new Date(now).toISOString()
      if (await securityEmailEnabled(client, 'lockout')) {
        await publishAccountEvent(client, {
          type: 'security_login_blocked',
          key: `${userId}:blocked:${window}`,
          userId,
          email,
          actorId: null,
          context: { occurredAt, blockScope: scope },
        })
      }
      if (await securityEmailEnabled(client, 'adminAlerts')) {
        await publishAccountEvent(client, {
          type: 'security_login_blocked_admin',
          key: `${userId}:blocked-admin:${window}`,
          userId,
          email: null,
          actorId: null,
          context: { occurredAt },
        })
      }
    })
  } catch (error) {
    logSecurityEvent('account_notice_failed', { detail: 'login_blocked', ...describeError(error) })
  }
}
