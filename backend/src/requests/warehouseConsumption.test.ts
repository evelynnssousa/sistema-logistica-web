import assert from 'node:assert/strict'
import { test } from 'node:test'
import { monthlyConsumption } from './warehouseConsumption.js'

const now = new Date('2026-11-11T12:00:00.000Z')

test('consumo médio: sem nenhuma entrega, não há média', () => {
  assert.deepEqual(monthlyConsumption(0, null, now), { average: null, total: 0, months: null })
})

test('consumo médio: material antigo divide pelos 12 meses da janela', () => {
  const result = monthlyConsumption(120, new Date('2024-01-10T00:00:00.000Z'), now)
  assert.deepEqual(result, { average: 10, total: 120, months: 12 })
})

test('consumo médio: material novo conta desde a primeira entrega', () => {
  // Primeira entrega há cerca de 3 meses: 30 unidades viram 10 por mês, não 2,5.
  const result = monthlyConsumption(30, new Date('2026-08-11T12:00:00.000Z'), now)
  assert.equal(result.months, 3)
  assert.equal(result.average, 10)
})

test('consumo médio: entrega desta semana conta como 1 mês, sem multiplicar', () => {
  const result = monthlyConsumption(7, new Date('2026-11-09T12:00:00.000Z'), now)
  assert.deepEqual(result, { average: 7, total: 7, months: 1 })
})

test('consumo médio: já entregue, mas nada nos últimos 12 meses, dá zero', () => {
  assert.deepEqual(monthlyConsumption(0, new Date('2023-05-01T00:00:00.000Z'), now), { average: 0, total: 0, months: 12 })
})
