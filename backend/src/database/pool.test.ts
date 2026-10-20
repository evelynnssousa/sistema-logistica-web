import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getDatabaseConfiguration, getDatabasePool } from './pool.js'

test('rejects a missing DATABASE_URL without exposing a value', () => {
  assert.throws(
    () => getDatabaseConfiguration({}),
    { message: 'DATABASE_URL ausente ou inválida.' },
  )
})

test('accepts a PostgreSQL URL and uses the default pool size', () => {
  const connectionString = 'postgresql://user:password@localhost:5432/logistica'

  assert.deepEqual(
    getDatabaseConfiguration({ DATABASE_URL: connectionString }),
    { connectionString, max: 5 },
  )
})

test('accepts a configured positive pool size', () => {
  assert.deepEqual(
    getDatabaseConfiguration({
      DATABASE_URL: 'postgres://user:password@localhost/logistica',
      DB_POOL_MAX: '12',
    }),
    {
      connectionString: 'postgres://user:password@localhost/logistica',
      max: 12,
    },
  )
})

test('rejects malformed or non-PostgreSQL connection URLs', () => {
  for (const connectionString of [
    'not-a-url',
    'https://user:password@localhost/logistica',
    'postgresql://localhost/',
  ]) {
    assert.throws(
      () => getDatabaseConfiguration({ DATABASE_URL: connectionString }),
      { message: 'DATABASE_URL ausente ou inválida.' },
    )
  }
})

test('rejects non-positive or non-integer pool sizes', () => {
  for (const max of ['0', '-1', '1.5', 'invalid']) {
    assert.throws(
      () =>
        getDatabaseConfiguration({
          DATABASE_URL: 'postgresql://localhost/logistica',
          DB_POOL_MAX: max,
        }),
      { message: 'DB_POOL_MAX deve ser um inteiro positivo.' },
    )
  }
})

test('validates configuration only when the pool is requested', () => {
  const previousUrl = process.env.DATABASE_URL
  delete process.env.DATABASE_URL

  try {
    assert.throws(
      () => getDatabasePool(),
      { message: 'DATABASE_URL ausente ou inválida.' },
    )
  } finally {
    if (previousUrl === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = previousUrl
    }
  }
})