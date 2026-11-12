import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brasiliaInstant } from './insightsRepository.js'

test('agenda de Passagens: data e horário de Brasília viram o instante certo', () => {
  assert.equal(brasiliaInstant('2031-06-12', '08:00')?.toISOString(), '2031-06-12T11:00:00.000Z')
  // Perto da meia-noite, o dia em UTC muda, mas o compromisso continua no dia pedido.
  assert.equal(brasiliaInstant('2031-06-12', '23:30')?.toISOString(), '2031-06-13T02:30:00.000Z')
  // Sem horário válido, vale o início do dia.
  assert.equal(brasiliaInstant('2031-06-12', null)?.toISOString(), '2031-06-12T03:00:00.000Z')
})

test('agenda de Passagens: data impossível ou fora do formato fica de fora, sem erro', () => {
  assert.equal(brasiliaInstant('2027-02-31', '08:00'), null)
  assert.equal(brasiliaInstant('2027-13-01', '08:00'), null)
  assert.equal(brasiliaInstant('12/06/2031', '08:00'), null)
  assert.equal(brasiliaInstant('2031-06-12', '25:00'), null)
  assert.equal(brasiliaInstant(null, '08:00'), null)
})
