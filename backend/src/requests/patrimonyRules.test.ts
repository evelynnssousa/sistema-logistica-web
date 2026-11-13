import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyRead,
  guessAssetColumns,
  importLines,
  matchSector,
  normalizeAssetNumber,
  parseSheetDate,
  parseSituation,
  readAssetInput,
  readMoney,
} from './patrimonyRules.js'
import { RequestValidationError } from './validation.js'
import { holdsPermission, permissionsForProfile } from '../auth/permissions.js'

test('número do patrimônio: pontos, traços e espaços não contam; zeros à esquerda contam', () => {
  assert.equal(normalizeAssetNumber(' 123.456-7 '), '1234567')
  assert.equal(normalizeAssetNumber('jc-0012'), 'JC0012')
  assert.notEqual(normalizeAssetNumber('0012'), normalizeAssetNumber('12'))
})

test('cadastro: número e descrição obrigatórios, situação conhecida, data real e não futura', () => {
  const asset = readAssetInput({ number: '7', description: 'Mesa de escritório', acquisitionValue: '1.234,56', registeredOn: '2024-02-29' })
  assert.equal(asset.situation, 'em_uso')
  assert.equal(asset.acquisitionValue, 1234.56)
  assert.equal(asset.number, '7')
  assert.throws(() => readAssetInput({ number: '--', description: 'Mesa' }), RequestValidationError)
  assert.throws(() => readAssetInput({ number: '1', description: '' }), RequestValidationError)
  assert.throws(() => readAssetInput({ number: '1', description: 'Mesa', situation: 'perdido' }), /situação/)
  assert.throws(() => readAssetInput({ number: '1', description: 'Mesa', registeredOn: '2026-02-30' }), /data inválida/)
  assert.throws(() => readAssetInput({ number: '1', description: 'Mesa', registeredOn: '2999-01-01' }), /futura/)
  assert.throws(() => readMoney('-5', 'Valor'), /inválido/)
})

test('conferência: no local, em outro setor ou sala, não cadastrado e baixado', () => {
  const asset = { sectorId: 's1', room: 'Sala 10', situation: 'em_uso' }
  assert.equal(classifyRead(asset, { sectorId: 's1', room: 'sala 10' }), 'no_local')
  assert.equal(classifyRead(asset, { sectorId: 's1', room: null }), 'no_local')
  assert.equal(classifyRead(asset, { sectorId: 's1', room: 'Sala 11' }), 'outro_local')
  assert.equal(classifyRead(asset, { sectorId: 's2', room: null }), 'outro_local')
  assert.equal(classifyRead(asset, { sectorId: null, room: null }), 'no_local')
  assert.equal(classifyRead(null, { sectorId: 's1', room: null }), 'nao_cadastrado')
  assert.equal(classifyRead({ ...asset, situation: 'baixado' }, { sectorId: 's1', room: null }), 'baixado')
})

test('datas da planilha: brasileira, ISO e número de série do Excel', () => {
  assert.equal(parseSheetDate('13/11/2026', 'csv'), '2026-11-13')
  assert.equal(parseSheetDate('5/3/99', 'csv'), '1999-03-05')
  assert.equal(parseSheetDate('2026-11-13 10:00', 'csv'), '2026-11-13')
  assert.equal(parseSheetDate('46339', 'xlsx'), '2026-11-13')
  assert.equal(parseSheetDate('46339', 'csv'), null)
  assert.equal(parseSheetDate('31/02/2026', 'csv'), null)
  assert.equal(parseSheetDate('', 'csv'), null)
})

test('situação e setor escritos na planilha', () => {
  assert.equal(parseSituation('Inservível'), 'inservivel')
  assert.equal(parseSituation('BAIXADO'), 'baixado')
  assert.equal(parseSituation('Bom'), 'em_uso')
  assert.equal(parseSituation(''), null)
  const sectors = [{ id: 'a', name: 'Diretoria Administrativa', acronym: 'DA' }]
  assert.equal(matchSector('diretoria administrativa', sectors)?.id, 'a')
  assert.equal(matchSector('da', sectors)?.id, 'a')
  assert.equal(matchSector('Outra', sectors), null)
})

test('importação: acha as colunas e aponta problemas e avisos por linha', () => {
  const rows = [
    ['Inventário patrimonial', '', '', '', '', ''],
    ['Nº Patrimônio', 'Descrição do bem', 'Setor', 'Sala', 'Data de tombamento', 'Valor'],
    ['1001', 'Cadeira giratória', 'DA', 'Sala 3', '10/01/2020', '450,00'],
    ['1001', 'Cadeira repetida', 'DA', '', '', ''],
    ['', 'Sem número', '', '', '', ''],
    ['1002', 'Armário', 'Setor desconhecido', '', '32/13/2020', 'x'],
  ]
  const columns = guessAssetColumns(rows)
  assert.equal(columns.headerRow, 1)
  assert.deepEqual([columns.number, columns.description, columns.sector, columns.room, columns.registeredOn, columns.acquisitionValue], [0, 1, 2, 3, 4, 5])
  const lines = importLines(rows, columns, 'csv', [{ id: 'da', name: 'Diretoria Administrativa', acronym: 'DA' }])
  assert.deepEqual(lines.map((line) => [line.line, line.problems, line.warnings.length]), [
    [3, [], 0],
    [4, ['Número repetido na linha 3'], 0],
    [5, ['Sem número de patrimônio'], 0],
    [6, [], 3],
  ])
  assert.equal(lines[0].sectorId, 'da')
  assert.equal(lines[0].registeredOn, '2020-01-10')
  assert.equal(lines[0].acquisitionValue, 450)
})

test('Patrimônio: Administrador e Operador SLM da equipe; Solicitante nunca, mesmo com a permissão concedida', () => {
  assert.ok(permissionsForProfile('administrator').includes('patrimony:manage'))
  assert.ok(permissionsForProfile('slm_operator').includes('patrimony:manage'))
  assert.ok(!permissionsForProfile('requester').includes('patrimony:manage'))
  const permissions = ['patrimony:manage'] as const
  assert.equal(holdsPermission({ role: 'administrator', slmMember: false, permissions: [...permissions] }, 'patrimony:manage'), true)
  assert.equal(holdsPermission({ role: 'slm_operator', slmMember: true, permissions: [...permissions] }, 'patrimony:manage'), true)
  assert.equal(holdsPermission({ role: 'slm_operator', slmMember: false, permissions: [...permissions] }, 'patrimony:manage'), false)
  assert.equal(holdsPermission({ role: 'requester', slmMember: false, permissions: [...permissions] }, 'patrimony:manage'), false)
})
