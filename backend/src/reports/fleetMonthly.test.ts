import assert from 'node:assert/strict'
import { test } from 'node:test'
import { kilometersByVehicle, matchVehicle, monthPeriod, plateKey } from './fleetMonthly.js'

const fleet = [
  { id: '1', placa: 'ABC-1D23', modelo: 'Gol', logKm: 40, logUses: 2 },
  { id: '2', placa: 'XYZ9876', modelo: 'Spin', logKm: 0, logUses: 0 },
  { id: '3', placa: 'QWE5R67', modelo: 'Onix', logKm: 0, logUses: 0 },
]

test('placa sem pontuação e veículo reconhecido dentro do texto da viagem', () => {
  assert.equal(plateKey(' abc-1d23 '), 'ABC1D23')
  assert.equal(matchVehicle('Gol abc1d23', fleet)?.id, '1')
  assert.equal(matchVehicle('Spin XYZ-9876 (prata)', fleet)?.id, '2')
  assert.equal(matchVehicle('Carro alugado', fleet), null)
  assert.equal(matchVehicle('', fleet), null)
})

test('km do mês: portal e diário de bordo por carro, sem cadastro pelo texto informado', () => {
  const rows = kilometersByVehicle(
    [
      { vehicle: 'ABC-1D23', kilometers: 120 },
      { vehicle: 'gol abc1d23', kilometers: 30 },
      { vehicle: 'ABC1D23', kilometers: null },
      { vehicle: 'Van alugada', kilometers: 15 },
      { vehicle: 'van  alugada', kilometers: 5 },
      { vehicle: null, kilometers: 8 },
    ],
    fleet,
  )
  assert.deepEqual(rows[0], {
    vehicle: 'ABC-1D23', model: 'Gol', registered: true, trips: 3, tripsWithoutOdometer: 1,
    tripKm: 150, logUses: 2, logKm: 40, totalKm: 190,
  })
  const van = rows.find((row) => row.vehicle === 'Van alugada')
  assert.equal(van?.trips, 2)
  assert.equal(van?.totalKm, 20)
  assert.equal(van?.registered, false)
  assert.equal(rows.find((row) => row.vehicle === 'Veículo não informado')?.tripKm, 8)
  // Carros sem viagem e sem diário no mês não aparecem.
  assert.equal(rows.some((row) => row.vehicle === 'XYZ9876'), false)
  assert.equal(rows.length, 3)
})

test('mês inteiro no horário de Brasília', () => {
  const period = monthPeriod('2026-11')!
  assert.equal(period.from.toISOString(), '2026-11-01T03:00:00.000Z')
  assert.equal(period.to.toISOString(), '2026-12-01T03:00:00.000Z')
  assert.equal(monthPeriod('2026-12')!.to.toISOString(), '2027-01-01T03:00:00.000Z')
  assert.equal(monthPeriod('2026-13'), null)
  assert.equal(monthPeriod('nov'), null)
})
