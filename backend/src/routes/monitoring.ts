import { Router } from 'express'
import type { Request, Response } from 'express'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { notFound, sendModuleError } from '../database/moduleErrors.js'
import { inactivityDays, MonitoringRepository, reviewIntervalDays } from '../database/monitoringRepository.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { readBackupStatus, runHealthChecks, shouldRunMonitoring } from '../monitoring/healthChecks.js'
import { monitoredServices } from '../monitoring/technicalEvents.js'
import type { MonitoredService } from '../monitoring/technicalEvents.js'
import { asBody, isUuid, optionalText, readPage, RequestValidationError } from '../requests/validation.js'

/** Saúde dos serviços e revisão de acessos. /api/health continua igual, para quem já o usa. */

const router = Router()
const monitoring = new MonitoringRepository()

router.use('/monitoring', requireAuth, requireCsrf)
router.use('/admin/access-review', requireAuth, requireCsrf)

const read = requirePermission('monitoring:read')

type Handler = (request: Request, response: Response) => Promise<void>

function guarded(handler: Handler): Handler {
  return async (request, response) => {
    try {
      await handler(request, response)
    } catch (error) {
      sendModuleError(response, error)
    }
  }
}

router.get(
  '/monitoring/status',
  read,
  guarded(async (_request, response) => {
    const [checks, availability, incidents, events] = await Promise.all([
      runHealthChecks(),
      monitoring.availability(30),
      monitoring.incidents(20),
      monitoring.events({ page: 1 }),
    ])
    response.json({
      success: true,
      checks,
      availability,
      incidents,
      errorsLast24h: events.last24h,
      monitoringActive: shouldRunMonitoring(),
      backup: readBackupStatus(),
    })
  }),
)

router.get(
  '/monitoring/events',
  read,
  guarded(async (request, response) => {
    const query = asBody(request.query)
    const service = monitoredServices.find((item): item is MonitoredService => item === query.service)
    response.json({
      success: true,
      ...(await monitoring.events({ service, page: readPage(query.page) })),
    })
  }),
)

router.get(
  '/admin/access-review',
  requirePermission('users:read'),
  guarded(async (_request, response) => {
    response.json({
      success: true,
      users: await monitoring.accessReview(),
      criteria: { reviewIntervalDays, inactivityDays },
    })
  }),
)

router.post(
  '/admin/access-review/:userId',
  requirePermission('users:manage'),
  guarded(async (request, response) => {
    const userId = String(request.params.userId)
    if (!isUuid(userId)) throw notFound()
    const body = asBody(request.body)
    if (body.resultado !== 'mantido' && body.resultado !== 'ajustado') {
      throw new RequestValidationError('Selecione o resultado da revisão.')
    }
    await monitoring.addAccessReview(response.locals.authenticatedUser as AuthenticatedIdentity, userId, {
      result: body.resultado,
      note: optionalText(body.observacao, 'Observação', 1000),
    })
    response.status(201).json({ success: true })
  }),
)

export default router
