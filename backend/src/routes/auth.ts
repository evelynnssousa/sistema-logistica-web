
import { Router } from 'express'
import {
  createClearedSessionCookie,
  createSessionCookie,
  readSessionToken,
} from '../auth/cookies.js'
import { verifyPassword } from '../auth/password.js'
import { SessionService } from '../auth/session.js'
import { PostgresSessionStore } from '../database/postgresSessionStore.js'
import { UserRepository } from '../database/userRepository.js'
import { requireAuthentication } from '../middleware/requireAuthentication.js'

const authRouter = Router()
const users = new UserRepository()
const sessions = new SessionService(new PostgresSessionStore())
const requireAuth = requireAuthentication(sessions)

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
  } catch {
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

export default authRouter
