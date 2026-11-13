import express, { Router } from 'express'
import type { Request, Response } from 'express'
import { holdsPermission } from '../auth/permissions.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { ModuleError, sendModuleError } from '../database/moduleErrors.js'
import { RobotRepository } from '../database/robotRepository.js'
import { getDatabasePool } from '../database/pool.js'
import { readSystemSettings } from '../database/settingsRepository.js'
import { emailMode } from '../integrations/config.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { readSpreadsheet, SpreadsheetError, spreadsheetLimits } from '../reports/spreadsheetReader.js'
import {
  guessColumns,
  matchLine,
  restockMonthOptions,
  sheetLines,
} from '../requests/robotRules.js'
import type { ColumnGuess, SheetKind } from '../requests/robotRules.js'
import { asBody, RequestValidationError } from '../requests/validation.js'

/**
 * Robô do Almoxarifado (sem inteligência artificial): leitura da planilha do sistema governamental,
 * sugestão de reposição e resumo semanal. Só quem administra o Almoxarifado. A sessão e o CSRF são
 * conferidos pelo roteador do Almoxarifado, registrado antes deste em routes/index.ts.
 */

const router = Router()
const robot = new RobotRepository()
const manage = requirePermission('warehouse:manage')

// A planilha chega como arquivo, fora do limite de 100 KB do JSON; o teto vem do leitor.
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

function sheetKind(content: Buffer, fileName: string): SheetKind {
  if (content.subarray(0, 2).toString('latin1') === 'PK') return /\.ods$/i.test(fileName) ? 'ods' : 'xlsx'
  return /<table[\s>]/i.test(content.subarray(0, 200_000).toString('latin1')) ? 'html' : 'csv'
}

/** Coluna escolhida na tela (número a partir de 0), "" para nenhuma; sem o parâmetro, vale o palpite. */
function column(value: unknown, guessed: number | null, width: number) {
  if (value === undefined) return guessed
  if (value === '' || value === 'none') return null
  const index = Number(value)
  if (!Number.isInteger(index) || index < 0 || index >= width) throw new RequestValidationError('Coluna inválida.')
  return index
}

/**
 * Lê a planilha e compara cada linha com o catálogo. Nada é gravado: a resposta vai para a tela, onde
 * a pessoa confere as correspondências e cria a conferência pela rota de sempre.
 */
router.post(
  '/warehouse/robot/sheet',
  manage,
  sheetBody,
  guarded(async (request, response) => {
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
    const guess = guessColumns(rows)
    const query = asBody(request.query)
    const headerRow = query.header === undefined ? guess.headerRow : Number(query.header)
    if (!Number.isInteger(headerRow) || headerRow < -1 || headerRow >= rows.length) {
      throw new RequestValidationError('Linha de cabeçalho inválida.')
    }
    const columns: ColumnGuess = {
      headerRow,
      code: column(query.code, guess.code, width),
      description: column(query.description, guess.description, width),
      quantity: column(query.quantity, guess.quantity, width),
      unit: column(query.unit, guess.unit, width),
    }
    const catalog = await robot.catalog()
    const lines =
      columns.description === null && columns.code === null
        ? []
        : sheetLines(rows, columns, kind).map((line) => ({ ...line, match: matchLine(line, catalog) }))
    response.json({
      success: true,
      fileName,
      kind,
      rowCount: rows.length,
      // As primeiras linhas, para a pessoa reconhecer o cabeçalho e as colunas.
      preview: rows.slice(0, 12),
      columns,
      guessed: guess,
      lines,
      catalog,
    })
  }),
)

router.get(
  '/warehouse/robot/restock',
  manage,
  guarded(async (request, response) => {
    const months = Number(asBody(request.query).months ?? 3)
    if (!(restockMonthOptions as readonly number[]).includes(months)) {
      throw new RequestValidationError('Escolha por quantos meses o estoque deve durar.')
    }
    const withValues = holdsPermission(identityOf(response), 'warehouse:finance')
    response.json({ success: true, months, withInstruments: withValues, suggestions: await robot.restock(months, withValues) })
  }),
)

router.get(
  '/warehouse/robot/weekly-summary',
  manage,
  guarded(async (_request, response) => {
    const settings = await readSystemSettings(getDatabasePool())
    response.json({
      success: true,
      enabled: settings.notifications.warehouseWeeklySummary,
      emailConfigured: emailMode() !== 'none',
      summary: await robot.weeklySummary(),
    })
  }),
)

// Rota sem uso fora do robô: erros de tamanho do arquivo chegam aqui com a mensagem do sistema.
router.use('/warehouse/robot', (error: unknown, _request: Request, response: Response, next: (error?: unknown) => void) => {
  if (error && typeof error === 'object' && (error as { type?: string }).type === 'entity.too.large') {
    sendModuleError(response, new ModuleError('A planilha passa de 5 MB. Envie só a aba ou o período necessário.', 413))
    return
  }
  next(error)
})

export default router
