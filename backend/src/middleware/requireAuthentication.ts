import type { RequestHandler } from 'express'
import {
  createClearedSessionCookie,
  hasSessionCookie,
  readSessionToken,
} from '../auth/cookies.js'
import { isDriverApiPath } from '../auth/driverPolicy.js'
import type { ResolvedSession } from '../auth/session.js'
import { logSecurityEvent } from '../security/logger.js'

export type SessionResolver = {
  resolve(token: string): Promise<ResolvedSession | null>
}

export function requireAuthentication(
  sessions: SessionResolver,
): RequestHandler {
  return async (request, response, next) => {
    const token = readSessionToken(request.headers.cookie)
    if (!token) {
      // Sem cookie, não há o que limpar. Limpar mesmo assim apagaria a sessão criada por um login
      // concluído enquanto esta resposta estava a caminho.
      if (hasSessionCookie(request.headers.cookie)) {
        response.append('Set-Cookie', createClearedSessionCookie())
      }
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

      // O motorista só alcança o próprio portal. Vale para toda rota, mesmo as que só pedem sessão.
      if (session.role === 'driver' && !isDriverApiPath(request.originalUrl ?? '')) {
        logSecurityEvent('driver_route_denied', { path: (request.originalUrl ?? '').split('?')[0] })
        response.status(403).json({ success: false, message: 'Acesso não autorizado.' })
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