import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { detectKind } from '../attachments/fileValidation.js'
import { renderWorkbook } from './xlsxDocument.js'

/** Lê o próprio ZIP pelo diretório central, como um leitor de planilhas faria. */
function unzip(buffer: Buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end > 0, 'sem fim de diretório')
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

test('gera uma planilha xlsx reconhecida pela validação de arquivos do próprio sistema', () => {
  const file = renderWorkbook([{ name: 'Indicadores', rows: [['Total', 3]] }])
  assert.equal(detectKind(file), 'xlsx')
})

test('textos ficam como texto, números como número, e nada vira fórmula', () => {
  const files = unzip(
    renderWorkbook([
      { name: 'Dados', rows: [['Título', 'Qtd'], ['=1+1 <b>&"', 12], [null, 1.5]] },
    ]),
  )
  const sheet = files.get('xl/worksheets/sheet1.xml')!
  assert.ok(sheet.includes('<c r="A2" t="inlineStr"><is><t xml:space="preserve">=1+1 &lt;b&gt;&amp;&quot;</t></is></c>'))
  assert.ok(sheet.includes('<c r="B2"><v>12</v></c>'))
  assert.ok(sheet.includes('<c r="B3"><v>1.5</v></c>'))
  assert.ok(!sheet.includes('<f>'))
})

test('nomes de planilha são limpos, curtos e sem repetição', () => {
  const files = unzip(
    renderWorkbook([
      { name: 'Por setor / responsável [geral] com nome muito comprido', rows: [] },
      { name: 'Por setor / responsável [geral] com nome muito comprido', rows: [] },
    ]),
  )
  const names = [...files.get('xl/workbook.xml')!.matchAll(/<sheet name="([^"]+)"/g)].map((match) => match[1])
  assert.equal(names.length, 2)
  assert.notEqual(names[0], names[1])
  for (const name of names) {
    assert.ok(name.length <= 31)
    assert.ok(!/[:\\/?*[\]]/.test(name))
  }
})

test('o conteúdo declara uma entrada para cada planilha', () => {
  const files = unzip(renderWorkbook([{ name: 'A', rows: [] }, { name: 'B', rows: [] }]))
  assert.ok(files.has('xl/worksheets/sheet2.xml'))
  assert.ok(files.get('[Content_Types].xml')!.includes('/xl/worksheets/sheet2.xml'))
  assert.ok(files.get('xl/_rels/workbook.xml.rels')!.includes('worksheets/sheet2.xml'))
})
