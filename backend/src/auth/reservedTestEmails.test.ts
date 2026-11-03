import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isRemoteDatabaseConfigured,
  isReservedTestEmail,
  isTestAccountBlocked,
} from './reservedTestEmails.js'

const remote = { DATABASE_URL: 'postgresql://u:p@aws-0-exemplo.pooler.supabase.com:5432/postgres' }
const local = { DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/banco_test' }

test('reconhece os domínios reservados a testes', () => {
  for (const email of [
    'sol@example.gov.br',
    'OPE@EXAMPLE.GOV.BR',
    'x@sub.example.com',
    'x@slm-e2e.invalid',
    'x@x.test',
    'x@example.org',
  ]) {
    assert.equal(isReservedTestEmail(email), true, email)
  }

  for (const email of [
    'pessoa@jucesp.sp.gov.br',
    'pessoa@gmail.com',
    'x@notexample.com',
    'x@example.gov.br.outro.com',
    'test@jucesp.sp.gov.br',
  ]) {
    assert.equal(isReservedTestEmail(email), false, email)
  }
})

test('sem certeza de que o banco é local, trata como remoto', () => {
  assert.equal(isRemoteDatabaseConfigured(remote), true)
  assert.equal(isRemoteDatabaseConfigured(local), false)
  assert.equal(isRemoteDatabaseConfigured({}), false)
  assert.equal(isRemoteDatabaseConfigured({ DATABASE_URL: 'nao-e-url' }), true)
})

test('bloqueia conta de teste só em banco remoto', () => {
  assert.equal(isTestAccountBlocked('sol@example.gov.br', remote), true)
  assert.equal(isTestAccountBlocked('sol@example.gov.br', local), false)
  assert.equal(isTestAccountBlocked('pessoa@jucesp.sp.gov.br', remote), false)
})
