import { Router } from 'express'
import type { Request, Response } from 'express'
import type { Permission } from '../auth/permissions.js'
import {
  canCancelRequest,
  canReadRequest,
  canScheduleRequest,
  canUpdateRequest,
  canActOnBehalfOfOtherSectors,
} from '../auth/requestPolicy.js'
import type { RequestModule } from '../auth/requestPolicy.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { privacyNoticeVersions } from '../integrations/privacyNotices.js'
import { FlightPassengerRepository } from '../database/flightPassengerRepository.js'
import { conflict, forbidden, notFound, sendModuleError } from '../database/moduleErrors.js'
import { OperationsRepository } from '../database/operationsRepository.js'
import { getDatabasePool } from '../database/pool.js'
import { ServiceRequestRepository } from '../database/serviceRequestRepository.js'
import { readSystemSettings } from '../database/settingsRepository.js'
import type { NewRequest, ServiceRequest } from '../database/serviceRequestRepository.js'
import { missingRequiredCustomField } from '../requests/settingsRules.js'
import { insertAuthAuditEvent } from '../database/authAuditRepository.js'
import { AttachmentRepository } from '../database/attachmentRepository.js'
import { CommunicationRepository } from '../database/communicationRepository.js'
import { DriverRepository } from '../database/driverRepository.js'
import { readPublishedConfig } from '../database/configRepository.js'
import { moduleNames } from '../integrations/catalog.js'
import { renderReportCsv, renderReportPdf } from '../reports/reportDocument.js'
import { buildRequestReport } from '../reports/requestReport.js'
import { missingStandardField, validateCustomValues } from '../requests/formRules.js'
import type { ManagedFormContent } from '../requests/formRules.js'
import {
  canReturnFromStatus,
  correctableFields,
  pickCorrections,
  validateReturn,
} from '../requests/justificationRules.js'
import type { TripType } from '../requests/validation.js'
import type { FormKey } from '../requests/settingsRules.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requireAuditedPermission } from '../middleware/requireAuditedPermission.js'
import { requirePermission } from '../middleware/requirePermission.js'
import {
  asBody,
  isUuid,
  optionalText,
  optionalUuid,
  readPage,
  readPeriod,
  readPrivacyNotice,
  readSearch,
  RequestValidationError,
  tripTypes,
  validateCompletion,
  validateFleet,
  validateFlightCreation,
  validateFlightDetails,
  validateMaintenance,
  validateOccurrence,
  validatePassengerUpdate,
  validateReason,
  validateSchedule,
  validateStart,
} from '../requests/validation.js'
import {
  isTerminalStatus,
  nextStatus,
  statusesOf,
} from '../requests/workflow.js'
import type { RequestStatus } from '../requests/workflow.js'

/**
 * Fluxo das solicitações de Manutenção, Frota e Passagens. As permissões da rota são
 * conferidas pelo middleware; o acesso à solicitação em si, aqui. Sem acesso, responde 404.
 */

const requests = new ServiceRequestRepository()
const passengers = new FlightPassengerRepository()
const operations = new OperationsRepository()
const attachments = new AttachmentRepository()
const communications = new CommunicationRepository()
const drivers = new DriverRepository()

function identityOf(response: Response) {
  return response.locals.authenticatedUser as AuthenticatedIdentity
}

const prefixes: Record<RequestModule, string> = {
  maintenance: '/maintenance',
  fleet: '/fleet',
  flights: '/flights',
}

function toFormInput(module: RequestModule, rawBody: unknown) {
  const body = asBody(rawBody)
  const privacyNotice = readPrivacyNotice(body, privacyNoticeVersions[module])
  if (module === 'maintenance') {
    const validated = validateMaintenance(body)
    return {
      title: validated.details.localServico,
      description: validated.description,
      priority: validated.priority,
      sectorId: optionalUuid(body.setorId, 'Setor'),
      floorId: validated.floorId,
      serviceTypeId: validated.serviceTypeId,
      details: validated.details,
      lgpdAccepted: false,
      privacyNotice,
    } satisfies NewRequest
  }
  if (module === 'fleet') {
    const validated = validateFleet(body)
    return {
      title: `${validated.details.origem} → ${validated.details.destino}`,
      description: validated.description,
      priority: validated.priority,
      sectorId: optionalUuid(body.setorId, 'Setor'),
      floorId: validated.floorId,
      details: validated.details,
      lgpdAccepted: false,
      privacyNotice,
    } satisfies NewRequest
  }
  const validated = validateFlightCreation(body)
  return {
    ...flightTitle(validated),
    priority: validated.priority,
    sectorId: optionalUuid(body.setorId, 'Setor'),
    floorId: validated.floorId,
    details: validated.details,
    // O aviso de privacidade não é um consentimento: ver PRIVACIDADE_E_TRATAMENTO_DE_DADOS.md.
    lgpdAccepted: false,
    privacyNotice,
    passengers: validated.passengers,
  } satisfies NewRequest
}

function flightTitle(validated: ReturnType<typeof validateFlightDetails>) {
  const segment = validated.details.ida ?? validated.details.volta!
  return {
    title: `${segment.origem} → ${segment.destino}`,
    description: validated.description,
  }
}

/** Reúne os dados guardados e os enviados, para a edição passar pelas mesmas regras. */
function toEditInput(module: RequestModule, current: ServiceRequest, rawBody: unknown) {
  const merged = {
    ...current.details,
    descricao: current.description,
    prioridade: current.priority,
    andarId: current.floorId,
    tipoServicoId: current.serviceTypeId,
    ...asBody(rawBody),
  }

  if (module === 'maintenance') {
    const validated = validateMaintenance(merged)
    return {
      title: validated.details.localServico,
      description: validated.description,
      priority: validated.priority,
      floorId: validated.floorId,
      serviceTypeId: validated.serviceTypeId,
      details: validated.details,
    }
  }
  if (module === 'fleet') {
    const validated = validateFleet(merged)
    return {
      title: `${validated.details.origem} → ${validated.details.destino}`,
      description: validated.description,
      priority: validated.priority,
      floorId: validated.floorId,
      details: validated.details,
    }
  }
  const validated = validateFlightDetails(merged)
  return {
    ...flightTitle(validated),
    priority: validated.priority,
    floorId: validated.floorId,
    details: validated.details,
  }
}

/** Ações disponíveis para a pessoa neste status, calculadas com as mesmas regras da API. */
function allowedActions(identity: AuthenticatedIdentity, current: ServiceRequest) {
  const { module, status } = current
  const scope = { module, requesterId: current.requester.id }
  const update = canUpdateRequest(identity, module)
  const open = !isTerminalStatus(status)

  return {
    edit: update && open,
    schedule: module !== 'flights' && !current.waitingSince && canScheduleRequest(identity, module) && Boolean(nextStatus(module, status, 'schedule')),
    start: update && !current.waitingSince && Boolean(nextStatus(module, status, 'start')),
    complete: update && Boolean(nextStatus(module, status, 'complete')),
    cancel: canCancelRequest(identity, scope) && Boolean(nextStatus(module, status, 'cancel')),
    advanceTo: update && !current.waitingSince ? nextStatus(module, status, 'advance') : null,
    occurrence: module === 'fleet' && update && ['agendado', 'reagendado', 'em_andamento', 'concluido'].includes(status),
    editPassengers: module === 'flights' && update && open,
    upload: open && (update || current.requester.id === identity.userId),
    removeAttachment: update,
    returnForCorrection: update && canReturnFromStatus(status) && !current.waitingSince,
    closeReturn: update && Boolean(current.waitingSince),
    respondReturn: current.requester.id === identity.userId && Boolean(current.waitingSince),
  }
}

async function loadReadable(
  response: Response,
  module: RequestModule,
  id: string,
): Promise<ServiceRequest> {
  if (!isUuid(id)) throw notFound()
  const current = await requests.find(module, id)
  if (
    !current ||
    !canReadRequest(identityOf(response), { module, requesterId: current.requester.id })
  ) {
    throw notFound()
  }
  return current
}

/** Quem atende vê o contexto interno da solicitação; quem só solicita, o andamento. */
function seesInternalContext(identity: AuthenticatedIdentity, module: RequestModule) {
  return (
    canUpdateRequest(identity, module) ||
    (identity.permissions.includes('slm_central:read') && identity.permissions.includes('requests:read_all'))
  )
}

// Motivos internos de gestão ficam com quem atende. Os fatos continuam visíveis a quem solicita.
const internalHistoryActions = new Set([
  'nota_interna',
  // O solicitante acompanha a situação da viagem; quem dirige e o que foi relatado são da equipe.
  'motorista_atribuido',
  'motorista_removido',
  'motorista_orientacao_alterada',
  'ocorrencia_motorista',
  'execucao_dados_motorista',
  'execucao_corrigida',
  'prioridade_alterada',
  'prazo_alterado',
  'complexidade_alterada',
  'cotacao_registrada',
  'cotacao_selecionada',
  'email_registrado',
  'passagem_encaminhada',
])
const anonymizedHistoryActions = new Set(['responsavel_alterado'])

type Timeline = Awaited<ReturnType<ServiceRequestRepository['history']>>

const reportStatusLabels: Record<string, string> = {
  aguardando_agendamento: 'Aguardando agendamento',
  agendado: 'Agendado',
  reagendado: 'Reagendado',
  em_andamento: 'Em andamento',
  concluido: 'Concluído',
  cancelado: 'Cancelado',
  em_cotacao: 'Em cotação',
  aguardando_aprovacao: 'Aguardando aprovação',
  em_emissao: 'Em emissão',
  emitida: 'Emitida',
  cancelada: 'Cancelada',
}

function historyFor(history: Timeline, internal: boolean): Timeline {
  if (internal) return history
  return history
    .filter((entry) => !internalHistoryActions.has(entry.action))
    .map((entry) =>
      anonymizedHistoryActions.has(entry.action) ? { ...entry, comment: null, user: null } : entry,
    )
}

function rethrowUnlessMissingSchema(error: unknown) {
  const code = (error as { code?: unknown }).code
  if (code !== '42P01' && code !== '42703') throw error
}

function missingSchemaAsEmptyMap(error: unknown) {
  rethrowUnlessMissingSchema(error)
  return new Map<string, string>()
}

function missingSchemaAsEmptySet(error: unknown) {
  rethrowUnlessMissingSchema(error)
  return new Set<string>()
}

/** Recurso de uma migração ainda não aplicada não impede abrir a solicitação. */
function emptyWithoutMigration<Item>(work: Promise<Item[]>): Promise<Item[]> {
  return work.catch((error: unknown) => {
    const code = (error as { code?: unknown }).code
    if (code === '42P01' || code === '42703') return []
    throw error
  })
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
  return String(request.params.requestId)
}

const formKeyOf: Record<RequestModule, FormKey> = {
  maintenance: 'maintenance',
  fleet: 'fleet',
  flights: 'airTravel',
}

/** Registra as rotas de um módulo. Passagens usa o mesmo router dos passageiros. */
export function registerRequestRoutes(router: Router, module: RequestModule) {
  const prefix = `${prefixes[module]}/requests`
  const updatePermission = `${module}:update` as Permission

  router.get(
    prefix,
    requirePermission(`${module}:read` as Permission),
    guarded(async (request, response) => {
      const query = asBody(request.query)
      const status = (statusesOf(module) as readonly string[]).includes(String(query.status))
        ? (query.status as RequestStatus)
        : undefined
      const period = readPeriod(query)

      const found = await requests.list(identityOf(response), module, {
          status,
          search: readSearch(query.search),
          // Só Passagens tem tipo de viagem; valor desconhecido é ignorado, como os demais filtros.
          tripType:
            module === 'flights' && tripTypes.includes(query.tripType as TripType)
              ? (query.tripType as TripType)
              : undefined,
          ...period,
          page: readPage(query.page),
        })
      // Indicador do bilhete, só para quem atende: vem do histórico, e não muda o status.
      const identity = identityOf(response)
      const showsTicket = module === 'flights' && canUpdateRequest(identity, module) && identity.permissions.includes('communications:read')
      const tickets = showsTicket ? await communications.ticketStatuses(found.requests.map((item) => item.id)) : null
      // Motorista de cada viagem, só para a equipe. Sem a migração 016, a lista segue sem ele.
      const driverNames =
        module === 'fleet' && seesInternalContext(identity, module)
          ? await drivers.driverNames(found.requests.map((item) => item.id)).catch(missingSchemaAsEmptyMap)
          : null
      response.json({
        success: true,
        ...found,
        requests: found.requests.map((item) => ({
          ...item,
          ...(tickets ? { ticketStatus: tickets.get(item.id)?.status ?? 'nao_enviado' } : {}),
          ...(driverNames ? { driverName: driverNames.get(item.id) ?? null } : {}),
        })),
      })
    }),
  )

  router.post(
    prefix,
    requirePermission('requests:create'),
    requirePermission(`${module}:create` as Permission),
    guarded(async (request, response) => {
      const input: NewRequest = toFormInput(module, request.body)
      const body = asBody(request.body)
      const pool = getDatabasePool()
      const identity = identityOf(response)
      const published = await readPublishedConfig<ManagedFormContent>(pool, 'form', formKeyOf[module])
      if (published) {
        const missing = missingStandardField(formKeyOf[module], published.content, body)
        if (missing) throw new RequestValidationError(`Preencha o campo "${missing.label}".`)
        const custom = validateCustomValues(published.content, body.customFields, {
          staff: canUpdateRequest(identity, module),
          context: body,
        })
        // A versão e os nomes usados ficam no registro: mudar o formulário depois não o altera.
        input.details = { ...input.details, customFields: custom.values, customFieldLabels: custom.labels }
        input.formVersion = published.version
      } else {
        const settings = await readSystemSettings(pool)
        const missing = missingRequiredCustomField(settings.forms.definitions, formKeyOf[module], body.customFields)
        if (missing) throw new RequestValidationError(`Preencha o campo "${missing.label}".`)
      }
      input.duplicateAcknowledged = body.duplicidadeAvisada === true
      const created = await requests.create(
        identity,
        module,
        input,
      )
      response.status(201).json({ success: true, ...created })
    }),
  )

  // Só alerta: o registro nunca é impedido, porque demandas legítimas podem se parecer.
  router.post(
    `${prefix}/duplicates`,
    requirePermission('requests:create'),
    requirePermission(`${module}:create` as Permission),
    guarded(async (request, response) => {
      const body = asBody(request.body)
      const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 4000) : null)
      const segment = asBody(body.ida ?? body.volta)
      response.json({
        success: true,
        duplicates: await requests.possibleDuplicates(identityOf(response), module, {
          sectorId: isUuid(body.setorId) ? body.setorId : null,
          floorId: isUuid(body.andarId) ? body.andarId : null,
          serviceTypeId: isUuid(body.tipoServicoId) ? body.tipoServicoId : null,
          location: text(body.localServico),
          vehicle: text(body.veiculo),
          origin: text(body.origem) ?? text(segment.origem),
          destination: text(body.destino) ?? text(segment.destino),
          date: text(body.dataHora) ?? text(body.dataPreferencial) ?? (text(segment.data) ? `${segment.data}T12:00:00.000Z` : null),
          description: text(body.descricao) ?? text(body.finalidade) ?? text(body.observacoes),
        }),
      })
    }),
  )

  router.get(
    `${prefix}/:requestId`,
    requirePermission(`${module}:read` as Permission),
    guarded(async (request, response) => {
      const identity = identityOf(response)
      const current = await loadReadable(response, module, requestIdOf(request))
      const internal = seesInternalContext(identity, module)
      const [history, allOccurrences, driverOccurrences, passengerList, notes, communications, returns] = await Promise.all([
        requests.history(current.id),
        requests.occurrences(current.id),
        module === 'fleet'
          ? drivers.driverOccurrenceIds(current.id).catch(missingSchemaAsEmptySet)
          : Promise.resolve(new Set<string>()),
        module === 'flights' ? passengers.listMasked(current.id) : Promise.resolve([]),
        internal ? emptyWithoutMigration(operations.notes(current.id)) : Promise.resolve([]),
        internal ? emptyWithoutMigration(operations.communications(current.id)) : Promise.resolve([]),
        requests.returns(current.id, internal),
      ])

      response.json({
        success: true,
        request: current,
        history: historyFor(history, internal),
        // As do motorista têm painel próprio, só para a equipe: ver /fleet/requests/:id/execution.
        occurrences: allOccurrences.filter((item) => !driverOccurrences.has(item.id)),
        passengers: passengerList,
        notes,
        communications,
        returns,
        fieldNames: correctableFields[module],
        actions: allowedActions(identity, current),
      })
    }),
  )

  router.patch(
    `${prefix}/:requestId`,
    requirePermission('requests:update'),
    requirePermission(updatePermission),
    guarded(async (request, response) => {
      const current = await loadReadable(response, module, requestIdOf(request))
      await requests.update(
        identityOf(response),
        module,
        current.id,
        {
          ...toEditInput(module, current, request.body),
          justification: optionalText(asBody(request.body).justificativa, 'Justificativa'),
        },
      )
      response.json({ success: true })
    }),
  )

  router.post(
    `${prefix}/:requestId/cancel`,
    requirePermission('requests:cancel'),
    requirePermission(`${module}:read` as Permission),
    guarded(async (request, response) => {
      const identity = identityOf(response)
      const current = await loadReadable(response, module, requestIdOf(request))
      if (!canCancelRequest(identity, { module, requesterId: current.requester.id })) {
        throw notFound()
      }
      const body = asBody(request.body)
      const status = await requests.cancel(identity, module, current.id, {
        code: body.motivoCodigo,
        text: body.motivo,
      })
      response.json({ success: true, status })
    }),
  )

  // Devolve ao solicitante, sem novo protocolo e sem apagar nada.
  router.post(
    `${prefix}/:requestId/return`,
    requirePermission('requests:update'),
    requirePermission(updatePermission),
    guarded(async (request, response) => {
      const current = await loadReadable(response, module, requestIdOf(request))
      await requests.openReturn(identityOf(response), module, current.id, validateReturn(module, asBody(request.body)))
      response.status(201).json({ success: true })
    }),
  )

  router.post(
    `${prefix}/:requestId/return/close`,
    requirePermission('requests:update'),
    requirePermission(updatePermission),
    guarded(async (request, response) => {
      const current = await loadReadable(response, module, requestIdOf(request))
      await requests.closeReturn(identityOf(response), module, current.id, validateReason(asBody(request.body)))
      response.json({ success: true })
    }),
  )

  // Só quem solicitou responde, e só os campos indicados na devolução são aceitos.
  router.post(
    `${prefix}/:requestId/return/respond`,
    requirePermission(`${module}:read` as Permission),
    guarded(async (request, response) => {
      const identity = identityOf(response)
      const current = await loadReadable(response, module, requestIdOf(request))
      if (current.requester.id !== identity.userId) throw notFound()
      const open = await requests.currentReturn(current.id)
      if (!open) throw conflict('Esta solicitação não está aguardando correção.')

      const body = asBody(request.body)
      const picked = pickCorrections(open.campos, body.dados)
      const passengerList = module === 'flights' && picked.passageiros !== undefined
        ? validatePassengerUpdate({ passageiros: picked.passageiros })
        : null
      if (module === 'flights') delete picked.passageiros

      await requests.respondReturn(identity, module, current.id, {
        response: optionalText(body.resposta, 'Resposta'),
        edit: Object.keys(picked).length > 0 ? toEditInput(module, current, picked) : null,
        passengers: passengerList,
      })
      response.json({ success: true })
    }),
  )

  // Relatório individual, com o mesmo alcance da tela. Nomes e CPF de passageiros não entram.
  router.get(
    `${prefix}/:requestId/report`,
    requirePermission(`${module}:read` as Permission),
    guarded(async (request, response) => {
      const identity = identityOf(response)
      const current = await loadReadable(response, module, requestIdOf(request))
      const internal = seesInternalContext(identity, module)
      const format = String(asBody(request.query).format ?? 'pdf')
      if (format !== 'pdf' && format !== 'csv') throw new RequestValidationError('Formato inválido.')
      const pool = getDatabasePool()
      const [history, passengerList, notes, communications, returns, files, account] = await Promise.all([
        requests.history(current.id),
        module === 'flights' ? passengers.listMasked(current.id) : Promise.resolve([]),
        internal ? emptyWithoutMigration(operations.notes(current.id)) : Promise.resolve([]),
        internal ? emptyWithoutMigration(operations.communications(current.id)) : Promise.resolve([]),
        requests.returns(current.id, false),
        emptyWithoutMigration(attachments.list({ type: 'service_request', id: current.id })),
        pool.query<{ full_name: string }>(`SELECT full_name FROM public.auth_users WHERE id = $1`, [identity.userId]),
      ])
      const document = buildRequestReport({
        module,
        generatedBy: account.rows[0]?.full_name ?? 'Sistema',
        statusLabel: reportStatusLabels[current.status] ?? current.status,
        statuses: reportStatusLabels,
        request: current,
        history: historyFor(history, internal),
        passengerCount: passengerList.length,
        returns,
        communications,
        attachments: files
          .filter((file) => !file.removedAt && (!file.restricted || internal || file.uploadedById === identity.userId))
          .map((file) => ({ name: file.name, category: file.category, uploadedAt: file.uploadedAt })),
        notes,
      })
      await insertAuthAuditEvent(pool, {
        actorUserId: identity.userId,
        actorKind: 'user',
        subjectUserId: current.requester.id,
        sessionId: current.id,
        eventType: 'request_report_exported',
        details: { module: moduleNames[module], format },
      })
      const name = `solicitacao-${current.protocol.replace(/[^A-Za-z0-9-]/g, '')}.${format}`
      response.set('Content-Disposition', `attachment; filename="${name}"`)
      if (format === 'pdf') response.type('application/pdf').send(renderReportPdf(document))
      else response.type('text/csv; charset=utf-8').send(renderReportCsv(document))
    }),
  )

  if (module === 'flights') {
    router.post(
      `${prefix}/:requestId/advance`,
      requirePermission('requests:update'),
      requirePermission(updatePermission),
      guarded(async (request, response) => {
        const current = await loadReadable(response, module, requestIdOf(request))
        const body = asBody(request.body)
        const expected = body.status as RequestStatus
        const status = await requests.advanceFlight(identityOf(response), current.id, {
          expected,
          comment: optionalText(body.comentario, 'Comentário'),
        })
        response.json({ success: true, status })
      }),
    )

    router.put(
      `${prefix}/:requestId/passengers`,
      requirePermission('requests:update'),
      requirePermission(updatePermission),
      guarded(async (request, response) => {
        const current = await loadReadable(response, module, requestIdOf(request))
        await requests.replacePassengers(
          identityOf(response),
          current.id,
          validatePassengerUpdate(asBody(request.body)),
        )
        response.json({
          success: true,
          passengers: await passengers.listMasked(current.id),
        })
      }),
    )
    return
  }

  router.post(
    `${prefix}/:requestId/schedule`,
    requireAuditedPermission(['requests:schedule', `${module}:schedule` as Permission], `${module}.schedule`),
    guarded(async (request, response) => {
      const identity = identityOf(response)
      if (!canScheduleRequest(identity, module)) throw forbidden()
      const current = await loadReadable(response, module, requestIdOf(request))
      const status = await requests.schedule(
        identity,
        module,
        current.id,
        validateSchedule(asBody(request.body)),
      )
      response.json({ success: true, status })
    }),
  )

  router.post(
    `${prefix}/:requestId/start`,
    requirePermission('requests:update'),
    requirePermission(updatePermission),
    guarded(async (request, response) => {
      const current = await loadReadable(response, module, requestIdOf(request))
      const status = await requests.start(
        identityOf(response),
        module,
        current.id,
        validateStart(asBody(request.body)),
      )
      response.json({ success: true, status })
    }),
  )

  router.post(
    `${prefix}/:requestId/complete`,
    requirePermission('requests:update'),
    requirePermission(updatePermission),
    guarded(async (request, response) => {
      const current = await loadReadable(response, module, requestIdOf(request))
      const status = await requests.complete(
        identityOf(response),
        module,
        current.id,
        validateCompletion(asBody(request.body)),
      )
      response.json({ success: true, status })
    }),
  )

  if (module === 'fleet') {
    router.post(
      `${prefix}/:requestId/occurrences`,
      requirePermission('requests:update'),
      requirePermission(updatePermission),
      guarded(async (request, response) => {
        const current = await loadReadable(response, module, requestIdOf(request))
        await requests.addOccurrence(
          identityOf(response),
          module,
          current.id,
          validateOccurrence(asBody(request.body)),
        )
        response.status(201).json({ success: true })
      }),
    )
  }
}

const router = Router()

router.use('/maintenance', requireAuth, requireCsrf)
router.use('/fleet', requireAuth, requireCsrf)
router.use('/operations', requireAuth, requireCsrf)

registerRequestRoutes(router, 'maintenance')
registerRequestRoutes(router, 'fleet')

// Pessoas elegíveis como responsáveis por um atendimento. Só nomes.
router.get(
  '/operations/assignees',
  requirePermission('requests:update'),
  guarded(async (_request, response) => {
    response.json({ success: true, assignees: await requests.listAssignable() })
  }),
)

// Indica à tela se o seletor de setor deve ser oferecido, com a mesma regra da gravação.
router.get(
  '/operations/capabilities',
  guarded(async (_request, response) => {
    const settings = await readSystemSettings(getDatabasePool())
    response.json({
      success: true,
      canActOnBehalf: canActOnBehalfOfOtherSectors(identityOf(response)),
      workday: settings.calendar,
      // Opções dos seletores de justificativa. Só as ativas, sem nada pessoal.
      reasons: {
        scheduling: settings.reasons.scheduling.filter((item) => item.active),
        cancellation: settings.reasons.cancellation.filter((item) => item.active),
        warehouse: settings.reasons.warehouse.filter((item) => item.active),
      },
    })
  }),
)

export default router
