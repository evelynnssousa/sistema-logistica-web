import { Router } from 'express'
import type { Response } from 'express'
import {
  canReadFullCpf,
  canReadRequest,
  hasCpfAuthorization,
} from '../auth/requestPolicy.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { recordAuthAuditEvent } from '../database/authAuditRepository.js'
import { FlightPassengerRepository } from '../database/flightPassengerRepository.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { describeError, logSecurityEvent } from '../security/logger.js'
import { registerRequestRoutes } from './requests.js'

/**
 * Passagens aéreas: o fluxo comum das solicitações, em requests.ts, e o acesso aos
 * passageiros. Recursos sem acesso respondem 404, para não revelar que existem.
 */

const router = Router()
const passengers = new FlightPassengerRepository()

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

router.use('/flights', requireAuth, requirePermission('flights:read'), requireCsrf)

registerRequestRoutes(router, 'flights')

function identityOf(response: Response) {
  return response.locals.authenticatedUser as AuthenticatedIdentity
}

function sendNotFound(response: Response) {
  response.status(404).json({
    success: false,
    message: 'Recurso não encontrado.',
  })
}

function sendUnavailable(response: Response, error: unknown) {
  logSecurityEvent('flight_passengers_failed', describeError(error))
  response.status(503).json({
    success: false,
    message: 'Não foi possível concluir a consulta neste momento.',
  })
}

router.get('/flights/requests/:requestId/passengers', async (request, response) => {
  const { requestId } = request.params
  if (!uuidPattern.test(requestId)) {
    sendNotFound(response)
    return
  }

  try {
    const scope = await passengers.findRequestScope(requestId)
    if (
      !scope ||
      !canReadRequest(identityOf(response), {
        module: 'flights',
        requesterId: scope.requesterId,
      })
    ) {
      sendNotFound(response)
      return
    }

    response.json({
      success: true,
      passengers: await passengers.listMasked(requestId),
    })
  } catch (error) {
    sendUnavailable(response, error)
  }
})

router.get('/flights/passengers/:passengerId/cpf', async (request, response) => {
  const { passengerId } = request.params
  const identity = identityOf(response)

  if (!hasCpfAuthorization(identity)) {
    await recordAuthAuditEvent({
      actorUserId: identity.userId,
      actorKind: 'user',
      subjectUserId: null,
      sessionId: uuidPattern.test(passengerId) ? passengerId : null,
      eventType: 'cpf_read_denied',
      result: 'denied',
      details: { operation: 'flights.passenger.cpf.read' },
    })
    response.status(403).json({
      success: false,
      message: 'Acesso não autorizado.',
    })
    return
  }

  if (!uuidPattern.test(passengerId)) {
    sendNotFound(response)
    return
  }

  try {
    const scope = await passengers.findPassengerScope(passengerId)
    if (!scope || !canReadFullCpf(identity, scope)) {
      sendNotFound(response)
      return
    }

    const cpf = await passengers.readFullCpf(identity.userId, passengerId, scope)
    if (!cpf) {
      sendNotFound(response)
      return
    }

    response.json({ success: true, cpf })
  } catch (error) {
    sendUnavailable(response, error)
  }
})

export default router
