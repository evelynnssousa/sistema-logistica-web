import express, { Router } from 'express'
import type { Request, RequestHandler, Response } from 'express'
import { AttachmentRejectedError, validateAttachment } from '../attachments/fileValidation.js'
import { resolveAttachmentStorage } from '../attachments/storage.js'
import { tripGroups } from '../auth/driverPolicy.js'
import type { TripGroup } from '../auth/driverPolicy.js'
import { canScheduleRequest } from '../auth/requestPolicy.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { AttachmentRepository } from '../database/attachmentRepository.js'
import { readOccurrenceTypes } from '../database/driverOccurrenceTypeRepository.js'
import { DriverRepository } from '../database/driverRepository.js'
import { forbidden, ModuleError, notFound, sendModuleError } from '../database/moduleErrors.js'
import { getDatabasePool } from '../database/pool.js'
import { readSystemSettings } from '../database/settingsRepository.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requireAuditedPermission } from '../middleware/requireAuditedPermission.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'
import { driverPortalView, portalAttachmentKinds } from '../requests/driverPortalRules.js'
import type { AttachmentKind } from '../requests/settingsRules.js'
import {
  asBody,
  isUuid,
  optionalDateTime,
  optionalText,
  optionalUuid,
  readPage,
  readPeriod,
  RequestValidationError,
  requiredText,
} from '../requests/validation.js'

/**
 * Portal do Motorista (/driver) e o lado da equipe da Frota (/fleet/drivers e a execução da viagem).
 * No portal, o motorista sai sempre da sessão: nenhum identificador de motorista é aceito do navegador,
 * e os horários são os do servidor. Veja docs/PORTAL_DO_MOTORISTA.md.
 */

const router = Router()
const drivers = new DriverRepository()
const attachments = new AttachmentRepository()

router.use('/driver', requireAuth, requireCsrf)

const hardLimit = express.raw({ type: () => true, limit: '101mb' })

function identityOf(response: Response) {
  return response.locals.authenticatedUser as AuthenticatedIdentity
}

type Handler = (request: Request, response: Response) => Promise<void>

function guarded(handler: Handler): Handler {
  return async (request, response) => {
    try {
      await handler(request, response)
    } catch (error) {
      if (error instanceof AttachmentRejectedError) {
        response.status(400).json({ success: false, message: error.message })
        return
      }
      sendModuleError(response, error)
    }
  }
}

function uuidParam(request: Request, name: string) {
  const value = String(request.params[name])
  if (!isUuid(value)) throw notFound()
  return value
}

const onlyDrivers: RequestHandler = (_request, response, next) => {
  const identity = identityOf(response)
  if (identity.role !== 'driver' || !identity.permissions.includes('driver_portal:access')) {
    sendModuleError(response, forbidden())
    return
  }
  next()
}

router.use('/driver', onlyDrivers)

/**
 * Portal desativado em Configurações: viagens e registros ficam fora do ar, pela API. /driver/me segue
 * respondendo, para a tela explicar a situação e mostrar o contato. A Frota continua pela equipe.
 */
const portalEnabled: RequestHandler = (request, response, next) => {
  if (request.path === '/me') {
    next()
    return
  }
  readSystemSettings(getDatabasePool())
    .then((settings) => {
      if (settings.driverAccess.portalEnabled) {
        next()
        return
      }
      sendModuleError(response, new ModuleError('O Portal do Motorista está desativado pela administração.', 403, 'DRIVER_PORTAL_DISABLED'))
    })
    .catch((error: unknown) => sendModuleError(response, error))
}

router.use('/driver', portalEnabled)

async function currentDriver(response: Response) {
  const driver = await drivers.driverOf(identityOf(response))
  if (!driver) {
    throw new ModuleError('Seu cadastro de motorista não está ativo. Fale com a equipe de Frota.', 403)
  }
  return driver
}

// ---------------------------------------------------------------------------
// Portal
// ---------------------------------------------------------------------------
router.get(
  '/driver/me',
  guarded(async (_request, response) => {
    const driver = await drivers.driverOf(identityOf(response))
    const pool = getDatabasePool()
    const [settings, types] = await Promise.all([readSystemSettings(pool), readOccurrenceTypes(pool)])
    const kinds = portalAttachmentKinds(settings.driverAccess, settings.attachments.allowedKinds)
    response.json({
      success: true,
      linked: driver !== null,
      driver: driver && { name: driver.name, registration: driver.registration },
      portal: driverPortalView(settings, types),
      attachments: resolveAttachmentStorage() && kinds.length > 0
        ? { enabled: true, maxFileMb: settings.attachments.maxFileMb, allowedKinds: kinds }
        : { enabled: false },
    })
  }),
)

router.get(
  '/driver/trips',
  guarded(async (request, response) => {
    const driver = await currentDriver(response)
    const query = asBody(request.query)
    const { driverExecution } = await readSystemSettings(getDatabasePool())
    const requested = query.group as TripGroup
    const group: TripGroup = tripGroups.includes(requested) && driverExecution.visibleGroups.includes(requested) ? requested : 'proximas'
    response.json({ success: true, group, ...(await drivers.trips(driver.id, group, readPage(query.page))) })
  }),
)

router.get(
  '/driver/history',
  guarded(async (request, response) => {
    const driver = await currentDriver(response)
    const query = asBody(request.query)
    response.json({ success: true, ...(await drivers.history(driver.id, { ...readPeriod(query), page: readPage(query.page) })) })
  }),
)

router.get(
  '/driver/trips/:tripId',
  guarded(async (request, response) => {
    const driver = await currentDriver(response)
    response.json({ success: true, ...(await drivers.trip(driver.id, uuidParam(request, 'tripId'))) })
  }),
)

// Horários enviados são ignorados: início e fim são sempre o do servidor. Do corpo, só saem os dados
// que a configuração exige, na validação do repositório.
router.post(
  '/driver/trips/:tripId/start',
  guarded(async (request, response) => {
    const driver = await currentDriver(response)
    response.json({ success: true, ...(await drivers.start(identityOf(response), driver, uuidParam(request, 'tripId'), asBody(request.body))) })
  }),
)

router.post(
  '/driver/trips/:tripId/finish',
  guarded(async (request, response) => {
    const driver = await currentDriver(response)
    response.json({ success: true, ...(await drivers.finish(identityOf(response), driver, uuidParam(request, 'tripId'), asBody(request.body))) })
  }),
)

async function readOccurrence(body: Record<string, unknown>) {
  const pool = getDatabasePool()
  const [settings, types] = await Promise.all([readSystemSettings(pool), readOccurrenceTypes(pool)])
  if (!settings.driverAccess.occurrencesEnabled) {
    throw new ModuleError('O registro de ocorrências está desativado pela administração.', 403)
  }
  // Tipo desativado sai das escolhas. As ocorrências antigas continuam com o nome que usaram.
  const type = types.find((item) => item.active && item.key === body.categoria)
  if (!type) throw new RequestValidationError('Selecione o tipo de ocorrência.')
  let delayMinutes: number | null = null
  if (type.asksDelay) {
    delayMinutes = Number(body.atrasoMinutos)
    if (!Number.isInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > 100000) {
      throw new RequestValidationError('Informe o atraso em minutos.')
    }
  }
  return {
    type,
    delayMinutes,
    description: requiredText(body.descricao, 'a descrição', { min: 3, max: 2000 }),
    justification: type.requiresJustification ? requiredText(body.justificativa, 'a justificativa', { min: 3, max: 1000 }) : null,
  }
}

router.post(
  '/driver/trips/:tripId/occurrences',
  guarded(async (request, response) => {
    const driver = await currentDriver(response)
    const id = await drivers.addOccurrence(identityOf(response), driver, uuidParam(request, 'tripId'), await readOccurrence(asBody(request.body)))
    response.status(201).json({ success: true, id })
  }),
)

router.post(
  '/driver/trips/:tripId/occurrences/:occurrenceId/attachments',
  hardLimit,
  guarded(async (request, response) => {
    const driver = await currentDriver(response)
    const tripId = uuidParam(request, 'tripId')
    const occurrenceId = uuidParam(request, 'occurrenceId')
    const category = await drivers.assertOwnOccurrence(driver.id, tripId, occurrenceId)

    const content = request.body
    if (!Buffer.isBuffer(content)) throw new AttachmentRejectedError('Envie o arquivo.')
    let rawName: string
    try {
      rawName = decodeURIComponent(String(request.get('x-file-name') ?? ''))
    } catch {
      throw new AttachmentRejectedError('Informe um nome de arquivo válido.')
    }
    const pool = getDatabasePool()
    const [settings, types] = await Promise.all([readSystemSettings(pool), readOccurrenceTypes(pool)])
    const kinds = portalAttachmentKinds(settings.driverAccess, settings.attachments.allowedKinds) as AttachmentKind[]
    const type = types.find((item) => item.key === category)
    if (kinds.length === 0 || !type?.allowsAttachments) {
      throw new ModuleError('O envio de anexos não está habilitado para esta ocorrência.', 403)
    }
    const { kind, name } = validateAttachment(content, rawName, { ...settings.attachments, allowedKinds: kinds })
    const storage = resolveAttachmentStorage()
    if (!storage) throw new ModuleError('O envio de anexos não está habilitado.', 503)

    try {
      // Restrito: só a equipe que atende a Frota e quem enviou. O solicitante não vê.
      const id = await attachments.add(identityOf(response), storage, { type: 'service_request', id: tripId }, {
        content,
        name,
        kind,
        category: 'outro',
        restricted: true,
        maxTotalBytes: settings.attachments.maxTotalMb * 1024 * 1024,
      })
      await drivers.linkOccurrenceAttachment(occurrenceId, id)
      response.status(201).json({ success: true, id })
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'EACCES' || code === 'ENOSPC') recordTechnicalEvent('storage', 'attachment_write_failed', error)
      throw error
    }
  }),
)

// ---------------------------------------------------------------------------
// Equipe da Frota: cadastro de motoristas
// ---------------------------------------------------------------------------
const manageDrivers = requirePermission('fleet:manage')

function readDriver(body: Record<string, unknown>) {
  if (body.active !== undefined && typeof body.active !== 'boolean') throw new RequestValidationError('Situação inválida.')
  return {
    name: requiredText(body.name, 'o nome', { min: 3, max: 160 }),
    registration: optionalText(body.registration, 'Matrícula', 40),
    active: body.active !== false,
    userId: optionalUuid(body.userId, 'Conta de acesso'),
  }
}

router.get(
  '/fleet/drivers',
  manageDrivers,
  guarded(async (_request, response) => {
    const [list, accounts] = await Promise.all([drivers.listDrivers(), drivers.listLinkableAccounts()])
    response.json({ success: true, drivers: list, accounts })
  }),
)

router.get(
  '/fleet/drivers/assignable',
  requirePermission('fleet:schedule'),
  guarded(async (_request, response) => {
    response.json({ success: true, drivers: await drivers.listAssignable() })
  }),
)

router.post(
  '/fleet/drivers',
  manageDrivers,
  guarded(async (request, response) => {
    const id = await drivers.createDriver(identityOf(response), readDriver(asBody(request.body)))
    response.status(201).json({ success: true, id })
  }),
)

router.patch(
  '/fleet/drivers/:driverId',
  manageDrivers,
  guarded(async (request, response) => {
    await drivers.updateDriver(identityOf(response), uuidParam(request, 'driverId'), readDriver(asBody(request.body)))
    response.json({ success: true })
  }),
)

// ---------------------------------------------------------------------------
// Equipe da Frota: execução da viagem, que é a mesma solicitação de Frota.
// ---------------------------------------------------------------------------
router.get(
  '/fleet/requests/:requestId/execution',
  requirePermission('fleet:read'),
  requirePermission('requests:read_all'),
  guarded(async (request, response) => {
    response.json({ success: true, ...(await drivers.execution(uuidParam(request, 'requestId'))) })
  }),
)

// Quem agenda atribui, com a mesma regra. O motorista não tem nenhuma das duas permissões.
router.post(
  '/fleet/requests/:requestId/driver',
  requireAuditedPermission(['requests:schedule', 'fleet:schedule'], 'fleet.driver_assign'),
  guarded(async (request, response) => {
    const identity = identityOf(response)
    if (!canScheduleRequest(identity, 'fleet')) throw forbidden()
    const id = uuidParam(request, 'requestId')
    const body = asBody(request.body)
    await drivers.assign(identity, id, {
      driverId: optionalUuid(body.driverId, 'Motorista'),
      notes: optionalText(body.notes, 'Observações para o motorista', 1000),
      confirmConflicts: body.confirmConflicts === true,
    })
    response.json({ success: true })
  }),
)

router.post(
  '/fleet/requests/:requestId/execution-correction',
  requirePermission('fleet:execution_correct'),
  guarded(async (request, response) => {
    const id = uuidParam(request, 'requestId')
    const body = asBody(request.body)
    const start = optionalDateTime(body.start, 'o início efetivo')
    const end = optionalDateTime(body.end, 'o término efetivo')
    const limit = Date.now() + 60_000
    if ((start && start.getTime() > limit) || (end && end.getTime() > limit)) {
      throw new RequestValidationError('O horário corrigido não pode estar no futuro.')
    }
    if (!start && !end) throw new RequestValidationError('Informe o horário a corrigir.')
    await drivers.correctExecution(identityOf(response), id, {
      start,
      end,
      reason: requiredText(body.reason, 'o motivo da correção', { min: 3, max: 1000 }),
    })
    response.json({ success: true })
  }),
)

export default router
