import { normalizeText, parseQuantity } from './robotRules.js'
import type { SheetKind } from './robotRules.js'
import { asBody, optionalText, optionalUuid, requiredText, RequestValidationError } from './validation.js'

/**
 * Regras do Patrimônio (023): cadastro dos bens, leitura do código de barras, importação da planilha
 * pelo robô (sem inteligência artificial) e conferência por setor ou sala. Cálculo puro.
 */

export const assetSituations = ['em_uso', 'ocioso', 'em_manutencao', 'inservivel', 'baixado'] as const
export type AssetSituation = (typeof assetSituations)[number]

export const situationLabels: Record<AssetSituation, string> = {
  em_uso: 'Em uso',
  ocioso: 'Ocioso',
  em_manutencao: 'Em manutenção',
  inservivel: 'Inservível',
  baixado: 'Baixado',
}

export function isAssetSituation(value: unknown): value is AssetSituation {
  return typeof value === 'string' && (assetSituations as readonly string[]).includes(value)
}

/** Igual ao índice único do banco: só letras e números, em maiúsculas. Zeros à esquerda contam. */
export function normalizeAssetNumber(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * O leitor de código de barras "digita" o número e um Enter. Alguns acrescentam prefixo ou espaços;
 * o que sobra precisa ter ao menos um dígito ou letra.
 */
export function readAssetNumber(value: unknown, label = 'o número do patrimônio') {
  const text = requiredText(value, label, { min: 1, max: 60 })
  if (!normalizeAssetNumber(text)) throw new RequestValidationError(`Informe ${label}.`)
  return text
}

/** Data AAAA-MM-DD que existe no calendário. */
export function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function optionalDate(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !isCalendarDate(value)) throw new RequestValidationError(`${label}: data inválida.`)
  return value
}

/** Reais com até duas casas; aceita "1.234,56". */
export function readMoney(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null
  const parsed = typeof value === 'number' ? value : parseQuantity(String(value), 'csv')
  if (parsed === null || !Number.isFinite(parsed) || parsed < 0 || parsed > 999_999_999_999) {
    throw new RequestValidationError(`${label}: valor inválido.`)
  }
  return Math.round(parsed * 100) / 100
}

export type AssetInput = {
  number: string
  description: string
  sectorId: string | null
  room: string | null
  situation: AssetSituation
  brand: string | null
  model: string | null
  serialNumber: string | null
  registeredOn: string | null
  acquisitionValue: number | null
  invoice: string | null
  supplier: string | null
  note: string | null
}

export function readAssetInput(raw: unknown): AssetInput {
  const body = asBody(raw)
  const situation = body.situation === undefined || body.situation === '' ? 'em_uso' : body.situation
  if (!isAssetSituation(situation)) throw new RequestValidationError('Selecione a situação do bem.')
  const registeredOn = optionalDate(body.registeredOn, 'Data em que foi patrimoniado')
  if (registeredOn && registeredOn > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) {
    throw new RequestValidationError('A data em que foi patrimoniado não pode ser futura.')
  }
  return {
    number: readAssetNumber(body.number),
    description: requiredText(body.description, 'a descrição do bem', { min: 2, max: 500 }),
    sectorId: optionalUuid(body.sectorId, 'Setor'),
    room: optionalText(body.room, 'Sala', 120),
    situation,
    brand: optionalText(body.brand, 'Marca', 120),
    model: optionalText(body.model, 'Modelo', 120),
    serialNumber: optionalText(body.serialNumber, 'Número de série', 120),
    registeredOn,
    acquisitionValue: readMoney(body.acquisitionValue, 'Valor de aquisição'),
    invoice: optionalText(body.invoice, 'Nota fiscal', 60),
    supplier: optionalText(body.supplier, 'Fornecedor', 200),
    note: optionalText(body.note, 'Observação', 2000),
  }
}

// ---------------------------------------------------------------------------
// Conferência
// ---------------------------------------------------------------------------
export type CheckReadResult = 'no_local' | 'outro_local' | 'nao_cadastrado' | 'baixado'

export const readResultLabels: Record<CheckReadResult, string> = {
  no_local: 'No local certo',
  outro_local: 'Registrado em outro local',
  nao_cadastrado: 'Não cadastrado',
  baixado: 'Bem baixado',
}

const sameRoom = (a: string | null, b: string | null) => normalizeText(a ?? '') === normalizeText(b ?? '')

/**
 * Resultado de uma leitura. A conferência pode ser de um setor (qualquer sala) ou de uma sala do
 * setor; sem setor, é geral e só confere se o bem existe e não foi baixado.
 */
export function classifyRead(
  asset: { sectorId: string | null; room: string | null; situation: string } | null,
  check: { sectorId: string | null; room: string | null },
): CheckReadResult {
  if (!asset) return 'nao_cadastrado'
  if (asset.situation === 'baixado') return 'baixado'
  if (check.sectorId && asset.sectorId !== check.sectorId) return 'outro_local'
  if (check.room && !sameRoom(asset.room, check.room)) return 'outro_local'
  return 'no_local'
}

// ---------------------------------------------------------------------------
// Importação da planilha
// ---------------------------------------------------------------------------
export const assetColumnKeys = [
  'number', 'description', 'sector', 'room', 'registeredOn', 'situation',
  'brand', 'model', 'serialNumber', 'acquisitionValue', 'invoice', 'supplier',
] as const
export type AssetColumnKey = (typeof assetColumnKeys)[number]
export type AssetColumns = { headerRow: number } & Record<AssetColumnKey, number | null>

const assetHints: Record<AssetColumnKey, RegExp> = {
  registeredOn: /\b(data|dt)\b/,
  number: /\b(patrimonio|tombamento|tombo|plaqueta|chapa|n patrimonio|numero|codigo|cod|rgp|etiqueta)\b/,
  description: /\b(descricao|bem|material|especificacao|denominacao|item)\b/,
  sector: /\b(setor|unidade|lotacao|departamento|area|orgao)\b/,
  room: /\b(sala|local|localizacao|ambiente|andar)\b/,
  situation: /\b(situacao|estado|status|conservacao)\b/,
  brand: /\b(marca|fabricante)\b/,
  model: /\b(modelo)\b/,
  serialNumber: /\b(serie|serial|n serie)\b/,
  acquisitionValue: /\b(valor|preco|custo)\b/,
  invoice: /\b(nota|nf|nfe|nota fiscal)\b/,
  supplier: /\b(fornecedor|empresa|razao social)\b/,
}

/** Ordem de escolha: "Data de tombamento" é a data, não o número. */
const assignmentOrder: readonly AssetColumnKey[] = [
  'registeredOn', 'serialNumber', 'invoice', 'acquisitionValue', 'supplier', 'brand', 'model',
  'situation', 'room', 'sector', 'number', 'description',
]

export function guessAssetColumns(rows: readonly (readonly string[])[]): AssetColumns {
  const empty = () => Object.fromEntries(assetColumnKeys.map((key) => [key, null])) as Record<AssetColumnKey, number | null>
  let best: AssetColumns = { headerRow: 0, ...empty() }
  let bestScore = 0
  rows.slice(0, 20).forEach((row, rowIndex) => {
    const guess: AssetColumns = { headerRow: rowIndex, ...empty() }
    const taken = new Set<number>()
    for (const key of assignmentOrder) {
      const index = row.findIndex((cell, cellIndex) => !taken.has(cellIndex) && assetHints[key].test(normalizeText(cell)))
      if (index >= 0) {
        guess[key] = index
        taken.add(index)
      }
    }
    const score = assetColumnKeys.filter((key) => guess[key] !== null).length + (guess.number !== null ? 2 : 0)
    if (score > bestScore) {
      best = guess
      bestScore = score
    }
  })
  return best
}

/** Data da planilha: DD/MM/AAAA, DD/MM/AA, AAAA-MM-DD ou número de série de data do Excel. */
export function parseSheetDate(value: string, kind: SheetKind): string | null {
  const text = value.trim()
  if (!text) return null
  let match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s.*)?$/.exec(text)
  if (match) {
    const year = match[3].length === 2 ? (Number(match[3]) > 50 ? 1900 : 2000) + Number(match[3]) : Number(match[3])
    const date = `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`
    return isCalendarDate(date) ? date : null
  }
  match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (match) return isCalendarDate(match[0]) ? match[0] : null
  // Excel guarda a data como número de dias desde 30/12/1899.
  if ((kind === 'xlsx' || kind === 'ods') && /^\d{4,5}(\.\d+)?$/.test(text)) {
    const serial = Math.floor(Number(text))
    if (serial < 1 || serial > 80000) return null
    return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10)
  }
  return null
}

/** Situação escrita na planilha ("Bom", "Em uso", "Inservível"...). Sem correspondência, vale "Em uso". */
export function parseSituation(value: string): AssetSituation | null {
  const text = normalizeText(value)
  if (!text) return null
  if (/baix/.test(text)) return 'baixado'
  if (/inserv|sucata|irrecuper|antieconom/.test(text)) return 'inservivel'
  if (/manut|conserto|reparo/.test(text)) return 'em_manutencao'
  if (/ocios|deposito|sem uso|disponivel/.test(text)) return 'ocioso'
  return 'em_uso'
}

export type SectorEntry = { id: string; name: string; acronym: string | null }

/** Setor pelo nome ou pela sigla, sem acento nem caixa. */
export function matchSector(value: string, sectors: readonly SectorEntry[]) {
  const text = normalizeText(value)
  if (!text) return null
  return (
    sectors.find((sector) => normalizeText(sector.name) === text) ??
    sectors.find((sector) => sector.acronym && normalizeText(sector.acronym) === text) ??
    null
  )
}

export type ImportLine = {
  line: number
  number: string
  description: string
  sectorText: string
  sectorId: string | null
  room: string | null
  registeredOn: string | null
  situation: AssetSituation
  brand: string | null
  model: string | null
  serialNumber: string | null
  acquisitionValue: number | null
  invoice: string | null
  supplier: string | null
  /** Problemas que impedem a linha; avisos (setor não encontrado, data ilegível) não impedem. */
  problems: string[]
  warnings: string[]
}

const clip = (value: string, max: number) => (value.trim() ? value.trim().slice(0, max) : null)

export function importLines(
  rows: readonly (readonly string[])[],
  columns: AssetColumns,
  kind: SheetKind,
  sectors: readonly SectorEntry[],
): ImportLine[] {
  const cell = (row: readonly string[], key: AssetColumnKey) => {
    const index = columns[key]
    return index === null ? '' : (row[index] ?? '').trim()
  }
  const seen = new Map<string, number>()
  const lines: ImportLine[] = []
  rows.forEach((row, index) => {
    if (index <= columns.headerRow) return
    if (!row.some((value) => value.trim() !== '')) return
    const number = cell(row, 'number')
    const description = cell(row, 'description')
    const problems: string[] = []
    const warnings: string[] = []
    const normalized = normalizeAssetNumber(number)
    if (!normalized) problems.push('Sem número de patrimônio')
    else if (number.length > 60) problems.push('Número com mais de 60 caracteres')
    else if (seen.has(normalized)) problems.push(`Número repetido na linha ${seen.get(normalized)}`)
    else seen.set(normalized, index + 1)
    if (description.length < 2) problems.push('Sem descrição')

    const sectorText = cell(row, 'sector')
    const sector = matchSector(sectorText, sectors)
    if (sectorText && !sector) warnings.push(`Setor "${sectorText}" não cadastrado: o bem fica sem setor`)
    const dateText = cell(row, 'registeredOn')
    const registeredOn = parseSheetDate(dateText, kind)
    if (dateText && !registeredOn) warnings.push(`Data "${dateText}" não reconhecida`)
    const valueText = cell(row, 'acquisitionValue')
    let acquisitionValue: number | null = null
    if (valueText) {
      const parsed = parseQuantity(valueText, kind)
      if (parsed === null || parsed < 0) warnings.push(`Valor "${valueText}" não reconhecido`)
      else acquisitionValue = Math.round(parsed * 100) / 100
    }
    lines.push({
      line: index + 1,
      number: number.slice(0, 60),
      description: description.slice(0, 500),
      sectorText,
      sectorId: sector?.id ?? null,
      room: clip(cell(row, 'room'), 120),
      registeredOn,
      situation: parseSituation(cell(row, 'situation')) ?? 'em_uso',
      brand: clip(cell(row, 'brand'), 120),
      model: clip(cell(row, 'model'), 120),
      serialNumber: clip(cell(row, 'serialNumber'), 120),
      acquisitionValue,
      invoice: clip(cell(row, 'invoice'), 60),
      supplier: clip(cell(row, 'supplier'), 200),
      problems,
      warnings,
    })
  })
  return lines
}
