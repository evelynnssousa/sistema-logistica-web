import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Journey } from '../auth/driverPolicy.js'
import { expectedDailyMinutes, formatHours, workloadByDay, workloadSummary } from './driverWorkload.js'

// Segunda a sexta, 8h às 17h, 1 h de intervalo: 8 h previstas por dia.
const journey: Journey = { start: '08:00', end: '17:00', weekdays: [1, 2, 3, 4, 5], breakMinutes: 60, expectedMinutes: null }
// Horários de Brasília (UTC−3) escritos como instantes.
const at = (day: string, time: string) => new Date(`${day}T${time}:00-03:00`)
const trip = (driverId: string, day: string, start: string, end: string) => ({
  driverId,
  driverName: driverId === 'a' ? 'Ana Motorista' : 'Bruno Motorista',
  startedAt: at(day, start),
  finishedAt: at(day, end),
})

test('jornada prevista: duração definida ou faixa menos o intervalo', () => {
  assert.equal(expectedDailyMinutes(journey), 480)
  assert.equal(expectedDailyMinutes({ ...journey, expectedMinutes: 360 }), 360)
})

test('dia útil acima da jornada vira hora extra, e o que sai da faixa é contado à parte', () => {
  // Quarta-feira, 12/11/2031: 7h às 12h e 13h às 18h30 → 11h30 de ponta a ponta, 10h30 sem o intervalo.
  const [day] = workloadByDay([trip('a', '2031-11-12', '07:00', '12:00'), trip('a', '2031-11-12', '13:00', '18:30')], journey)
  assert.equal(day.trips, 2)
  assert.equal(day.tripMinutes, 630)
  assert.equal(day.workedMinutes, 630)
  assert.equal(day.expectedMinutes, 480)
  assert.equal(day.extraMinutes, 150)
  assert.equal(day.missingMinutes, 0)
  // Das 7h às 8h e das 17h às 18h30, fora da faixa.
  assert.equal(day.outsideJourneyMinutes, 150)
})

test('dia útil curto vira horas a menos, nunca menos que o tempo em viagem', () => {
  const [day] = workloadByDay([trip('a', '2031-11-13', '09:00', '13:00')], journey)
  // 4 h de ponta a ponta, menos 1 h de intervalo, daria 3 h: vale o tempo real em viagem.
  assert.equal(day.workedMinutes, 240)
  assert.equal(day.missingMinutes, 240)
  assert.equal(day.extraMinutes, 0)
})

test('fim de semana: sem jornada prevista, tudo é extra', () => {
  // Sábado, 15/11/2031.
  const [day] = workloadByDay([trip('b', '2031-11-15', '09:00', '11:00')], journey)
  assert.equal(day.expectedMinutes, 0)
  assert.equal(day.extraMinutes, 120)
  assert.equal(day.outsideJourneyMinutes, 120)
})

test('viagem sem início ou fim real não entra nas horas', () => {
  const days = workloadByDay(
    [{ driverId: 'a', driverName: 'Ana', startedAt: at('2031-11-12', '08:00'), finishedAt: null }],
    journey,
  )
  assert.deepEqual(days, [])
})

test('resumo por motorista soma os dias e calcula o saldo', () => {
  const days = workloadByDay(
    [
      trip('a', '2031-11-12', '07:00', '12:00'),
      trip('a', '2031-11-12', '13:00', '18:30'),
      trip('a', '2031-11-13', '09:00', '13:00'),
      trip('b', '2031-11-15', '09:00', '11:00'),
    ],
    journey,
  )
  const [ana, bruno] = workloadSummary(days)
  assert.equal(ana.driverName, 'Ana Motorista')
  assert.deepEqual([ana.days, ana.trips, ana.extraMinutes, ana.missingMinutes, ana.balanceMinutes], [2, 3, 150, 240, -90])
  assert.deepEqual([bruno.days, bruno.extraMinutes, bruno.balanceMinutes], [1, 120, 120])
})

test('horas no formato do relatório', () => {
  assert.equal(formatHours(125), '2:05')
  assert.equal(formatHours(0), '0:00')
  assert.equal(formatHours(-30), '-0:30')
})
