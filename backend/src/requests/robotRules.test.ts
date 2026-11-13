import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  brasiliaWeek,
  guessColumns,
  instrumentHints,
  matchLine,
  nameSimilarity,
  normalizeCode,
  parseQuantity,
  restockSuggestions,
  sheetLines,
} from './robotRules.js'

test('quantidades no formato brasileiro e no das células numéricas', () => {
  assert.equal(parseQuantity('1.234,50', 'csv'), 1234.5)
  assert.equal(parseQuantity('1.250', 'csv'), 1250)
  assert.equal(parseQuantity('1.250', 'xlsx'), 1.25)
  assert.equal(parseQuantity('3,5', 'csv'), 3.5)
  assert.equal(parseQuantity('1,234.5', 'csv'), 1234.5)
  assert.equal(parseQuantity('12 UN', 'html'), 12)
  assert.equal(parseQuantity('1.000.000', 'xlsx'), 1000000)
  assert.equal(parseQuantity('—', 'csv'), null)
  assert.equal(parseQuantity('', 'csv'), null)
  assert.equal(parseQuantity('-2', 'csv'), -2)
})

test('códigos comparáveis sem zeros à esquerda e pontuação', () => {
  assert.equal(normalizeCode('000.123-4'), '1234')
  assert.equal(normalizeCode('ab-01'), 'AB01')
  assert.equal(normalizeCode('0'), '0')
})

test('acha o cabeçalho e as colunas mesmo abaixo de um título', () => {
  const rows = [
    ['Relatório de saldo — Almoxarifado', '', '', ''],
    ['', '', '', ''],
    ['Cód. Item', 'Descrição do material', 'Unidade de fornecimento', 'Saldo atual'],
    ['10', 'Caneta azul', 'UN', '5'],
  ]
  assert.deepEqual(guessColumns(rows), { headerRow: 2, code: 0, description: 1, quantity: 3, unit: 2 })
})

test('linhas de dados: ignora vazias e totais', () => {
  const rows = [['Código', 'Descrição', 'Qtd'], ['10', 'Caneta', '2'], ['', '', ''], ['', 'Total geral', '2'], ['', 'Grampo', 'x']]
  assert.deepEqual(sheetLines(rows, { headerRow: 0, code: 0, description: 1, quantity: 2, unit: null }, 'csv'), [
    { line: 2, code: '10', description: 'Caneta', unit: '', quantity: 2 },
    { line: 5, code: '', description: 'Grampo', unit: '', quantity: null },
  ])
})

const catalog = [
  { id: 'a', code: '0010', name: 'Caneta esferográfica azul' },
  { id: 'b', code: null, name: 'Papel A4' },
  { id: 'c', code: '22', name: 'Tinta azul para carimbo' },
  { id: 'd', code: null, name: 'Clipe nº 2' },
]

test('correspondência: primeiro o código, depois o nome igual, depois os parecidos', () => {
  assert.deepEqual(matchLine({ code: '10', description: 'qualquer' }, catalog), { status: 'code', materialId: 'a', suggestions: [] })
  assert.deepEqual(matchLine({ code: '', description: 'PAPEL  a4' }, catalog), { status: 'name', materialId: 'b', suggestions: [] })
  const similar = matchLine({ code: '999', description: 'Caneta azul' }, catalog)
  assert.equal(similar.status, 'suggested')
  assert.equal(similar.materialId, 'a')
  assert.equal(similar.suggestions[0].id, 'a')
  assert.deepEqual(matchLine({ code: '', description: 'Grampeador' }, catalog), { status: 'none', materialId: null, suggestions: [] })
})

test('semelhança dá peso à primeira palavra', () => {
  assert.ok(nameSimilarity('Caneta azul', 'Caneta esferográfica azul') > nameSimilarity('Caneta azul', 'Tinta azul para carimbo'))
  assert.equal(nameSimilarity('', 'Papel'), 0)
  assert.equal(nameSimilarity('Papel A4', 'papel a4'), 1)
})

const item = (overrides: Partial<Parameters<typeof restockSuggestions>[0][number]>) => ({
  id: 'm', code: null, name: 'Material', unit: 'UN', location: null,
  current: 0, minimum: 0, reserved: 0, available: 0,
  monthlyConsumption: { average: null, months: null },
  ...overrides,
})

test('reposição: compra para durar o período, nunca abaixo do mínimo, mais urgentes primeiro', () => {
  const result = restockSuggestions([
    item({ id: 'folgado', name: 'Folgado', current: 100, available: 100, monthlyConsumption: { average: 10, months: 12 } }),
    item({ id: 'curto', name: 'Curto', current: 12, available: 5, reserved: 7, monthlyConsumption: { average: 10, months: 12 } }),
    item({ id: 'minimo', name: 'Mínimo', current: 1, available: 1, minimum: 4 }),
    item({ id: 'parado', name: 'Parado', current: 0, available: 0 }),
    item({ id: 'meio', name: 'Meio', current: 20, available: 20, monthlyConsumption: { average: 8.4, months: 6 } }),
  ], 3)
  assert.deepEqual(result.map((entry) => [entry.materialId, entry.suggested, entry.reason, entry.coverageMonths]), [
    ['minimo', 3, 'below_minimum', null],
    ['curto', 25, 'short_coverage', 0.5],
    ['meio', 6, 'short_coverage', 2.4],
  ])
})

test('atas indicadas: vigentes, com saldo e nome parecido', () => {
  const base = { instrumentId: 'i', number: '1/2026', type: 'ata', validUntil: null, unit: 'UN' }
  const hints = instrumentHints('Caneta esferográfica azul', [
    { ...base, itemId: '1', description: 'Caneta esferográfica azul ponta média', expired: false, balance: 100 },
    { ...base, itemId: '2', description: 'Caneta esferográfica azul', expired: true, balance: 100 },
    { ...base, itemId: '3', description: 'Caneta esferográfica azul', expired: false, balance: 0 },
    { ...base, itemId: '4', description: 'Papel A4', expired: false, balance: 10 },
  ])
  assert.deepEqual(hints.map((hint) => hint.itemId), ['1'])
})

test('semana do resumo no horário de Brasília', () => {
  // Segunda, 16/11/2026, 9h30 em Brasília (12h30 UTC).
  assert.deepEqual(brasiliaWeek(new Date('2026-11-16T12:30:00Z')), { key: '2026-W47', weekday: 1, hour: 9 })
  // Segunda 1h UTC ainda é domingo em Brasília.
  assert.equal(brasiliaWeek(new Date('2026-11-16T01:00:00Z')).weekday, 7)
  // Virada de ano: 31/12/2026 é quinta, semana 53 de 2026.
  assert.equal(brasiliaWeek(new Date('2026-12-31T15:00:00Z')).key, '2026-W53')
})

test('unidade da planilha: nome igual, abreviação comum ou primeira palavra', async () => {
  const { matchUnit, materialNameFrom } = await import('./robotRules.js')
  const units = [
    { id: 'un', name: 'Unidade' },
    { id: 'cx', name: 'Caixa' },
    { id: 'pct', name: 'Pacote com 100' },
    { id: 'kg', name: 'Quilograma' },
  ]
  assert.equal(matchUnit('UN', units), 'un')
  assert.equal(matchUnit('Und.', units), 'un')
  assert.equal(matchUnit('cx', units), 'cx')
  assert.equal(matchUnit('CAIXA', units), 'cx')
  assert.equal(matchUnit('PCT', units), 'pct')
  assert.equal(matchUnit('Kg', units), 'kg')
  assert.equal(matchUnit('Litro', units), null)
  assert.equal(matchUnit('', units), null)
  assert.equal(materialNameFrom('  Papel   A4  '), 'Papel A4')
  assert.equal(materialNameFrom('x'.repeat(200)).length, 160)
})
