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
import { insertAuthAuditEvent } from '../database/authAuditRepository.js'
import { getDatabasePool } from '../database/pool.js'
import { fleetWorkbook, warehouseWorkbook } from '../reports/operationalSpreadsheets.js'
import { flightsWorkbook, generalWorkbook, maintenanceWorkbook } from '../reports/requestSpreadsheets.js'
import type { SpreadsheetPeriod } from '../reports/operationalSpreadsheets.js'
import { renderWorkbook } from '../reports/xlsxDocument.js'
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
    // Um mês só de dados: as linhas mostram dia a dia (14/11/2026).
    const byDay = byPeriod.length === 1 ? await insights.byDay(identity, filters, byPeriod[0].month) : null
    response.json({ success: true, ...summary, recent, byPeriod, byDay })
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
    const modules = (['maintenance', 'fleet', 'flights'] as RequestModule[]).filter(
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

// ---------------------------------------------------------------------------
// Planilhas do Almoxarifado e da Frota (.xlsx)
// ---------------------------------------------------------------------------

const maximumSpreadsheetRangeMs = 400 * 24 * 60 * 60 * 1000

/** Período obrigatório, de até cerca de 13 meses, como na agenda. */
function spreadsheetPeriod(request: Request): SpreadsheetPeriod {
  const { from, to } = readPeriod(asBody(request.query))
  if (!from || !to) throw new RequestValidationError('Informe o período.')
  if (to <= from) throw new RequestValidationError('O fim do período deve ser depois do início.')
  if (to.getTime() - from.getTime() > maximumSpreadsheetRangeMs) throw new RequestValidationError('O período é longo demais.')
  return { from, to }
}

type SpreadsheetKind = 'warehouse' | 'fleet' | 'maintenance' | 'flights' | 'general'

const spreadsheetFiles: Record<SpreadsheetKind, string> = {
  warehouse: 'almoxarifado',
  fleet: 'frota',
  maintenance: 'manutencao',
  flights: 'passagens-aereas',
  general: 'relatorio-geral',
}

const spreadsheetAudit = {
  warehouse: 'warehouse_spreadsheet_exported',
  fleet: 'fleet_spreadsheet_exported',
  maintenance: 'maintenance_spreadsheet_exported',
  flights: 'flights_spreadsheet_exported',
  general: 'general_spreadsheet_exported',
} as const

async function sendSpreadsheet(
  response: Response,
  kind: SpreadsheetKind,
  period: { from: Date | null; to: Date | null },
  build: (generatedBy: string) => Promise<Parameters<typeof renderWorkbook>[0]>,
) {
  const identity = identityOf(response)
  const pool = getDatabasePool()
  const generatedBy = (await pool.query<{ full_name: string }>(`SELECT full_name FROM public.auth_users WHERE id = $1`, [identity.userId]))
    .rows[0]?.full_name ?? ''
  const workbook = renderWorkbook(await build(generatedBy))
  await insertAuthAuditEvent(pool, {
    actorUserId: identity.userId,
    actorKind: 'user',
    subjectUserId: null,
    sessionId: null,
    eventType: spreadsheetAudit[kind],
    details: { de: period.from?.toISOString() ?? 'todo o período', ate: period.to?.toISOString() ?? 'todo o período' },
  })
  const day = (date: Date) => date.toISOString().slice(0, 10)
  const range = period.from && period.to ? `-${day(period.from)}-a-${day(new Date(period.to.getTime() - 1))}` : ''
  response.set('Content-Disposition', `attachment; filename="${spreadsheetFiles[kind]}${range}.xlsx"`)
  response.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(workbook)
}

router.get('/reports/warehouse/spreadsheet', requirePermission('warehouse:manage'), async (request, response) => {
  try {
    const period = spreadsheetPeriod(request)
    await sendSpreadsheet(response, 'warehouse', period, (generatedBy) =>
      warehouseWorkbook(period, generatedBy, undefined, holdsPermission(identityOf(response), 'warehouse:finance')),
    )
  } catch (error) {
    sendModuleError(response, error)
  }
})

router.get(
  '/reports/fleet/spreadsheet',
  requirePermission('reports:read'),
  requirePermission('fleet:read'),
  async (request, response) => {
    try {
      const period = spreadsheetPeriod(request)
      await sendSpreadsheet(response, 'fleet', period, (generatedBy) =>
        fleetWorkbook(identityOf(response), period, generatedBy),
      )
    } catch (error) {
      sendModuleError(response, error)
    }
  },
)

router.get(
  '/reports/maintenance/spreadsheet',
  requirePermission('reports:read'),
  requirePermission('maintenance:read'),
  async (request, response) => {
    try {
      const period = spreadsheetPeriod(request)
      await sendSpreadsheet(response, 'maintenance', period, (generatedBy) =>
        maintenanceWorkbook(identityOf(response), period, generatedBy),
      )
    } catch (error) {
      sendModuleError(response, error)
    }
  },
)

router.get(
  '/reports/flights/spreadsheet',
  requirePermission('reports:read'),
  requirePermission('flights:read'),
  async (request, response) => {
    try {
      const period = spreadsheetPeriod(request)
      await sendSpreadsheet(response, 'flights', period, (generatedBy) =>
        flightsWorkbook(identityOf(response), period, generatedBy),
      )
    } catch (error) {
      sendModuleError(response, error)
    }
  },
)

/** Planilha geral: os mesmos filtros da tela Relatórios; sem período, todo o período. */
router.get('/reports/general/spreadsheet', requirePermission('reports:read'), async (request, response) => {
  try {
    const filters = readFilters(request)
    const query = asBody(request.query)
    const status = typeof query.status === 'string' && [...operationalStatuses, ...flightStatuses].includes(query.status as never)
      ? query.status
      : null
    // O fim do filtro da tela é o último instante incluído; a planilha usa o limite exclusivo.
    const to = filters.to ? new Date(filters.to.getTime() + 1) : null
    const modules = (['maintenance', 'fleet', 'flights'] as RequestModule[]).filter(
      (module) => !filters.module || filters.module === module,
    )
    await sendSpreadsheet(response, 'general', { from: filters.from ?? null, to }, (generatedBy) =>
      generalWorkbook(
        identityOf(response),
        { from: filters.from ?? null, to, modules, sectorId: filters.sectorId, responsibleId: isUuid(query.responsibleId) ? query.responsibleId : null, status },
        generatedBy,
      ),
    )
  } catch (error) {
    sendModuleError(response, error)
  }
})

export default router
