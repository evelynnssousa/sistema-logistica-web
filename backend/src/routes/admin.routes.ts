import { Router, type RequestHandler } from 'express'
import type { AuthRepository, ModulePermission, UserRole } from '../auth/types'
import { AuthError } from '../auth/errors'
import { csrfMatches, readAuthContext } from '../auth/session'
import { normalizePermissions } from '../auth/permissions'

interface AdminRouteOptions {
  repository: AuthRepository | null
  secureCookies: boolean
  allowedOrigins: string[]
}

export function createAdminRouter(options: AdminRouteOptions): Router {
  const router = Router()
  const repository = options.repository
  if (!repository) {
    router.use((_request, response) => {
      response.status(503).json({
        error: {
          code: 'AUTH_DATABASE_UNAVAILABLE',
          message: 'Administração indisponível: a conexão com o banco não está configurada.',
        },
      })
    })
    return router
  }

  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store')
    next()
  })

  const authenticate: RequestHandler = async (request, response, next) => {
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

  const requireAdmin: RequestHandler = async (request, response, next) => {
    const context = response.locals.authContext as Awaited<ReturnType<typeof readAuthContext>>
    if (!context) {
      response.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Autenticação necessária.' } })
      return
    }
    if (context.user.role !== 'admin') {
      try {
        await repository.createAuditEvent({
          actorUserId: context.user.id,
          action: 'admin.access.denied',
          targetUserId: firstParam(request.params.userId) || null,
          result: 'denied',
          details: { path: request.path },
        })
      } catch (error) {
        next(error)
        return
      }
      response.status(403).json({ error: { code: 'ADMIN_REQUIRED', message: 'Permissão administrativa necessária.' } })
      return
    }
    next()
  }

  const requireCsrf: RequestHandler = (request, response, next) => {
    const context = response.locals.authContext as Awaited<ReturnType<typeof readAuthContext>>
    if (!context || !csrfMatches(request, context.session)) {
      response.status(403).json({ error: { code: 'CSRF_INVALID', message: 'Validação de segurança inválida.' } })
      return
    }
    next()
  }

  const requireOrigin: RequestHandler = (request, response, next) => {
    const origin = request.header('origin')
    if (!origin || !options.allowedOrigins.includes(origin)) {
      response.status(403).json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origem da solicitação não autorizada.' } })
      return
    }
    next()
  }

  router.use(authenticate, requireAdmin)

  router.get('/registration-requests', async (_request, response, next) => {
    try {
      const context = response.locals.authContext as NonNullable<Awaited<ReturnType<typeof readAuthContext>>>
      const pendingUsers = await repository.listPendingUsers()
      await repository.createAuditEvent({
        actorUserId: context.user.id,
        action: 'registration.pending.list',
        targetUserId: null,
        result: 'success',
        details: { count: pendingUsers.length },
      })
      response.json({ requests: pendingUsers })
    } catch (error) {
      next(error)
    }
  })

  router.post('/registration-requests/:userId/decision', requireOrigin, requireCsrf, async (request, response, next) => {
    try {
      const context = response.locals.authContext as NonNullable<Awaited<ReturnType<typeof readAuthContext>>>
      const userId = firstParam(request.params.userId)
      const body = request.body as Record<string, unknown> | null
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new AuthError('Informe uma decisão válida.', 400, 'INVALID_DECISION')
      }
      if (userId === context.user.id) {
        await repository.createAuditEvent({
          actorUserId: context.user.id,
          action: `registration.${String(body.action)}`,
          targetUserId: userId,
          result: 'denied',
          details: { reason: 'self_approval' },
        })
        throw new AuthError('Não é permitido aprovar ou rejeitar a própria conta.', 403, 'SELF_DECISION_DENIED')
      }

      let decision: { action: 'approve' | 'reject'; role?: UserRole; permissions?: ModulePermission[] }
      if (body.action === 'reject') {
        if (Object.hasOwn(body, 'role') || Object.hasOwn(body, 'permissions')) {
          throw new AuthError('Rejeição não aceita atribuição de perfil.', 400, 'INVALID_DECISION')
        }
        decision = { action: 'reject' }
      } else if (body.action === 'approve') {
        const role = body.role
        const permissions = normalizePermissions(body.permissions)
        if ((role !== 'admin' && role !== 'operator') || permissions === null) {
          throw new AuthError('A aprovação exige um perfil e permissões válidos.', 400, 'INVALID_ASSIGNMENT')
        }
        decision = { action: 'approve', role, permissions }
      } else {
        throw new AuthError('Ação de decisão inválida.', 400, 'INVALID_DECISION')
      }

      const user = await repository.decideRegistration(userId, context.user.id, decision)
      if (!user) {
        response.status(404).json({ error: { code: 'REQUEST_NOT_PENDING', message: 'Solicitação não encontrada ou já decidida.' } })
        return
      }
      response.json({
        user: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          sector: user.sector,
          status: user.status,
          role: user.role,
          permissions: user.permissions,
        },
      })
    } catch (error) {
      next(error)
    }
  })

  router.post('/users/:userId/block', requireOrigin, requireCsrf, async (request, response, next) => {
    try {
      const context = response.locals.authContext as NonNullable<Awaited<ReturnType<typeof readAuthContext>>>
      const userId = firstParam(request.params.userId)
      if (userId === context.user.id) {
        await repository.createAuditEvent({
          actorUserId: context.user.id,
          action: 'account.block',
          targetUserId: userId,
          result: 'denied',
          details: { reason: 'self_block' },
        })
        throw new AuthError('Não é permitido bloquear a própria conta.', 403, 'SELF_BLOCK_DENIED')
      }
      const target = await repository.findUserById(userId)
      if (!target) {
        response.status(404).json({ error: { code: 'USER_NOT_FOUND', message: 'Usuário não encontrado.' } })
        return
      }
      if (target.role === 'admin' && !(await repository.hasOtherAdministrator(userId))) {
        await repository.createAuditEvent({
          actorUserId: context.user.id,
          action: 'account.block',
          targetUserId: userId,
          result: 'denied',
          details: { reason: 'last_administrator' },
        })
        throw new AuthError('Não é permitido bloquear o último administrador ativo.', 409, 'LAST_ADMINISTRATOR')
      }
      const user = await repository.setUserStatus(userId, context.user.id, 'blocked')
      if (!user) {
        response.status(409).json({ error: { code: 'ACCOUNT_NOT_APPROVED', message: 'A conta não está ativa para bloqueio.' } })
        return
      }
      response.json({ id: user.id, status: user.status })
    } catch (error) {
      next(error)
    }
  })

  return router
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}