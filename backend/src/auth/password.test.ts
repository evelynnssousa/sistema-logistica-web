import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { test } from 'node:test'
import { hashPassword, verifyPassword } from './password.js'

test('hashes passwords with Argon2id and verifies only the matching password', async () => {
  const password = 'local-test-password'
  const encodedHash = await hashPassword(password)

  assert.match(encodedHash, /^\$argon2id\$/)
  assert.notEqual(encodedHash, password)
  assert.equal(await verifyPassword(password, encodedHash), true)
  assert.equal(await verifyPassword('different-password', encodedHash), false)
})

test('rejects empty passwords and unsupported hash formats', async () => {
  await assert.rejects(() => hashPassword(''))
  assert.equal(await verifyPassword('', '$argon2id$invalid'), false)
  assert.equal(await verifyPassword('password', '$argon2i$invalid'), false)
  assert.equal(await verifyPassword('password', 'scrypt$invalid'), false)
})

test('verifies scrypt hashes written by the previous version of the system', async () => {
  const salt = Buffer.alloc(16, 7)
  const key = scryptSync('local-test-password', salt, 64, {
    N: 32_768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })
  const stored = ['scrypt', 32_768, 8, 1, salt.toString('hex'), key.toString('hex')].join('$')

  assert.equal(await verifyPassword('local-test-password', stored), true)
  assert.equal(await verifyPassword('different-password', stored), false)
})
