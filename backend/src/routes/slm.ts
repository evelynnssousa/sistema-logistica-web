import { Router } from 'express'
import type { Request, Response } from 'express'
import type { RequestModule } from '../auth/requestPolicy.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { notFound, sendModuleError } from '../database/moduleErrors.js'
import { isQueueKey, OperationsRepository } from '../database/operationsRepository.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { priorities } from '../requests/settingsRules.js'
import {
  asBody,
  isUuid,
  optionalDateTime,
  optionalText,
  optionalUuid,
  readPage,
  readPeriod,
  readSearch,
  requiredText,
  RequestValidationError,
} from '../requests/validation.js'
import { flightStatuses, operationalStatuses } from '../requests/workflow.js'
import type { RequestStatus } from '../requests/workflow.js'

/**
 * Central de Operações da SLM. Tem permissão própria, independente do perfil de Administrador,
 * e cada rota é conferida no servidor: esconder o item do menu não protege nada.
 */

const router = Router()
const operations = new OperationsRepository()

router.use('/slm', requireAuth, requireCsrf)

const canRead = [requirePermission('slm_central:read'), requirePermission('requests:read_all')]
const canManage = [
  requirePermission('slm_central:manage'),
  requirePermission('requests:read_all'),
  requirePermission('requests:update'),
]

function identityOf(response: Response) {
  return response.locals.authenticatedUser as AuthenticatedIdentity
}

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

function requestIdOf(request: Request) {
  const id = String(request.params.requestId)
  if (!isUuid(id)) throw notFound()
  return id
}

const allStatuses: readonly string[] = [...operationalStatuses, ...flightStatuses]

function readModule(value: unknown): RequestModule | undefined {
  return value === 'maintenance' || value === 'fleet' || value === 'flights' ? value : undefined
}

router.get(
  '/slm/overview',
  ...canRead,
  guarded(async (_request, response) => {
    response.json({ success: true, ...(await operations.overview(identityOf(response))) })
  }),
)

router.get(
  '/slm/requests',
  ...canRead,
  guarded(async (request, response) => {
    const query = asBody(request.query)
    response.json({
      success: true,
      ...(await operations.list(identityOf(response), {
        queue: isQueueKey(query.queue) ? query.queue : undefined,
        module: readModule(query.module),
        sectorId: isUuid(query.sectorId) ? query.sectorId : undefined,
        responsibleId: isUuid(query.responsibleId) ? query.responsibleId : undefined,
        status: allStatuses.includes(String(query.status)) ? (query.status as RequestStatus) : undefined,
        ...readPeriod(query),
        search: readSearch(query.search),
        page: readPage(query.page),
      })),
    })
  }),
)

router.get(
  '/slm/team',
  ...canRead,
  guarded(async (_request, response) => {
    response.json({ success: true, team: await operations.team(identityOf(response)) })
  }),
)

router.post(
  '/slm/requests/:requestId/assign',
  ...canManage,
  guarded(async (request, response) => {
    const body = asBody(request.body)
    await operations.assign(identityOf(response), requestIdOf(request), {
      responsibleId: optionalUuid(body.responsavelId, 'Responsável'),
      justification: optionalText(body.justificativa, 'Justificativa'),
    })
    response.json({ success: true })
  }),
)

router.post(
  '/slm/requests/:requestId/priority',
  ...canManage,
  guarded(async (request, response) => {
    const body = asBody(request.body)
    const priority = String(body.prioridade)
    if (!(priorities as readonly string[]).includes(priority)) {
      throw new RequestValidationError('Selecione a prioridade.')
    }
    await operations.setPriority(
      identityOf(response),
      requestIdOf(request),
      priority,
      requiredText(body.justificativa, 'a justificativa', { min: 3, max: 2000 }),
    )
    response.json({ success: true })
  }),
)

router.post(
  '/slm/requests/:requestId/deadline',
  ...canManage,
  guarded(async (request, response) => {
    const body = asBody(request.body)
    await operations.setDeadline(
      identityOf(response),
      requestIdOf(request),
      optionalDateTime(body.prazo, 'o prazo'),
      optionalText(body.justificativa, 'Justificativa'),
    )
    response.json({ success: true })
  }),
)

router.post(
  '/slm/requests/:requestId/complexity',
  ...canManage,
  guarded(async (request, response) => {
    const value = asBody(request.body).complexidade
    if (value !== null && value !== 'simples' && value !== 'media' && value !== 'complexa') {
      throw new RequestValidationError('Selecione a complexidade.')
    }
    await operations.setComplexity(identityOf(response), requestIdOf(request), value)
    response.json({ success: true })
  }),
)

router.post(
  '/slm/requests/:requestId/notes',
  ...canManage,
  guarded(async (request, response) => {
    await operations.addNote(
      identityOf(response),
      requestIdOf(request),
      requiredText(asBody(request.body).texto, 'a observação', { min: 3, max: 2000 }),
    )
    response.status(201).json({ success: true })
  }),
)

export default router
