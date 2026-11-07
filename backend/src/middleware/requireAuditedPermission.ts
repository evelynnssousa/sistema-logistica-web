import type { RequestHandler } from 'express'
import { holdsPermission } from '../auth/permissions.js'
import type { Permission } from '../auth/permissions.js'
import { recordAuthAuditEvent } from '../database/authAuditRepository.js'
import { currentIdentity } from './requirePermission.js'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Como requirePermission, para operações sensíveis: a recusa a quem está autenticado fica na
 * auditoria, com quem tentou, a operação, a permissão que faltou, o registro e o momento. Uma
 * falha ao auditar vai para o log e não muda a resposta (recordAuthAuditEvent).
 */
export function requireAuditedPermission(
  permissions: readonly Permission[],
  operation: string,
  resourceParam = 'requestId',
): RequestHandler {
  return async (request, response, next) => {
    const identity = currentIdentity(response)
    if (!identity || !Array.isArray(identity.permissions)) {
      response.status(401).json({ success: false, message: 'Autenticação necessária.' })
      return
    }
    const missing = permissions.filter((permission) => !holdsPermission(identity, permission))
    if (missing.length === 0) {
      next()
      return
    }
    const resource = String(request.params[resourceParam] ?? '')
    await recordAuthAuditEvent({
      actorUserId: identity.userId,
      actorKind: 'user',
      subjectUserId: null,
      sessionId: uuidPattern.test(resource) ? resource : null,
      eventType: 'sensitive_operation_denied',
      result: 'denied',
      details: { operation, missing },
    })
    response.status(403).json({ success: false, message: 'Acesso não autorizado.' })
  }
}
