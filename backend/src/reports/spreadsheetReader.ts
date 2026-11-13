import { inflateRawSync } from 'node:zlib'

/**
 * Leitura de planilhas enviadas pela equipe (robô do Almoxarifado), sem dependência nova. Aceita:
 *   - .xlsx (Excel atual) e .ods (LibreOffice): ZIP com XML, lido pelo diretório central;
 *   - .csv com ";" ou "," (o Excel em português usa ";" e grava em Windows-1252);
 *   - .xls que na verdade é uma página HTML com tabela, formato comum nas exportações de sistemas
 *     do governo. O .xls binário antigo não é lido: a mensagem pede para salvar como .xlsx ou .csv.
 * Só a primeira aba é lida. Nada é executado: fórmulas valem pelo último resultado gravado no arquivo.
 * O arquivo é tratado como não confiável: tamanho, linhas, colunas e descompactação têm teto.
 */

export class SpreadsheetError extends Error {}

export const spreadsheetLimits = {
  maxFileBytes: 5 * 1024 * 1024,
  /** Teto de cada parte descompactada do ZIP, contra arquivo feito para estourar a memória. */
  maxEntryBytes: 40 * 1024 * 1024,
  maxRows: 5000,
  maxColumns: 60,
  maxCellLength: 500,
} as const

export type SpreadsheetRows = string[][]

const oldXlsSignature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

export function readSpreadsheet(content: Buffer, fileName: string): SpreadsheetRows {
  if (content.length === 0) throw new SpreadsheetError('O arquivo está vazio.')
  if (content.length > spreadsheetLimits.maxFileBytes) {
    throw new SpreadsheetError('A planilha passa de 5 MB. Envie só a aba ou o período necessário.')
  }
  const extension = (fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '').trim()
  let rows: SpreadsheetRows
  if (content.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const files = unzip(content)
    rows = files.has('content.xml') && !files.has('xl/workbook.xml') ? readOds(files) : readXlsx(files)
  } else if (content.subarray(0, 8).equals(oldXlsSignature)) {
    throw new SpreadsheetError(
      'Este .xls é do formato antigo do Excel. Abra no Excel ou no LibreOffice e salve como .xlsx ou .csv.',
    )
  } else {
    const text = decodeText(content)
    if (/<table[\s>]/i.test(text.slice(0, 200_000))) rows = readHtmlTable(text)
    else if (extension === 'csv' || extension === 'txt' || extension === 'xls' || extension === '') rows = readCsv(text)
    else throw new SpreadsheetError('Formato não reconhecido. Envie a planilha em .xlsx, .csv ou .ods.')
  }
  return tidy(rows)
}

/**
 * Tira linhas vazias do fim e colunas vazias à direita, e aplica os tetos. As linhas vazias do meio
 * ficam, para o número da linha na tela ser o mesmo do Excel.
 */
function tidy(rows: SpreadsheetRows): SpreadsheetRows {
  const cleaned = rows.map((row) =>
    row.slice(0, spreadsheetLimits.maxColumns).map((cell) =>
      cell.replace(/\s+/g, ' ').trim().slice(0, spreadsheetLimits.maxCellLength),
    ),
  )
  let lastFilled = cleaned.length - 1
  while (lastFilled >= 0 && !cleaned[lastFilled].some((cell) => cell !== '')) lastFilled -= 1
  const nonEmpty = cleaned.slice(0, lastFilled + 1)
  if (nonEmpty.length === 0) throw new SpreadsheetError('Não há dados na primeira aba da planilha.')
  if (nonEmpty.length > spreadsheetLimits.maxRows) {
    throw new SpreadsheetError(`A planilha tem mais de ${spreadsheetLimits.maxRows} linhas. Divida o arquivo e envie em partes.`)
  }
  const width = Math.max(...nonEmpty.map((row) => {
    let last = row.length
    while (last > 0 && row[last - 1] === '') last -= 1
    return last
  }))
  return nonEmpty.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ''))
}

function decodeText(content: Buffer) {
  const withoutBom = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf ? content.subarray(3) : content
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(withoutBom)
  } catch {
    // CSV salvo pelo Excel em português: Windows-1252.
    return new TextDecoder('windows-1252').decode(withoutBom)
  }
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------
function unzip(buffer: Buffer) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  const end = buffer.lastIndexOf(signature)
  if (end < 0 || end + 22 > buffer.length) throw new SpreadsheetError('A planilha está corrompida ou incompleta.')
  const total = buffer.readUInt16LE(end + 10)
  let cursor = buffer.readUInt32LE(end + 16)
  const files = new Map<string, Buffer>()
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new SpreadsheetError('A planilha está corrompida ou incompleta.')
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const packedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const offset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength
    // Só as partes que a leitura usa: o resto (imagens, macros) nem é descompactado.
    if (!/^(xl\/(workbook\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)|content\.xml)$/.test(name)) continue
    if (offset + 30 > buffer.length) throw new SpreadsheetError('A planilha está corrompida ou incompleta.')
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28)
    const packed = buffer.subarray(start, start + packedSize)
    if (method === 0) files.set(name, packed)
    else if (method === 8) {
      try {
        files.set(name, inflateRawSync(packed, { maxOutputLength: spreadsheetLimits.maxEntryBytes }))
      } catch {
        throw new SpreadsheetError('A planilha está corrompida ou é grande demais para ser lida.')
      }
    } else throw new SpreadsheetError('A planilha usa uma compactação não suportada. Salve de novo como .xlsx.')
  }
  return files
}

// ---------------------------------------------------------------------------
// XML (só o necessário para as planilhas)
// ---------------------------------------------------------------------------
function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower === 'amp') return '&'
    if (lower === 'lt') return '<'
    if (lower === 'gt') return '>'
    if (lower === 'quot') return '"'
    if (lower === 'apos') return "'"
    if (lower === 'nbsp') return ' '
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10)
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

function attribute(tag: string, name: string) {
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag) ?? new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`).exec(tag)
  return match ? decodeEntities(match[1]) : null
}

/** Texto de <t> dentro do trecho, juntando os pedaços de texto formatado. */
function joinedText(xml: string) {
  let text = ''
  for (const match of xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) text += match[1]
  return decodeEntities(text)
}

function columnIndex(reference: string) {
  const letters = /^[A-Z]+/i.exec(reference)?.[0].toUpperCase() ?? ''
  let index = 0
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

function readXlsx(files: Map<string, Buffer>): SpreadsheetRows {
  const workbook = files.get('xl/workbook.xml')?.toString('utf8')
  if (!workbook) throw new SpreadsheetError('Não foi possível ler a planilha. Salve de novo como .xlsx.')
  const firstSheet = /<(?:\w+:)?sheet\s[^>]*>/.exec(workbook)?.[0]
  const relationId = firstSheet ? attribute(firstSheet, 'r:id') : null
  const relations = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''
  let target: string | null = null
  for (const match of relations.matchAll(/<Relationship\s[^>]*>/g)) {
    if (attribute(match[0], 'Id') === relationId) target = attribute(match[0], 'Target')
  }
  const sheetPath = target
    ? target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
    : 'xl/worksheets/sheet1.xml'
  const sheet = files.get(sheetPath)?.toString('utf8') ?? files.get('xl/worksheets/sheet1.xml')?.toString('utf8')
  if (!sheet) throw new SpreadsheetError('Não foi possível encontrar a primeira aba da planilha.')

  const shared: string[] = []
  const sharedXml = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? ''
  for (const match of sharedXml.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)) {
    // Sem a pronúncia fonética (<rPh>), que algumas planilhas guardam junto do texto.
    shared.push(joinedText(match[1].replace(/<(?:\w+:)?rPh[\s\S]*?<\/(?:\w+:)?rPh>/g, '')))
  }

  const rows: SpreadsheetRows = []
  for (const rowMatch of sheet.matchAll(/<(?:\w+:)?row(\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const rowNumber = Number(attribute(`<row${rowMatch[1] ?? ''}>`, 'r') ?? rows.length + 1)
    if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > spreadsheetLimits.maxRows * 4) {
      throw new SpreadsheetError(`A planilha tem mais de ${spreadsheetLimits.maxRows} linhas. Divida o arquivo e envie em partes.`)
    }
    const row: string[] = []
    let next = 0
    for (const cell of (rowMatch[2] ?? '').matchAll(/<(?:\w+:)?c(\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const tag = `<c${cell[1] ?? ''}>`
      const reference = attribute(tag, 'r')
      const index = reference ? columnIndex(reference) : next
      next = index + 1
      if (index < 0 || index >= spreadsheetLimits.maxColumns) continue
      const type = attribute(tag, 't')
      const inner = cell[2] ?? ''
      const raw = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1]
      let value = ''
      if (type === 's') value = shared[Number(raw)] ?? ''
      else if (type === 'inlineStr') value = joinedText(inner)
      else if (type === 'b') value = raw === '1' ? 'VERDADEIRO' : 'FALSO'
      else if (type === 'e') value = ''
      else value = raw === undefined ? '' : decodeEntities(raw)
      row[index] = value
    }
    while (rows.length < rowNumber - 1) rows.push([])
    rows.push(Array.from({ length: row.length }, (_, index) => row[index] ?? ''))
  }
  return rows
}

function readOds(files: Map<string, Buffer>): SpreadsheetRows {
  const content = files.get('content.xml')!.toString('utf8')
  const table = /<table:table[\s>][\s\S]*?<\/table:table>/.exec(content)?.[0]
  if (!table) throw new SpreadsheetError('Não há dados na primeira aba da planilha.')
  const rows: SpreadsheetRows = []
  for (const rowMatch of table.matchAll(/<table:table-row(\s[^>]*)?(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
    const repeatRows = Math.min(Number(attribute(`<r${rowMatch[1] ?? ''}>`, 'table:number-rows-repeated') ?? 1), spreadsheetLimits.maxRows + 1)
    const row: string[] = []
    for (const cell of (rowMatch[2] ?? '').matchAll(/<table:(?:covered-)?table-cell(\s[^>]*)?(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
      const tag = `<c${cell[1] ?? ''}>`
      const repeat = Math.min(Number(attribute(tag, 'table:number-columns-repeated') ?? 1), spreadsheetLimits.maxColumns)
      const numeric = attribute(tag, 'office:value')
      const text = [...(cell[2] ?? '').matchAll(/<text:p(?:\s[^>]*)?>([\s\S]*?)<\/text:p>/g)]
        .map((paragraph) => decodeEntities(paragraph[1].replace(/<text:s(?:\s[^>]*)?\/>/g, ' ').replace(/<[^>]+>/g, '')))
        .join(' ')
      const value = numeric ?? text
      for (let index = 0; index < repeat && row.length < spreadsheetLimits.maxColumns; index += 1) row.push(value)
    }
    const filled = row.some((cell) => cell !== '')
    // Linhas vazias repetidas no fim da aba (comum no LibreOffice) não contam.
    for (let index = 0; index < (filled ? repeatRows : Math.min(repeatRows, 1)); index += 1) {
      rows.push([...row])
      if (rows.length > spreadsheetLimits.maxRows * 2) break
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// HTML e CSV
// ---------------------------------------------------------------------------
function readHtmlTable(html: string): SpreadsheetRows {
  const table = /<table[\s>][\s\S]*?<\/table>/i.exec(html)?.[0] ?? html
  const rows: SpreadsheetRows = []
  for (const rowMatch of table.matchAll(/<tr[\s>]([\s\S]*?)(?=<tr[\s>]|<\/table>|$)/gi)) {
    const row: string[] = []
    for (const cell of rowMatch[1].matchAll(/<t[dh](\s[^>]*)?>([\s\S]*?)(?=<t[dh][\s>]|<\/tr>|$)/gi)) {
      const text = decodeEntities(
        cell[2]
          .replace(/<\/t[dh]>[\s\S]*$/i, '')
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ''),
      )
      const span = Math.min(Math.max(1, Number(attribute(`<td${cell[1] ?? ''}>`, 'colspan') ?? 1) || 1), spreadsheetLimits.maxColumns)
      row.push(text)
      for (let index = 1; index < span; index += 1) row.push('')
    }
    rows.push(row)
    if (rows.length > spreadsheetLimits.maxRows * 2) break
  }
  return rows
}

function readCsv(text: string): SpreadsheetRows {
  const sample = text.slice(0, 5000).split(/\r?\n/).slice(0, 10)
  const count = (separator: string) => sample.reduce((total, line) => total + line.split(separator).length - 1, 0)
  const separator = [';', '\t', ','].sort((a, b) => count(b) - count(a))[0]
  const rows: SpreadsheetRows = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"' && cell === '') quoted = true
    else if (char === separator) {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      if (rows.length > spreadsheetLimits.maxRows * 2) break
    } else cell += char
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}
