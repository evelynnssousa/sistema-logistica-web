import { recordAuthAuditEvent } from '../database/authAuditRepository.js'
import type { AuthAuditEvent } from '../database/authAuditRepository.js'
import { PasswordRecoveryRepository } from '../database/passwordRecoveryRepository.js'
import { getDatabasePool } from '../database/pool.js'
import { reserveEmailQuota } from '../integrations/emailQuota.js'
import {
  RECIPIENT_OUTSIDE_TEST_LIST,
  recipientDomains,
  recipientsOutsideList,
  restrictionEnforcedFor,
} from '../integrations/recipientAllowlist.js'
import { describeError, logSecurityEvent } from '../security/logger.js'
import {
  isEmailConfigured,
  PasswordRecoveryDeliveryError,
  sendPasswordRecoveryCode,
  sendPasswordRecoveryLink,
} from './email.js'
import type { RecoveryDelivery } from './email.js'
import {
  generatePasswordRecoveryCode,
  generatePasswordRecoveryToken,
  hashPasswordRecoveryCode,
  hashPasswordRecoveryToken,
  isPasswordResetPepperUsable,
  passwordRecoveryLink,
} from './passwordRecovery.js'

export function isPasswordRecoveryConfigured(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return (
    isPasswordResetPepperUsable(environment) &&
    isEmailConfigured(environment)
  )
}

type RecoveryDependencies = {
  isConfigured: () => boolean
  createCode: (
    email: string,
    codeHash: string,
  ) => Promise<{ id: string; email: string } | null>
  invalidateCodes: (userId: string) => Promise<void>
  send: (recipient: string, code: string) => Promise<RecoveryDelivery | void>
  // Com endereço público configurado, o e-mail leva um link no lugar do código.
  link?: {
    build: (token: string) => string | null
    send: (recipient: string, link: string) => Promise<RecoveryDelivery | void>
  }
  /**
   * Registro do envio na auditoria: canal, tentativas e código do erro. Nunca o código, o token,
   * o link ou o endereço. Sem ele, o resultado fica só no log.
   */
  record?: (event: AuthAuditEvent) => Promise<void>
  /**
   * Reserva de capacidade no dia (EMAIL_RECOVERY_DAILY_RESERVE). A recuperação usa a reserva e o que
   * as notificações deixaram livre; a fila de notificações nunca toca na reserva. Sem ela, envia.
   */
  reserveQuota?: () => Promise<boolean>
  /**
   * Lista de destinatários permitidos (homologação). A recuperação sempre usa o Resend real, então a
   * restrição vale sempre, salvo EMAIL_RECIPIENT_RESTRICTION=off. Conferida antes da cota.
   */
  recipientAllowed?: (email: string) => boolean
}

function defaultDependencies(): RecoveryDependencies {
  const repository = new PasswordRecoveryRepository()
  return {
    isConfigured: () => isPasswordRecoveryConfigured(),
    createCode: (email, codeHash) => repository.createCode(email, codeHash),
    invalidateCodes: (userId) => repository.invalidateCodes(userId),
    send: sendPasswordRecoveryCode,
    link: { build: passwordRecoveryLink, send: sendPasswordRecoveryLink },
    record: (event) => recordAuthAuditEvent(event),
    reserveQuota: async () =>
      (await reserveEmailQuota(getDatabasePool(), 'recovery', 1, { enforced: true })).allowed,
    recipientAllowed: (email) => !restrictionEnforcedFor('resend') || recipientsOutsideList([email]).length === 0,
  }
}

/**
 * Executa depois de a resposta ter sido enviada, para que o tempo de resposta não
 * revele se o e-mail existe. Nunca rejeita: as falhas ficam apenas no log.
 */
export async function processPasswordRecoveryRequest(
  email: string,
  dependencies: RecoveryDependencies = defaultDependencies(),
): Promise<void> {
  if (!dependencies.isConfigured()) {
    logSecurityEvent('password_recovery_unconfigured')
    return
  }

  try {
    const token = generatePasswordRecoveryToken()
    const link = dependencies.link?.build(token) ?? null
    const code = generatePasswordRecoveryCode()
    const account = await dependencies.createCode(
      email,
      link ? hashPasswordRecoveryToken(token) : hashPasswordRecoveryCode(code),
    )
    if (!account) return

    const channel = link ? 'link' : 'codigo'
    try {
      // Fora da lista de testes: nada sai e nada da cota é usado. Registra só o domínio.
      if (dependencies.recipientAllowed && !dependencies.recipientAllowed(account.email)) {
        await dependencies.record?.({
          actorUserId: null,
          actorKind: 'system',
          subjectUserId: account.id,
          sessionId: null,
          eventType: 'email_recipient_blocked',
          result: 'denied',
          details: { channel: 'recuperacao_senha', template: channel, domains: recipientDomains([account.email]) },
        })
        throw new PasswordRecoveryDeliveryError(RECIPIENT_OUTSIDE_TEST_LIST, 0)
      }
      // Sem capacidade no dia, nada é pedido ao provedor: o código é invalidado e a falha fica auditada.
      if (dependencies.reserveQuota && !(await dependencies.reserveQuota())) {
        throw new PasswordRecoveryDeliveryError('DAILY_LIMIT_REACHED', 0)
      }
      const delivery = link
        ? await dependencies.link!.send(account.email, link)
        : await dependencies.send(account.email, code)
      await dependencies.record?.({
        actorUserId: null,
        actorKind: 'system',
        subjectUserId: account.id,
        sessionId: null,
        eventType: 'password_recovery_email_sent',
        details: { channel, attempts: String(delivery?.attempts ?? 1) },
      })
    } catch (error) {
      const failure =
        error instanceof PasswordRecoveryDeliveryError
          ? { code: error.code, attempts: String(error.attempts) }
          : { code: 'UNEXPECTED', attempts: '1' }
      logSecurityEvent('password_recovery_email_failed', { ...describeError(error), deliveryCode: failure.code })
      await dependencies.invalidateCodes(account.id)
      await dependencies.record?.({
        actorUserId: null,
        actorKind: 'system',
        subjectUserId: account.id,
        sessionId: null,
        eventType: 'password_recovery_email_failed',
        result: 'failure',
        details: { channel, ...failure },
      })
    }
  } catch (error) {
    logSecurityEvent('password_recovery_failed', describeError(error))
  }
}
