import type { RequestHandler } from 'express'
import type { AuthRepository, ModulePermission } from './types'
import { canAccess } from './permissions'
import { readAuthContext } from './session'

export function requirePermission(
  repository: AuthRepository,
  permission: ModulePermission,
): RequestHandler {
  return async (request, response, next) => {
    try {
      const context = await readAuthContext(request, repository)
      if (!context) {
        response.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Autenticação necessária.' } })
        return
      }
      if (!canAccess(context.user.role!, context.user.permissions, permission)) {
        await repository.createAuditEvent({
          actorUserId: context.user.id,
          action: 'authorization.denied',
          targetUserId: permission === 'flights:cpf:read' ? null : context.user.id,
          targetResourceId: stringParam(request.params.passengerId),
          result: 'denied',
          details: { permission },
        })
        response.status(403).json({ error: { code: 'PERMISSION_REQUIRED', message: 'Permissão insuficiente.' } })
        return
      }
      if (permission === 'flights:cpf:read') {
        await repository.createAuditEvent({
          actorUserId: context.user.id,
          action: 'passenger.cpf.access',
          targetUserId: null,
          targetResourceId: stringParam(request.params.passengerId),
          result: 'success',
          details: { permission },
        })
      }
      response.locals.authContext = context
      next()
    } catch (error) {
      next(error)
    }
  }
}

function stringParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}