import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sortByName } from './naturalOrder.js'

test('ordem dos formulários: acentos, maiúsculas e números como no português', () => {
  const names = ['Zeladoria', 'área técnica', '10º andar', 'Térreo', '2º andar', 'Protocolo', 'Ábaco', 'arquivo']
  assert.deepEqual(sortByName(names, (name) => name), [
    '2º andar', '10º andar', 'Ábaco', 'área técnica', 'arquivo', 'Protocolo', 'Térreo', 'Zeladoria',
  ])
})

test('ordem dos formulários: não altera a lista original', () => {
  const rows = [{ name: 'B' }, { name: 'A' }]
  sortByName(rows, (row) => row.name)
  assert.deepEqual(rows.map((row) => row.name), ['B', 'A'])
})
