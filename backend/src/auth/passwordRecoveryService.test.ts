import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import {
  isPasswordRecoveryConfigured,
  processPasswordRecoveryRequest,
} from './passwordRecoveryService.js'

process.env.PASSWORD_RESET_PEPPER = 'pepper-de-teste'

const account = { id: 'user-id', email: 'pessoa@example.gov.br' }

function captureLogs() {
  const logs: string[] = []
  const warn = mock.method(console, 'warn', (line: string) => {
    logs.push(line)
  })
  return { logs, restore: () => warn.mock.restore() }
}

test('só considera configurado com segredo e e-mail definidos', () => {
  const complete = {
    PASSWORD_RESET_PEPPER: 'segredo',
    RESEND_API_KEY: 'chave',
    RESEND_FROM: 'sistema@example.gov.br',
  }

  assert.equal(isPasswordRecoveryConfigured(complete), true)
  for (const name of Object.keys(complete)) {
    assert.equal(
      isPasswordRecoveryConfigured({ ...complete, [name]: '  ' }),
      false,
    )
  }
})

test('sem configuração, não toca no banco e deixa o motivo no log', async () => {
  const { logs, restore } = captureLogs()
  let touched = false

  try {
    await processPasswordRecoveryRequest(account.email, {
      isConfigured: () => false,
      createCode: async () => {
        touched = true
        return account
      },
      invalidateCodes: async () => {},
      send: async () => {},
    })
  } finally {
    restore()
  }

  assert.equal(touched, false)
  assert.match(logs.join(), /password_recovery_unconfigured/)
})

test('envia o código original e guarda somente o hash', async () => {
  let storedHash = ''
  let sentCode = ''

  await processPasswordRecoveryRequest(account.email, {
    isConfigured: () => true,
    createCode: async (_email, codeHash) => {
      storedHash = codeHash
      return account
    },
    invalidateCodes: async () => {},
    send: async (_recipient, code) => {
      sentCode = code
    },
  })

  assert.match(sentCode, /^\d{6}$/)
  assert.match(storedHash, /^[0-9a-f]{64}$/)
  assert.equal(storedHash.includes(sentCode), false)
})

test('conta inexistente não recebe e-mail', async () => {
  let sent = false

  await processPasswordRecoveryRequest('ninguem@example.gov.br', {
    isConfigured: () => true,
    createCode: async () => null,
    invalidateCodes: async () => {},
    send: async () => {
      sent = true
    },
  })

  assert.equal(sent, false)
})

test('falha no e-mail invalida o código e não registra o código nem o endereço', async () => {
  const { logs, restore } = captureLogs()
  const invalidated: string[] = []
  let sentCode = ''

  try {
    await processPasswordRecoveryRequest(account.email, {
      isConfigured: () => true,
      createCode: async () => account,
      invalidateCodes: async (userId) => {
        invalidated.push(userId)
      },
      send: async (_recipient, code) => {
        sentCode = code
        throw new Error(`falha ao enviar ${code} para ${account.email}`)
      },
    })
  } finally {
    restore()
  }

  assert.deepEqual(invalidated, [account.id])
  assert.match(logs.join(), /password_recovery_email_failed/)
  assert.equal(logs.join().includes(sentCode), false)
  assert.equal(logs.join().includes(account.email), false)
})

test('tabela ausente no banco fica no log com o código do erro, sem rejeitar', async () => {
  const { logs, restore } = captureLogs()

  try {
    await processPasswordRecoveryRequest(account.email, {
      isConfigured: () => true,
      createCode: async () => {
        throw new Error('Falha de persistência.', {
          cause: Object.assign(
            new Error('relation "password_recovery_codes" does not exist'),
            { code: '42P01' },
          ),
        })
      },
      invalidateCodes: async () => {},
      send: async () => {},
    })
  } finally {
    restore()
  }

  assert.match(logs.join(), /password_recovery_failed/)
  assert.match(logs.join(), /42P01/)
})
