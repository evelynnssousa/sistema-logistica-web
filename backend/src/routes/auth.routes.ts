import { randomBytes } from 'node:crypto'
import { Router, type RequestHandler } from 'express'
import type { AuthRepository, RegistrationInput, UserRecord } from '../auth/types'
import { AuthError } from '../auth/errors'
import { hashPassword, verifyPassword } from '../auth/password'
import { createTokens, csrfMatches, getCsrfCookie, hashToken, publicUser, readAuthContext, sessionDurationMs, setSessionCookies, clearSessionCookies, sessionCookieName } from '../auth/session'
import { parseRegistration, validateLogin } from '../auth/validation'

const dummyPasswordHash = hashPassword(randomBytes(32).toString('hex'))

export interface AuthRouteOptions {
  repository: AuthRepository | null
  allowedEmailDomains: string[]
  allowedOrigins: string[]
  secureCookies: boolean
}

function accountAccessError(status: UserRecord['status']): AuthError {
  switch (status) {
    case 'pending':
      return new AuthError('Sua solicitação aguarda aprovação administrativa.', 403, 'ACCOUNT_PENDING')
    case 'rejected':
      return new AuthError('A solicitação desta conta foi rejeitada.', 403, 'ACCOUNT_REJECTED')
    case 'blocked':
      return new AuthError('Esta conta está bloqueada. Contate a administração.', 403, 'ACCOUNT_BLOCKED')
    case 'inactive':
      return new AuthError('Esta conta está inativa. Contate a administração.', 403, 'ACCOUNT_INACTIVE')
    case 'approved':
      return new AuthError('Esta conta não possui um perfil de acesso.', 403, 'ACCOUNT_UNASSIGNED')
  }
}

function checkOrigin(request: Parameters<RequestHandler>[0], allowedOrigins: string[]): void {
  const origin = request.header('origin')
  if (!origin || !allowedOrigins.includes(origin)) {
    console.warn('[auth] Origin rejected by checkOrigin', {
      origin: origin ?? null,
      allowedOrigins,
    })
    throw new AuthError('Origem da solicitação não autorizada.', 403, 'ORIGIN_NOT_ALLOWED')
  }
}

function toSafeUser(user: UserRecord) {
  const safeUser = publicUser(user)
  if (!safeUser) throw accountAccessError(user.status)
  return safeUser
}

export function createAuthRouter(options: AuthRouteOptions): Router {
  const router = Router()
  const repository = options.repository
  if (!repository) {
    router.use((_request, response) => {
      response.status(503).json({
        error: {
          code: 'AUTH_DATABASE_UNAVAILABLE',
          message: 'Autenticação indisponível: a conexão com o banco não está configurada.',
        },
      })
    })
    return router
  }

  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store')
    next()
  })

  const requireSession: RequestHandler = async (request, response, next) => {
    try {
      const context = await readAuthContext(request, repository)
      if (!context) {
        response.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Autenticação necessária.' } })
        return
      }
      response.locals.authContext = context
      next()
    } catch (error) {
      next(error)
    }
  }

  const requireCsrf: RequestHandler = (request, response, next) => {
    const context = response.locals.authContext as Awaited<ReturnType<typeof readAuthContext>>
    if (!context || !csrfMatches(request, context.session)) {
      response.status(403).json({ error: { code: 'CSRF_INVALID', message: 'Validação de segurança inválida.' } })
      return
    }
    next()
  }

  const requireOrigin: RequestHandler = (request, _response, next) => {
    try {
      checkOrigin(request, options.allowedOrigins)
      next()
    } catch (error) {
      next(error)
    }
  }

  router.post('/register', async (request, response, next) => {
    try {
      checkOrigin(request, options.allowedOrigins)
      const registration: RegistrationInput = parseRegistration(request.body, options.allowedEmailDomains)
      const passwordHash = await hashPassword(registration.password)
      const user = await repository.createPendingUser({ ...registration, passwordHash })
      response.status(202).json({
        message: 'Solicitação recebida. O acesso será liberado após aprovação administrativa.',
        requestId: user.id,
        status: user.status,
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        try {
          await repository.createAuditEvent({
            actorUserId: null,
            action: 'registration.duplicate',
            targetUserId: null,
            result: 'denied',
          })
        } catch (auditError) {
          next(auditError)
          return
        }
        response.status(409).json({ error: { code: 'EMAIL_ALREADY_REGISTERED', message: 'Já existe uma solicitação para este e-mail.' } })
        return
      }
      next(error)
    }
  })

  router.post('/login', async (request, response, next) => {
    try {
      checkOrigin(request, options.allowedOrigins)
      const { email, password } = validateLogin(request.body)
      const user = await repository.findUserByEmail(email)
      const passwordMatches = user
        ? await verifyPassword(password, user.passwordHash)
        : await verifyPassword(password, await dummyPasswordHash)

      if (!user || !passwordMatches) {
        if (user) {
          await repository.createAuditEvent({
            actorUserId: null,
            action: 'auth.login.denied',
            targetUserId: user.id,
            result: 'denied',
            details: { reason: 'invalid_credentials' },
          })
        }
        response.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'E-mail ou senha inválidos.' } })
        return
      }

      if (user.status !== 'approved' || !user.role) {
        await repository.createAuditEvent({
          actorUserId: null,
          action: 'auth.login.denied',
          targetUserId: user.id,
          result: 'denied',
          details: { reason: user.status },
        })
        const error = accountAccessError(user.status)
        response.status(error.status).json({ error: { code: error.code, message: error.message } })
        return
      }

      const tokens = createTokens()
      const expiresAt = new Date(Date.now() + sessionDurationMs)
      await repository.createSession({
        userId: user.id,
        sessionTokenHash: hashToken(tokens.sessionToken),
        csrfTokenHash: hashToken(tokens.csrfToken),
        expiresAt,
      })
      setSessionCookies(response, tokens.sessionToken, tokens.csrfToken, options.secureCookies)
      response.json({ user: toSafeUser(user), csrfToken: tokens.csrfToken })
    } catch (error) {
      next(error)
    }
  })

  router.get('/session', requireSession, (request, response) => {
    const context = response.locals.authContext as NonNullable<Awaited<ReturnType<typeof readAuthContext>>>
    response.json({ user: toSafeUser(context.user), csrfToken: getCsrfCookie(request) })
  })

  router.post('/logout', requireSession, requireOrigin, requireCsrf, async (request, response, next) => {
    try {
      const context = response.locals.authContext as NonNullable<Awaited<ReturnType<typeof readAuthContext>>>
      const cookie = request.header('cookie') ?? ''
      const sessionToken = readCookieValue(cookie, sessionCookieName)
      if (sessionToken) await repository.endSession(hashToken(sessionToken), context.user.id)
      clearSessionCookies(response, options.secureCookies)
      response.status(204).end()
    } catch (error) {
      next(error)
    }
  })

  return router
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505')
}

function readCookieValue(header: string, name: string): string | null {
  for (const cookie of header.split(';')) {
    const separator = cookie.indexOf('=')
    if (separator >= 0 && cookie.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(cookie.slice(separator + 1).trim())
      } catch {
        return null
      }
    }
  }
  return null
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}