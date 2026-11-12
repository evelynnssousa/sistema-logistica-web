import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agreementSituation, deliveryDebit, entryValue, exitCost, unitCost } from './warehouseValuation.js'

test('custo médio ponderado: 10 a R$ 20 e mais 10 a R$ 30 dão R$ 25', () => {
  let stock = { quantity: 10, value: 200 }
  const entry = entryValue(stock, 10, 300)
  assert.deepEqual(entry, { value: 300, informed: true })
  stock = { quantity: 20, value: stock.value + entry.value }
  assert.equal(unitCost(stock.quantity, stock.value), 25)
  assert.equal(exitCost(stock, 4), 100)
})

test('entrada sem valor: entra pelo custo médio e a média não muda; sem estoque, vale zero', () => {
  assert.deepEqual(entryValue({ quantity: 4, value: 10 }, 2, null), { value: 5, informed: false })
  assert.deepEqual(entryValue({ quantity: 0, value: 0 }, 2, null), { value: 0, informed: false })
  assert.equal(unitCost(0, 0), null)
})

test('saída: a última unidade leva o valor que resta, sem centavo perdido', () => {
  const stock = { quantity: 3, value: 10 }
  const first = exitCost(stock, 1)
  assert.equal(first, 3.33)
  const afterFirst = Math.round((10 - first) * 100) / 100
  const second = exitCost({ quantity: 2, value: afterFirst }, 1)
  const afterSecond = Math.round((afterFirst - second) * 100) / 100
  const third = exitCost({ quantity: 1, value: afterSecond }, 1)
  assert.equal(third, afterSecond)
  assert.equal(Math.round((first + second + third) * 100), 1000)
  assert.equal(exitCost({ quantity: 2, value: 7 }, 5), 7)
  assert.equal(exitCost({ quantity: 0, value: 0 }, 1), 0)
})

test('baixa da entrega: nunca mais que o saldo, e informa o que faltou', () => {
  assert.deepEqual(deliveryDebit(10, 4), { debited: 4, missing: 0 })
  assert.deepEqual(deliveryDebit(3, 5), { debited: 3, missing: 2 })
  assert.deepEqual(deliveryDebit(0, 5), { debited: 0, missing: 5 })
})

test('situação da ata', () => {
  const ata = { active: true, validFrom: '2026-01-01', validUntil: '2026-12-31' }
  assert.equal(agreementSituation(ata, '2026-11-12'), 'vigente')
  assert.equal(agreementSituation(ata, '2025-12-31'), 'futura')
  assert.equal(agreementSituation(ata, '2027-01-01'), 'vencida')
  assert.equal(agreementSituation({ ...ata, active: false }, '2026-11-12'), 'encerrada')
  assert.equal(agreementSituation({ active: true, validFrom: null, validUntil: null }, '2026-11-12'), 'vigente')
})
