import { presentCustomFields, readCustomForm, saveCustomFields } from '../database/customFormValues.js'
import { assertModuleEnabled } from '../database/moduleSwitch.js'
import express, { Router } from 'express'
import type { Request, RequestHandler, Response } from 'express'
import { AttachmentRejectedError, contentTypes, inlineKinds, validateAttachment } from '../attachments/fileValidation.js'
import { isStorageFailure, resolveAttachmentStorage } from '../attachments/storage.js'
import { transmitAttachment } from '../attachments/transmit.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { AttachmentRepository } from '../database/attachmentRepository.js'
import { DemandConfigRepository, duplicatedName, loadDemandContextData } from '../database/demandConfigRepository.js'
import { DemandInsightsRepository } from '../database/demandInsightsRepository.js'
import { DemandRepository } from '../database/demandRepository.js'
import { DemandSeriesRepository } from '../database/demandSeriesRepository.js'
import { InstitutionalLinkRepository } from '../database/institutionalLinkRepository.js'
import { InstrumentRepository } from '../database/instrumentRepository.js'
import { instrumentAccess } from '../demands/instrumentRules.js'
import { forbidden, ModuleError, notFound, sendModuleError } from '../database/moduleErrors.js'
import { getDatabasePool } from '../database/pool.js'
import { readSystemSettings } from '../database/settingsRepository.js'
import {
  canConfigureModule,
  canCreateAgendaEvents,
  canCreateDemands,
  canSeeReports,
  contextFromIdentity,
  creationScope,
  demandProfiles,
  hasDemandAccess,
  isConsultationOnly,
} from '../demands/demandPolicy.js'
import type { DemandAccess, DemandContext, DemandFacts } from '../demands/demandPolicy.js'
import { demandReportDocument, demandReportWorkbook, describeDemandFilters } from '../demands/demandReport.js'
import {
  demandStatuses,
  optionalDate,
  readAgendaEvent,
  readCollaboration,
  readComment,
  readCompletion,
  readDemandFilters,
  readDemandInput,
  readDemandPatch,
  readDirectorateLink,
  readLink,
  readPreferences,
  readReason,
  readRecurrenceInput,
  readScope,
  readStatusDetails,
  readSubtask,
  readVersion,
  subtaskStatuses,
  terminalStatuses,
} from '../demands/demandValidation.js'
import type { DemandStatus } from '../demands/demandValidation.js'
import { isCalendarDate } from '../demands/recurrence.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'
import { renderReportPdf } from '../reports/reportDocument.js'
import { renderWorkbook } from '../reports/xlsxDocument.js'
import type { AttachmentKind } from '../requests/settingsRules.js'
import {
  asBody,
  isUuid,
  optionalText,
  optionalUuid,
  readPage,
  readSearch,
  RequestValidationError,
  requiredText,
} from '../requests/validation.js'

/**
 * Controle de Demandas. O acesso depende do perfil (veja demands/demandPolicy.ts), e é conferido em
 * cada rota a partir do banco. Sem acesso a uma demanda, a resposta é igual à de uma inexistente.
 */

const router = Router()
const demands = new DemandRepository()
const series = new DemandSeriesRepository()
const insights = new DemandInsightsRepository()
const config = new DemandConfigRepository()
const institutional = new InstitutionalLinkRepository()
const attachmentUsage = new AttachmentRepository()
const instrumentLinks = new InstrumentRepository()

router.use('/demands', requireAuth, requireCsrf)

const hardLimit = express.raw({ type: () => true, limit: '101mb' })
// Definir diretores segue exigindo a permissão: quem é Diretor não amplia o próprio grupo.
const configureDirectorate = requirePermission('demands:configure')

function identityOf(response: Response) {
  return response.locals.authenticatedUser as AuthenticatedIdentity
}

async function contextOf(response: Response): Promise<DemandContext> {
  const identity = identityOf(response)
  return contextFromIdentity(identity, await loadDemandContextData(getDatabasePool(), identity.userId))
}

/** Identidade e vínculos atuais. Quem não tem nenhum vínculo recebe 403 em todo o módulo. */
async function requireContext(response: Response) {
  const context = await contextOf(response)
  if (!hasDemandAccess(context)) throw forbidden()
  return context
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

/** Setores, integrantes e categorias: a permissão ou o perfil de Diretor, conferido no banco. */
const configure: RequestHandler = async (_request, response, next) => {
  try {
    if (!canConfigureModule(await contextOf(response), identityOf(response).permissions)) throw forbidden()
  } catch (error) {
    sendModuleError(response, error)
    return
  }
  next()
}

function idParam(request: Request, name: string) {
  const value = String(request.params[name])
  if (!isUuid(value)) throw notFound()
  return value
}

async function readable(context: DemandContext, id: string): Promise<{ access: DemandAccess; facts: DemandFacts }> {
  const resolved = await demands.accessTo(context, id)
  if (!resolved?.access.read) throw notFound()
  return resolved
}

/** Carrega a demanda e confere a capacidade exigida. Sem leitura, 404; sem a capacidade, 403. */
async function loadWith(response: Response, request: Request, capability: keyof DemandAccess) {
  const context = await requireContext(response)
  const id = idParam(request, 'demandId')
  const { access, facts } = await readable(context, id)
  if (!access[capability]) throw forbidden()
  return { context, id, access, facts, identity: identityOf(response) }
}

// ---------------------------------------------------------------------------
// Contexto. Responde também a quem não tem acesso, para a tela decidir o que mostrar.
// ---------------------------------------------------------------------------
router.get(
  '/demands/context',
  guarded(async (_request, response) => {
    const identity = identityOf(response)
    try {
      const context = await contextOf(response)
      response.json({
        success: true,
        migrated: true,
        hasAccess: hasDemandAccess(context),
        administrator: context.administrator,
        directorate: context.directorate,
        consultationOnly: isConsultationOnly(context),
        profiles: demandProfiles(context),
        canCreate: canCreateDemands(context),
        createAnywhere: creationScope(context).anywhere,
        creatableSectorIds: creationScope(context).sectorIds,
        canCreateEvents: canCreateAgendaEvents(context),
        canSeeReports: canSeeReports(context),
        memberships: context.memberships,
        canConfigure: canConfigureModule(context, identity.permissions),
      })
    } catch (error) {
      // Banco ainda sem as migrações 014 ou 015: o módulo só fica oculto, e isso não é erro.
      const code = (error as { code?: unknown }).code
      if (code !== '42P01' && code !== '42703') throw error
      response.json({
        success: true,
        migrated: false,
        hasAccess: false,
        administrator: false,
        directorate: false,
        consultationOnly: false,
        profiles: [],
        canCreate: false,
        createAnywhere: false,
        creatableSectorIds: [],
        canCreateEvents: false,
        canSeeReports: false,
        memberships: [],
        canConfigure: identity.permissions.includes('demands:configure'),
      })
    }
  }),
)

router.get(
  '/demands/options',
  guarded(async (_request, response) => {
    await requireContext(response)
    response.json({ success: true, ...(await config.listActiveOptions()) })
  }),
)

router.get(
  '/demands/dashboard',
  guarded(async (request, response) => {
    const context = await requireContext(response)
    response.json({ success: true, ...(await insights.dashboard(context, readDemandFilters(asBody(request.query)))) })
  }),
)

async function reportContext(response: Response) {
  const context = await requireContext(response)
  if (!canSeeReports(context)) throw forbidden()
  return context
}

router.get(
  '/demands/reports',
  guarded(async (request, response) => {
    const context = await reportContext(response)
    response.json({ success: true, ...(await insights.report(context, readDemandFilters(asBody(request.query)))) })
  }),
)

router.get(
  '/demands/reports/export',
  guarded(async (request, response) => {
    const context = await reportContext(response)
    const query = asBody(request.query)
    const format = query.format === 'xlsx' ? 'xlsx' : query.format === 'pdf' ? 'pdf' : null
    if (!format) throw new RequestValidationError('Formato de exportação inválido.')
    const filters = readDemandFilters(query)
    const [report, rows] = await Promise.all([insights.report(context, filters), insights.reportRows(context, filters)])
    await insights.recordExport(identityOf(response), format)

    const generatedBy = (
      await getDatabasePool().query<{ full_name: string }>(`SELECT full_name FROM public.auth_users WHERE id = $1`, [
        context.userId,
      ])
    ).rows[0].full_name
    response.set('Content-Disposition', `attachment; filename="relatorio-demandas.${format}"`)
    if (format === 'pdf') {
      response.type('application/pdf').send(renderReportPdf(demandReportDocument(report, rows, generatedBy)))
    } else {
      response
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(renderWorkbook(demandReportWorkbook(report, rows, { generatedBy, filters: describeDemandFilters(filters) })))
    }
  }),
)

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------
router.get(
  '/demands/agenda',
  guarded(async (request, response) => {
    const context = await requireContext(response)
    const query = asBody(request.query)
    const from = query.from
    const to = query.to
    if (!isCalendarDate(from) || !isCalendarDate(to) || to < from) {
      throw new RequestValidationError('Informe um período válido.')
    }
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 93) {
      throw new RequestValidationError('Consulte até três meses por vez.')
    }
    const scope = query.scope === 'individual' || query.scope === 'sector' ? query.scope : 'all'
    response.json({
      success: true,
      items: await insights.agenda(context, identityOf(response), {
        from,
        to,
        scope,
        sectorId: optionalUuid(query.sectorId, 'Setor'),
        responsibleId: optionalUuid(query.responsibleId, 'Responsável'),
      }),
    })
  }),
)

router.post(
  '/demands/agenda/events',
  guarded(async (request, response) => {
    const context = await requireContext(response)
    const input = readAgendaEvent(asBody(request.body))
    if (input.demandId) {
      const { access } = await readable(context, input.demandId)
      if (!access.edit) throw forbidden()
    }
    const id = await insights.createEvent(identityOf(response), context, input)
    response.status(201).json({ success: true, id })
  }),
)

router.post(
  '/demands/agenda/events/:eventId/cancel',
  guarded(async (request, response) => {
    const context = await requireContext(response)
    if (!canCreateAgendaEvents(context)) throw forbidden()
    const cancelled = await insights.cancelEvent(identityOf(response), context, idParam(request, 'eventId'))
    if (!cancelled) throw notFound()
    response.json({ success: true })
  }),
)

// ---------------------------------------------------------------------------
// Preferências de cada pessoa
// ---------------------------------------------------------------------------
router.get(
  '/demands/preferences',
  guarded(async (_request, response) => {
    const context = await requireContext(response)
    response.json({ success: true, preferences: await config.readPreferences(context.userId) })
  }),
)

router.put(
  '/demands/preferences',
  guarded(async (request, response) => {
    const context = await requireContext(response)
    await config.savePreferences(context.userId, readPreferences(asBody(request.body)))
    response.json({ success: true })
  }),
)

// ---------------------------------------------------------------------------
// Configurações: setores, integrantes e categorias
// ---------------------------------------------------------------------------
function readNamed(body: Record<string, unknown>) {
  const order = body.order === undefined || body.order === '' ? 0 : Number(body.order)
  if (!Number.isInteger(order) || order < 0 || order > 100000) throw new RequestValidationError('Ordem inválida.')
  return {
    name: requiredText(body.name, 'o nome', { min: 2, max: 120 }),
    description: optionalText(body.description, 'Descrição', 500),
    order,
  }
}

const readSector = (body: Record<string, unknown>) => ({
  ...readNamed(body),
  acronym: optionalText(body.acronym, 'Sigla', 20),
  isSlm: body.isSlm === true,
})

const readActive = (body: Record<string, unknown>) => {
  if (typeof body.active !== 'boolean') throw new RequestValidationError('Situação inválida.')
  return body.active
}

router.get(
  '/demands/settings/sectors',
  configure,
  guarded(async (_request, response) => {
    response.json({ success: true, sectors: await config.listSectors() })
  }),
)

router.post(
  '/demands/settings/sectors',
  configure,
  guarded(async (request, response) => {
    try {
      const id = await config.createSector(identityOf(response), readSector(asBody(request.body)))
      response.status(201).json({ success: true, id })
    } catch (error) {
      throw duplicatedName(error, 'um setor')
    }
  }),
)

router.patch(
  '/demands/settings/sectors/:sectorId',
  configure,
  guarded(async (request, response) => {
    const body = asBody(request.body)
    try {
      await config.updateSector(identityOf(response), idParam(request, 'sectorId'), {
        ...readSector(body),
        active: readActive(body),
      })
      response.json({ success: true })
    } catch (error) {
      throw duplicatedName(error, 'um setor')
    }
  }),
)

router.get(
  '/demands/settings/users',
  configure,
  guarded(async (request, response) => {
    response.json({ success: true, users: await config.searchUsers(readSearch(asBody(request.query).q)) })
  }),
)

router.put(
  '/demands/settings/sectors/:sectorId/members/:userId',
  configure,
  guarded(async (request, response) => {
    const body = asBody(request.body)
    const role = body.role === 'responsavel' ? 'responsavel' : 'colaborador'
    await config.setMember(identityOf(response), idParam(request, 'sectorId'), idParam(request, 'userId'), {
      role,
      canCreate: body.canCreate !== false,
      seesSector: body.seesSector !== false,
      chefia: body.chefia === true,
      function: optionalText(body.function, 'Função no setor', 120),
    })
    response.json({ success: true })
  }),
)

router.post(
  '/demands/settings/sectors/:sectorId/members/:userId/remove',
  configure,
  guarded(async (request, response) => {
    await config.removeMember(identityOf(response), idParam(request, 'sectorId'), idParam(request, 'userId'))
    response.json({ success: true })
  }),
)

router.get(
  '/demands/settings/directorate',
  configureDirectorate,
  guarded(async (_request, response) => {
    response.json({ success: true, links: await institutional.listDirectorate() })
  }),
)

router.put(
  '/demands/settings/directorate/:userId',
  configureDirectorate,
  guarded(async (request, response) => {
    await institutional.setDirectorateLink(
      identityOf(response),
      idParam(request, 'userId'),
      readDirectorateLink(asBody(request.body)),
    )
    response.json({ success: true })
  }),
)

router.post(
  '/demands/settings/directorate/:userId/remove',
  configureDirectorate,
  guarded(async (request, response) => {
    await institutional.setDirectorateLink(identityOf(response), idParam(request, 'userId'), null)
    response.json({ success: true })
  }),
)

router.get(
  '/demands/settings/categories',
  configure,
  guarded(async (_request, response) => {
    response.json({ success: true, categories: await config.listCategories() })
  }),
)

router.post(
  '/demands/settings/categories',
  configure,
  guarded(async (request, response) => {
    try {
      const id = await config.createCategory(identityOf(response), readNamed(asBody(request.body)))
      response.status(201).json({ success: true, id })
    } catch (error) {
      throw duplicatedName(error, 'uma categoria')
    }
  }),
)

router.patch(
  '/demands/settings/categories/:categoryId',
  configure,
  guarded(async (request, response) => {
    const body = asBody(request.body)
    try {
      await config.updateCategory(identityOf(response), idParam(request, 'categoryId'), {
        ...readNamed(body),
        active: readActive(body),
      })
      response.json({ success: true })
    } catch (error) {
      throw duplicatedName(error, 'uma categoria')
    }
  }),
)

// ---------------------------------------------------------------------------
// Anexos. Sem URL pública: todo acesso passa pela sessão e pelas regras da demanda.
// ---------------------------------------------------------------------------
function availableStorage() {
  const storage = resolveAttachmentStorage()
  if (!storage) throw new ModuleError('O armazenamento de anexos ainda não foi configurado.', 503)
  return storage
}

router.get(
  '/demands/attachments/:attachmentId/content',
  guarded(async (request, response) => {
    const context = await requireContext(response)
    const attachment = await demands.findAttachment(idParam(request, 'attachmentId'))
    if (!attachment || attachment.removedAt) throw notFound()
    const { access } = await readable(context, attachment.demandId)
    if (access.administrativeRead) {
      await demands.recordAdministrativeAccess(identityOf(response), attachment.demandId, 'Anexo de demanda restrita baixado')
    }

    const storage = availableStorage()
    const kind = attachment.kind as AttachmentKind
    const inline = asBody(request.query).inline === '1' && inlineKinds.includes(kind)
    await demands.recordAttachmentDownload(identityOf(response), attachment.id, attachment.demandId)

    response.set({
      'Content-Type': contentTypes[kind],
      'Content-Length': String(attachment.sizeBytes),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        kind === 'pdf' && inline
          ? "default-src 'none'; style-src 'unsafe-inline'"
          : "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    })
    await transmitAttachment(response, storage, attachment, 'demand_attachment_read_failed')
  }),
)

router.post(
  '/demands/attachments/:attachmentId/remove',
  guarded(async (request, response) => {
    const context = await requireContext(response)
    const attachment = await demands.findAttachment(idParam(request, 'attachmentId'))
    if (!attachment) throw notFound()
    const { access } = await readable(context, attachment.demandId)
    if (!access.edit) throw forbidden()
    await demands.removeAttachment(identityOf(response), attachment.id, attachment.demandId, readReason(asBody(request.body)))
    response.json({ success: true })
  }),
)

// ---------------------------------------------------------------------------
// Demandas
// ---------------------------------------------------------------------------
router.get(
  '/demands',
  guarded(async (request, response) => {
    const context = await requireContext(response)
    const query = asBody(request.query)
    const requestedSize = Number(query.pageSize)
    response.json({
      success: true,
      ...(await demands.list(context, readDemandFilters(query), {
        sort: typeof query.sort === 'string' ? query.sort : 'atualizacao',
        page: readPage(query.page),
        // O quadro e a exportação precisam de mais linhas, sempre com teto.
        pageSize: Number.isInteger(requestedSize) && requestedSize >= 1 && requestedSize <= 200 ? requestedSize : 25,
      })),
    })
  }),
)

router.post(
  '/demands',
  guarded(async (request, response) => {
    const context = await requireContext(response)
    // A autorização vem antes da validação: quem não pode cadastrar não recebe dicas sobre os dados.
    if (!canCreateDemands(context)) throw forbidden()
    await assertModuleEnabled('demands')
    const custom = await readCustomForm('demand', asBody(request.body).customFields)
    const created = await demands.create(identityOf(response), context, readDemandInput(asBody(request.body)))
    await saveCustomFields('demands', created.id, custom)
    response.status(201).json({ success: true, ...created })
  }),
)

router.get(
  '/demands/:demandId',
  guarded(async (request, response) => {
    const context = await requireContext(response)
    const detail = await demands.detail(identityOf(response), context, idParam(request, 'demandId'))
    if (detail.access.administrativeRead) {
      await demands.recordAdministrativeAccess(identityOf(response), detail.demand.id, 'Demanda restrita consultada')
    }
    // Ata ou contrato vinculado (021) e campos novos do formulário (022). Sem as migrações, vazios.
    const extra = await getDatabasePool().query<{ campos: unknown }>(
      `SELECT to_jsonb(d)->'campos_personalizados' AS campos FROM public.demands d WHERE d.id = $1`,
      [detail.demand.id],
    )
    response.json({
      success: true,
      ...detail,
      instrument: await instrumentLinks.linkedInstrument(detail.demand.id),
      customFields: presentCustomFields(extra.rows[0]?.campos),
    })
  }),
)

/** Vincula ou desvincula uma ata ou contrato que a pessoa também enxerga. */
router.put(
  '/demands/:demandId/instrument',
  guarded(async (request, response) => {
    const { context, id, identity } = await loadWith(response, request, 'edit')
    const instrumentId = optionalUuid(asBody(request.body).instrumentId, 'Ata ou contrato')
    if (instrumentId) {
      const sectors = await instrumentLinks.sectorsOf(instrumentId)
      if (!sectors || !instrumentAccess(context, sectors).read) throw new ModuleError('Ata ou contrato não encontrado.', 400)
    }
    await instrumentLinks.linkDemand(identity, id, instrumentId)
    response.json({ success: true })
  }),
)

router.patch(
  '/demands/:demandId',
  guarded(async (request, response) => {
    const { context, id, access, identity } = await loadWith(response, request, 'edit')
    const body = asBody(request.body)
    const custom = 'customFields' in body ? await readCustomForm('demand', body.customFields) : null
    const collaboration =
      'collaborators' in body || 'collaboratorSectorIds' in body || 'authorizedUserIds' in body
        ? readCollaboration(body)
        : undefined
    await demands.patch(
      identity,
      id,
      {
        patch: readDemandPatch(body),
        scope: readScope(body),
        version: readVersion(body),
        // Valem só para rascunhos: publicada, a demanda usa as rotas de atribuição e colaboração.
        draftExtras: {
          ...('requesterId' in body ? { requesterId: optionalUuid(body.requesterId, 'Solicitante') } : {}),
          ...('responsibleId' in body ? { responsibleId: optionalUuid(body.responsibleId, 'Responsável') } : {}),
          ...(collaboration ? { collaboration } : {}),
          ...('recurrence' in body ? { recurrence: body.recurrence ? readRecurrenceInput(body.recurrence) : null } : {}),
        },
      },
      access,
      context,
    )
    if (custom) await saveCustomFields('demands', id, custom)
    response.json({ success: true })
  }),
)

router.post(
  '/demands/:demandId/publish',
  guarded(async (request, response) => {
    const { context, id, identity } = await loadWith(response, request, 'edit')
    await demands.publish(identity, context, id)
    response.json({ success: true })
  }),
)

router.post(
  '/demands/:demandId/discard',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    await demands.discard(identity, id, optionalText(asBody(request.body).reason, 'Motivo'))
    response.json({ success: true })
  }),
)

router.post(
  '/demands/:demandId/assign',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'assign')
    const body = asBody(request.body)
    await demands.assign(identity, id, {
      responsibleId: optionalUuid(body.responsibleId, 'Responsável'),
      reason: optionalText(body.reason, 'Motivo'),
      scope: readScope(body),
      version: readVersion(body),
    })
    response.json({ success: true })
  }),
)

router.put(
  '/demands/:demandId/collaboration',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    const body = asBody(request.body)
    await demands.setCollaboration(identity, id, { ...readCollaboration(body), scope: readScope(body) })
    response.json({ success: true })
  }),
)

router.post(
  '/demands/:demandId/follow',
  guarded(async (request, response) => {
    const { context, id } = await loadWith(response, request, 'follow')
    await demands.follow(context, id, asBody(request.body).following === true)
    response.json({ success: true })
  }),
)

router.post(
  '/demands/:demandId/status',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    const body = asBody(request.body)
    const status = body.status as DemandStatus
    if (!demandStatuses.includes(status)) throw new RequestValidationError('Status inválido.')
    if (terminalStatuses.includes(status)) {
      throw new RequestValidationError('Concluir e cancelar têm campos próprios.')
    }
    await demands.changeStatus(identity, id, {
      status,
      details: readStatusDetails(status, body),
      version: readVersion(body),
    })
    response.json({ success: true })
  }),
)

router.post(
  '/demands/:demandId/complete',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    const body = asBody(request.body)
    await demands.complete(identity, id, { ...readCompletion(body), version: readVersion(body) })
    response.json({ success: true })
  }),
)

router.post(
  '/demands/:demandId/reopen',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    await demands.reopen(identity, id, readReason(asBody(request.body)))
    response.json({ success: true })
  }),
)

router.post(
  '/demands/:demandId/cancel',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    await demands.cancel(identity, id, readReason(asBody(request.body), 'o motivo do cancelamento'))
    response.json({ success: true })
  }),
)

router.post(
  '/demands/:demandId/comments',
  guarded(async (request, response) => {
    const { id, facts, identity } = await loadWith(response, request, 'comment')
    const commentId = await demands.addComment(identity, id, facts, readComment(asBody(request.body)))
    response.status(201).json({ success: true, id: commentId })
  }),
)

router.post(
  '/demands/:demandId/subtasks',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'subtasksManage')
    const subtaskId = await demands.addSubtask(identity, id, readSubtask(asBody(request.body)))
    response.status(201).json({ success: true, id: subtaskId })
  }),
)

router.patch(
  '/demands/:demandId/subtasks/:subtaskId',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'subtasksManage')
    const body = asBody(request.body)
    const input: Parameters<DemandRepository['updateSubtask']>[3] = {}
    if ('title' in body) input.title = requiredText(body.title, 'o título da etapa', { max: 200 })
    if ('description' in body) input.description = optionalText(body.description, 'Descrição da etapa', 4000)
    if ('responsibleId' in body) input.responsibleId = optionalUuid(body.responsibleId, 'Responsável pela etapa')
    if ('dueDate' in body) input.dueDate = optionalDate(body.dueDate, 'O prazo da etapa')
    if ('notes' in body) input.notes = optionalText(body.notes, 'Observações da etapa', 4000)
    if ('status' in body) {
      if (!(subtaskStatuses as readonly unknown[]).includes(body.status)) {
        throw new RequestValidationError('Status da etapa inválido.')
      }
      input.status = body.status as string
    }
    await demands.updateSubtask(identity, id, idParam(request, 'subtaskId'), input)
    response.json({ success: true })
  }),
)

router.post(
  '/demands/:demandId/attachments',
  hardLimit,
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'attach')
    const content = request.body
    if (!Buffer.isBuffer(content)) throw new AttachmentRejectedError('Envie o arquivo.')
    const query = asBody(request.query)
    const category = query.categoria === 'comprovante' ? 'comprovante' : 'documento'
    let rawName: string
    try {
      rawName = decodeURIComponent(String(request.get('x-file-name') ?? ''))
    } catch {
      throw new AttachmentRejectedError('Informe um nome de arquivo válido.')
    }
    const settings = await readSystemSettings(getDatabasePool())
    const { kind, name } = validateAttachment(content, rawName, settings.attachments)
    const storage = availableStorage()
    const { bytes } = await attachmentUsage.usedBytes()
    if (bytes + content.length > settings.attachments.maxTotalMb * 1024 * 1024) {
      throw new ModuleError('A capacidade de armazenamento de anexos foi atingida.', 507)
    }
    try {
      const attachmentId = await demands.addAttachment(identity, storage, id, {
        content,
        name,
        kind,
        category,
        subtaskId: optionalUuid(query.etapa, 'Etapa'),
      })
      response.status(201).json({ success: true, id: attachmentId })
    } catch (error) {
      if (isStorageFailure(error)) recordTechnicalEvent('storage', 'demand_attachment_write_failed', error)
      throw error
    }
  }),
)

router.get(
  '/demands/:demandId/attachment-limits',
  guarded(async (request, response) => {
    await loadWith(response, request, 'read')
    const settings = await readSystemSettings(getDatabasePool())
    response.json({
      success: true,
      limits: { maxFileMb: settings.attachments.maxFileMb, allowedKinds: settings.attachments.allowedKinds },
      storageConfigured: resolveAttachmentStorage() !== null,
    })
  }),
)

router.post(
  '/demands/:demandId/links',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'attach')
    const linkId = await demands.addLink(identity, id, readLink(asBody(request.body)))
    response.status(201).json({ success: true, id: linkId })
  }),
)

router.post(
  '/demands/:demandId/links/:linkId/remove',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'attach')
    await demands.removeLink(identity, id, idParam(request, 'linkId'))
    response.json({ success: true })
  }),
)

// ---------------------------------------------------------------------------
// Recorrência. Sempre a partir de uma ocorrência que a pessoa administra.
// ---------------------------------------------------------------------------
router.post(
  '/demands/:demandId/series/suspend',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    await series.suspend(identity, id, readReason(asBody(request.body)))
    response.json({ success: true })
  }),
)

router.post(
  '/demands/:demandId/series/resume',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    response.json({ success: true, nextDate: await series.resume(identity, id) })
  }),
)

router.post(
  '/demands/:demandId/series/cancel',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    const body = asBody(request.body)
    await series.cancel(identity, id, { reason: readReason(body), cancelFuture: body.cancelFuture === true })
    response.json({ success: true })
  }),
)

router.post(
  '/demands/:demandId/series/skip',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    const body = asBody(request.body)
    await series.skip(identity, id, { reason: readReason(body), date: optionalDate(body.date, 'A data') })
    response.json({ success: true })
  }),
)

router.post(
  '/demands/:demandId/series/rule',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    response.json({ success: true, nextDate: await series.changeRule(identity, id, readRecurrenceInput(asBody(request.body))) })
  }),
)

export default router
