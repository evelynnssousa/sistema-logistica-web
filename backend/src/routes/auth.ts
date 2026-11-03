
import { Router } from 'express'
import {
  createClearedSessionCookie,
  createSessionCookie,
  readSessionToken,
} from '../auth/cookies.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { SessionService } from '../auth/session.js'
import { PostgresSessionStore } from '../database/postgresSessionStore.js'
import { UserRepository } from '../database/userRepository.js'
import { requireAuthentication } from '../middleware/requireAuthentication.js'
import { sendPasswordRecoveryCode } from '../auth/email.js'
import {
  generatePasswordRecoveryCode,
  hashPasswordRecoveryCode,
} from '../auth/passwordRecovery.js'
import { PasswordRecoveryRepository } from '../database/passwordRecoveryRepository.js'

const authRouter = Router()
const users = new UserRepository()
const passwordRecovery = new PasswordRecoveryRepository()

const recoveryRateLimits = new Map<string, { count: number; resetAt: number }>()

function allowRecoveryAttempt(key: string, maximum: number): boolean {
  const now = Date.now()
  const current = recoveryRateLimits.get(key)

  if (!current || current.resetAt <= now) {
    recoveryRateLimits.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 })
    return true
  }

  if (current.count >= maximum) return false
  current.count += 1
  return true
}
const sessions = new SessionService(new PostgresSessionStore())
const requireAuth = requireAuthentication(sessions)

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

  try {
    const passwordHash = await hashPassword(password)
    await users.createPendingUser({
      name: submittedName.trim(),
      email: email.trim().toLowerCase(),
      sector: sector.trim(),
      passwordHash,
    })

    response.status(202).json({
      success: true,
      message: 'Solicitação enviada. Aguarde a aprovação de um administrador para acessar o sistema.',
    })
  } catch (error) {
    // withTransaction preserva o erro do banco em "cause".
    const databaseError = error instanceof Error ? error.cause : undefined
    const code = databaseError && typeof databaseError === 'object' && 'code' in databaseError
      ? String((databaseError as { code?: unknown }).code)
      : ''

    if (code === '23505') {
      response.status(409).json({
        success: false,
        message: 'Já existe uma conta cadastrada com esse e-mail.',
      })
      return
    }

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
      message: 'Informe o usuário e a senha.',
    })
    return
  }

  try {
    const account = await users.findActiveForAuthentication(identifier.trim())

    // Não revelar se o usuário existe ou se está inativo.
    if (
      !account ||
      !(await verifyPassword(password, account.passwordHash))
    ) {
      response.status(401).json({
        success: false,
        message: 'Usuário ou senha inválidos.',
      })
      return
    }

    const { token, expiresAt } = await sessions.issue({
      userId: account.id,
      role: account.role,
    })

    response.append(
      'Set-Cookie',
      createSessionCookie(token, expiresAt),
    )

    response.json({
      success: true,
      user: {
        id: account.id,
        name: account.name,
        email: account.email,
        username: account.username,
        role: account.role,
      },
    })
    } catch (error) {
    console.error(
      '[AUTH LOGIN] Falha interna:',
      error instanceof Error ? error.message : 'Erro desconhecido',
    )

    response.status(503).json({
      success: false,
      message: 'Não foi possível realizar o login neste momento.',
    })
  }
})


authRouter.get('/auth/me', requireAuth, async (_request, response) => {
  const identity = response.locals.authenticatedUser

  try {
    const account = await users.findActiveById(identity.userId)

    if (!account) {
      response.status(401).json({
        success: false,
        message: 'Autenticação necessária.',
      })
      return
    }

    response.json({
      success: true,
      user: {
        id: account.id,
        name: account.name,
        email: account.email,
        username: account.username,
        role: account.role,
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
    if (token) {
      await sessions.revoke(token)
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

  const ip = request.ip || 'unknown'
  if (
    !allowRecoveryAttempt(`request:ip:${ip}`, 10) ||
    !allowRecoveryAttempt(`request:email:${email}`, 3)
  ) {
    response.status(429).json({
      success: false,
      message: 'Muitas solicitações. Aguarde alguns minutos antes de tentar novamente.',
    })
    return
  }

  // A mesma resposta é devolvida para e-mails cadastrados e não cadastrados.
  const genericMessage =
    'Se houver uma conta ativa associada a esse e-mail, você receberá instruções para recuperar a senha.'

  try {
    const code = generatePasswordRecoveryCode()
    const codeHash = hashPasswordRecoveryCode(code)
    const account = await passwordRecovery.createCode(email, codeHash)

    if (account) {
      try {
        await sendPasswordRecoveryCode(account.email, code)
      } catch {
        // Não expor detalhes do serviço de e-mail nem deixar o código utilizável.
        await passwordRecovery.invalidateCodes(account.id).catch(() => undefined)
      }
    }

    response.status(202).json({
      success: true,
      message: genericMessage,
    })
  } catch {
    response.status(202).json({
      success: true,
      message: genericMessage,
    })
  }
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

  const ip = request.ip || 'unknown'
  if (!allowRecoveryAttempt(`reset:ip:${ip}`, 20)) {
    response.status(429).json({
      success: false,
      message: 'Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.',
    })
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

    response.json({
      success: true,
      message: 'Senha alterada com sucesso. Entre com sua nova senha.',
    })
  } catch {
    response.status(503).json({
      success: false,
      message: 'Não foi possível redefinir a senha neste momento.',
    })
  }
})

export default authRouter
