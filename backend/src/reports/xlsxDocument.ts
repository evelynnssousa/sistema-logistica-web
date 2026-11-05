import { deflateRawSync } from 'node:zlib'

/**
 * Planilha .xlsx real, sem dependência nova: um arquivo ZIP com o XML mínimo do formato. Os textos
 * vão como texto, nunca como fórmula, e as células numéricas continuam somáveis no Excel.
 */

export type Cell = string | number | null
export type Sheet = { name: string; rows: readonly (readonly Cell[])[] }

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(buffer: Buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function zip(files: readonly { name: string; content: string }[]) {
  const parts: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const raw = Buffer.from(file.content, 'utf8')
    const packed = deflateRawSync(raw)
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, packed)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(packed.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    directory.push(entry, name)

    offset += local.length + name.length + packed.length
  }

  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, central, end])
}

function escapeXml(text: string) {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function columnName(index: number) {
  let name = ''
  for (let value = index; value >= 0; value = Math.floor(value / 26) - 1) {
    name = String.fromCharCode(65 + (value % 26)) + name
  }
  return name
}

function sheetXml(sheet: Sheet) {
  const rows = sheet.rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, cellIndex) => {
          if (cell === null || cell === '') return ''
          const reference = `${columnName(cellIndex)}${rowIndex + 1}`
          return typeof cell === 'number' && Number.isFinite(cell)
            ? `<c r="${reference}"><v>${cell}</v></c>`
            : `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(cell))}</t></is></c>`
        })
        .join('')
      return `<row r="${rowIndex + 1}">${cells}</row>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
}

/** Nomes de planilha: até 31 caracteres, sem : \ / ? * [ ], e sem repetir. */
function sheetNames(sheets: readonly Sheet[]) {
  const used = new Set<string>()
  return sheets.map((sheet, index) => {
    const clean = sheet.name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || `Planilha ${index + 1}`
    const name = used.has(clean.toLowerCase()) ? `${clean.slice(0, 27)} ${index + 1}` : clean
    used.add(name.toLowerCase())
    return name
  })
}

export function renderWorkbook(sheets: readonly Sheet[]): Buffer {
  const names = sheetNames(sheets)
  return zip([
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
        .map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('')}</Types>`,
    },
    {
      name: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
        .map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
        .join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
        .join('')}</Relationships>`,
    },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content: sheetXml(sheet) })),
  ])
}
