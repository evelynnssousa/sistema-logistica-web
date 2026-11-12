import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'

/** Só para testes: lê o .xlsx gerado pelo próprio sistema e devolve o texto de cada arquivo interno. */
export function readXlsx(buffer: Buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end > 0, 'sem fim de diretório: não é um .xlsx')
  const total = buffer.readUInt16LE(end + 10)
  let cursor = buffer.readUInt32LE(end + 16)
  const files = new Map<string, string>()
  for (let index = 0; index < total; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50)
    const packedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const offset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    const localNameLength = buffer.readUInt16LE(offset + 26)
    const start = offset + 30 + localNameLength
    files.set(name, inflateRawSync(buffer.subarray(start, start + packedSize)).toString('utf8'))
    cursor += 46 + nameLength
  }
  return files
}

/** Nomes das abas, na ordem. */
export function sheetNamesOf(files: Map<string, string>) {
  return [...(files.get('xl/workbook.xml') ?? '').matchAll(/<sheet name="([^"]+)"/g)].map((match) =>
    match[1].replace(/&amp;/g, '&'),
  )
}

/** Todo o texto das abas, para conferir valores sem depender da posição das células. */
export function allSheetsText(files: Map<string, string>) {
  return [...files.entries()]
    .filter(([name]) => name.startsWith('xl/worksheets/'))
    .map(([, content]) => content)
    .join('\n')
}
