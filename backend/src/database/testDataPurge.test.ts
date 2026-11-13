import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { confirmationPhrases, databaseEnvironment, isPurgeGroup } from './testDataPurge.js'

const poolWith = (options: Record<string, string>) => ({ options }) as unknown as Pool

test('ambiente da limpeza pelo banco em uso: local, homologação e, na dúvida, principal', () => {
  assert.equal(databaseEnvironment(poolWith({ connectionString: 'postgres://u:p@127.0.0.1:55432/x_test' })), 'local')
  assert.equal(databaseEnvironment(poolWith({ host: 'localhost' })), 'local')
  assert.equal(
    databaseEnvironment(poolWith({ connectionString: 'postgres://postgres.rrqulhpnghoetgrdswqr:s@aws-0-sa-east-1.pooler.supabase.com:5432/postgres' })),
    'homologacao',
  )
  assert.equal(databaseEnvironment(poolWith({ connectionString: 'postgres://postgres.outroprojeto:s@aws-0-sa-east-1.pooler.supabase.com:5432/postgres' })), 'principal')
  assert.equal(databaseEnvironment(poolWith({ connectionString: 'não é url' })), 'principal')
  assert.equal(databaseEnvironment(poolWith({})), 'principal')
  assert.notEqual(confirmationPhrases.principal, confirmationPhrases.homologacao)
})

test('grupos aceitos na limpeza', () => {
  assert.equal(isPurgeGroup('maintenance'), true)
  assert.equal(isPurgeGroup('auth_audit_events'), false)
  assert.equal(isPurgeGroup(undefined), false)
})
