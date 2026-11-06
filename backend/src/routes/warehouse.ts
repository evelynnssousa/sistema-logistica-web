import { Router } from 'express'
import type { Request, Response } from 'express'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { privacyNoticeVersions } from '../integrations/privacyNotices.js'
import { ModuleError, notFound, sendModuleError } from '../database/moduleErrors.js'
import { OperationsRepository } from '../database/operationsRepository.js'
import { WarehouseRepository } from '../database/warehouseRepository.js'
import type { ItemInput, MaterialInput } from '../database/warehouseRepository.js'
import { insertAuthAuditEvent } from '../database/authAuditRepository.js'
import { readPublishedConfig } from '../database/configRepository.js'
import { getDatabasePool } from '../database/pool.js'
import { renderReportCsv, renderReportPdf } from '../reports/reportDocument.js'
import type { ReportDocument } from '../reports/reportDocument.js'
import { formatReportDate, historyLine } from '../reports/requestReport.js'
import { defaultForms, validateCustomValues } from '../requests/formRules.js'
import type { ManagedFormContent } from '../requests/formRules.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requireAuditedPermission } from '../middleware/requireAuditedPermission.js'
import { requirePermission } from '../middleware/requirePermission.js'
import {
  asBody,
  isUuid,
  optionalDateTime,
  optionalText,
  optionalUuid,
  readPage,
  readPeriod,
  readPrivacyNotice,
  readQuantity,
  readSearch,
  requiredText,
  requiredUuid,
  RequestValidationError,
} from '../requests/validation.js'
import {
  readEffectiveDeliveryDate,
  readRequesterEmail,
  validateDeliveryForecast,
} from '../requests/deliveryRules.js'
import { isWarehouseStatus } from '../requests/workflow.js'
import type { WarehouseStatus } from '../requests/workflow.js'

/**
 * Almoxarifado. A escrita é de quem tem warehouse:manage, exceto a abertura de um pedido
 * interno. Sem esse acesso, a pessoa vê apenas os próprios pedidos.
 */

const router = Router()
const warehouse = new WarehouseRepository()
const operations = new OperationsRepository()

router.use('/warehouse', requireAuth, requireCsrf)

const manage = requirePermission('warehouse:manage')

function identityOf(response: Response) {
  return response.locals.authenticatedUser as AuthenticatedIdentity
}

function seesAllRequests(identity: AuthenticatedIdentity) {
  return (
    identity.permissions.includes('warehouse:manage') ||
    identity.permissions.includes('requests:read_all')
  )
}

type WarehouseRequestRecord = NonNullable<Awaited<ReturnType<WarehouseRepository['findRequest']>>>

/**
 * O que cada pessoa vê do pedido. Quem foi identificado pelo e-mail em um pedido digitado recebe
 * só o acompanhamento, em lista fechada: um campo novo nunca chega a essa pessoa por descuido.
 */
function requestViewFor(identity: AuthenticatedIdentity, request: WarehouseRequestRecord) {
  if (seesAllRequests(identity)) return { ...request, limitedView: false }
  const { externalRequesterEmail: _email, ...own } = request
  if (request.requesterId === identity.userId) return { ...own, limitedView: false }
  return {
    id: request.id,
    protocol: request.protocol,
    status: request.status,
    origin: request.origin,
    externalReference: request.externalReference,
    externalRequester: request.externalRequester,
    requesterId: identity.userId,
    requester: request.externalRequester ?? '',
    registeredBy: null,
    sector: request.sector,
    note: null,
    attendedBy: null,
    attendedAt: null,
    deliveredAt: request.deliveredAt,
    deliveredBy: null,
    receivedBy: null,
    itemCount: request.itemCount,
    deliveryForecast: request.deliveryForecast,
    deliveryStatus: request.deliveryStatus,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    limitedView: true,
  }
}

const warehouseHistoryLabels: Record<string, string> = {
  criado: 'Pedido criado',
  registrado_externo: 'Pedido externo registrado',
  editado: 'Registro local alterado',
  itens_alterados: 'Itens alterados',
  status_alterado: 'Status alterado',
  entregue: 'Entrega registrada',
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

function idParam(request: Request, name: string) {
  const value = String(request.params[name])
  if (!isUuid(value)) throw notFound()
  return value
}

function readMaterial(raw: unknown): MaterialInput {
  const body = asBody(raw)
  return {
    code: optionalText(body.code, 'Código', 60),
    name: requiredText(body.name, 'o nome do material', { max: 160 }),
    description: optionalText(body.description, 'Descrição'),
    unitId: requiredUuid(body.unitId, 'a unidade de medida'),
    categoryId: optionalUuid(body.categoryId, 'Categoria'),
    active: body.active !== false,
  }
}

function readItems(raw: unknown, { fulfilledAllowed }: { fulfilledAllowed: boolean }): ItemInput[] {
  if (!Array.isArray(raw) || raw.length > 200) {
    throw new RequestValidationError('Lista de itens inválida.')
  }
  return raw.map((entry) => {
    const item = asBody(entry)
    return {
      materialId: requiredUuid(item.materialId, 'o material'),
      requested: readQuantity(item.requested, 'Quantidade solicitada'),
      fulfilled:
        fulfilledAllowed && item.fulfilled !== undefined && item.fulfilled !== ''
          ? readQuantity(item.fulfilled, 'Quantidade atendida', { allowZero: true })
          : 0,
      reasonCode: fulfilledAllowed ? optionalText(item.reasonCode, 'Motivo', 60) : null,
      note: fulfilledAllowed ? optionalText(item.note, 'Observação do item') : null,
    }
  })
}

function readStatus(value: unknown): WarehouseStatus {
  if (!isWarehouseStatus(value)) throw new RequestValidationError('Status inválido.')
  return value
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------
router.get(
  '/warehouse/materials',
  requirePermission('warehouse:read'),
  guarded(async (request, response) => {
    const canManage = identityOf(response).permissions.includes('warehouse:manage')
    const query = asBody(request.query)
    response.json({
      success: true,
      materials: await warehouse.listMaterials({
        search: readSearch(query.search),
        includeInactive: canManage && query.inactive === 'true',
      }),
    })
  }),
)

router.post(
  '/warehouse/materials',
  manage,
  guarded(async (request, response) => {
    const id = await warehouse.createMaterial(identityOf(response), readMaterial(request.body))
    response.status(201).json({ success: true, id })
  }),
)

router.patch(
  '/warehouse/materials/:materialId',
  manage,
  guarded(async (request, response) => {
    const id = idParam(request, 'materialId')
    await warehouse.updateMaterial(identityOf(response), id, readMaterial(request.body))
    response.json({ success: true })
  }),
)

// ---------------------------------------------------------------------------
// Central de pedidos
// ---------------------------------------------------------------------------
router.get(
  '/warehouse/requests',
  requirePermission('warehouse:read'),
  guarded(async (request, response) => {
    const identity = identityOf(response)
    const query = asBody(request.query)
    const found = await warehouse.listRequests(
      { allRequests: seesAllRequests(identity), userId: identity.userId },
      {
        status: isWarehouseStatus(query.status) ? query.status : undefined,
        origin:
          query.origin === 'interna' || query.origin === 'governamental'
            ? query.origin
            : undefined,
        search: readSearch(query.search),
        ...readPeriod(query),
        page: readPage(query.page),
      },
    )
    response.json({
      success: true,
      ...found,
      requests: found.requests.map((item) => requestViewFor(identity, item)),
    })
  }),
)

// O setor e o solicitante vêm da sessão, nunca do corpo.
router.post(
  '/warehouse/requests',
  requirePermission('warehouse:read'),
  requirePermission('requests:create'),
  guarded(async (request, response) => {
    const body = asBody(request.body)
    const created = await warehouse.createInternalRequest(identityOf(response), {
      note: optionalText(body.note, 'Observação'),
      items: readItems(body.items, { fulfilledAllowed: false }),
      privacyNotice: readPrivacyNotice(body, privacyNoticeVersions.warehouse),
    })
    response.status(201).json({ success: true, ...created })
  }),
)

router.post(
  '/warehouse/external-requests',
  manage,
  guarded(async (request, response) => {
    const body = asBody(request.body)
    const created = await warehouse.createExternalRequest(identityOf(response), {
      externalReference: optionalText(body.externalReference, 'Número de referência', 120),
      externalRequester: optionalText(body.externalRequester, 'Solicitante', 120),
      externalRequesterEmail: readRequesterEmail(body.externalRequesterEmail),
      sectorId: requiredUuid(body.sectorId, 'o setor'),
      note: optionalText(body.note, 'Observação'),
      items: readItems(body.items, { fulfilledAllowed: true }),
    })
    response.status(201).json({ success: true, ...created })
  }),
)

router.get(
  '/warehouse/requests/:requestId',
  requirePermission('warehouse:read'),
  guarded(async (request, response) => {
    const identity = identityOf(response)
    const current = await warehouse.findRequest(idParam(request, 'requestId'))
    if (!current) throw notFound()

    const seesAll = seesAllRequests(identity)
    const owns = seesAll || current.requesterId === identity.userId
    if (!owns && !(await warehouse.isIdentifiedRequester(current, identity.userId))) {
      throw notFound()
    }

    // O histórico das previsões é interno. Quem só foi identificado pelo e-mail não vê o do pedido.
    // A situação dos envios também é da equipe, como na linha do tempo das solicitações.
    const [items, history, deliveryHistory, communications] = await Promise.all([
      warehouse.requestItems(current.id),
      owns ? warehouse.requestHistory(current.id) : [],
      seesAll ? warehouse.deliveryHistory(current.id) : [],
      seesAll ? operations.communications(current.id) : [],
    ])
    response.json({
      success: true,
      request: requestViewFor(identity, current),
      // A observação é interna. Quem foi só identificado pelo e-mail vê as quantidades, sem motivos.
      items: items.map((item) =>
        seesAll
          ? item
          : {
              id: item.id,
              materialId: item.materialId,
              material: item.material,
              unit: item.unit,
              requested: item.requested,
              fulfilled: item.fulfilled,
              notProvided: item.notProvided,
              ...(owns ? { reason: item.reason } : {}),
            },
      ),
      itemChanges: seesAll ? await warehouse.itemChanges(current.id) : [],
      history,
      deliveryHistory,
      communications,
    })
  }),
)

// Mesmo alcance da tela. Quem só foi identificado pelo e-mail acompanha pela tela, sem relatório.
router.get(
  '/warehouse/requests/:requestId/report',
  requirePermission('warehouse:read'),
  guarded(async (request, response) => {
    const identity = identityOf(response)
    const current = await warehouse.findRequest(idParam(request, 'requestId'))
    if (!current) throw notFound()
    const seesAll = seesAllRequests(identity)
    if (!seesAll && current.requesterId !== identity.userId) throw notFound()
    const format = String(asBody(request.query).format ?? 'pdf')
    if (format !== 'pdf' && format !== 'csv') throw new RequestValidationError('Formato inválido.')

    const pool = getDatabasePool()
    const [items, history, deliveryHistory, itemChanges, account] = await Promise.all([
      warehouse.requestItems(current.id),
      warehouse.requestHistory(current.id),
      seesAll ? warehouse.deliveryHistory(current.id) : [],
      seesAll ? warehouse.itemChanges(current.id) : [],
      pool.query<{ full_name: string }>(`SELECT full_name FROM public.auth_users WHERE id = $1`, [identity.userId]),
    ])
    const document: ReportDocument = {
      title: 'Relatório do pedido de materiais',
      subtitle: `Protocolo ${current.protocol}`,
      generatedAt: new Date(),
      generatedBy: account.rows[0]?.full_name ?? 'Sistema',
      sections: [
        {
          heading: 'Dados principais',
          rows: [
            ['Protocolo', current.protocol],
            ['Módulo', 'Almoxarifado'],
            ['Origem', current.origin === 'governamental' ? 'Sistema governamental (cópia digitada)' : 'Sistema JUCESP'],
            ['Referência externa', current.externalReference ?? '-'],
            ['Solicitante', current.externalRequester ?? current.requester],
            ['Setor', current.sector ?? '-'],
            ['Situação final', current.status],
            ['Previsão de entrega', current.deliveryForecast ?? '-'],
            ['Entregue em', formatReportDate(current.deliveredAt)],
            ['Registrado em', formatReportDate(current.createdAt)],
          ],
        },
        {
          heading: 'Materiais',
          entries: items.map(
            (item) =>
              `${item.material}: solicitada ${item.requested} ${item.unit}, disponibilizada ${item.fulfilled}, não disponibilizada ${item.notProvided}${item.reason ? ` - Motivo: ${item.reason}` : ''}${seesAll && item.note ? ` - ${item.note}` : ''}`,
          ),
        },
        {
          heading: 'Histórico',
          entries: history.map((entry) => historyLine(entry, warehouseHistoryLabels, {})),
        },
        ...(seesAll
          ? [
              {
                heading: 'Histórico de quantidades',
                entries: itemChanges.map(
                  (change) =>
                    `${formatReportDate(change.at)} - ${change.material}: ${change.previous ?? 0} -> ${change.fulfilled}${change.reason ? ` - ${change.reason}` : ''} - ${change.user ?? 'Sistema'}`,
                ),
              },
              {
                heading: 'Histórico de previsões',
                entries: deliveryHistory.map(
                  (entry) =>
                    `${formatReportDate(entry.at)} - ${entry.action}: ${entry.previousForecast ?? '-'} -> ${entry.newForecast ?? entry.effectiveDate ?? '-'}${entry.comment ? ` - ${entry.comment}` : ''} - ${entry.user ?? 'Sistema'}`,
                ),
              },
            ]
          : []),
      ],
    }
    await insertAuthAuditEvent(pool, {
      actorUserId: identity.userId,
      actorKind: 'user',
      subjectUserId: null,
      sessionId: current.id,
      eventType: 'warehouse_report_exported',
      details: { format },
    })
    const name = `pedido-${current.protocol.replace(/[^A-Za-z0-9-]/g, '')}.${format}`
    response.set('Content-Disposition', `attachment; filename="${name}"`)
    if (format === 'pdf') response.type('application/pdf').send(renderReportPdf(document))
    else response.type('text/csv; charset=utf-8').send(renderReportCsv(document))
  }),
)

router.patch(
  '/warehouse/requests/:requestId',
  manage,
  guarded(async (request, response) => {
    const id = idParam(request, 'requestId')
    const body = asBody(request.body)
    await warehouse.updateRequest(identityOf(response), id, {
      note: optionalText(body.note, 'Observação'),
      externalReference: optionalText(body.externalReference, 'Número de referência', 120),
      externalRequester: optionalText(body.externalRequester, 'Solicitante', 120),
      // Ausente não apaga: só muda quem envia o campo.
      externalRequesterEmail:
        body.externalRequesterEmail === undefined
          ? undefined
          : readRequesterEmail(body.externalRequesterEmail),
    })
    response.json({ success: true })
  }),
)

router.put(
  '/warehouse/requests/:requestId/items',
  manage,
  guarded(async (request, response) => {
    const id = idParam(request, 'requestId')
    await warehouse.replaceItems(
      identityOf(response),
      id,
      readItems(asBody(request.body).items, { fulfilledAllowed: true }),
    )
    response.json({ success: true })
  }),
)

router.post(
  '/warehouse/requests/:requestId/status',
  manage,
  guarded(async (request, response) => {
    const id = idParam(request, 'requestId')
    const body = asBody(request.body)
    await warehouse.changeStatus(identityOf(response), id, {
      status: readStatus(body.status),
      comment: optionalText(body.comment, 'Comentário'),
    })
    response.json({ success: true })
  }),
)

router.post(
  '/warehouse/requests/:requestId/deliver',
  manage,
  guarded(async (request, response) => {
    const id = idParam(request, 'requestId')
    const body = asBody(request.body)
    const deliveredAt =
      readEffectiveDeliveryDate(body.deliveredDate) ??
      optionalDateTime(body.deliveredAt, 'a data da entrega') ??
      new Date()
    if (deliveredAt.getTime() > Date.now() + 60_000) {
      throw new ModuleError('A data da entrega não pode estar no futuro.', 400)
    }
    await warehouse.registerDelivery(identityOf(response), id, {
      receivedBy: requiredText(body.receivedBy, 'quem recebeu', { max: 120 }),
      deliveredAt,
      comment: optionalText(body.comment, 'Comentário'),
      deliveryNote: optionalText(body.deliveryNote, 'Observação sobre a entrega'),
    })
    response.json({ success: true })
  }),
)

router.put(
  '/warehouse/requests/:requestId/delivery-forecast',
  // Administrar o Almoxarifado não basta: a previsão exige a permissão própria, só da equipe SLM (P-08).
  requireAuditedPermission(['warehouse:manage', 'warehouse:forecast'], 'warehouse.delivery_forecast'),
  guarded(async (request, response) => {
    const id = idParam(request, 'requestId')
    const result = await warehouse.setDeliveryForecast(
      identityOf(response),
      id,
      validateDeliveryForecast(asBody(request.body)),
    )
    response.json({ success: true, ...result })
  }),
)

// ---------------------------------------------------------------------------
// Controle interno da SLM. Não recebe pedidos de outros setores: eles seguem no sistema governamental.
// ---------------------------------------------------------------------------
async function controlForm() {
  const published = await readPublishedConfig<ManagedFormContent>(getDatabasePool(), 'form', 'warehouseControl')
  return { content: published?.content ?? defaultForms.warehouseControl, version: published?.version ?? null }
}

router.get(
  '/warehouse/control-form',
  manage,
  guarded(async (_request, response) => {
    response.json({ success: true, ...(await controlForm()) })
  }),
)

router.get(
  '/warehouse/control-records',
  manage,
  guarded(async (request, response) => {
    response.json({ success: true, ...(await warehouse.listControlRecords(readPage(asBody(request.query).page))) })
  }),
)

router.post(
  '/warehouse/control-records',
  manage,
  guarded(async (request, response) => {
    const body = asBody(request.body)
    const form = await controlForm()
    const optionalQuantity = (value: unknown, label: string) =>
      value === undefined || value === null || value === '' ? null : readQuantity(value, label, { allowZero: true })
    const required = new Map(form.content.fields.filter((field) => field.active && field.required).map((field) => [field.id, field.label]))
    for (const [id, label] of required) {
      const value = body[id]
      if (!id.startsWith('custom-') && (value === undefined || value === null || value === '')) {
        throw new RequestValidationError(`Preencha o campo "${label}".`)
      }
    }
    const referenceQuantity = optionalQuantity(body.referenceQuantity, 'Quantidade de referência')
    const countedQuantity = optionalQuantity(body.countedQuantity, 'Quantidade conferida')
    const justification = optionalText(body.divergenceJustification, 'Justificativa de divergências')
    const divergent = referenceQuantity !== null && countedQuantity !== null && referenceQuantity !== countedQuantity
    if (divergent && !justification) {
      throw new RequestValidationError('Informe a justificativa: a quantidade conferida difere da referência.')
    }
    const custom = validateCustomValues(form.content, body.customFields, { staff: true, context: body })
    const id = await warehouse.createControlRecord(identityOf(response), {
      reference: optionalText(body.reference, 'Referência', 120),
      sectorId: optionalUuid(body.sector, 'Setor'),
      materialId: requiredUuid(body.material, 'o material'),
      description: optionalText(body.description, 'Descrição'),
      referenceQuantity,
      countedQuantity,
      providedQuantity: optionalQuantity(body.providedQuantity, 'Quantidade disponibilizada'),
      notes: optionalText(body.notes, 'Observações'),
      justification,
      customFields: { valores: custom.values, nomes: custom.labels },
      formVersion: form.version,
    })
    response.status(201).json({ success: true, id })
  }),
)

// ---------------------------------------------------------------------------
// Conferência de inventário
// ---------------------------------------------------------------------------
router.get(
  '/warehouse/inventory-checks',
  manage,
  guarded(async (request, response) => {
    response.json({
      success: true,
      ...(await warehouse.listChecks(readPage(asBody(request.query).page))),
    })
  }),
)

router.post(
  '/warehouse/inventory-checks',
  manage,
  guarded(async (request, response) => {
    const body = asBody(request.body)
    const referenceDate = typeof body.referenceDate === 'string' ? body.referenceDate : ''
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate) ||
      Number.isNaN(new Date(`${referenceDate}T00:00:00Z`).getTime())
    ) {
      throw new RequestValidationError('Informe a data de referência.')
    }
    if (!Array.isArray(body.items) || body.items.length > 500) {
      throw new RequestValidationError('Lista de materiais inválida.')
    }

    const created = await warehouse.createCheck(identityOf(response), {
      title: requiredText(body.title, 'o título', { min: 3, max: 160 }),
      referenceDate,
      note: optionalText(body.note, 'Observação'),
      items: body.items.map((entry) => {
        const item = asBody(entry)
        return {
          materialId: requiredUuid(item.materialId, 'o material'),
          governmentQuantity: readQuantity(item.governmentQuantity, 'Quantidade governamental', {
            allowZero: true,
          }),
        }
      }),
    })
    response.status(201).json({ success: true, ...created })
  }),
)

router.get(
  '/warehouse/inventory-checks/:checkId',
  manage,
  guarded(async (request, response) => {
    const check = await warehouse.findCheck(idParam(request, 'checkId'))
    if (!check) throw notFound()
    response.json({ success: true, check })
  }),
)

router.put(
  '/warehouse/inventory-checks/:checkId/items/:materialId',
  manage,
  guarded(async (request, response) => {
    const checkId = idParam(request, 'checkId')
    const materialId = idParam(request, 'materialId')
    const body = asBody(request.body)
    await warehouse.updateCheckItem(identityOf(response), checkId, materialId, {
      governmentQuantity: readQuantity(body.governmentQuantity, 'Quantidade governamental', {
        allowZero: true,
      }),
      countedQuantity:
        body.countedQuantity === null || body.countedQuantity === undefined || body.countedQuantity === ''
          ? null
          : readQuantity(body.countedQuantity, 'Quantidade contada', { allowZero: true }),
      note: optionalText(body.note, 'Observação', 500),
    })
    response.json({ success: true })
  }),
)

router.post(
  '/warehouse/inventory-checks/:checkId/close',
  manage,
  guarded(async (request, response) => {
    const id = idParam(request, 'checkId')
    const body = asBody(request.body)
    if (body.outcome !== 'concluida' && body.outcome !== 'cancelada') {
      throw new RequestValidationError('Selecione como encerrar a conferência.')
    }
    await warehouse.closeCheck(identityOf(response), id, {
      outcome: body.outcome,
      comment: optionalText(body.comment, 'Comentário'),
    })
    response.json({ success: true })
  }),
)

export default router
