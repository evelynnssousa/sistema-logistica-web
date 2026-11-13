import express, { Router } from 'express'
import type { Request, Response } from 'express'
import { AttachmentRejectedError, contentTypes, inlineKinds, validateAttachment } from '../attachments/fileValidation.js'
import { isStorageFailure, resolveAttachmentStorage } from '../attachments/storage.js'
import { transmitAttachment } from '../attachments/transmit.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { AttachmentRepository } from '../database/attachmentRepository.js'
import { loadDemandContextData } from '../database/demandConfigRepository.js'
import { InstrumentRepository } from '../database/instrumentRepository.js'
import type { InstrumentInput } from '../database/instrumentRepository.js'
import { forbidden, ModuleError, notFound, sendModuleError } from '../database/moduleErrors.js'
import { getDatabasePool } from '../database/pool.js'
import { readSystemSettings } from '../database/settingsRepository.js'
import { contextFromIdentity, hasDemandAccess, visibilityLevel } from '../demands/demandPolicy.js'
import type { DemandContext } from '../demands/demandPolicy.js'
import {
  amendmentTypes,
  canCreateInstrumentFor,
  instrumentAccess,
  instrumentCategories,
  instrumentTypes,
} from '../demands/instrumentRules.js'
import type { InstrumentSituation } from '../demands/instrumentRules.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'
import type { AttachmentKind } from '../requests/settingsRules.js'
import {
  asBody,
  isUuid,
  optionalText,
  optionalUuid,
  readSearch,
  RequestValidationError,
  requiredText,
  requiredUuid,
} from '../requests/validation.js'

/**
 * Atas e contratos do Controle de Demandas (migração 021). Mesmo acesso por setor das demandas:
 * instrumentRules.ts decide. Sem acesso a um instrumento, a resposta é igual à de um inexistente.
 */

const router = Router()
const instruments = new InstrumentRepository()
const attachmentUsage = new AttachmentRepository()

router.use('/demand-instruments', requireAuth, requireCsrf)

const hardLimit = express.raw({ type: () => true, limit: '101mb' })

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

function identityOf(response: Response) {
  return response.locals.authenticatedUser as AuthenticatedIdentity
}

async function requireContext(response: Response): Promise<DemandContext> {
  const identity = identityOf(response)
  const context = contextFromIdentity(identity, await loadDemandContextData(getDatabasePool(), identity.userId))
  if (!hasDemandAccess(context)) throw forbidden()
  return context
}

function viewerOf(context: DemandContext) {
  return { userId: context.userId, level: visibilityLevel(context) }
}

function idParam(request: Request, name: string) {
  const value = String(request.params[name])
  if (!isUuid(value)) throw notFound()
  return value
}

/** Instrumento com a capacidade exigida. Sem leitura, 404; sem a capacidade, 403. */
async function loadWith(response: Response, request: Request, capability: 'read' | 'edit') {
  const context = await requireContext(response)
  const id = idParam(request, 'instrumentId')
  const sectors = await instruments.sectorsOf(id)
  if (!sectors) throw notFound()
  const access = instrumentAccess(context, sectors)
  if (!access.read) throw notFound()
  if (!access[capability]) throw forbidden()
  return { context, id, access, identity: identityOf(response) }
}

function oneOf<T extends string>(options: readonly T[], value: unknown, label: string): T {
  if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T
  throw new RequestValidationError(`${label} inválido.`)
}

/** Número com até "decimals" casas; aceita vírgula. */
function decimal(value: unknown, label: string, { required = true, decimals = 2, positive = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new RequestValidationError(`Informe ${label}.`)
    return null
  }
  const text = String(value).trim().replace(/\s/g, '')
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text
  const number = Number(normalized)
  if (!/^\d+(\.\d+)?$/.test(normalized) || !Number.isFinite(number) || number > 999_999_999_999 || (positive && number <= 0)) {
    throw new RequestValidationError(`${label} inválido.`)
  }
  const factor = 10 ** decimals
  return Math.round(number * factor) / factor
}

function day(value: unknown, label: string, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new RequestValidationError(`Informe ${label}.`)
    return null
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new RequestValidationError(`${label} inválida.`)
  }
  return value
}

function readInstrument(body: Record<string, unknown>): InstrumentInput {
  const validFrom = day(body.validFrom, 'A data de início da vigência')
  const validUntil = day(body.validUntil, 'A data de fim da vigência')
  if (validFrom && validUntil && validUntil < validFrom) {
    throw new RequestValidationError('O fim da vigência não pode ser anterior ao início.')
  }
  const notice = body.noticeDays === undefined || body.noticeDays === '' ? 90 : Number(body.noticeDays)
  if (!Number.isInteger(notice) || notice < 0 || notice > 365) {
    throw new RequestValidationError('O aviso de vencimento deve ficar entre 0 e 365 dias.')
  }
  const shared = Array.isArray(body.sharedSectorIds) ? body.sharedSectorIds : []
  if (shared.length > 30 || !shared.every(isUuid)) throw new RequestValidationError('Setores compartilhados inválidos.')
  return {
    type: oneOf(instrumentTypes, body.type, 'Tipo'),
    number: requiredText(body.number, 'o número', { min: 1, max: 60 }),
    subject: requiredText(body.subject, 'o objeto', { min: 3, max: 1000 }),
    category: oneOf(instrumentCategories, body.category, 'Categoria'),
    supplier: optionalText(body.supplier, 'Fornecedor', 200),
    process: optionalText(body.process, 'Processo', 60),
    total: decimal(body.total, 'o valor total')!,
    validFrom,
    validUntil,
    responsibleSectorId: requiredUuid(body.responsibleSectorId, 'o setor responsável'),
    sharedSectorIds: shared as string[],
    managerId: optionalUuid(body.managerId, 'Gestor'),
    noticeDays: notice,
    closed: body.closed === true,
    notes: optionalText(body.notes, 'Observações', 4000),
  }
}

// ---------------------------------------------------------------------------
// Lista, opções e detalhe
// ---------------------------------------------------------------------------
const situations: readonly InstrumentSituation[] = ['vigente', 'vencendo', 'vencido', 'futuro', 'encerrado']

router.get(
  '/demand-instruments',
  guarded(async (request, response) => {
    const context = await requireContext(response)
    const query = asBody(request.query)
    const pick = <T extends string>(options: readonly T[], value: unknown) =>
      typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : null
    response.json({
      success: true,
      instruments: await instruments.list(viewerOf(context), {
        search: readSearch(query.search),
        type: pick(instrumentTypes, query.type),
        category: pick(instrumentCategories, query.category),
        situation: pick(situations, query.situation),
        sectorId: isUuid(query.sectorId) ? query.sectorId : null,
      }),
    })
  }),
)

router.get(
  '/demand-instruments/options',
  guarded(async (_request, response) => {
    const context = await requireContext(response)
    response.json({ success: true, instruments: await instruments.options(viewerOf(context)) })
  }),
)

router.get(
  '/demand-instruments/:instrumentId',
  guarded(async (request, response) => {
    const { context, id, access } = await loadWith(response, request, 'read')
    const settings = await readSystemSettings(getDatabasePool())
    response.json({
      success: true,
      instrument: await instruments.detail(id, viewerOf(context)),
      access,
      attachmentLimits: { maxFileMb: settings.attachments.maxFileMb, allowedKinds: settings.attachments.allowedKinds },
      storageConfigured: resolveAttachmentStorage() !== null,
    })
  }),
)

// ---------------------------------------------------------------------------
// Cadastro e alteração
// ---------------------------------------------------------------------------
router.post(
  '/demand-instruments',
  guarded(async (request, response) => {
    const context = await requireContext(response)
    const input = readInstrument(asBody(request.body))
    if (!canCreateInstrumentFor(context, input.responsibleSectorId)) throw forbidden()
    const id = await instruments.create(identityOf(response), input)
    response.status(201).json({ success: true, id })
  }),
)

router.put(
  '/demand-instruments/:instrumentId',
  guarded(async (request, response) => {
    const { context, id, identity } = await loadWith(response, request, 'edit')
    const input = readInstrument(asBody(request.body))
    // Trocar o setor responsável: só para um setor em que a pessoa também pode cadastrar.
    const current = await instruments.sectorsOf(id)
    if (current && current.responsibleSectorId !== input.responsibleSectorId && !canCreateInstrumentFor(context, input.responsibleSectorId)) {
      throw forbidden()
    }
    await instruments.update(identity, id, input)
    response.json({ success: true })
  }),
)

router.post(
  '/demand-instruments/:instrumentId/items',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    const itemId = await instruments.saveItem(identity, id, null, readItem(asBody(request.body)))
    response.status(201).json({ success: true, id: itemId })
  }),
)

router.put(
  '/demand-instruments/:instrumentId/items/:itemId',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    await instruments.saveItem(identity, id, idParam(request, 'itemId'), readItem(asBody(request.body)))
    response.json({ success: true })
  }),
)

function readItem(body: Record<string, unknown>) {
  return {
    itemNumber: optionalText(body.itemNumber, 'Número do item', 20),
    description: requiredText(body.description, 'a descrição do item', { min: 2, max: 500 }),
    unit: requiredText(body.unit, 'a unidade', { min: 1, max: 40 }),
    registered: decimal(body.registered, 'a quantidade registrada')!,
    unitPrice: decimal(body.unitPrice, 'o valor unitário', { decimals: 4 })!,
    active: body.active === undefined ? true : body.active === true,
  }
}

router.post(
  '/demand-instruments/:instrumentId/usages',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    const body = asBody(request.body)
    const usageId = await instruments.addUsage(identity, id, {
      itemId: requiredUuid(body.itemId, 'o item'),
      quantity: decimal(body.quantity, 'a quantidade', { positive: true })!,
      date: day(body.date, 'a data', true)!,
      document: optionalText(body.document, 'Documento', 120),
      note: optionalText(body.note, 'Observação', 2000),
      demandId: optionalUuid(body.demandId, 'Demanda'),
    })
    response.status(201).json({ success: true, id: usageId })
  }),
)

router.post(
  '/demand-instruments/:instrumentId/amendments',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    const body = asBody(request.body)
    const amendmentId = await instruments.addAmendment(identity, id, {
      type: oneOf(amendmentTypes, body.type, 'Tipo de aditivo'),
      number: optionalText(body.number, 'Número do aditivo', 60),
      signedAt: day(body.signedAt, 'A data de assinatura'),
      newEnd: day(body.newEnd, 'A nova data de fim'),
      newValue: decimal(body.newValue, 'o novo valor total', { required: false }),
      description: requiredText(body.description, 'a descrição', { min: 3, max: 2000 }),
    })
    response.status(201).json({ success: true, id: amendmentId })
  }),
)

// ---------------------------------------------------------------------------
// Anexos: PDF da ata, do contrato e dos aditivos. Sem URL pública.
// ---------------------------------------------------------------------------
function availableStorage() {
  const storage = resolveAttachmentStorage()
  if (!storage) throw new ModuleError('O armazenamento de anexos ainda não foi configurado.', 503)
  return storage
}

router.post(
  '/demand-instruments/:instrumentId/attachments',
  hardLimit,
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    const content = request.body
    if (!Buffer.isBuffer(content)) throw new AttachmentRejectedError('Envie o arquivo.')
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
      const attachmentId = await instruments.addAttachment(identity, storage, id, {
        content,
        name,
        kind,
        amendmentId: optionalUuid(asBody(request.query).aditivo, 'Aditivo'),
      })
      response.status(201).json({ success: true, id: attachmentId })
    } catch (error) {
      if (isStorageFailure(error)) recordTechnicalEvent('storage', 'contract_attachment_write_failed', error)
      throw error
    }
  }),
)

router.get(
  '/demand-instruments/:instrumentId/attachments/:attachmentId',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'read')
    const attachment = await instruments.findAttachment(idParam(request, 'attachmentId'))
    if (!attachment || attachment.removedAt || attachment.instrumentId !== id) throw notFound()
    const storage = availableStorage()
    const kind = attachment.kind as AttachmentKind
    const inline = asBody(request.query).inline === '1' && inlineKinds.includes(kind)
    await instruments.recordAttachmentDownload(identity, attachment.id, id)
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
    await transmitAttachment(response, storage, attachment, 'contract_attachment_read_failed')
  }),
)

router.post(
  '/demand-instruments/:instrumentId/attachments/:attachmentId/remove',
  guarded(async (request, response) => {
    const { id, identity } = await loadWith(response, request, 'edit')
    const reason = requiredText(asBody(request.body).reason, 'o motivo', { min: 3, max: 500 })
    await instruments.removeAttachment(identity, idParam(request, 'attachmentId'), id, reason)
    response.json({ success: true })
  }),
)

export default router
