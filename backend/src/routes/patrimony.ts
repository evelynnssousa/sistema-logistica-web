import express, { Router } from 'express'
import type { Request, Response } from 'express'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { ModuleError, notFound, sendModuleError } from '../database/moduleErrors.js'
import { PatrimonyRepository } from '../database/patrimonyRepository.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { readSpreadsheet, SpreadsheetError, spreadsheetLimits } from '../reports/spreadsheetReader.js'
import {
  assetColumnKeys,
  guessAssetColumns,
  importLines,
  isAssetSituation,
  normalizeAssetNumber,
  readAssetInput,
  readAssetNumber,
  readResultLabels,
} from '../requests/patrimonyRules.js'
import type { AssetColumns } from '../requests/patrimonyRules.js'
import type { SheetKind } from '../requests/robotRules.js'
import {
  asBody,
  isUuid,
  optionalText,
  optionalUuid,
  readPage,
  readSearch,
  requiredText,
  RequestValidationError,
} from '../requests/validation.js'

/**
 * Patrimônio (023): bens do órgão, leitura do código de barras, importação pela planilha (robô, sem
 * inteligência artificial) e conferências. Só quem tem patrimony:manage: Administrador e Operador
 * SLM da equipe SLM. O leitor de código de barras funciona como um teclado: "digita" o número e um Enter.
 */

const router = Router()
const patrimony = new PatrimonyRepository()

router.use('/patrimony', requireAuth, requireCsrf, requirePermission('patrimony:manage'))

const sheetBody = express.raw({ type: () => true, limit: spreadsheetLimits.maxFileBytes + 1024 })

type Handler = (request: Request, response: Response) => Promise<void>

function guarded(handler: Handler): Handler {
  return async (request, response) => {
    try {
      await handler(request, response)
    } catch (error) {
      if (error instanceof SpreadsheetError) {
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

function idParam(request: Request, name: string) {
  const value = String(request.params[name])
  if (!isUuid(value)) throw notFound()
  return value
}

router.get(
  '/patrimony/options',
  guarded(async (_request, response) => {
    const ready = await patrimony.schemaReady()
    response.json({
      success: true,
      ready,
      sectors: await patrimony.sectors(),
      rooms: ready ? await patrimony.rooms() : [],
    })
  }),
)

router.get(
  '/patrimony/assets',
  guarded(async (request, response) => {
    await patrimony.requireSchema()
    const query = asBody(request.query)
    const situation = query.situation === undefined || query.situation === '' ? null : query.situation
    if (situation !== null && !isAssetSituation(situation)) throw new RequestValidationError('Situação inválida.')
    response.json({
      success: true,
      ...(await patrimony.list({
        search: readSearch(query.search),
        sectorId: optionalUuid(query.sectorId, 'Setor'),
        room: optionalText(query.room, 'Sala', 120),
        situation,
        page: readPage(query.page),
      })),
    })
  }),
)

router.post(
  '/patrimony/assets',
  guarded(async (request, response) => {
    const id = await patrimony.create(identityOf(response), readAssetInput(request.body))
    response.status(201).json({ success: true, id })
  }),
)

/** Consulta pelo número lido: diz se já foi patrimoniado, onde está e quando foi patrimoniado. */
router.get(
  '/patrimony/lookup',
  guarded(async (request, response) => {
    await patrimony.requireSchema()
    const number = readAssetNumber(asBody(request.query).number)
    response.json({ success: true, number, asset: await patrimony.findByNumber(number) })
  }),
)

router.get(
  '/patrimony/assets/:assetId',
  guarded(async (request, response) => {
    await patrimony.requireSchema()
    const id = idParam(request, 'assetId')
    const asset = await patrimony.find(id)
    if (!asset) throw notFound()
    response.json({ success: true, asset, history: await patrimony.history(id) })
  }),
)

router.put(
  '/patrimony/assets/:assetId',
  guarded(async (request, response) => {
    const body = asBody(request.body)
    await patrimony.update(identityOf(response), idParam(request, 'assetId'), readAssetInput(body), optionalText(body.justification, 'Observação da alteração', 2000))
    response.json({ success: true })
  }),
)

router.put(
  '/patrimony/assets/:assetId/location',
  guarded(async (request, response) => {
    const body = asBody(request.body)
    await patrimony.move(
      identityOf(response),
      idParam(request, 'assetId'),
      { sectorId: optionalUuid(body.sectorId, 'Setor'), room: optionalText(body.room, 'Sala', 120) },
      optionalText(body.note, 'Observação', 2000),
    )
    response.json({ success: true })
  }),
)

// ---------------------------------------------------------------------------
// Importação pela planilha (robô)
// ---------------------------------------------------------------------------
function sheetKind(content: Buffer, fileName: string): SheetKind {
  if (content.subarray(0, 2).toString('latin1') === 'PK') return /\.ods$/i.test(fileName) ? 'ods' : 'xlsx'
  return /<table[\s>]/i.test(content.subarray(0, 200_000).toString('latin1')) ? 'html' : 'csv'
}

/**
 * Sem confirm, só mostra a prévia: o que é novo, o que já existe (e onde está) e o que tem problema.
 * Com confirm=1, cadastra as linhas novas e sem problema; as que já existem não mudam.
 */
router.post(
  '/patrimony/import',
  sheetBody,
  guarded(async (request, response) => {
    await patrimony.requireSchema()
    const content = request.body
    if (!Buffer.isBuffer(content) || content.length === 0) throw new RequestValidationError('Envie a planilha.')
    let fileName: string
    try {
      fileName = decodeURIComponent(String(request.get('x-file-name') ?? '')).slice(0, 200)
    } catch {
      throw new RequestValidationError('Informe um nome de arquivo válido.')
    }
    const rows = readSpreadsheet(content, fileName)
    const kind = sheetKind(content, fileName)
    const width = rows[0]?.length ?? 0
    const guessed = guessAssetColumns(rows)
    const query = asBody(request.query)
    const headerRow = query.header === undefined ? guessed.headerRow : Number(query.header)
    if (!Number.isInteger(headerRow) || headerRow < -1 || headerRow >= rows.length) throw new RequestValidationError('Linha de cabeçalho inválida.')
    const columns = { headerRow } as AssetColumns
    for (const key of assetColumnKeys) {
      const value = query[key]
      if (value === undefined) columns[key] = guessed[key]
      else if (value === '' || value === 'none') columns[key] = null
      else {
        const index = Number(value)
        if (!Number.isInteger(index) || index < 0 || index >= width) throw new RequestValidationError('Coluna inválida.')
        columns[key] = index
      }
    }
    const sectors = await patrimony.sectors()
    const lines = columns.number === null ? [] : importLines(rows, columns, kind, sectors)

    if (query.confirm === '1') {
      if (lines.length === 0) throw new RequestValidationError('Nenhuma linha para importar. Confira a coluna do número de patrimônio.')
      const result = await patrimony.importLines(identityOf(response), lines, fileName)
      response.status(201).json({ success: true, ...result })
      return
    }

    const existing = await patrimony.existingByNumbers(lines.map((line) => line.number))
    response.json({
      success: true,
      fileName,
      kind,
      rowCount: rows.length,
      preview: rows.slice(0, 12),
      columns,
      guessed,
      lines: lines.map((line) => {
        const found = existing.get(normalizeAssetNumber(line.number)) ?? null
        return {
          ...line,
          existing: found
            ? { id: found.id, description: found.description, sector: found.sector, room: found.room, registeredOn: found.registeredOn, situation: found.situationLabel }
            : null,
          // Já cadastrado, mas a planilha diz outro setor ou sala.
          locationDiffers: Boolean(
            found && ((line.sectorId ?? null) !== found.sectorId || (line.room ?? '').toLowerCase() !== (found.room ?? '').toLowerCase()),
          ),
        }
      }),
    })
  }),
)

// ---------------------------------------------------------------------------
// Conferências
// ---------------------------------------------------------------------------
router.get(
  '/patrimony/checks',
  guarded(async (request, response) => {
    await patrimony.requireSchema()
    response.json({ success: true, checks: await patrimony.listChecks(readPage(asBody(request.query).page)) })
  }),
)

router.post(
  '/patrimony/checks',
  guarded(async (request, response) => {
    const body = asBody(request.body)
    const id = await patrimony.createCheck(identityOf(response), {
      title: requiredText(body.title, 'o título', { min: 3, max: 160 }),
      sectorId: optionalUuid(body.sectorId, 'Setor'),
      room: optionalText(body.room, 'Sala', 120),
    })
    response.status(201).json({ success: true, id })
  }),
)

router.get(
  '/patrimony/checks/:checkId',
  guarded(async (request, response) => {
    await patrimony.requireSchema()
    const check = await patrimony.findCheck(idParam(request, 'checkId'))
    if (!check) throw notFound()
    response.json({ success: true, check })
  }),
)

router.post(
  '/patrimony/checks/:checkId/reads',
  guarded(async (request, response) => {
    const number = readAssetNumber(asBody(request.body).number)
    const outcome = await patrimony.read(identityOf(response), idParam(request, 'checkId'), number)
    response.status(outcome.repeated ? 200 : 201).json({ success: true, number, label: readResultLabels[outcome.result], ...outcome })
  }),
)

router.post(
  '/patrimony/checks/:checkId/close',
  guarded(async (request, response) => {
    const body = asBody(request.body)
    if (body.outcome !== 'concluida' && body.outcome !== 'cancelada') throw new RequestValidationError('Selecione como encerrar a conferência.')
    await patrimony.closeCheck(identityOf(response), idParam(request, 'checkId'), body.outcome, optionalText(body.comment, 'Comentário', 2000))
    response.json({ success: true })
  }),
)

router.use('/patrimony', (error: unknown, _request: Request, response: Response, next: (error?: unknown) => void) => {
  if (error && typeof error === 'object' && (error as { type?: string }).type === 'entity.too.large') {
    sendModuleError(response, new ModuleError('A planilha passa de 5 MB. Envie só a aba ou o período necessário.', 413))
    return
  }
  next(error)
})

export default router
