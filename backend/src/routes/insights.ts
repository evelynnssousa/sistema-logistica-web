import { holdsPermission } from '../auth/permissions.js'
import { Router } from 'express'
import type { Request, Response } from 'express'
import type { RequestModule } from '../auth/requestPolicy.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { InsightsRepository } from '../database/insightsRepository.js'
import type { InsightFilters } from '../database/insightsRepository.js'
import { sendModuleError } from '../database/moduleErrors.js'
import { flightStatuses, operationalStatuses } from '../requests/workflow.js'
import type { RequestStatus } from '../requests/workflow.js'
import { WarehouseRepository } from '../database/warehouseRepository.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requirePermission } from '../middleware/requirePermission.js'
import {
  asBody,
  isUuid,
  readPeriod,
  RequestValidationError,
} from '../requests/validation.js'

/** Painel, relatórios e agenda. Só leitura, sempre no alcance de quem consulta. */

const router = Router()
const insights = new InsightsRepository()
const warehouse = new WarehouseRepository()

router.use('/dashboard', requireAuth, requireCsrf)
router.use('/reports', requireAuth, requireCsrf)
router.use('/calendar', requireAuth, requireCsrf)

function identityOf(response: Response) {
  return response.locals.authenticatedUser as AuthenticatedIdentity
}

function readFilters(request: Request): InsightFilters {
  const query = asBody(request.query)
  const module = query.module
  return {
    ...readPeriod(query),
    module:
      module === 'maintenance' || module === 'fleet' || module === 'flights' || module === 'warehouse'
        ? module
        : null,
    sectorId: isUuid(query.sectorId) ? query.sectorId : null,
  }
}

router.get('/dashboard/summary', async (request, response) => {
  try {
    const identity = identityOf(response)
    const filters = readFilters(request)
    const [summary, recent, byPeriod] = await Promise.all([
      insights.summary(identity, filters),
      insights.recent(identity, filters),
      insights.byPeriod(identity, filters),
    ])
    response.json({ success: true, ...summary, recent, byPeriod })
  } catch (error) {
    sendModuleError(response, error)
  }
})

router.get('/reports/summary', requirePermission('reports:read'), async (request, response) => {
  try {
    const identity = identityOf(response)
    const filters = readFilters(request)
    const [summary, byPeriod, bySector, materials] = await Promise.all([
      insights.summary(identity, filters),
      insights.byPeriod(identity, filters),
      insights.bySector(identity, filters),
      // Totais por material são indicador interno: Solicitante não os recebe nem com read_all.
      holdsPermission(identity, 'warehouse:manage') ||
      (identity.permissions.includes('requests:read_all') && identity.role === 'slm_operator')
        ? warehouse.topMaterials({ from: filters.from ?? null, to: filters.to ?? null })
        : Promise.resolve([]),
    ])
    response.json({ success: true, ...summary, byPeriod, bySector, materials })
  } catch (error) {
    sendModuleError(response, error)
  }
})

router.get('/reports/operational', requirePermission('reports:read'), async (request, response) => {
  try {
    response.json({
      success: true,
      ...(await insights.operational(identityOf(response), readFilters(request))),
    })
  } catch (error) {
    sendModuleError(response, error)
  }
})

router.get('/reports/performance', requirePermission('reports:read'), async (request, response) => {
  try {
    const identity = identityOf(response)
    const query = asBody(request.query)
    const managesTeam = identity.permissions.includes('slm_central:read')
    const allStatuses: readonly string[] = [...operationalStatuses, ...flightStatuses]
    response.json({
      success: true,
      ...(await insights.performance(
        identity,
        {
          ...readFilters(request),
          // Filtrar por pessoa é ver o desempenho dela: exige a mesma permissão do quadro da equipe.
          responsibleId: managesTeam && isUuid(query.responsibleId) ? query.responsibleId : null,
          status: allStatuses.includes(String(query.status)) ? String(query.status) : null,
        },
        managesTeam,
      )),
    })
  } catch (error) {
    sendModuleError(response, error)
  }
})

const maximumCalendarRangeMs = 400 * 24 * 60 * 60 * 1000

router.get('/calendar/events', requirePermission('calendar:read'), async (request, response) => {
  try {
    const query = asBody(request.query)
    const { from, to } = readPeriod(query)
    if (!from || !to) throw new RequestValidationError('Informe o período.')
    if (to.getTime() - from.getTime() > maximumCalendarRangeMs) {
      throw new RequestValidationError('O período é longo demais.')
    }

    const requested = typeof query.modules === 'string' ? query.modules.split(',') : []
    const modules = (['maintenance', 'fleet'] as RequestModule[]).filter(
      (module) => requested.length === 0 || requested.includes(module),
    )

    const requestedStatuses = typeof query.statuses === 'string' ? query.statuses.split(',') : []
    const statuses = operationalStatuses.filter((status) =>
      requestedStatuses.includes(status),
    ) as RequestStatus[]

    response.json({
      success: true,
      events: await insights.calendarEvents(identityOf(response), {
        from,
        to,
        modules,
        statuses,
        responsibleId: isUuid(query.responsibleId) ? query.responsibleId : null,
      }),
    })
  } catch (error) {
    sendModuleError(response, error)
  }
})

export default router
