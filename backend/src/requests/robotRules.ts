/**
 * Regras do robô do Almoxarifado, sem inteligência artificial: leitura das colunas da planilha do
 * sistema governamental, comparação com o catálogo e sugestão de reposição. Tudo aqui é cálculo
 * puro: o robô prepara, e a pessoa confere e confirma na tela antes de qualquer gravação.
 */

export type SheetKind = 'xlsx' | 'ods' | 'csv' | 'html'

/** Minúsculas, sem acento e sem pontuação: "Papel A4, 75g/m²" -> "papel a4 75g m2". */
export function normalizeText(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Código comparável: só letras e números, sem zeros à esquerda ("000.123-4" = "1234"). */
export function normalizeCode(value: string) {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return compact.replace(/^0+(?=.)/, '')
}

/**
 * Quantidade escrita na planilha. Nas planilhas digitadas (CSV, HTML), "1.234" é mil duzentos e
 * trinta e quatro; nas células numéricas do Excel e do LibreOffice, o ponto é sempre decimal.
 * Devolve null quando não há número ("—", "sem saldo", vazio).
 */
export function parseQuantity(value: string, kind: SheetKind): number | null {
  const cleaned = value.replace(/\s/g, '').replace(/[^0-9.,-]/g, '')
  if (!/\d/.test(cleaned)) return null
  const negative = cleaned.startsWith('-')
  let digits = cleaned.replace(/-/g, '')
  const lastComma = digits.lastIndexOf(',')
  const lastDot = digits.lastIndexOf('.')
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? ',' : '.'
    const thousands = decimal === ',' ? '.' : ','
    digits = digits.split(thousands).join('').replace(decimal, '.')
  } else if (lastComma >= 0) {
    digits = /^\d{1,3}(,\d{3}){2,}$/.test(digits) ? digits.split(',').join('') : digits.replace(',', '.')
  } else if (lastDot >= 0) {
    const human = kind === 'csv' || kind === 'html'
    if ((digits.match(/\./g) ?? []).length > 1 || (human && /^\d{1,3}\.\d{3}$/.test(digits))) {
      digits = digits.split('.').join('')
    }
  }
  if (!/^\d*\.?\d*$/.test(digits) || digits === '.' || (digits.match(/\./g) ?? []).length > 1) return null
  const number = Number(digits)
  if (!Number.isFinite(number)) return null
  return Math.round((negative ? -number : number) * 1000) / 1000
}

export type ColumnGuess = {
  headerRow: number
  code: number | null
  description: number | null
  quantity: number | null
  unit: number | null
}

const columnHints = {
  code: /\b(cod|codigo|item|catmat|siafisico|bec|patrimonio|ref|referencia)\b/,
  description: /\b(descricao|material|produto|nome|especificacao|discriminacao|item descricao)\b/,
  quantity: /\b(qtd|qtde|quant|quantidade|saldo|estoque|existente|disponivel)\b/,
  unit: /\b(un|und|unid|unidade|medida|embalagem|fornecimento)\b/,
} as const

/**
 * Procura, nas primeiras linhas, o cabeçalho com mais nomes conhecidos (código, descrição,
 * quantidade, unidade). É só um palpite: a tela mostra as colunas e a pessoa pode trocar.
 */
export function guessColumns(rows: readonly (readonly string[])[]): ColumnGuess {
  let best: ColumnGuess = { headerRow: 0, code: null, description: null, quantity: null, unit: null }
  let bestScore = 0
  rows.slice(0, 20).forEach((row, rowIndex) => {
    const guess: ColumnGuess = { headerRow: rowIndex, code: null, description: null, quantity: null, unit: null }
    const taken = new Set<number>()
    // A descrição primeiro: "Descrição do item" não deve virar a coluna de código.
    for (const key of ['description', 'quantity', 'unit', 'code'] as const) {
      const index = row.findIndex((cell, cellIndex) => !taken.has(cellIndex) && columnHints[key].test(normalizeText(cell)))
      if (index >= 0) {
        guess[key] = index
        taken.add(index)
      }
    }
    const score = (['code', 'description', 'quantity', 'unit'] as const).filter((key) => guess[key] !== null).length
    if (score > bestScore) {
      best = guess
      bestScore = score
    }
  })
  return best
}

export type SheetLine = { line: number; code: string; description: string; unit: string; quantity: number | null }

/** Linhas de dados, abaixo do cabeçalho, nas colunas escolhidas. Linhas sem código e sem descrição ficam de fora. */
export function sheetLines(
  rows: readonly (readonly string[])[],
  columns: Omit<ColumnGuess, 'headerRow'> & { headerRow: number },
  kind: SheetKind,
): SheetLine[] {
  const cell = (row: readonly string[], index: number | null) => (index === null ? '' : (row[index] ?? '').trim())
  const lines: SheetLine[] = []
  rows.forEach((row, index) => {
    if (index <= columns.headerRow) return
    const code = cell(row, columns.code)
    const description = cell(row, columns.description)
    if (!code && !description) return
    // Linhas de total ("Total geral", "Soma") não são materiais.
    if (!code && /^(sub)?total|^soma\b/.test(normalizeText(description))) return
    lines.push({
      line: index + 1,
      code,
      description,
      unit: cell(row, columns.unit),
      quantity: parseQuantity(cell(row, columns.quantity), kind),
    })
  })
  return lines
}

const stopWords = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'para', 'em', 'a', 'o', 'tipo', 'cor', 'un', 'und'])

function tokens(value: string) {
  return new Set(normalizeText(value).split(' ').filter((token) => token.length > 1 && !stopWords.has(token)))
}

/**
 * Semelhança entre dois nomes, de 0 a 1 (coeficiente de Dice das palavras). Palavras iguais no
 * começo valem mais: "Caneta azul" se parece mais com "Caneta esferográfica azul" do que com "Tinta azul".
 */
export function nameSimilarity(a: string, b: string) {
  const left = tokens(a)
  const right = tokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  const dice = (2 * shared) / (left.size + right.size)
  const firstLeft = [...left][0]
  const firstRight = [...right][0]
  const bonus = firstLeft === firstRight ? 0.1 : 0
  return Math.min(1, Math.round((dice + (shared > 0 ? bonus : 0)) * 1000) / 1000)
}

export type CatalogEntry = { id: string; code: string | null; name: string }

export type LineMatch = {
  /** code: mesmo código; name: mesmo nome; suggested: nome parecido, a confirmar; none: sem correspondência. */
  status: 'code' | 'name' | 'suggested' | 'none'
  materialId: string | null
  suggestions: { id: string; name: string; score: number }[]
}

export const suggestionThreshold = 0.45

export function matchLine(line: Pick<SheetLine, 'code' | 'description'>, catalog: readonly CatalogEntry[]): LineMatch {
  const code = line.code ? normalizeCode(line.code) : ''
  if (code) {
    const byCode = catalog.find((entry) => entry.code && normalizeCode(entry.code) === code)
    if (byCode) return { status: 'code', materialId: byCode.id, suggestions: [] }
  }
  const name = normalizeText(line.description)
  if (name) {
    const byName = catalog.filter((entry) => normalizeText(entry.name) === name)
    if (byName.length === 1) return { status: 'name', materialId: byName[0].id, suggestions: [] }
  }
  const suggestions = catalog
    .map((entry) => ({ id: entry.id, name: entry.name, score: nameSimilarity(line.description, entry.name) }))
    .filter((entry) => entry.score >= suggestionThreshold)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'pt-BR'))
    .slice(0, 3)
  return suggestions.length
    ? { status: 'suggested', materialId: suggestions[0].id, suggestions }
    : { status: 'none', materialId: null, suggestions: [] }
}

// ---------------------------------------------------------------------------
// Reposição
// ---------------------------------------------------------------------------
export type StockForRestock = {
  id: string
  code: string | null
  name: string
  unit: string
  location?: string | null
  current: number
  minimum: number
  reserved: number
  available: number
  monthlyConsumption: { average: number | null; months: number | null }
}

export type RestockSuggestion = {
  materialId: string
  code: string | null
  name: string
  unit: string
  location: string | null
  available: number
  minimum: number
  monthlyAverage: number | null
  /** Meses que o saldo disponível dura no consumo médio; null sem consumo registrado. */
  coverageMonths: number | null
  /** Saldo desejado: o consumo do período escolhido, nunca abaixo do mínimo. */
  target: number
  suggested: number
  reason: 'below_minimum' | 'short_coverage'
}

export const restockMonthOptions = [1, 2, 3, 4, 6, 12] as const

/**
 * Quanto comprar para o estoque disponível (físico menos reservado) durar o período escolhido.
 * Material sem consumo registrado só entra se estiver abaixo do mínimo. Arredonda para cima: não
 * se compra meia caixa. Os mais urgentes (menor cobertura) vêm primeiro.
 */
export function restockSuggestions(items: readonly StockForRestock[], months: number): RestockSuggestion[] {
  const result: RestockSuggestion[] = []
  for (const item of items) {
    const average = item.monthlyConsumption.average && item.monthlyConsumption.average > 0 ? item.monthlyConsumption.average : null
    const target = Math.max(item.minimum, average === null ? 0 : average * months)
    const missing = target - item.available
    if (missing <= 0) continue
    const belowMinimum = item.minimum > 0 && item.current < item.minimum
    if (average === null && !belowMinimum) continue
    result.push({
      materialId: item.id,
      code: item.code,
      name: item.name,
      unit: item.unit,
      location: item.location ?? null,
      available: item.available,
      minimum: item.minimum,
      monthlyAverage: average,
      coverageMonths: average === null ? null : Math.round((item.available / average) * 10) / 10,
      target: Math.ceil(target),
      suggested: Math.ceil(missing),
      reason: belowMinimum ? 'below_minimum' : 'short_coverage',
    })
  }
  return result.sort(
    (a, b) =>
      (a.coverageMonths ?? -1) - (b.coverageMonths ?? -1) ||
      a.name.localeCompare(b.name, 'pt-BR'),
  )
}

export type InstrumentItemForRestock = {
  instrumentId: string
  number: string
  type: string
  validUntil: string | null
  expired: boolean
  itemId: string
  description: string
  unit: string
  balance: number
}

/** Itens de atas e contratos vigentes, com saldo, cujo nome lembra o material. Só uma indicação. */
export function instrumentHints(materialName: string, items: readonly InstrumentItemForRestock[]) {
  return items
    .filter((item) => !item.expired && item.balance > 0)
    .map((item) => ({ ...item, score: nameSimilarity(materialName, item.description) }))
    .filter((item) => item.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
}

/** Semana ISO (AAAA-Www) no horário de Brasília: chave do resumo semanal, que sai uma vez por semana. */
export function brasiliaWeek(now: Date = new Date()) {
  const local = new Date(now.getTime() - 3 * 3_600_000)
  const day = local.getUTCDay() || 7
  const thursday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 4 - day))
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return { key: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`, weekday: day, hour: local.getUTCHours() }
}

// ---------------------------------------------------------------------------
// Unidade de medida escrita na planilha
// ---------------------------------------------------------------------------
/** Abreviações comuns nas planilhas do governo, para o nome usado no cadastro de unidades. */
const unitAbbreviations: Record<string, string[]> = {
  unidade: ['un', 'und', 'unid', 'unidade', 'unidades', 'u', 'pc', 'pca', 'peca', 'pecas'],
  caixa: ['cx', 'caixa', 'caixas'],
  pacote: ['pct', 'pc te', 'pac', 'pacote', 'pacotes'],
  resma: ['rm', 'resma', 'resmas'],
  quilograma: ['kg', 'quilo', 'quilos', 'quilograma'],
  grama: ['g', 'gr', 'grama', 'gramas'],
  litro: ['l', 'lt', 'litro', 'litros'],
  mililitro: ['ml', 'mililitro'],
  metro: ['m', 'mt', 'metro', 'metros'],
  rolo: ['rl', 'rolo', 'rolos'],
  par: ['par', 'pares', 'pr'],
  frasco: ['fr', 'frasco', 'frascos'],
  galao: ['gl', 'galao', 'galoes'],
  tubo: ['tb', 'tubo', 'tubos'],
  bloco: ['bl', 'bloco', 'blocos'],
  conjunto: ['cj', 'conj', 'conjunto', 'kit', 'jogo', 'jg'],
  duzia: ['dz', 'duzia'],
  cartela: ['ct', 'cartela'],
  envelope: ['env', 'envelope'],
  saco: ['sc', 'saco', 'sacos'],
}

/**
 * Unidade do cadastro que corresponde ao texto da planilha ("UN", "Cx.", "Pacote com 100"), ou null.
 * Compara pelo nome igual, pela primeira palavra e pelas abreviações comuns.
 */
export function matchUnit(text: string, units: readonly { id: string; name: string }[]) {
  const value = normalizeText(text)
  if (!value) return null
  const byName = units.find((unit) => normalizeText(unit.name) === value)
  if (byName) return byName.id
  const first = value.split(' ')[0]
  for (const [canonical, aliases] of Object.entries(unitAbbreviations)) {
    if (!aliases.includes(value) && !aliases.includes(first)) continue
    const unit = units.find((option) => {
      const name = normalizeText(option.name)
      return name === canonical || name.startsWith(`${canonical} `) || aliases.includes(name)
    })
    if (unit) return unit.id
  }
  const byFirstWord = units.find((unit) => normalizeText(unit.name).split(' ')[0] === first)
  return byFirstWord?.id ?? null
}

/** Nome do material a cadastrar: a descrição da planilha, limpa e dentro do limite do cadastro. */
export function materialNameFrom(description: string) {
  return description.replace(/\s+/g, ' ').trim().slice(0, 160)
}
