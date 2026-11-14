import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderWorkbook } from '../reports/xlsxDocument.js'
import { readSpreadsheet } from '../reports/spreadsheetReader.js'
import { instrumentTemplate, parseDate, parseInstrumentSheet, parseNumber } from './instrumentSpreadsheet.js'

test('números e datas nos formatos comuns', () => {
  assert.equal(parseNumber('1.234,56'), 1234.56)
  assert.equal(parseNumber('R$ 12,50'), 12.5)
  assert.equal(parseNumber('1234.5'), 1234.5)
  assert.equal(parseNumber('1.350'), 1350)
  assert.equal(parseNumber('1,234.56'), 1234.56)
  assert.equal(parseNumber('abc'), null)
  assert.equal(parseDate('31/12/2026'), '2026-12-31')
  assert.equal(parseDate('2026-01-02'), '2026-01-02')
  assert.equal(parseDate('46022'), '2025-12-31')
  assert.equal(parseDate('31/02/2026'), null)
})

test('o modelo gerado pelo sistema volta inteiro pela leitura', () => {
  const file = renderWorkbook(instrumentTemplate())
  const parsed = parseInstrumentSheet(readSpreadsheet(file, 'modelo.xlsx'))
  assert.deepEqual(parsed.fields, {
    type: 'ata', number: '12/2026', subject: 'Material de expediente', category: 'material',
    supplier: 'Papelaria Exemplo Ltda.', process: '151.00000/2026-00', total: 23463,
    validFrom: '2026-01-01', validUntil: '2026-12-31', sectorName: 'Almoxarifado', noticeDays: 90,
  })
  assert.equal(parsed.items.length, 2)
  assert.deepEqual(parsed.items[0], {
    row: 16, itemNumber: '1', description: 'Papel A4 75 g/m², caixa com 10 resmas', unit: 'caixa', registered: 120, unitPrice: 189.9,
  })
  assert.deepEqual(parsed.warnings, [])
})

test('planilha só com itens, com títulos diferentes, linha de total e problemas apontados', () => {
  const parsed = parseInstrumentSheet([
    ['Quadro comparativo - pregão 5/2026'],
    ['Nº', 'Especificação', 'Und.', 'Qtd.', 'Preço unitário'],
    ['1', 'Cadeira giratória', 'un', '10', 'R$ 450,00'],
    ['2', 'Mesa', '', '5', '1.200,00'],
    ['3', 'Armário', 'un', 'dez', '900'],
    ['', 'TOTAL', '', '', '10.500,00'],
  ])
  assert.equal(parsed.fields.number, null)
  assert.deepEqual(parsed.items.map((item) => [item.description, item.unit, item.registered, item.unitPrice]), [
    ['Cadeira giratória', 'un', 10, 450],
    ['Mesa', 'unidade', 5, 1200],
  ])
  assert.equal(parsed.fields.total, 10500)
  assert.equal(parsed.warnings.length, 2)
  assert.match(parsed.warnings.join(' '), /Linha 4: sem unidade/)
  assert.match(parsed.warnings.join(' '), /Linha 5: quantidade ou valor unitário inválido/)
})

test('total diferente da soma dos itens vira aviso; sem tabela, aviso claro', () => {
  const different = parseInstrumentSheet([
    ['Valor total', '100'],
    ['Descrição', 'Unidade', 'Quantidade', 'Valor unitário'],
    ['Item A', 'un', '1', '50'],
  ])
  assert.match(different.warnings[0], /diferente da soma/)
  assert.match(parseInstrumentSheet([['Objeto', 'Algo']]).warnings[0], /Não achei a tabela de itens/)
})
