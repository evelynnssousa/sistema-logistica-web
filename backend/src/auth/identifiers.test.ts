import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeLoginIdentifiers } from './identifiers.js'

test('normalizes email and username for consistent case-insensitive lookup', () => {
  assert.deepEqual(
    normalizeLoginIdentifiers({
      email: '  Operador.SLM@Example.gov.br ',
      username: ' Equipe.SLM-01 ',
    }),
    {
      email: 'operador.slm@example.gov.br',
      username: 'equipe.slm-01',
    },
  )
})

test('accepts either login identifier or both', () => {
  assert.deepEqual(normalizeLoginIdentifiers({ email: 'a@b.com' }), {
    email: 'a@b.com',
    username: null,
  })
  assert.deepEqual(normalizeLoginIdentifiers({ username: 'operator' }), {
    email: null,
    username: 'operator',
  })
})

test('rejects missing, malformed, or unsupported identifiers', () => {
  for (const input of [
    {},
    { email: 'invalid-email' },
    { email: 'a@b.com', username: 'contains whitespace' },
    { username: '-starts-with-punctuation' },
    { username: 'x'.repeat(65) },
    { email: 'x'.repeat(245) + '@example.gov.br' },
  ]) {
    assert.throws(() =>
      normalizeLoginIdentifiers(input as { email?: string; username?: string }),
    )
  }
})