import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { readSpreadsheet, SpreadsheetError } from './spreadsheetReader.js'
import { renderWorkbook } from './xlsxDocument.js'

/** ZIP mínimo, para montar planilhas como o Excel e o LibreOffice gravam. */
function zipOf(files: Record<string, string>, { stored = false } = {}) {
  const parts: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const [fileName, content] of Object.entries(files)) {
    const name = Buffer.from(fileName)
    const raw = Buffer.from(content)
    const packed = stored ? raw : deflateRawSync(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, packed)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(stored ? 0 : 8, 10)
    entry.writeUInt32LE(packed.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    directory.push(entry, name)
    offset += 30 + name.length + packed.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(directory.length / 2, 8)
  end.writeUInt16LE(directory.length / 2, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, central, end])
}

test('lê a planilha .xlsx gerada pelo próprio sistema', () => {
  const file = renderWorkbook([{ name: 'Estoque', rows: [['Código', 'Descrição', 'Qtd'], ['001', 'Caneta azul', 12], ['002', 'Lápis & borracha', 3.5]] }])
  assert.deepEqual(readSpreadsheet(file, 'estoque.xlsx'), [
    ['Código', 'Descrição', 'Qtd'],
    ['001', 'Caneta azul', '12'],
    ['002', 'Lápis & borracha', '3.5'],
  ])
})

test('xlsx do Excel: textos compartilhados, células puladas, linhas vazias e a primeira aba', () => {
  const file = zipOf({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Saldo" sheetId="1" r:id="rId7"/><sheet name="Outra" sheetId="2" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      '<sst><si><t>Item</t></si><si><r><t>Descri</t></r><r><t xml:space="preserve">ção</t></r></si><si><t>Papel A4 &amp; ofício</t><rPh><t>x</t></rPh></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>errada</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
      '<row r="3"><c r="A3"><v>123</v></c><c r="C3" t="s"><v>2</v></c><c r="D3" t="str"><f>A3*2</f><v>246</v></c></row>' +
      '</sheetData></worksheet>',
  })
  assert.deepEqual(readSpreadsheet(file, 'saldo.xlsx'), [
    ['Item', '', 'Descrição', ''],
    ['', '', '', ''],
    ['123', '', 'Papel A4 & ofício', '246'],
  ])
})

test('csv do Excel em português: ponto e vírgula, aspas e Windows-1252', () => {
  const text = 'Código;Descrição;Quantidade\r\n10;"Pasta ""AZ""; lombo largo";1.250\r\n11;Clipe nº 2;3,5\r\n'
  const file = Buffer.from(text, 'latin1')
  assert.deepEqual(readSpreadsheet(file, 'saldo.csv'), [
    ['Código', 'Descrição', 'Quantidade'],
    ['10', 'Pasta "AZ"; lombo largo', '1.250'],
    ['11', 'Clipe nº 2', '3,5'],
  ])
})

test('.xls que é uma página HTML, como exportam os sistemas do governo', () => {
  const html = '<html><body><table><tr><th>Código</th><th>Material</th><th>Saldo</th></tr>' +
    '<tr><td>7</td><td>Fita&nbsp;adesiva <b>larga</b></td><td>4</td></tr><tr><td colspan="2">Total</td><td>4</td></tr></table></body></html>'
  assert.deepEqual(readSpreadsheet(Buffer.from(html), 'relatorio.xls'), [
    ['Código', 'Material', 'Saldo'],
    ['7', 'Fita adesiva larga', '4'],
    ['Total', '', '4'],
  ])
})

test('ods do LibreOffice, com células e linhas repetidas', () => {
  const file = zipOf({
    'content.xml':
      '<office:document-content><office:body><office:spreadsheet><table:table table:name="A">' +
      '<table:table-row><table:table-cell><text:p>Código</text:p></table:table-cell><table:table-cell><text:p>Nome</text:p></table:table-cell></table:table-row>' +
      '<table:table-row><table:table-cell office:value="5"><text:p>5</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"><text:p>Cola</text:p></table:table-cell></table:table-row>' +
      '<table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>' +
      '</table:table></office:spreadsheet></office:body></office:document-content>',
  }, { stored: true })
  assert.deepEqual(readSpreadsheet(file, 'saldo.ods'), [
    ['Código', 'Nome', ''],
    ['5', 'Cola', 'Cola'],
  ])
})

test('recusa .xls antigo, arquivo vazio, corrompido e grande demais, com mensagem clara', () => {
  const oldXls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)])
  assert.throws(() => readSpreadsheet(oldXls, 'a.xls'), /formato antigo/)
  assert.throws(() => readSpreadsheet(Buffer.alloc(0), 'a.csv'), /vazio/)
  assert.throws(() => readSpreadsheet(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 'a.xlsx'), SpreadsheetError)
  assert.throws(() => readSpreadsheet(Buffer.alloc(6 * 1024 * 1024, 65), 'a.csv'), /5 MB/)
  assert.throws(() => readSpreadsheet(Buffer.from('%PDF-1.4'), 'a.pdf'), /Formato não reconhecido/)
})

test('arquivo compactado para estourar a memória é recusado', () => {
  const bomb = zipOf({ 'xl/workbook.xml': '<workbook/>', 'xl/worksheets/sheet1.xml': ' '.repeat(45 * 1024 * 1024) })
  assert.ok(bomb.length < 5 * 1024 * 1024)
  assert.throws(() => readSpreadsheet(bomb, 'a.xlsx'), /grande demais/)
})

test('planilha com linhas demais pede para dividir', () => {
  const text = Array.from({ length: 5002 }, (_, index) => `${index};Material ${index};1`).join('\n')
  assert.throws(() => readSpreadsheet(Buffer.from(text), 'a.csv'), /mais de 5000 linhas/)
})
