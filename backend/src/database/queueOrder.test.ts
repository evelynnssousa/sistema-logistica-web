import assert from 'node:assert/strict'
import { test } from 'node:test'
import { byNextAttempt } from './queueOrder.js'

test('lote da fila: a mais antiga primeiro, empate pelo id, sem alterar o original', () => {
  const rows = [
    { id: 'c', at: new Date('2026-11-11T10:02:00Z') },
    { id: 'b', at: new Date('2026-11-11T10:00:00Z') },
    { id: 'a', at: new Date('2026-11-11T10:02:00Z') },
  ]
  assert.deepEqual(byNextAttempt(rows, (row) => row.at).map((row) => row.id), ['b', 'a', 'c'])
  assert.deepEqual(rows.map((row) => row.id), ['c', 'b', 'a'])
})
