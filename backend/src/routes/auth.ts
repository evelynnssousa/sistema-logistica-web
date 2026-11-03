
import { createHash } from 'node:crypto'
import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  createClearedSessionCookie,
  createSessionCookie,
  readSessionToken,
} from '../auth/cookies.js'
import {
  csrfHeaderName,
  csrfTokenMatches,
  deriveCsrfToken,
} from '../auth/csrf.js'
import {
  hashPassword,
  verifyPassword,
  verifyPasswordAgainstDecoy,
} from '../auth/password.js'
import { processPasswordRecoveryRequest } from '../auth/passwordRecoveryService.js'
import { isTestAccountBlocked } from '../auth/reservedTestEmails.js'
import { requireAuth, sessions } from '../auth/sessionRuntime.js'
import { recordAuthAuditEvent } from '../database/authAuditRepository.js'
import { PasswordRecoveryRepository } from '../database/passwordRecoveryRepository.js'
import { UserRepository } from '../database/userRepository.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { describeError, logSecurityEvent } from '../security/logger.js'
import type { RateLimitResult } from '../security/rateLimiter.js'

const authRouter = Router()
const users = new UserRepository()
const passwordRecovery = new PasswordRecoveryRepository()

function clientIp(request: Request) {
  return request.ip || 'unknown'
}

function sendTooManyRequests(
  response: Response,
  blocked: RateLimitResult,
  message: string,
) {
  response.set('Retry-After', String(blocked.retryAfterSeconds))
  response.status(429).json({ success: false, message })
}

// Permite correlacionar tentativas na auditoria sem gravar o e-mail digitado.
function identifierFingerprint(identifier: string) {
  return createHash('sha256')
    .update(`slm:login:${identifier}`)
    .digest('hex')
    .slice(0, 32)
}

authRouter.post('/auth/register', async (request, response) => {
  const { fullName, name, email, sector, password, passwordConfirmation } =
    request.body ?? {}
  const submittedName = typeof fullName === 'string' ? fullName : name

  if (
    typeof submittedName !== 'string' ||
    submittedName.trim().length < 2 ||
    submittedName.trim().length > 120 ||
    typeof email !== 'string' ||
    email.trim().length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
    typeof sector !== 'string' ||
    sector.trim().length < 2 ||
    sector.trim().length > 120 ||
    typeof password !== 'string' ||
    password.length < 12 ||
    password.length > 512 ||
    typeof passwordConfirmation !== 'string' ||
    password !== passwordConfirmation
  ) {
    response.status(400).json({
      success: false,
      message: password !== passwordConfirmation
        ? 'A confirmação de senha não corresponde.'
        : 'Confira os dados informados e use uma senha com ao menos 12 caracteres.',
    })
    return
  }

  if (isTestAccountBlocked(email)) {
    response.status(400).json({
      success: false,
      message: 'Informe um e-mail institucional válido.',
    })
    return
  }

  // Vem antes do hash da senha, que é a etapa cara em memória e processamento.
  const ipLimit = authRateLimits.registerIp.consume(clientIp(request))
  const globalLimit = ipLimit.allowed
    ? authRateLimits.registerGlobal.consume('global')
    : ipLimit
  if (!globalLimit.allowed) {
    sendTooManyRequests(
      response,
      globalLimit,
      'Muitas solicitações de cadastro. Aguarde antes de tentar novamente.',
    )
    return
  }

  // A resposta é a mesma para e-mails novos e já cadastrados.
  const accepted = () =>
    response.status(202).json({
      success: true,
      message:
        'Solicitação recebida. Se este e-mail puder ser utilizado, o cadastro aguardará a aprovação de um administrador. Se você já tem uma conta, entre ou recupere sua senha.',
    })

  try {
    const passwordHash = await hashPassword(password)
    await users.createPendingUser({
      name: submittedName.trim(),
      email: email.trim().toLowerCase(),
      sector: sector.trim(),
      passwordHash,
    })
    accepted()
  } catch (error) {
    // withTransaction preserva o erro do banco em "cause".
    const databaseError = error instanceof Error ? error.cause : undefined
    const code = databaseError && typeof databaseError === 'object' && 'code' in databaseError
      ? String((databaseError as { code?: unknown }).code)
      : ''

    // Dois cadastros simultâneos com o mesmo e-mail: o segundo cai no índice único.
    if (code === '23505') {
      accepted()
      return
    }

    logSecurityEvent('registration_failed', describeError(error))
    response.status(503).json({
      success: false,
      message: 'Não foi possível enviar a solicitação neste momento.',
    })
  }
})

authRouter.post('/auth/login', async (request, response) => {
  const { identifier, password } = request.body ?? {}

  if (
    typeof identifier !== 'string' ||
    !identifier.trim() ||
    identifier.length > 320 ||
    typeof password !== 'string' ||
    !password ||
    password.length > 1024
  ) {
    response.status(400).json({
      success: false,
      message: 'Informe o e-mail e a senha.',
    })
    return
  }

  const normalizedIdentifier = identifier.trim().toLowerCase()
  const ip = clientIp(request)
  const pairKey = `${ip}|${normalizedIdentifier}`

  // A tentativa é reservada antes da verificação, para que requisições simultâneas
  // não ultrapassem o limite. O limite por IP só conta falhas, porque toda a
  // instituição pode compartilhar o mesmo endereço.
  const pairLimit = authRateLimits.loginPair.consume(pairKey)
  const accountLimit = authRateLimits.loginAccount.consume(normalizedIdentifier)
  const blocked = [
    pairLimit,
    accountLimit,
    authRateLimits.loginIp.check(ip),
  ].find((limit) => !limit.allowed)

  if (blocked) {
    sendTooManyRequests(
      response,
      blocked,
      'Muitas tentativas de acesso. Aguarde alguns minutos antes de tentar novamente.',
    )
    return
  }

  try {
    // Em banco remoto, conta de teste se comporta como inexistente.
    const account = isTestAccountBlocked(normalizedIdentifier)
      ? null
      : await users.findActiveForAuthentication(identifier.trim())
    const passwordMatches = account
      ? await verifyPassword(password, account.passwordHash)
      : await verifyPasswordAgainstDecoy(password)

    // Não revelar se o usuário existe ou se está inativo.
    if (!account || !passwordMatches) {
      const limitReached = [
        pairLimit,
        accountLimit,
        authRateLimits.loginIp.consume(ip),
      ].some((limit) => limit.remaining === 0)

      const fingerprint = identifierFingerprint(normalizedIdentifier)
      logSecurityEvent('login_failed', { identifier: fingerprint })
      await recordAuthAuditEvent({
        actorUserId: null,
        actorKind: 'system',
        subjectUserId: account?.id ?? null,
        sessionId: null,
        eventType: 'login_failed',
        result: 'failure',
        details: { identifier: fingerprint, ip },
      })

      // Registrado uma vez, ao atingir o limite, para que um ataque não encha a tabela.
      if (limitReached) {
        logSecurityEvent('login_rate_limited', { identifier: fingerprint })
        await recordAuthAuditEvent({
          actorUserId: null,
          actorKind: 'system',
          subjectUserId: account?.id ?? null,
          sessionId: null,
          eventType: 'login_rate_limited',
          result: 'denied',
          details: { identifier: fingerprint, ip },
        })
      }

      response.status(401).json({
        success: false,
        message: 'E-mail ou senha inválidos.',
      })
      return
    }

    const { token, expiresAt, csrfToken } = await sessions.issue({
      userId: account.id,
      role: account.role,
    })

    authRateLimits.loginPair.reset(pairKey)
    authRateLimits.loginAccount.reset(normalizedIdentifier)

    response.append(
      'Set-Cookie',
      createSessionCookie(token, expiresAt),
    )

    response.json({
      success: true,
      csrfToken,
      user: {
        id: account.id,
        name: account.name,
        email: account.email,
        username: account.username,
        role: account.role,
        sector: account.sector,
        permissions: account.permissions,
        slmMember: account.slmMember,
      },
    })
  } catch (error) {
    // Indisponibilidade do banco não conta como tentativa do usuário.
    authRateLimits.loginPair.release(pairKey)
    authRateLimits.loginAccount.release(normalizedIdentifier)
    logSecurityEvent('login_error', describeError(error))

    response.status(503).json({
      success: false,
      message: 'Não foi possível realizar o login neste momento.',
    })
  }
})


authRouter.get('/auth/me', requireAuth, async (request, response) => {
  const identity = response.locals.authenticatedUser

  try {
    const account = await users.findActiveById(identity.userId)
    const sessionToken = readSessionToken(request.headers.cookie)

    if (!account || !sessionToken) {
      response.status(401).json({
        success: false,
        message: 'Autenticação necessária.',
      })
      return
    }

    response.json({
      success: true,
      csrfToken: deriveCsrfToken(sessionToken),
      user: {
        id: account.id,
        name: account.name,
        email: account.email,
        username: account.username,
        role: account.role,
        sector: account.sector,
        permissions: account.permissions,
        slmMember: account.slmMember,
      },
    })
  } catch {
    response.status(503).json({
      success: false,
      message: 'Não foi possível verificar seu acesso neste momento.',
    })
  }
})


authRouter.post('/auth/logout', async (request, response) => {
  const token = readSessionToken(request.headers.cookie)

  try {
    // Sessão já encerrada não oferece risco: basta limpar o cookie.
    const session = token ? await sessions.resolve(token) : null

    if (session) {
      if (
        !csrfTokenMatches(request.get(csrfHeaderName), session.csrfTokenHash)
      ) {
        logSecurityEvent('csrf_rejected', { method: request.method })
        response.status(403).json({
          success: false,
          code: 'CSRF_INVALID',
          message: 'Não foi possível validar sua sessão. Atualize a página e tente novamente.',
        })
        return
      }

      await sessions.revoke(token as string)
    }

    response.append('Set-Cookie', createClearedSessionCookie())
    response.json({
      success: true,
      message: 'Sessão encerrada.',
    })
  } catch {
    response.status(503).json({
      success: false,
      message: 'Não foi possível encerrar a sessão neste momento.',
    })
  }
})


authRouter.post('/auth/password-recovery/request', async (request, response) => {
  const submittedEmail = request.body?.email
  const email = typeof submittedEmail === 'string'
    ? submittedEmail.trim().toLowerCase()
    : ''

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    response.status(400).json({
      success: false,
      message: 'Informe um endereço de e-mail válido.',
    })
    return
  }

  const ipLimit = authRateLimits.recoveryRequestIp.consume(clientIp(request))
  const emailLimit = ipLimit.allowed
    ? authRateLimits.recoveryRequestEmail.consume(email)
    : ipLimit
  if (!emailLimit.allowed) {
    sendTooManyRequests(
      response,
      emailLimit,
      'Muitas solicitações. Aguarde alguns minutos antes de tentar novamente.',
    )
    return
  }

  // A mesma resposta é devolvida para e-mails cadastrados e não cadastrados,
  // e antes do processamento, para que o tempo de resposta também não os diferencie.
  response.status(202).json({
    success: true,
    message:
      'Se houver uma conta ativa associada a esse e-mail, você receberá instruções para recuperar a senha.',
  })

  void processPasswordRecoveryRequest(email)
})

authRouter.post('/auth/password-recovery/reset', async (request, response) => {
  const { email: submittedEmail, code, password, passwordConfirmation } =
    request.body ?? {}

  const email = typeof submittedEmail === 'string'
    ? submittedEmail.trim().toLowerCase()
    : ''

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254 ||
    typeof code !== 'string' ||
    !/^\d{6}$/.test(code) ||
    typeof password !== 'string' ||
    password.length < 12 ||
    password.length > 512 ||
    typeof passwordConfirmation !== 'string' ||
    password !== passwordConfirmation
  ) {
    response.status(400).json({
      success: false,
      message: password !== passwordConfirmation
        ? 'A confirmação de senha não corresponde.'
        : 'Confira o e-mail, o código e a nova senha. A senha deve ter ao menos 12 caracteres.',
    })
    return
  }

  const ip = clientIp(request)
  const ipLimit = authRateLimits.recoveryResetIp.consume(ip)
  const emailLimit = ipLimit.allowed
    ? authRateLimits.recoveryResetEmail.consume(email)
    : ipLimit
  if (!emailLimit.allowed) {
    sendTooManyRequests(
      response,
      emailLimit,
      'Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.',
    )
    return
  }

  try {
    const passwordHash = await hashPassword(password)
    const changed = await passwordRecovery.resetPassword({
      email,
      code,
      passwordHash,
    })

    if (!changed) {
      response.status(400).json({
        success: false,
        message: 'Código inválido ou expirado. Solicite um novo código e tente novamente.',
      })
      return
    }

    authRateLimits.recoveryResetEmail.reset(email)
    authRateLimits.loginPair.reset(`${ip}|${email}`)
    authRateLimits.loginAccount.reset(email)

    response.json({
      success: true,
      message: 'Senha alterada com sucesso. Entre com sua nova senha.',
    })
  } catch (error) {
    logSecurityEvent('password_reset_failed', describeError(error))
    response.status(503).json({
      success: false,
      message: 'Não foi possível redefinir a senha neste momento.',
    })
  }
})

export default authRouter
