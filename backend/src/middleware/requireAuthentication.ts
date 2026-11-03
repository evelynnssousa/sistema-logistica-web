import type { RequestHandler } from 'express'
import { createClearedSessionCookie, readSessionToken } from '../auth/cookies.js'
import type { ResolvedSession } from '../auth/session.js'

export type SessionResolver = {
  resolve(token: string): Promise<ResolvedSession | null>
}

export function requireAuthentication(
  sessions: SessionResolver,
): RequestHandler {
  return async (request, response, next) => {
    const token = readSessionToken(request.headers.cookie)
    if (!token) {
      response.append('Set-Cookie', createClearedSessionCookie())
      response.status(401).json({
        success: false,
        message: 'Autenticação necessária.',
      })
      return
    }

    try {
      const session = await sessions.resolve(token)
      if (!session) {
        response.append('Set-Cookie', createClearedSessionCookie())
        response.status(401).json({
          success: false,
          message: 'Autenticação necessária.',
        })
        return
      }

      response.locals.authenticatedUser = {
        userId: session.userId,
        role: session.role,
        permissions: session.permissions,
        slmMember: session.slmMember,
        sector: session.sector,
      }
      response.locals.csrfTokenHash = session.csrfTokenHash
      next()
    } catch {
      response.status(503).json({
        success: false,
        message: 'Serviço de autenticação indisponível.',
      })
    }
  }
}