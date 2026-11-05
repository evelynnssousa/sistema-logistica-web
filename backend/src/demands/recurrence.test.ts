import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RequestValidationError } from '../requests/validation.js'
import {
  addDays,
  describeRule,
  isCalendarDate,
  occurrenceAfter,
  occurrenceOnOrAfter,
  occurrencesBetween,
  readRecurrenceRule,
} from './recurrence.js'

test('mensal nos dias 5 e 20 gera duas datas por mês, em ordem', () => {
  const rule = readRecurrenceRule({ frequency: 'mensal', startDate: '2026-11-01', monthDays: [20, 5] })
  assert.deepEqual(occurrencesBetween(rule, '2026-11-01', '2027-01-31'), [
    '2026-11-05', '2026-11-20', '2026-12-05', '2026-12-20', '2027-01-05', '2027-01-20',
  ])
})

test('não gera data anterior ao início, mesmo no primeiro mês', () => {
  const rule = readRecurrenceRule({ frequency: 'mensal', startDate: '2026-11-10', monthDays: [5, 20] })
  assert.equal(occurrenceOnOrAfter(rule, '2026-01-01'), '2026-11-20')
})

test('dia 31 cai no último dia dos meses menores, sem pular nenhum mês', () => {
  const rule = readRecurrenceRule({ frequency: 'mensal', startDate: '2027-01-31', monthDays: [31] })
  assert.deepEqual(occurrencesBetween(rule, '2027-01-01', '2027-05-31'), [
    '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31',
  ])
})

test('em ano bissexto, o último dia de fevereiro é 29', () => {
  const rule = readRecurrenceRule({ frequency: 'mensal', startDate: '2028-01-31', monthDays: [31] })
  assert.equal(occurrenceAfter(rule, '2028-01-31'), '2028-02-29')
})

test('dias 30 e 31 viram uma só data em fevereiro, sem duplicar', () => {
  const rule = readRecurrenceRule({ frequency: 'mensal', startDate: '2027-02-01', monthDays: [30, 31] })
  assert.deepEqual(occurrencesBetween(rule, '2027-02-01', '2027-03-31'), [
    '2027-02-28', '2027-03-30', '2027-03-31',
  ])
})

test('anual em 29/02 cai em 28/02 nos anos comuns e volta a 29 no bissexto', () => {
  const rule = readRecurrenceRule({ frequency: 'anual', startDate: '2028-02-29' })
  assert.deepEqual(occurrencesBetween(rule, '2028-01-01', '2032-12-31'), [
    '2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29',
  ])
})

test('semanal em dias específicos', () => {
  // 02/11/2026 é uma segunda-feira.
  const rule = readRecurrenceRule({ frequency: 'semanal', startDate: '2026-11-02', weekdays: [1, 4] })
  assert.deepEqual(occurrencesBetween(rule, '2026-11-01', '2026-11-15'), [
    '2026-11-02', '2026-11-05', '2026-11-09', '2026-11-12',
  ])
})

test('semanal sem dia escolhido usa o dia da semana da data inicial', () => {
  const rule = readRecurrenceRule({ frequency: 'semanal', startDate: '2026-11-04' })
  assert.deepEqual(rule.weekdays, [3])
})

test('quinzenal repete a cada 15 dias, inclusive na virada do ano', () => {
  const rule = readRecurrenceRule({ frequency: 'quinzenal', startDate: '2026-12-10' })
  assert.deepEqual(occurrencesBetween(rule, '2026-12-01', '2027-01-31'), [
    '2026-12-10', '2026-12-25', '2027-01-09', '2027-01-24',
  ])
})

test('bimestral, trimestral e semestral respeitam o mês de início', () => {
  const dates = (frequency: string) =>
    occurrencesBetween(readRecurrenceRule({ frequency, startDate: '2026-11-15' }), '2026-01-01', '2027-11-30')
  assert.deepEqual(dates('bimestral').slice(0, 3), ['2026-11-15', '2027-01-15', '2027-03-15'])
  assert.deepEqual(dates('trimestral').slice(0, 3), ['2026-11-15', '2027-02-15', '2027-05-15'])
  assert.deepEqual(dates('semestral'), ['2026-11-15', '2027-05-15', '2027-11-15'])
})

test('personalizado a cada 2 semanas não usa as semanas intermediárias', () => {
  const rule = readRecurrenceRule({
    frequency: 'personalizada', interval: 2, unit: 'semana', startDate: '2026-11-02', weekdays: [1, 5],
  })
  assert.deepEqual(occurrencesBetween(rule, '2026-11-01', '2026-11-30'), [
    '2026-11-02', '2026-11-06', '2026-11-16', '2026-11-20', '2026-11-30',
  ])
})

test('consultar a partir de uma data no meio do ciclo continua alinhado ao início', () => {
  const rule = readRecurrenceRule({ frequency: 'personalizada', interval: 3, unit: 'mes', startDate: '2026-01-10' })
  assert.equal(occurrenceOnOrAfter(rule, '2026-02-20'), '2026-04-10')
  const everyTen = readRecurrenceRule({ frequency: 'personalizada', interval: 10, unit: 'dia', startDate: '2026-01-01' })
  assert.equal(occurrenceOnOrAfter(everyTen, '2026-01-12'), '2026-01-21')
})

test('encerramento por data não passa do limite', () => {
  const rule = readRecurrenceRule({
    frequency: 'semanal', startDate: '2026-11-02', end: { type: 'data', date: '2026-11-16' },
  })
  assert.deepEqual(occurrencesBetween(rule, '2026-11-01', '2027-12-31'), ['2026-11-02', '2026-11-09', '2026-11-16'])
  assert.equal(occurrenceAfter(rule, '2026-11-16'), null)
})

test('dados inválidos são recusados', () => {
  for (const input of [
    {},
    { frequency: 'mensal' },
    { frequency: 'horaria', startDate: '2026-11-01' },
    { frequency: 'mensal', startDate: '2026-02-30' },
    { frequency: 'mensal', startDate: '2026-11-01', monthDays: [32] },
    { frequency: 'semanal', startDate: '2026-11-01', weekdays: [7] },
    { frequency: 'personalizada', startDate: '2026-11-01', unit: 'mes', interval: 0 },
    { frequency: 'personalizada', startDate: '2026-11-01', unit: 'hora', interval: 1 },
    { frequency: 'mensal', startDate: '2026-11-01', end: { type: 'quantidade', count: 0 } },
    { frequency: 'mensal', startDate: '2026-11-01', end: { type: 'data', date: '2026-10-01' } },
    { frequency: 'mensal', startDate: '2026-11-01', end: { type: 'outro' } },
  ]) {
    assert.throws(() => readRecurrenceRule(input), RequestValidationError, JSON.stringify(input))
  }
})

test('a frase descreve a regra', () => {
  assert.equal(
    describeRule(readRecurrenceRule({ frequency: 'mensal', startDate: '2026-11-01', monthDays: [5, 20], end: { type: 'quantidade', count: 6 } })),
    'A cada mês, dias 5 e 20 · termina após 6 ocorrências',
  )
  assert.equal(describeRule(readRecurrenceRule({ frequency: 'quinzenal', startDate: '2026-11-01' })), 'A cada 15 dias')
})

test('datas de calendário', () => {
  assert.equal(isCalendarDate('2028-02-29'), true)
  assert.equal(isCalendarDate('2027-02-29'), false)
  assert.equal(isCalendarDate('29/02/2028'), false)
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
})
