import type { RequestHandler, Response } from 'express'
import type { Permission } from '../auth/permissions.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'

/** Identidade montada por requireAuthentication a partir do banco, a cada requisição. */
export function currentIdentity(response: Response) {
  return response.locals.authenticatedUser as AuthenticatedIdentity | undefined
}

function denyUnless(
  isAllowed: (identity: AuthenticatedIdentity) => boolean,
): RequestHandler {
  return (_request, response, next) => {
    const identity = currentIdentity(response)

    if (!identity || !Array.isArray(identity.permissions)) {
      response.status(401).json({
        success: false,
        message: 'Autenticação necessária.',
      })
      return
    }

    if (!isAllowed(identity)) {
      response.status(403).json({
        success: false,
        message: 'Acesso não autorizado.',
      })
      return
    }

    next()
  }
}

/** Autorização: deve vir depois de requireAuthentication. */
export function requirePermission(permission: Permission): RequestHandler {
  return denyUnless((identity) => identity.permissions.includes(permission))
}

export function requireAnyPermission(
  ...permissions: Permission[]
): RequestHandler {
  return denyUnless((identity) =>
    permissions.some((permission) => identity.permissions.includes(permission)),
  )
}

export const requireSlmMember: RequestHandler = denyUnless(
  (identity) => identity.slmMember,
)
