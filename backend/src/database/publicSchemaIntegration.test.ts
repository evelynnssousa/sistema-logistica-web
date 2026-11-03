import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { Pool } from 'pg'
import app from '../app.js'
import { hashPassword } from '../auth/password.js'
import { hashPasswordRecoveryCode } from '../auth/passwordRecovery.js'
import { sessionCookieName } from '../auth/cookies.js'
import { setDatabasePoolForTests } from './pool.js'
import { PasswordRecoveryRepository } from './passwordRecoveryRepository.js'
import { AccountAuthorizationError, UserRepository } from './userRepository.js'

// Roda contra uma cópia vazia do esquema real, em um PostgreSQL descartável.
// Ver backend/database/POSTGRES_INTEGRATION_TESTS.md.

function testDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('Defina TEST_DATABASE_URL.')

  const { hostname, pathname } = new URL(url)
  if (
    !['127.0.0.1', 'localhost'].includes(hostname) ||
    !pathname.endsWith('_test')
  ) {
    throw new Error(
      'Recusado: o banco de teste precisa ser local e ter nome terminado em _test.',
    )
  }
  return url
}

const password = 'senha-de-teste-longa'
let pool: Pool
let server: Server
let baseUrl: string
let adminId: string

async function api(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  return {
    status: response.status,
    cookie,
    body: (await response.json()) as Record<string, any>,
  }
}

async function login(email: string) {
  return api('/auth/login', {
    method: 'POST',
    body: { identifier: email, password },
  })
}

async function register(email: string) {
  return api('/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Pessoa de Teste',
      email,
      sector: 'CPC',
      password,
      passwordConfirmation: password,
    },
  })
}

async function pendingId(email: string, cookie: string) {
  const { body } = await api('/admin/registrations/pending', { cookie })
  return body.registrations.find(
    (registration: { email: string }) => registration.email === email,
  )?.id as string
}

async function auditActions(targetUserId: string) {
  const { rows } = await pool.query<{ action: string }>(
    `SELECT action FROM public.auth_audit_events
      WHERE target_user_id = $1 ORDER BY id`,
    [targetUserId],
  )
  return rows.map((row) => row.action)
}

before(async () => {
  pool = new Pool({ connectionString: testDatabaseUrl() })

  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  const setup = await pool.connect()
  for (const file of ['001_public_schema_snapshot.sql', '002_password_recovery.sql']) {
    await setup.query(
      readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8'),
    )
  }
  // O snapshot esvazia o search_path; esta conexão não deve voltar ao pool assim.
  setup.release(true)

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO public.auth_users
      (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administrador', 'admin@example.gov.br', 'CPC', $1, 'approved', 'admin', now())
     RETURNING id::text AS id`,
    [await hashPassword(password)],
  )
  adminId = rows[0].id

  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await new Promise((done) => server.once('listening', done))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

test('login, sessão atual e saída funcionam e ficam auditados', async () => {
  const wrong = await api('/auth/login', {
    method: 'POST',
    body: { identifier: 'admin@example.gov.br', password: 'senha-incorreta-longa' },
  })
  assert.equal(wrong.status, 401)

  const signedIn = await login('ADMIN@example.gov.br')
  assert.equal(signedIn.status, 200)
  assert.equal(signedIn.body.user.role, 'administrator')
  assert.equal(signedIn.body.user.name, 'Administrador')
  assert.ok(signedIn.cookie.startsWith(`${sessionCookieName}=`))

  const me = await api('/auth/me', { cookie: signedIn.cookie })
  assert.equal(me.status, 200)
  assert.equal(me.body.user.email, 'admin@example.gov.br')

  assert.equal((await api('/auth/logout', { method: 'POST', cookie: signedIn.cookie })).status, 200)
  assert.equal((await api('/auth/me', { cookie: signedIn.cookie })).status, 401)

  const actions = await auditActions(adminId)
  assert.ok(actions.includes('auth.login'))
  assert.ok(actions.includes('auth.logout'))
})

test('login por nome de usuário é recusado sem erro interno', async () => {
  const response = await api('/auth/login', {
    method: 'POST',
    body: { identifier: 'admin', password },
  })
  assert.equal(response.status, 401)
})

test('senha scrypt gravada pela versão anterior continua entrando', async () => {
  const { scryptSync } = await import('node:crypto')
  const salt = Buffer.alloc(16, 3)
  const key = scryptSync(password, salt, 64, {
    N: 32_768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })
  await pool.query(
    `INSERT INTO public.auth_users
      (full_name, email, sector, password_hash, status, role, permissions, decided_at)
     VALUES ('Conta antiga', 'antiga@example.gov.br', 'CPC', $1, 'approved', 'operator',
             '{maintenance:read}', now())`,
    [['scrypt', 32_768, 8, 1, salt.toString('hex'), key.toString('hex')].join('$')],
  )

  const signedIn = await login('antiga@example.gov.br')
  assert.equal(signedIn.status, 200)
  assert.equal(signedIn.body.user.role, 'requester')
})

test('cadastro fica pendente, sem acesso, até a aprovação do administrador', async () => {
  const email = 'solicitante@example.gov.br'
  assert.equal((await register(email)).status, 202)
  assert.equal((await login(email)).status, 401)

  const admin = await login('admin@example.gov.br')
  const id = await pendingId(email, admin.cookie)
  assert.ok(id)

  const approved = await api(`/admin/registrations/${id}/approve`, {
    method: 'POST',
    cookie: admin.cookie,
    body: { role: 'requester' },
  })
  assert.equal(approved.status, 200)

  const signedIn = await login(email)
  assert.equal(signedIn.status, 200)
  assert.equal(signedIn.body.user.role, 'requester')

  const forbidden = await api('/admin/registrations/pending', { cookie: signedIn.cookie })
  assert.equal(forbidden.status, 403)

  const actions = await auditActions(id)
  assert.ok(actions.includes('registration.requested'))
  assert.ok(actions.includes('registration.approve'))
})

test('aprovação como operador SLM grava permissões de escrita, sem CPF', async () => {
  const email = 'operador@example.gov.br'
  await register(email)
  const admin = await login('admin@example.gov.br')
  const id = await pendingId(email, admin.cookie)

  await api(`/admin/registrations/${id}/approve`, {
    method: 'POST',
    cookie: admin.cookie,
    body: { role: 'slm_operator' },
  })

  assert.equal((await login(email)).body.user.role, 'slm_operator')
  const { rows } = await pool.query<{ role: string; permissions: string[] }>(
    'SELECT role, permissions FROM public.auth_users WHERE id = $1',
    [id],
  )
  assert.equal(rows[0].role, 'operator')
  assert.ok(rows[0].permissions.includes('maintenance:write'))
  assert.ok(!rows[0].permissions.includes('flights:cpf:read'))
})

test('rejeição impede o acesso e decidir de novo responde 409', async () => {
  const email = 'rejeitado@example.gov.br'
  await register(email)
  const admin = await login('admin@example.gov.br')
  const id = await pendingId(email, admin.cookie)

  const rejected = await api(`/admin/registrations/${id}/reject`, {
    method: 'POST',
    cookie: admin.cookie,
  })
  assert.equal(rejected.status, 200)
  assert.equal((await login(email)).status, 401)

  const again = await api(`/admin/registrations/${id}/reject`, {
    method: 'POST',
    cookie: admin.cookie,
  })
  assert.equal(again.status, 409)
})

test('identificadores inexistentes e inválidos respondem 404 e 400', async () => {
  const admin = await login('admin@example.gov.br')

  const missing = await api(
    '/admin/registrations/00000000-0000-4000-8000-000000000000/reject',
    { method: 'POST', cookie: admin.cookie },
  )
  assert.equal(missing.status, 404)

  const invalid = await api('/admin/registrations/nao-e-uuid/reject', {
    method: 'POST',
    cookie: admin.cookie,
  })
  assert.equal(invalid.status, 400)
})

test('e-mail já cadastrado responde 409, inclusive com maiúsculas', async () => {
  const response = await register('ADMIN@example.gov.br')
  assert.equal(response.status, 409)
})

test('rotas administrativas exigem sessão', async () => {
  const response = await api('/admin/registrations/pending')
  assert.equal(response.status, 401)
})

test('recuperação troca a senha uma vez e encerra as sessões', async () => {
  process.env.PASSWORD_RESET_PEPPER = 'pepper-de-teste'
  const email = 'operador@example.gov.br'
  const session = await login(email)
  const recovery = new PasswordRecoveryRepository(() => pool)
  const newPasswordHash = await hashPassword('nova-senha-de-teste')

  const account = await recovery.createCode(email, hashPasswordRecoveryCode('123456'))
  assert.ok(account)

  assert.equal(
    await recovery.resetPassword({ email, code: '654321', passwordHash: newPasswordHash }),
    false,
  )
  assert.equal(
    await recovery.resetPassword({ email, code: '123456', passwordHash: newPasswordHash }),
    true,
  )
  assert.equal(
    await recovery.resetPassword({ email, code: '123456', passwordHash: newPasswordHash }),
    false,
  )

  assert.equal((await api('/auth/me', { cookie: session.cookie })).status, 401)
  assert.equal((await login(email)).status, 401)
  const signedIn = await api('/auth/login', {
    method: 'POST',
    body: { identifier: email, password: 'nova-senha-de-teste' },
  })
  assert.equal(signedIn.status, 200)
})

test('recuperação ignora contas não aprovadas', async () => {
  const email = 'pendente@example.gov.br'
  await register(email)
  process.env.PASSWORD_RESET_PEPPER = 'pepper-de-teste'
  const recovery = new PasswordRecoveryRepository(() => pool)
  assert.equal(await recovery.createCode(email, hashPasswordRecoveryCode('123456')), null)
})

test('um administrador aprova outro, e os dois atuam ao mesmo tempo', async () => {
  const email = 'segundo-admin@example.gov.br'
  await register(email)
  const first = await login('admin@example.gov.br')
  const id = await pendingId(email, first.cookie)

  const approved = await api(`/admin/registrations/${id}/approve`, {
    method: 'POST',
    cookie: first.cookie,
    body: { role: 'administrator' },
  })
  assert.equal(approved.status, 200)

  const second = await login(email)
  assert.equal(second.body.user.role, 'administrator')

  // O segundo administrador decide um cadastro, com o primeiro ainda ativo.
  const other = 'aprovado-pelo-segundo@example.gov.br'
  await register(other)
  const otherId = await pendingId(other, second.cookie)
  const decided = await api(`/admin/registrations/${otherId}/approve`, {
    method: 'POST',
    cookie: second.cookie,
    body: { role: 'requester' },
  })
  assert.equal(decided.status, 200)
  assert.equal((await api('/auth/me', { cookie: first.cookie })).status, 200)

  const { rows } = await pool.query<{ decided_by: string }>(
    'SELECT decided_by::text AS decided_by FROM public.auth_users WHERE id = $1',
    [otherId],
  )
  assert.equal(rows[0].decided_by, id)

  const audit = await pool.query<{ role: string }>(
    `SELECT details->>'role' AS role FROM public.auth_audit_events
      WHERE target_user_id = $1 AND action = 'registration.approve'`,
    [id],
  )
  assert.equal(audit.rows[0].role, 'administrator')
})

test('perfil de aprovação desconhecido é recusado', async () => {
  const email = 'perfil-invalido@example.gov.br'
  await register(email)
  const admin = await login('admin@example.gov.br')
  const id = await pendingId(email, admin.cookie)

  const response = await api(`/admin/registrations/${id}/approve`, {
    method: 'POST',
    cookie: admin.cookie,
    body: { role: 'admin' },
  })
  assert.equal(response.status, 400)
})

test('administrador não remove o próprio acesso, então sempre resta um ativo', async () => {
  const users = new UserRepository(() => pool)
  const account = (await users.findActiveById(adminId))!
  const actor = { userId: adminId, role: 'administrator' as const }

  await assert.rejects(
    () =>
      users.updateUser(actor, adminId, {
        name: account.name,
        email: account.email,
        role: 'requester',
        isActive: true,
      }),
    AccountAuthorizationError,
  )
  await assert.rejects(
    () =>
      users.updateUser(actor, adminId, {
        name: account.name,
        email: account.email,
        role: 'administrator',
        isActive: false,
      }),
    AccountAuthorizationError,
  )
  assert.equal((await login('admin@example.gov.br')).status, 200)
})

test('um administrador pode desativar outro, e as sessões dele terminam', async () => {
  const email = 'admin-desativado@example.gov.br'
  await register(email)
  const first = await login('admin@example.gov.br')
  const id = await pendingId(email, first.cookie)
  await api(`/admin/registrations/${id}/approve`, {
    method: 'POST',
    cookie: first.cookie,
    body: { role: 'administrator' },
  })
  const target = await login(email)

  await new UserRepository(() => pool).updateUser(
    { userId: adminId, role: 'administrator' },
    id,
    { name: 'Pessoa de Teste', email, role: 'administrator', isActive: false },
  )

  assert.equal((await api('/auth/me', { cookie: target.cookie })).status, 401)
  assert.equal((await login(email)).status, 401)
  assert.equal((await login('admin@example.gov.br')).status, 200)
})
