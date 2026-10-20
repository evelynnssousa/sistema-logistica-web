import assert from 'node:assert/strict'
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

test('rejects empty passwords and hashes that are not Argon2id', async () => {
  await assert.rejects(() => hashPassword(''))
  assert.equal(await verifyPassword('', '$argon2id$invalid'), false)
  assert.equal(await verifyPassword('password', '$argon2i$invalid'), false)
})