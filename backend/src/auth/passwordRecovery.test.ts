import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  generatePasswordRecoveryCode,
  hashPasswordRecoveryCode,
  verifyPasswordRecoveryCode,
} from './passwordRecovery.js'

test('generates six-digit recovery codes, including leading zeros', () => {
  for (let i = 0; i < 100; i += 1) {
    assert.match(generatePasswordRecoveryCode(), /^\d{6}$/)
  }
})

test('hashes a code without storing the original code', () => {
  const hash = hashPasswordRecoveryCode('012345', 'test-pepper')

  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.notEqual(hash, '012345')
  assert.equal(
    verifyPasswordRecoveryCode('012345', hash, 'test-pepper'),
    true,
  )
})

test('rejects incorrect codes and incorrect secrets', () => {
  const hash = hashPasswordRecoveryCode('123456', 'test-pepper')

  assert.equal(
    verifyPasswordRecoveryCode('654321', hash, 'test-pepper'),
    false,
  )
  assert.equal(
    verifyPasswordRecoveryCode('123456', hash, 'another-pepper'),
    false,
  )
  assert.equal(
    verifyPasswordRecoveryCode('12345', hash, 'test-pepper'),
    false,
  )
  assert.equal(
    verifyPasswordRecoveryCode('123456', 'invalid', 'test-pepper'),
    false,
  )
})

test('does not generate a hash without a configured secret', () => {
  assert.throws(
    () => hashPasswordRecoveryCode('123456', ''),
    /Segredo de recuperação não configurado/,
  )
})
