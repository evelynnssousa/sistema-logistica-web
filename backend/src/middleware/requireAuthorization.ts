import type { RequestHandler } from 'express'
import { isAuthRole } from '../auth/roles.js'
import type { AuthRole, AuthenticatedIdentity } from '../auth/roles.js'

export function requireAuthorization(...allowedRoles: AuthRole[]): RequestHandler {
  return (_request, response, next) => {
    const identity = response.locals.authenticatedUser as
      | AuthenticatedIdentity
      | undefined

    if (
      !identity ||
      typeof identity.userId !== 'string' ||
      !isAuthRole(identity.role)
    ) {
      response.status(401).json({
        success: false,
        message: 'Autenticação necessária.',
      })
      return
    }

    if (!allowedRoles.includes(identity.role)) {
      response.status(403).json({
        success: false,
        message: 'Acesso não autorizado.',
      })
      return
    }

    next()
  }
}