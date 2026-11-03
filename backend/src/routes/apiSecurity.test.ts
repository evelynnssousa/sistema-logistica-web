import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import express from 'express'
import type { Pool } from 'pg'
import app from '../app.js'
import { setDatabasePoolForTests } from '../database/pool.js'
import { securityHeaders } from '../security/securityHeaders.js'

// Testa a API real com um pool falso: nenhum banco é acessado aqui.

type Row = Record<string, unknown>
type Call = { text: string; values: unknown[] }

const secret = 'senha-secreta-de-teste'

class FakeDatabase {
  calls: Call[] = []
  connections = 0
  existingUser: Row | null = null
  unavailable = false

  query = async (text: string, values: unknown[] = []) => {
    this.calls.push({ text, values })
    if (this.unavailable) throw new Error('banco indisponível')
    if (/SELECT[\s\S]*FROM public\.auth_users/.test(text)) {
      return this.existingUser
        ? { rows: [this.existingUser], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (/INSERT INTO public\.auth_users/.test(text)) {
      return { rows: [{ id: 'novo-usuario' }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }

  connect = async () => {
    this.connections += 1
    return { query: this.query, release: () => {} }
  }

  reset() {
    this.calls = []
    this.connections = 0
    this.existingUser = null
    this.unavailable = false
  }
}

const database = new FakeDatabase()
let server: Server
let baseUrl: string
let logs: string[] = []
const logMocks: Array<{ mock: { restore(): void } }> = []

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function failedLogin(identifier: string, headers?: Record<string, string>) {
  return post('/auth/login', { identifier, password: secret }, headers)
}

function registration(email: string) {
  return {
    fullName: 'Pessoa de Teste',
    email,
    sector: 'CPC',
    password: secret,
    passwordConfirmation: secret,
  }
}

before(async () => {
  setDatabasePoolForTests(database as unknown as Pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Sem endereço.')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise((done) => server.close(done))
})

beforeEach(() => {
  database.reset()
  logs = []
  for (const method of ['log', 'warn', 'error'] as const) {
    logMocks.push(
      mock.method(console, method, (...values: unknown[]) => {
        logs.push(values.map(String).join(' '))
      }),
    )
  }
})

afterEach(() => {
  while (logMocks.length) logMocks.pop()?.mock.restore()
})

test('JSON malformado responde em JSON, sem stack trace, e não vai para o log', async () => {
  const response = await post('/auth/login', `{"password":"${secret}",`)
  const text = await response.text()

  assert.equal(response.status, 400)
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  assert.doesNotMatch(text, /SyntaxError|node_modules|workspaces|at JSON/)
  assert.equal(text.includes(secret), false)
  assert.equal(logs.join().includes(secret), false)
})

test('corpo grande demais responde 413 em JSON', async () => {
  const response = await post('/auth/login', {
    identifier: 'a@example.gov.br',
    password: 'x'.repeat(200 * 1024),
  })

  assert.equal(response.status, 413)
  assert.deepEqual(await response.json(), {
    success: false,
    message: 'A requisição excede o tamanho permitido.',
  })
})

test('erro inesperado responde 500 genérico, sem expor a mensagem original', async () => {
  const testApp = express()
  const { errorHandler } = await import('../middleware/errorHandler.js')
  testApp.get('/falha', () => {
    throw new Error(`detalhe interno ${secret}`)
  })
  testApp.use(errorHandler)
  const testServer = testApp.listen(0, '127.0.0.1')
  await once(testServer, 'listening')
  const address = testServer.address()
  if (!address || typeof address === 'string') throw new Error('Sem endereço.')

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/falha`)
    const text = await response.text()

    assert.equal(response.status, 500)
    assert.equal(text.includes(secret), false)
    assert.equal(text.includes('Error'), false)
    assert.equal(logs.join().includes(secret), false)
    assert.match(logs.join(), /unhandled_error/)
  } finally {
    await new Promise((done) => testServer.close(done))
  }
})

test('rota inexistente responde 404: a guarda de administrador não alcança outras rotas', async () => {
  const response = await fetch(`${baseUrl}/api/rota-futura`)

  assert.equal(response.status, 404)
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
})

test('rotas administrativas continuam exigindo sessão', async () => {
  for (const path of [
    '/admin/registrations/pending',
    '/admin/registrations/qualquer/subrota',
  ]) {
    const response = await fetch(`${baseUrl}/api${path}`)
    assert.equal(response.status, 401, path)
  }
})

test('envia os cabeçalhos de segurança e não revela a tecnologia', async () => {
  const response = await fetch(`${baseUrl}/api/health`)
  const headers = response.headers

  assert.equal(headers.get('x-powered-by'), null)
  assert.equal(headers.get('x-content-type-options'), 'nosniff')
  assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.equal(headers.get('referrer-policy'), 'no-referrer')
  assert.equal(headers.get('cache-control'), 'no-store')
  assert.match(headers.get('content-security-policy') ?? '', /default-src 'none'/)
  assert.match(headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
  assert.equal(headers.get('strict-transport-security'), null)
})

test('HSTS só é enviado em produção', async () => {
  const testApp = express()
  testApp.use(securityHeaders({ NODE_ENV: 'production' }))
  testApp.get('/', (_request, response) => {
    response.json({})
  })
  const testServer = testApp.listen(0, '127.0.0.1')
  await once(testServer, 'listening')
  const address = testServer.address()
  if (!address || typeof address === 'string') throw new Error('Sem endereço.')

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`)
    assert.match(
      response.headers.get('strict-transport-security') ?? '',
      /max-age=\d+/,
    )
  } finally {
    await new Promise((done) => testServer.close(done))
  }
})

test('login bloqueia após 5 falhas, informa a espera e não afeta outra conta', async () => {
  const identifier = 'alvo@example.gov.br'

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await failedLogin(identifier)).status, 401)
  }

  const blocked = await failedLogin(identifier)
  assert.equal(blocked.status, 429)
  assert.match(blocked.headers.get('retry-after') ?? '', /^\d+$/)

  assert.equal((await failedLogin('outra@example.gov.br')).status, 401)
})

test('variar maiúsculas ou forjar X-Forwarded-For não contorna o limite', async () => {
  const identifier = 'forjado@example.gov.br'

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await failedLogin(attempt % 2 ? identifier.toUpperCase() : identifier, {
      'x-forwarded-for': `203.0.113.${attempt}`,
    })
  }

  const blocked = await failedLogin(identifier, {
    'x-forwarded-for': '198.51.100.7',
  })
  assert.equal(blocked.status, 429)
})

test('requisições simultâneas não ultrapassam o limite de login', async () => {
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => failedLogin('simultaneo@example.gov.br')),
  )
  const statuses = responses.map((response) => response.status)

  assert.equal(statuses.filter((status) => status === 401).length, 5)
  assert.equal(statuses.filter((status) => status === 429).length, 7)
})

test('falha de login é auditada e logada sem senha nem e-mail', async () => {
  const identifier = 'auditado@example.gov.br'
  assert.equal((await failedLogin(identifier)).status, 401)

  const audit = database.calls.find((call) =>
    /INSERT INTO public\.auth_audit_events/.test(call.text),
  )
  assert.ok(audit)
  assert.equal(audit.values[1], 'auth.login_failed')
  assert.equal(audit.values[5], 'failure')

  const recorded = JSON.stringify(audit.values) + logs.join()
  assert.equal(recorded.includes(secret), false)
  assert.equal(recorded.includes(identifier), false)
  assert.match(logs.join(), /login_failed/)
})

test('o limite atingido fica na auditoria uma única vez', async () => {
  const identifier = 'repetido@example.gov.br'
  for (let attempt = 0; attempt < 9; attempt += 1) {
    await failedLogin(identifier)
  }

  const events = database.calls.filter(
    (call) => call.values[1] === 'auth.login_rate_limited',
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].values[5], 'denied')
})

test('banco indisponível responde 503, sem contar como tentativa nem expor detalhes', async () => {
  database.unavailable = true
  const identifier = 'indisponivel@example.gov.br'

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await failedLogin(identifier)
    assert.equal(response.status, 503)
    assert.doesNotMatch(await response.text(), /banco indisponível/)
  }
  assert.equal(logs.join().includes('banco indisponível'), false)

  database.unavailable = false
  assert.equal((await failedLogin(identifier)).status, 401)
})

test('falha ao gravar a auditoria não muda a resposta do login', async () => {
  const original = database.query
  database.query = async (text, values = []) => {
    if (/auth_audit_events/.test(text)) throw new Error('auditoria fora do ar')
    return original(text, values)
  }

  try {
    const response = await failedLogin('sem-auditoria@example.gov.br')
    assert.equal(response.status, 401)
    assert.match(logs.join(), /audit_write_failed/)
  } finally {
    database.query = original
  }
})

test('saída sem sessão só limpa o cookie, com cookie seguro por padrão', async () => {
  const response = await post('/auth/logout', {})

  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie') ?? ''
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  assert.match(cookie, /Max-Age=0/)
})

test('cadastro responde igual para e-mail novo e já cadastrado', async () => {
  const created = await post('/auth/register', registration('novo@example.gov.br'))

  database.existingUser = { id: 'existente', status: 'approved' }
  const duplicate = await post('/auth/register', registration('novo@example.gov.br'))

  assert.equal(created.status, 202)
  assert.equal(duplicate.status, 202)
  assert.deepEqual(await created.json(), await duplicate.json())
})

test('recuperação responde igual para qualquer e-mail e sem expor a configuração', async () => {
  const first = await post('/auth/password-recovery/request', {
    email: 'existe@example.gov.br',
  })
  const second = await post('/auth/password-recovery/request', {
    email: 'nao-existe@example.gov.br',
  })

  assert.equal(first.status, 202)
  assert.equal(second.status, 202)
  assert.deepEqual(await first.json(), await second.json())
})

test('pedido de recuperação é limitado por e-mail', async () => {
  const email = 'limitado@example.gov.br'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(
      (await post('/auth/password-recovery/request', { email })).status,
      202,
    )
  }

  const blocked = await post('/auth/password-recovery/request', { email })
  assert.equal(blocked.status, 429)
  assert.ok(blocked.headers.get('retry-after'))
})

test('tentativas de redefinição são limitadas por e-mail', async () => {
  const body = {
    email: 'redefinir@example.gov.br',
    code: '123456',
    password: secret,
    passwordConfirmation: secret,
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal(
      (await post('/auth/password-recovery/reset', body)).status,
      400,
    )
  }

  assert.equal((await post('/auth/password-recovery/reset', body)).status, 429)
})

test('com banco remoto configurado, conta de teste não se cadastra nem entra, e o banco não é consultado', async () => {
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = 'postgresql://u:p@aws-0-exemplo.pooler.supabase.com:5432/postgres'

  try {
    const registered = await post('/auth/register', registration('nova-conta@example.gov.br'))
    assert.equal(registered.status, 400)
    assert.equal(database.connections, 0)

    database.existingUser = {
      id: 'conta-de-teste',
      role: 'operator',
      permissions: ['maintenance:write'],
      status: 'approved',
      password_hash: 'nao-usado',
    }
    const login = await failedLogin('sol-conta@example.gov.br')
    assert.equal(login.status, 401)
    assert.deepEqual(await login.json(), {
      success: false,
      message: 'E-mail ou senha inválidos.',
    })
    assert.equal(
      database.calls.some((call) => /FROM public\.auth_users/.test(call.text)),
      false,
      'a conta não chegou a ser procurada',
    )
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
})

// Por último: consome o limite de cadastros por IP deste processo.
test('cadastro é limitado por IP antes do hash, e dados inválidos não consomem o limite', async () => {
  const invalid = await post('/auth/register', { email: 'invalido' })
  assert.equal(invalid.status, 400)

  let accepted = 0
  let blocked: Response | undefined
  for (let attempt = 0; attempt < 25 && !blocked; attempt += 1) {
    const response = await post(
      '/auth/register',
      registration(`pessoa${attempt}@example.gov.br`),
    )
    if (response.status === 202) accepted += 1
    if (response.status === 429) blocked = response
  }

  assert.ok(blocked)
  assert.ok(blocked.headers.get('retry-after'))
  assert.ok(accepted <= 20)

  const connectionsWhenBlocked = database.connections
  await post('/auth/register', registration('depois@example.gov.br'))
  assert.equal(database.connections, connectionsWhenBlocked)
})
