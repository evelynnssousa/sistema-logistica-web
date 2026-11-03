import type { RequestHandler } from 'express'
import { csrfHeaderName, csrfTokenMatches } from '../auth/csrf.js'
import { logSecurityEvent } from '../security/logger.js'

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Deve vir depois de requireAuthentication, que identifica a sessão. */
export const requireCsrf: RequestHandler = (request, response, next) => {
  if (safeMethods.has(request.method)) {
    next()
    return
  }

  if (
    !csrfTokenMatches(
      request.get(csrfHeaderName),
      response.locals.csrfTokenHash,
    )
  ) {
    logSecurityEvent('csrf_rejected', { method: request.method })
    response.status(403).json({
      success: false,
      code: 'CSRF_INVALID',
      message: 'Não foi possível validar sua sessão. Atualize a página e tente novamente.',
    })
    return
  }

  next()
}
