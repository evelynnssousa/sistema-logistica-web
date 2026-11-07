import { holdsPermission } from '../auth/permissions.js'
import express, { Router } from 'express'
import type { Request, Response } from 'express'
import { AttachmentRejectedError, contentTypes, inlineKinds, validateAttachment } from '../attachments/fileValidation.js'
import { isStorageFailure, resolveAttachmentStorage } from '../attachments/storage.js'
import { transmitAttachment } from '../attachments/transmit.js'
import { canReadRequest, canUpdateRequest } from '../auth/requestPolicy.js'
import type { RequestModule } from '../auth/requestPolicy.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { attachmentCategories, AttachmentRepository } from '../database/attachmentRepository.js'
import type { AttachmentOwner } from '../database/attachmentRepository.js'
import { ModuleError, notFound, sendModuleError } from '../database/moduleErrors.js'
import { getDatabasePool } from '../database/pool.js'
import { readSystemSettings } from '../database/settingsRepository.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'
import type { AttachmentKind } from '../requests/settingsRules.js'
import { asBody, isUuid, requiredText } from '../requests/validation.js'
import { isTerminalStatus, moduleTypes, normalizeStatus } from '../requests/workflow.js'

/**
 * Anexos. Sem URL pública: todo acesso passa pela sessão e pelas regras da solicitação a que o
 * arquivo pertence. Sem acesso, a resposta é a mesma de um registro inexistente.
 */

const router = Router()
const attachments = new AttachmentRepository()

router.use('/attachments', requireAuth, requireCsrf)

// O limite real vem dos parâmetros; este é o teto do que chega a ser lido para a memória.
const hardLimit = express.raw({ type: () => true, limit: '101mb' })

function identityOf(response: Response) {
  return response.locals.authenticatedUser as AuthenticatedIdentity
}

const moduleByType = Object.fromEntries(
  Object.entries(moduleTypes).map(([module, type]) => [type, module]),
) as Record<string, RequestModule>

type Access = { read: boolean; staff: boolean; open: boolean; requester: boolean; module: RequestModule | 'warehouse' }

/** Mesmas regras de leitura da solicitação ou do pedido, conferidas a partir do banco. */
async function accessTo(identity: AuthenticatedIdentity, owner: AttachmentOwner): Promise<Access | null> {
  const pool = getDatabasePool()
  if (owner.type === 'service_request') {
    const found = await pool.query<{ tipo: string; status: string; solicitante_id: string }>(
      `SELECT tipo, status, solicitante_id::text AS solicitante_id FROM public.service_requests WHERE id = $1`,
      [owner.id],
    )
    const row = found.rows[0]
    if (!row) return null
    const module = moduleByType[row.tipo]
    return {
      module,
      read: canReadRequest(identity, { module, requesterId: row.solicitante_id }),
      staff: canUpdateRequest(identity, module),
      open: !isTerminalStatus(normalizeStatus(module, row.status)),
      requester: row.solicitante_id === identity.userId,
    }
  }

  const found = await pool.query<{ status: string; solicitante_id: string }>(
    `SELECT status, solicitante_id::text AS solicitante_id FROM public.material_requests WHERE id = $1`,
    [owner.id],
  )
  const row = found.rows[0]
  if (!row) return null
  const requester = row.solicitante_id === identity.userId
  const manages = holdsPermission(identity, 'warehouse:manage')
  return {
    module: 'warehouse',
    read:
      identity.permissions.includes('warehouse:read') &&
      (manages || requester || identity.permissions.includes('requests:read_all')),
    staff: manages,
    open: !['entregue', 'rejeitado', 'cancelado'].includes(row.status),
    requester,
  }
}

function ownerOf(request: Request): AttachmentOwner {
  const type = String(request.params.resourceType)
  const id = String(request.params.resourceId)
  if ((type !== 'service_request' && type !== 'material_request') || !isUuid(id)) throw notFound()
  return { type, id }
}

function isVisible(
  attachment: { restricted: boolean; uploadedById: string },
  access: Access,
  identity: AuthenticatedIdentity,
) {
  return !attachment.restricted || access.staff || attachment.uploadedById === identity.userId
}

function sendError(response: Response, error: unknown) {
  if (error instanceof AttachmentRejectedError) {
    response.status(400).json({ success: false, message: error.message })
    return
  }
  sendModuleError(response, error)
}

function availableStorage() {
  const storage = resolveAttachmentStorage()
  if (!storage) {
    throw new ModuleError('O armazenamento de anexos ainda não foi configurado.', 503)
  }
  return storage
}

router.get('/attachments/capacity', requirePermission('settings:read'), async (_request, response) => {
  try {
    const settings = await readSystemSettings(getDatabasePool())
    const usage = await attachments.usedBytes()
    response.json({
      success: true,
      configured: resolveAttachmentStorage() !== null,
      usedBytes: usage.bytes,
      files: usage.files,
      maxTotalBytes: settings.attachments.maxTotalMb * 1024 * 1024,
    })
  } catch (error) {
    sendError(response, error)
  }
})

router.get('/attachments/resources/:resourceType/:resourceId', async (request, response) => {
  try {
    const identity = identityOf(response)
    const owner = ownerOf(request)
    const access = await accessTo(identity, owner)
    if (!access?.read) throw notFound()

    const settings = await readSystemSettings(getDatabasePool())
    const list = await attachments.list(owner)
    response.json({
      success: true,
      attachments: list
        .filter((item) => isVisible(item, access, identity))
        .map(({ uploadedById: _omitted, ...item }) => item),
      limits: { maxFileMb: settings.attachments.maxFileMb, allowedKinds: settings.attachments.allowedKinds },
      storageConfigured: resolveAttachmentStorage() !== null,
    })
  } catch (error) {
    sendError(response, error)
  }
})

router.post('/attachments/resources/:resourceType/:resourceId', hardLimit, async (request, response) => {
  try {
    const identity = identityOf(response)
    const owner = ownerOf(request)
    const access = await accessTo(identity, owner)
    if (!access?.read) throw notFound()
    if (!access.staff && !access.requester) throw notFound()
    if (!access.open && !access.staff) {
      throw new ModuleError('Solicitações encerradas não recebem novos anexos.', 409)
    }

    const content = request.body
    if (!Buffer.isBuffer(content)) throw new AttachmentRejectedError('Envie o arquivo.')

    const query = asBody(request.query)
    const category = String(query.categoria ?? 'outro')
    if (!(attachmentCategories as readonly string[]).includes(category)) {
      throw new AttachmentRejectedError('Selecione uma categoria válida.')
    }
    let rawName: string
    try {
      rawName = decodeURIComponent(String(request.get('x-file-name') ?? ''))
    } catch {
      throw new AttachmentRejectedError('Informe um nome de arquivo válido.')
    }

    const settings = await readSystemSettings(getDatabasePool())
    const { kind, name } = validateAttachment(content, rawName, settings.attachments)
    const storage = availableStorage()

    // Bilhetes e comprovantes de Passagens trazem dados pessoais: restritos, salvo escolha expressa.
    const restricted = access.staff
      ? query.restrito === 'true' || (access.module === 'flights' && query.restrito !== 'false')
      : access.module === 'flights'

    const id = await attachments.add(identity, storage, owner, {
      content,
      name,
      kind,
      category,
      restricted,
      maxTotalBytes: settings.attachments.maxTotalMb * 1024 * 1024,
    })
    response.status(201).json({ success: true, id })
  } catch (error) {
    if (isStorageFailure(error)) {
      recordTechnicalEvent('storage', 'attachment_write_failed', error)
    }
    sendError(response, error)
  }
})

router.get('/attachments/files/:attachmentId/content', async (request, response) => {
  try {
    const identity = identityOf(response)
    const id = String(request.params.attachmentId)
    if (!isUuid(id)) throw notFound()
    const attachment = await attachments.find(id)
    if (!attachment || attachment.removedAt) throw notFound()
    const access = await accessTo(identity, attachment.owner)
    if (!access?.read || !isVisible(attachment, access, identity)) throw notFound()

    const storage = availableStorage()
    const kind = attachment.kind as AttachmentKind
    const inline = asBody(request.query).inline === '1' && inlineKinds.includes(kind)

    await attachments.recordDownload(identity, id, attachment.owner)

    response.set({
      'Content-Type': contentTypes[kind],
      'Content-Length': String(attachment.sizeBytes),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      'X-Content-Type-Options': 'nosniff',
      // Mesmo aberto na aba, o conteúdo não executa nada nem acessa a sessão. O leitor de PDF do
      // navegador não funciona em sandbox; PDFs com script já são recusados no envio.
      'Content-Security-Policy':
        kind === 'pdf' && inline
          ? "default-src 'none'; style-src 'unsafe-inline'"
          : "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    })

    await transmitAttachment(response, storage, attachment, 'attachment_read_failed')
  } catch (error) {
    sendError(response, error)
  }
})

router.post('/attachments/files/:attachmentId/remove', async (request, response) => {
  try {
    const identity = identityOf(response)
    const id = String(request.params.attachmentId)
    if (!isUuid(id)) throw notFound()
    const attachment = await attachments.find(id)
    if (!attachment) throw notFound()
    const access = await accessTo(identity, attachment.owner)
    if (!access?.read || !isVisible(attachment, access, identity)) throw notFound()
    if (!access.staff) throw new ModuleError('Acesso não autorizado.', 403)

    await attachments.remove(
      identity,
      id,
      requiredText(asBody(request.body).justificativa, 'a justificativa', { min: 3, max: 2000 }),
    )
    response.json({ success: true })
  } catch (error) {
    sendError(response, error)
  }
})

export default router
