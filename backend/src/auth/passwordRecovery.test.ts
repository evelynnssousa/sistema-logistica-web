import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import {
  assertPasswordResetPepperForStartup,
  generatePasswordRecoveryCode,
  generatePasswordRecoveryToken,
  hashPasswordRecoveryCode,
  hashPasswordRecoveryToken,
  isPasswordResetPepperUsable,
  passwordResetPepperProblem,
  verifyPasswordRecoveryCode,
} from './passwordRecovery.js'

// Segredos fictícios, gerados na hora: nenhum valor real de ambiente é lido.
const strongPepper = () => randomBytes(32).toString('hex')

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

test('pepper com espaços ou quebras de linha nas extremidades gera o mesmo HMAC', () => {
  const pepper = strongPepper()
  const padded = `  \t${pepper}\r\n`
  const code = '024680'
  const token = generatePasswordRecoveryToken()

  assert.equal(hashPasswordRecoveryCode(code, padded), hashPasswordRecoveryCode(code, pepper))
  assert.equal(hashPasswordRecoveryToken(token, padded), hashPasswordRecoveryToken(token, pepper))
  // Código gravado com um valor e conferido com o outro: as solicitações seguem válidas.
  assert.equal(verifyPasswordRecoveryCode(code, hashPasswordRecoveryCode(code, pepper), padded), true)
  assert.equal(verifyPasswordRecoveryCode(code, hashPasswordRecoveryCode(code, padded), pepper), true)
  assert.equal(passwordResetPepperProblem(padded), null)
})

test('o HMAC de um pepper sem espaços não muda (algoritmo e formato preservados)', async () => {
  const { createHmac } = await import('node:crypto')
  const pepper = strongPepper()
  const token = generatePasswordRecoveryToken()
  assert.equal(hashPasswordRecoveryCode('135790', pepper), createHmac('sha256', pepper).update('135790', 'utf8').digest('hex'))
  assert.equal(hashPasswordRecoveryToken(token, pepper), createHmac('sha256', pepper).update(`link:${token}`, 'utf8').digest('hex'))
})

test('pepper ausente ou só com espaços: sem HMAC e recuperação desligada', () => {
  for (const pepper of [undefined, '', '   ', '\n\t ']) {
    assert.equal(passwordResetPepperProblem(pepper), 'ausente')
    assert.throws(() => hashPasswordRecoveryCode('123456', pepper), /Segredo de recuperação não configurado/)
    assert.throws(
      () => hashPasswordRecoveryToken(generatePasswordRecoveryToken(), pepper),
      /Segredo de recuperação não configurado/,
    )
    for (const NODE_ENV of ['production', 'development', 'test']) {
      assert.equal(isPasswordResetPepperUsable({ NODE_ENV, PASSWORD_RESET_PEPPER: pepper }), false)
      // Ausente não impede o início: só desliga a recuperação.
      assert.doesNotThrow(() => assertPasswordResetPepperForStartup({ NODE_ENV, PASSWORD_RESET_PEPPER: pepper }))
    }
  }
})

test('pepper com menos de 32 caracteres: recusado em produção, depois de remover os espaços', () => {
  const short = 'a'.repeat(31)
  // 31 caracteres com espaços em volta continua curto: os espaços não contam.
  for (const pepper of [short, `   ${short}   `, 'curto']) {
    assert.match(passwordResetPepperProblem(pepper) ?? '', /ao menos 32/)
    assert.equal(isPasswordResetPepperUsable({ NODE_ENV: 'production', PASSWORD_RESET_PEPPER: pepper }), false)
    // Fora de produção continua aceito, como nos testes e no ambiente local.
    assert.equal(isPasswordResetPepperUsable({ NODE_ENV: 'development', PASSWORD_RESET_PEPPER: pepper }), true)
  }
  assert.equal(passwordResetPepperProblem('a'.repeat(32)), null)
})

test('inicialização em produção com pepper curto falha, sem expor o valor', () => {
  const short = 'valor-curto-ficticio'
  assert.throws(
    () => assertPasswordResetPepperForStartup({ NODE_ENV: 'production', PASSWORD_RESET_PEPPER: `${short}\n` }),
    (error: Error) => {
      assert.match(error.message, /PASSWORD_RESET_PEPPER precisa ter ao menos 32 caracteres/)
      assert.equal(error.message.includes(short), false)
      return true
    },
  )
  // Válido em produção, ou curto fora dela: inicia.
  assert.doesNotThrow(() => assertPasswordResetPepperForStartup({ NODE_ENV: 'production', PASSWORD_RESET_PEPPER: ` ${strongPepper()} ` }))
  assert.doesNotThrow(() => assertPasswordResetPepperForStartup({ NODE_ENV: 'development', PASSWORD_RESET_PEPPER: short }))
  assert.doesNotThrow(() => assertPasswordResetPepperForStartup({ NODE_ENV: 'test', PASSWORD_RESET_PEPPER: short }))
})
