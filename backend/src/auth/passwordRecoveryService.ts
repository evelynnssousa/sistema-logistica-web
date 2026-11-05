import { PasswordRecoveryRepository } from '../database/passwordRecoveryRepository.js'
import { describeError, logSecurityEvent } from '../security/logger.js'
import {
  isEmailConfigured,
  sendPasswordRecoveryCode,
  sendPasswordRecoveryLink,
} from './email.js'
import {
  generatePasswordRecoveryCode,
  generatePasswordRecoveryToken,
  hashPasswordRecoveryCode,
  hashPasswordRecoveryToken,
  passwordRecoveryLink,
} from './passwordRecovery.js'

export function isPasswordRecoveryConfigured(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return (
    Boolean(environment.PASSWORD_RESET_PEPPER?.trim()) &&
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
  send: (recipient: string, code: string) => Promise<void>
  // Com endereço público configurado, o e-mail leva um link no lugar do código.
  link?: {
    build: (token: string) => string | null
    send: (recipient: string, link: string) => Promise<void>
  }
}

function defaultDependencies(): RecoveryDependencies {
  const repository = new PasswordRecoveryRepository()
  return {
    isConfigured: () => isPasswordRecoveryConfigured(),
    createCode: (email, codeHash) => repository.createCode(email, codeHash),
    invalidateCodes: (userId) => repository.invalidateCodes(userId),
    send: sendPasswordRecoveryCode,
    link: { build: passwordRecoveryLink, send: sendPasswordRecoveryLink },
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

    try {
      if (link) {
        await dependencies.link!.send(account.email, link)
      } else {
        await dependencies.send(account.email, code)
      }
    } catch (error) {
      logSecurityEvent('password_recovery_email_failed', describeError(error))
      await dependencies.invalidateCodes(account.id)
    }
  } catch (error) {
    logSecurityEvent('password_recovery_failed', describeError(error))
  }
}
