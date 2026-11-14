import { readCustomForm, saveCustomFields } from '../database/customFormValues.js'
import { Router } from 'express'
import type { Request, Response } from 'express'
import { holdsPermission } from '../auth/permissions.js'
import type { Permission } from '../auth/permissions.js'
import { canReadRequest } from '../auth/requestPolicy.js'
import type { RequestModule } from '../auth/requestPolicy.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { ModuleExtensionsRepository } from '../database/moduleExtensionsRepository.js'
import type { VehicleInput } from '../database/moduleExtensionsRepository.js'
import { notFound, sendModuleError } from '../database/moduleErrors.js'
import { ServiceRequestRepository } from '../database/serviceRequestRepository.js'
import { WarehouseFinanceRepository } from '../database/warehouseFinanceRepository.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { fleetMonthlySummary, monthPeriod } from '../reports/fleetMonthly.js'
import {
  asBody,
  isUuid,
  optionalDateTime,
  optionalText,
  optionalUuid,
  readPage,
  readQuantity,
  readSearch,
  requiredDateTime,
  requiredText,
  requiredUuid,
  RequestValidationError,
} from '../requests/validation.js'

/**
 * Veículos, equipamentos, execução, cotações e estoque interno. As sessões são conferidas pelos
 * roteadores de cada prefixo, registrados antes deste, em routes/index.ts.
 */

const router = Router()
const extensions = new ModuleExtensionsRepository()
const requests = new ServiceRequestRepository()
const finance = new WarehouseFinanceRepository()


/** AAAA-MM-DD que existe no calendário (recusa 30/02 e 13/2026). */
function isCalendarDay(value: string) {
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

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

function idParam(request: Request, name: string) {
  const value = String(request.params[name])
  if (!isUuid(value)) throw notFound()
  return value
}

function all(...permissions: Permission[]) {
  return permissions.map((permission) => requirePermission(permission))
}

function integer(value: unknown, label: string, { optional = false, max = 10_000_000 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null
    throw new RequestValidationError(`Informe ${label}.`)
  }
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0 || number > max) {
    throw new RequestValidationError(`${label} deve ser um número inteiro válido.`)
  }
  return number
}

function decimal(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(String(value).replace(',', '.'))
  if (!Number.isFinite(number) || number < 0 || number > 9_999_999) {
    throw new RequestValidationError(`${label} inválido.`)
  }
  return Math.round(number * 100) / 100
}

function optionalDate(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new RequestValidationError(`${label} inválida.`)
  }
  return value
}

const vehicleStatuses = ['disponivel', 'em_uso', 'em_manutencao', 'inativo']

function readVehicle(raw: unknown): VehicleInput {
  const body = asBody(raw)
  const plate = requiredText(body.placa, 'a placa', { min: 5, max: 10 }).toUpperCase()
  if (!/^[A-Z0-9-]{5,10}$/.test(plate)) throw new RequestValidationError('Placa inválida.')
  const status = String(body.situacao ?? 'disponivel')
  if (!vehicleStatuses.includes(status)) throw new RequestValidationError('Selecione a situação do veículo.')
  return {
    plate,
    model: requiredText(body.modelo, 'o modelo', { max: 120 }),
    identification: optionalText(body.identificacao, 'Identificação', 120),
    status,
    currentKm: integer(body.kmAtual ?? 0, 'A quilometragem') as number,
    nextReviewKm: integer(body.proximaRevisaoKm, 'A quilometragem da revisão', { optional: true }),
    nextReviewDate: optionalDate(body.proximaRevisaoData, 'Data da revisão'),
  }
}

const fleetRead = all('fleet:read', 'fleet:update')
const fleetManage = all('fleet:manage')

// Resumo do mês: km por carro e, para quem administra a Frota, horas a mais e a menos por motorista.
router.get(
  '/fleet/monthly-summary',
  ...fleetRead,
  guarded(async (request, response) => {
    const month = asBody(request.query).month
    const period = typeof month === 'string' ? monthPeriod(month) : null
    if (typeof month !== 'string' || !period) throw new RequestValidationError('Informe o mês (AAAA-MM).')
    response.json({ success: true, ...(await fleetMonthlySummary(identityOf(response), month, period)) })
  }),
)

router.get(
  '/fleet/vehicles',
  ...fleetRead,
  guarded(async (_request, response) => {
    response.json({ success: true, vehicles: await extensions.listVehicles() })
  }),
)

router.post(
  '/fleet/vehicles',
  ...fleetManage,
  guarded(async (request, response) => {
    const custom = await readCustomForm('vehicle', asBody(request.body).customFields)
    const id = await extensions.createVehicle(identityOf(response), readVehicle(request.body))
    await saveCustomFields('vehicles', id, custom)
    response.status(201).json({ success: true, id })
  }),
)

router.get(
  '/fleet/vehicles/:vehicleId',
  ...fleetRead,
  guarded(async (request, response) => {
    const detail = await extensions.vehicleDetail(
      idParam(request, 'vehicleId'),
      readPage(asBody(request.query).page),
    )
    if (!detail) throw notFound()
    response.json({ success: true, ...detail })
  }),
)

router.patch(
  '/fleet/vehicles/:vehicleId',
  ...fleetManage,
  guarded(async (request, response) => {
    const body = asBody(request.body)
    const custom = 'customFields' in body ? await readCustomForm('vehicle', body.customFields) : null
    const id = idParam(request, 'vehicleId')
    await extensions.updateVehicle(identityOf(response), id, readVehicle(request.body))
    if (custom) await saveCustomFields('vehicles', id, custom)
    response.json({ success: true })
  }),
)

const logTypes = ['utilizacao', 'ocorrencia', 'abastecimento', 'manutencao']

router.post(
  '/fleet/vehicles/:vehicleId/logs',
  ...fleetRead,
  guarded(async (request, response) => {
    const body = asBody(request.body)
    const type = String(body.tipo)
    if (!logTypes.includes(type)) throw new RequestValidationError('Selecione o tipo de registro.')
    const startKm = integer(body.kmInicial, 'A quilometragem inicial', { optional: true })
    const endKm = integer(body.kmFinal, 'A quilometragem final', { optional: true })
    if (type === 'utilizacao' && (startKm === null || endKm === null)) {
      throw new RequestValidationError('Informe a quilometragem inicial e a final.')
    }
    if (startKm !== null && endKm !== null && endKm < startKm) {
      throw new RequestValidationError('A quilometragem final não pode ser menor que a inicial.')
    }
    const id = await extensions.addVehicleLog(identityOf(response), idParam(request, 'vehicleId'), {
      type,
      at: requiredDateTime(body.data, 'a data'),
      startKm,
      endKm,
      liters: decimal(body.litros, 'Quantidade de litros') || null,
      value: decimal(body.valor, 'Valor'),
      description: requiredText(body.descricao, 'a descrição', { min: 3, max: 2000 }),
      requestProtocol: optionalText(body.protocolo, 'Protocolo', 40),
    })
    response.status(201).json({ success: true, id })
  }),
)

// ---------------------------------------------------------------------------
// Manutenção
// ---------------------------------------------------------------------------
function readEquipment(raw: unknown) {
  const body = asBody(raw)
  return {
    name: requiredText(body.nome, 'o nome', { max: 160 }),
    identification: optionalText(body.identificacao, 'Identificação', 120),
    location: optionalText(body.local, 'Local', 160),
    active: body.ativo !== false,
  }
}

const maintenanceRead = all('maintenance:read', 'maintenance:update')
const maintenanceManage = all('maintenance:manage')

router.get(
  '/maintenance/equipments',
  ...maintenanceRead,
  guarded(async (request, response) => {
    response.json({
      success: true,
      equipments: await extensions.listEquipments(asBody(request.query).inactive === 'true'),
    })
  }),
)

router.post(
  '/maintenance/equipments',
  ...maintenanceManage,
  guarded(async (request, response) => {
    const custom = await readCustomForm('equipment', asBody(request.body).customFields)
    const id = await extensions.saveEquipment(identityOf(response), null, readEquipment(request.body))
    await saveCustomFields('equipments', id, custom)
    response.status(201).json({ success: true, id })
  }),
)

router.patch(
  '/maintenance/equipments/:equipmentId',
  ...maintenanceManage,
  guarded(async (request, response) => {
    const body = asBody(request.body)
    const custom = 'customFields' in body ? await readCustomForm('equipment', body.customFields) : null
    const id = idParam(request, 'equipmentId')
    await extensions.saveEquipment(identityOf(response), id, readEquipment(request.body))
    if (custom) await saveCustomFields('equipments', id, custom)
    response.json({ success: true })
  }),
)

router.get(
  '/maintenance/equipments/:equipmentId/history',
  ...maintenanceRead,
  guarded(async (request, response) => {
    response.json({ success: true, executions: await extensions.equipmentHistory(idParam(request, 'equipmentId')) })
  }),
)

/** Mesma regra da solicitação: sem acesso, responde como inexistente. */
async function loadReadable(response: Response, module: RequestModule, id: string) {
  if (!isUuid(id)) throw notFound()
  const current = await requests.find(module, id)
  if (!current || !canReadRequest(identityOf(response), { module, requesterId: current.requester.id })) {
    throw notFound()
  }
  return current
}

router.get(
  '/maintenance/requests/:requestId/executions',
  requirePermission('maintenance:read'),
  guarded(async (request, response) => {
    const current = await loadReadable(response, 'maintenance', String(request.params.requestId))
    response.json({ success: true, executions: await extensions.executionsOf(current.id) })
  }),
)

router.post(
  '/maintenance/requests/:requestId/executions',
  ...all('requests:update', 'maintenance:update'),
  guarded(async (request, response) => {
    const current = await loadReadable(response, 'maintenance', String(request.params.requestId))
    const body = asBody(request.body)
    await extensions.addExecution(identityOf(response), current.id, {
      equipmentId: optionalUuid(body.equipamentoId, 'Equipamento'),
      executedBy: requiredText(body.executadoPor, 'quem realizou o atendimento', { max: 160 }),
      executedAt: requiredDateTime(body.executadoEm, 'a data da execução'),
      service: requiredText(body.servico, 'o serviço realizado', { min: 3, max: 4000 }),
      pending: optionalText(body.pendencias, 'Pendências'),
      custom: await readCustomForm('maintenanceExecution', body.customFields),
    })
    response.status(201).json({ success: true })
  }),
)

// ---------------------------------------------------------------------------
// Passagens
// ---------------------------------------------------------------------------
const flightStaff = all('flights:read', 'requests:update', 'flights:update')

router.get(
  '/flights/requests/:requestId/quotes',
  ...flightStaff,
  guarded(async (request, response) => {
    const current = await loadReadable(response, 'flights', String(request.params.requestId))
    response.json({ success: true, quotes: await extensions.quotesOf(current.id) })
  }),
)

router.post(
  '/flights/requests/:requestId/quotes',
  ...flightStaff,
  guarded(async (request, response) => {
    const current = await loadReadable(response, 'flights', String(request.params.requestId))
    const body = asBody(request.body)
    const value = decimal(body.valor, 'Valor')
    if (value === null) throw new RequestValidationError('Informe o valor.')
    const id = await extensions.addQuote(identityOf(response), current.id, {
      company: requiredText(body.companhia, 'a companhia', { max: 120 }),
      flights: requiredText(body.voos, 'os voos', { max: 500 }),
      value,
      conditions: optionalText(body.condicoes, 'Condições'),
      validUntil: optionalDateTime(body.validade, 'a validade'),
      custom: await readCustomForm('flightQuote', body.customFields),
    })
    response.status(201).json({ success: true, id })
  }),
)

router.post(
  '/flights/requests/:requestId/quotes/:quoteId/select',
  ...flightStaff,
  guarded(async (request, response) => {
    const current = await loadReadable(response, 'flights', String(request.params.requestId))
    await extensions.selectQuote(
      identityOf(response),
      current.id,
      idParam(request, 'quoteId'),
      requiredText(asBody(request.body).justificativa, 'a justificativa', { min: 3, max: 2000 }),
    )
    response.json({ success: true })
  }),
)

// ---------------------------------------------------------------------------
// Almoxarifado
// ---------------------------------------------------------------------------
const manageWarehouse = requirePermission('warehouse:manage')

router.get(
  '/warehouse/stock',
  manageWarehouse,
  guarded(async (request, response) => {
    const query = asBody(request.query)
    response.json({
      success: true,
      items: await extensions.stock({
        search: readSearch(query.search),
        belowMinimum: query.belowMinimum === 'true',
        withValues: seesValues(response),
        byLocation: query.order === 'location',
      }),
    })
  }),
)

router.put(
  '/warehouse/stock/:materialId/minimum',
  manageWarehouse,
  guarded(async (request, response) => {
    await extensions.setMinimum(
      identityOf(response),
      idParam(request, 'materialId'),
      readQuantity(asBody(request.body).minimo, 'O estoque mínimo', { allowZero: true }),
    )
    response.json({ success: true })
  }),
)

router.put(
  '/warehouse/stock/:materialId/reserved',
  manageWarehouse,
  guarded(async (request, response) => {
    const body = asBody(request.body)
    await extensions.setReserved(
      identityOf(response),
      idParam(request, 'materialId'),
      readQuantity(body.reservada, 'A quantidade reservada', { allowZero: true }),
      requiredText(body.justificativa, 'a justificativa', { min: 3, max: 2000 }),
    )
    response.json({ success: true })
  }),
)

router.get(
  '/warehouse/stock-movements',
  manageWarehouse,
  guarded(async (request, response) => {
    const query = asBody(request.query)
    response.json({
      success: true,
      ...(await extensions.movements({
        materialId: isUuid(query.materialId) ? query.materialId : undefined,
        page: readPage(query.page),
        withValues: seesValues(response),
      })),
    })
  }),
)

router.post(
  '/warehouse/stock-movements',
  manageWarehouse,
  guarded(async (request, response) => {
    const body = asBody(request.body)
    if (body.tipo !== 'entrada' && body.tipo !== 'saida') {
      throw new RequestValidationError('Selecione entrada ou saída.')
    }
    const movementFinance = readMovementFinance(body, body.tipo)
    if (movementFinance && !seesValues(response)) {
      response.status(403).json({ success: false, message: 'Você não tem permissão para registrar valores do Almoxarifado.' })
      return
    }
    await extensions.addMovement(identityOf(response), {
      materialId: requiredUuid(body.materialId, 'o material'),
      type: body.tipo,
      quantity: readQuantity(body.quantidade, 'A quantidade'),
      reason: requiredText(body.justificativa, 'a justificativa', { min: 3, max: 2000 }),
      finance: movementFinance ?? undefined,
    })
    response.status(201).json({ success: true })
  }),
)

// ---------------------------------------------------------------------------
// Valores do Almoxarifado (migração 020): Administrador e Operador SLM da equipe.
// ---------------------------------------------------------------------------
const warehouseFinance = all('warehouse:manage', 'warehouse:finance')

function seesValues(response: Response) {
  return holdsPermission(identityOf(response), 'warehouse:finance')
}

/** Reais com até duas casas; aceita vírgula. */
function money(value: unknown, label: string, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new RequestValidationError(`Informe ${label}.`)
    return null
  }
  const text = String(value).trim().replace(/\s/g, '')
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text
  const number = Number(normalized)
  if (!/^\d+(\.\d+)?$/.test(normalized) || !Number.isFinite(number) || number > 999_999_999_999) {
    throw new RequestValidationError(`${label} inválido.`)
  }
  return Math.round(number * 100) / 100
}

function optionalDay(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !isCalendarDay(value)) {
    throw new RequestValidationError(`${label} inválida.`)
  }
  return value
}

/** Campos de valor de uma entrada. Nulo quando nenhum foi enviado. Saída não recebe valor digitado. */
function readMovementFinance(body: Record<string, unknown>, type: unknown) {
  const finance = {
    paid: money(body.valorPago, 'O valor pago'),
    invoice: optionalText(body.notaFiscal, 'Nota fiscal', 60),
    commitment: optionalText(body.empenho, 'Empenho', 60),
    supplier: optionalText(body.fornecedor, 'Fornecedor', 200),
    agreementId: optionalUuid(body.ataId, 'a ata'),
    instrumentItemId: optionalUuid(body.itemAtaId, 'o item da ata ou do contrato'),
  }
  const any = Object.values(finance).some((value) => value !== null)
  if (!any) return null
  if (type !== 'entrada') throw new RequestValidationError('Valor, nota, empenho, fornecedor e ata são só para entradas.')
  return finance
}

/** Período do painel em dias de Brasília; padrão: os últimos 12 meses, contando o atual. */
function financePeriod(query: Record<string, unknown>) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  const [year, month] = today.split('-').map(Number)
  const firstMonth = new Date(Date.UTC(year, month - 12, 1)).toISOString().slice(0, 10)
  const from = optionalDay(query.from, 'Data inicial') ?? firstMonth
  const to = optionalDay(query.to, 'Data final') ?? today
  if (to < from) throw new RequestValidationError('O fim do período não pode ser anterior ao início.')
  const start = new Date(`${from}T00:00:00-03:00`)
  const end = new Date(new Date(`${to}T00:00:00-03:00`).getTime() + 86_400_000)
  if (end.getTime() - start.getTime() > 5 * 366 * 86_400_000) throw new RequestValidationError('O período é longo demais.')
  return { from: start, to: end }
}

function readAgreement(body: Record<string, unknown>) {
  const validFrom = optionalDay(body.vigenciaInicio, 'Início da vigência')
  const validUntil = optionalDay(body.vigenciaFim, 'Fim da vigência')
  if (validFrom && validUntil && validUntil < validFrom) {
    throw new RequestValidationError('O fim da vigência não pode ser anterior ao início.')
  }
  return {
    number: requiredText(body.numero, 'o número da ata', { min: 1, max: 60 }),
    supplier: optionalText(body.fornecedor, 'Fornecedor', 200),
    subject: optionalText(body.objeto, 'Objeto', 500),
    total: money(body.valorTotal, 'o valor da ata', { required: true })!,
    validFrom,
    validUntil,
    active: body.ativo === undefined ? true : body.ativo === true,
  }
}

router.get(
  '/warehouse/finance',
  ...warehouseFinance,
  guarded(async (request, response) => {
    response.json({ success: true, summary: await finance.summary(financePeriod(asBody(request.query))) })
  }),
)

router.get(
  '/warehouse/finance/instruments',
  ...warehouseFinance,
  guarded(async (_request, response) => {
    response.json({ success: true, instruments: await finance.materialInstruments() })
  }),
)

router.get(
  '/warehouse/finance/agreements',
  ...warehouseFinance,
  guarded(async (_request, response) => {
    response.json({ success: true, agreements: await finance.agreements() })
  }),
)

router.post(
  '/warehouse/finance/agreements',
  ...warehouseFinance,
  guarded(async (request, response) => {
    const id = await finance.saveAgreement(identityOf(response), null, readAgreement(asBody(request.body)))
    response.status(201).json({ success: true, id })
  }),
)

router.put(
  '/warehouse/finance/agreements/:agreementId',
  ...warehouseFinance,
  guarded(async (request, response) => {
    await finance.saveAgreement(identityOf(response), idParam(request, 'agreementId'), readAgreement(asBody(request.body)))
    response.json({ success: true })
  }),
)

router.put(
  '/warehouse/stock/:materialId/value',
  ...warehouseFinance,
  guarded(async (request, response) => {
    const body = asBody(request.body)
    await finance.setStockValue(
      identityOf(response),
      idParam(request, 'materialId'),
      money(body.valor, 'o valor do estoque', { required: true })!,
      requiredText(body.justificativa, 'a justificativa', { min: 3, max: 2000 }),
    )
    response.json({ success: true })
  }),
)

export default router
