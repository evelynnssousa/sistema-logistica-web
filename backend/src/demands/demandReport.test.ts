import assert from 'node:assert/strict'
import { test } from 'node:test'
import { delayDays, demandReportWorkbook, describeDemandFilters } from './demandReport.js'
import type { DemandReport, DemandReportRow } from './demandReport.js'

// 12/11/2026, meio-dia em Brasília.
const now = new Date('2026-11-12T15:00:00.000Z')
const base: DemandReportRow = {
  number: 'DEM-1',
  title: 'Organizar arquivo',
  category: null,
  responsibleSector: 'Setor A',
  responsible: 'Pessoa',
  priority: 'media',
  status: 'em_andamento',
  openedAt: new Date('2026-11-01T12:00:00.000Z'),
  dueDate: '2026-11-05',
  overdue: true,
  recurring: false,
  shared: false,
}

test('dias de atraso: aberta conta até hoje; concluída, até a conclusão; no prazo, zero', () => {
  assert.equal(delayDays(base, now), 7)
  assert.equal(delayDays({ ...base, status: 'concluida', overdue: false, completedAt: new Date('2026-11-08T13:00:00.000Z') }, now), 3)
  assert.equal(delayDays({ ...base, status: 'concluida', overdue: false, completedAt: new Date('2026-11-04T13:00:00.000Z') }, now), 0)
  assert.equal(delayDays({ ...base, dueDate: null }, now), null)
  assert.equal(delayDays({ ...base, status: 'cancelada' }, now), null)
})

test('filtros em texto: só o que foi aplicado, sem identificadores', () => {
  assert.deepEqual(describeDemandFilters({ scope: 'all', statuses: [] }), [])
  const described = describeDemandFilters({
    scope: 'mine',
    statuses: ['em_andamento', 'suspensa'],
    priority: 'urgente',
    sectorId: '00000000-0000-0000-0000-000000000001',
    overdue: true,
  })
  assert.deepEqual(described, [
    ['Visão', 'Minhas'],
    ['Status', 'Em andamento, Suspensa'],
    ['Prioridade', 'Urgente'],
    ['Setor', 'selecionado na tela'],
    ['Atrasadas', 'Só atrasadas'],
  ])
  assert.doesNotMatch(JSON.stringify(described), /0000-0000/)
})

test('planilha: abas na ordem, atrasadas da maior para a menor', () => {
  const report: DemandReport = { totals: { total: 2 }, bySector: [], byResponsible: [], byCategory: [], byPriority: [], byStatus: [], monthly: [] }
  const rows = [base, { ...base, number: 'DEM-2', dueDate: '2026-10-01' }]
  const sheets = demandReportWorkbook(report, rows, { generatedBy: 'Administradora', now })
  assert.deepEqual(sheets.map((sheet) => sheet.name).slice(0, 2), ['Sobre', 'Indicadores'])
  const late = sheets.find((sheet) => sheet.name === 'Atrasadas')!
  assert.deepEqual(late.rows.slice(1).map((row) => [row[0], row[7]]), [['DEM-2', 42], ['DEM-1', 7]])
})
