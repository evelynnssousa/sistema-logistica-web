import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
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
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'
import { PasswordRecoveryRepository } from './passwordRecoveryRepository.js'
import { SessionService } from '../auth/session.js'
import { PostgresSessionStore } from './postgresSessionStore.js'

// Roda contra uma cópia vazia do esquema real, em um PostgreSQL descartável, ainda
// sem as migrações 003 e 004, como está o banco real hoje.
// Ver backend/database/POSTGRES_INTEGRATION_TESTS.md.

// Nova a cada execução: nenhuma credencial de teste fica no repositório.
const password = randomBytes(24).toString('hex')
let pool: Pool
let server: Server
let baseUrl: string
let adminId: string

// Token de CSRF de cada sessão, recebido no login, como faz a tela.
const csrfTokens = new Map<string, string>()

async function api(
  path: string,
  options: {
    method?: string
    body?: unknown
    cookie?: string
    csrf?: string | null
  } = {},
) {
  const csrf =
    options.csrf !== undefined
      ? options.csrf
      : options.cookie && options.method === 'POST'
        ? csrfTokens.get(options.cookie)
        : null
  const response = await fetch(`${baseUrl}/api${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  const body = (await response.json()) as Record<string, any>
  if (cookie && body.csrfToken) csrfTokens.set(cookie, body.csrfToken)
  return { status: response.status, cookie, body }
}

async function login(email: string) {
  return api('/auth/login', {
    method: 'POST',
    body: { identifier: email, password },
  })
}

async function register(email: string, chosenPassword = password) {
  return api('/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Pessoa de Teste',
      email,
      sector: 'CPC',
      password: chosenPassword,
      passwordConfirmation: chosenPassword,
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
  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })

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

  const operator = await login(email)
  assert.equal(operator.body.user.role, 'slm_operator')
  assert.equal(operator.body.user.slmMember, false, 'sem a 003, ninguém é da equipe SLM')
  assert.equal(operator.body.user.permissions.includes('requests:schedule'), false)
  assert.equal(operator.body.user.permissions.includes('requests:create_on_behalf'), false)
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

test('e-mail já cadastrado responde igual a um novo e não altera a conta', async () => {
  const before = await pool.query<{ password_hash: string; status: string }>(
    `SELECT password_hash, status FROM public.auth_users WHERE id = $1`,
    [adminId],
  )

  const fresh = await register('email-inedito@example.gov.br')
  const duplicate = await register('ADMIN@example.gov.br', 'outra-senha-de-teste')
  assert.equal(duplicate.status, 202)
  assert.deepEqual(duplicate.body, fresh.body)

  const after = await pool.query<{ password_hash: string; status: string }>(
    `SELECT password_hash, status FROM public.auth_users WHERE id = $1`,
    [adminId],
  )
  assert.deepEqual(after.rows, before.rows)
  assert.ok((await auditActions(adminId)).includes('registration.duplicate'))
  assert.equal((await login('admin@example.gov.br')).status, 200)
})

test('cadastro pendente não é sobrescrito por outro pedido com o mesmo e-mail', async () => {
  const email = 'pendente-unico@example.gov.br'
  await register(email)
  const before = await pool.query<{ password_hash: string }>(
    'SELECT password_hash FROM public.auth_users WHERE email = $1',
    [email],
  )

  assert.equal((await register(email, 'senha-de-outra-pessoa')).status, 202)

  const after = await pool.query<{ password_hash: string }>(
    'SELECT password_hash FROM public.auth_users WHERE email = $1',
    [email],
  )
  assert.deepEqual(after.rows, before.rows)
})

test('e-mail rejeitado pode pedir de novo, na mesma conta e preservando o histórico', async () => {
  const email = 'nova-chance@example.gov.br'
  const newPassword = 'senha-do-novo-pedido'
  await register(email)
  const admin = await login('admin@example.gov.br')
  const id = await pendingId(email, admin.cookie)
  await api(`/admin/registrations/${id}/reject`, {
    method: 'POST',
    cookie: admin.cookie,
  })

  const again = await register(email.toUpperCase(), newPassword)
  assert.equal(again.status, 202)

  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT id::text AS id, status, role, decided_by, decided_at
       FROM public.auth_users WHERE lower(email) = $1`,
    [email],
  )
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    id,
    status: 'pending',
    role: null,
    decided_by: null,
    decided_at: null,
  })

  const actions = await auditActions(id)
  assert.deepEqual(actions, [
    'registration.requested',
    'registration.reject',
    'registration.resubmitted',
  ])
  const details = await pool.query<{ by: string; at: string }>(
    `SELECT details->>'previousDecidedBy' AS by, details->>'previousDecidedAt' AS at
       FROM public.auth_audit_events
      WHERE target_user_id = $1 AND action = 'registration.resubmitted'`,
    [id],
  )
  assert.equal(details.rows[0].by, adminId)
  assert.ok(details.rows[0].at)

  // Continua sem acesso até nova decisão, e a nova decisão pode ser tomada.
  const pendingLogin = await api('/auth/login', {
    method: 'POST',
    body: { identifier: email, password: newPassword },
  })
  assert.equal(pendingLogin.status, 401)
  assert.equal(await pendingId(email, admin.cookie), id)

  const approved = await api(`/admin/registrations/${id}/approve`, {
    method: 'POST',
    cookie: admin.cookie,
    body: { role: 'requester' },
  })
  assert.equal(approved.status, 200)

  const signedIn = await api('/auth/login', {
    method: 'POST',
    body: { identifier: email, password: newPassword },
  })
  assert.equal(signedIn.status, 200)
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
  const admin = await login('admin@example.gov.br')

  const demoted = await api(`/admin/users/${adminId}/access`, {
    method: 'PUT',
    cookie: admin.cookie,
    csrf: admin.body.csrfToken,
    body: {
      role: 'requester',
      slmMember: false,
      grantedPermissions: [],
      deniedPermissions: [],
    },
  })
  assert.equal(demoted.status, 403)

  const deactivated = await api(`/admin/users/${adminId}/deactivate`, {
    method: 'POST',
    cookie: admin.cookie,
  })
  assert.equal(deactivated.status, 403)
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

  const deactivated = await api(`/admin/users/${id}/deactivate`, {
    method: 'POST',
    cookie: first.cookie,
  })
  assert.equal(deactivated.status, 200)

  assert.equal((await api('/auth/me', { cookie: target.cookie })).status, 401)
  assert.equal((await login(email)).status, 401)
  assert.equal((await login('admin@example.gov.br')).status, 200)
})

test('sem a migração 003, a edição de acesso avisa e o restante continua funcionando', async () => {
  const email = 'sem-migracao@example.gov.br'
  await register(email)
  const admin = await login('admin@example.gov.br')
  const id = await pendingId(email, admin.cookie)
  await api(`/admin/registrations/${id}/approve`, {
    method: 'POST',
    cookie: admin.cookie,
    body: { role: 'requester' },
  })

  const access = await api(`/admin/users/${id}/access`, {
    method: 'PUT',
    cookie: admin.cookie,
    csrf: admin.body.csrfToken,
    body: {
      role: 'slm_operator',
      slmMember: true,
      grantedPermissions: [],
      deniedPermissions: [],
    },
  })
  assert.equal(access.status, 503)
  assert.equal(access.body.code, 'ACCESS_MIGRATION_REQUIRED')

  const list = await api(`/admin/users?search=${encodeURIComponent(email)}`, {
    cookie: admin.cookie,
  })
  assert.equal(list.status, 200)
  assert.equal(list.body.users[0].role, 'requester')

  const signedIn = await login(email)
  assert.ok(signedIn.body.user.permissions.includes('requests:create'))
  assert.ok(!signedIn.body.user.permissions.includes('requests:read_all'))
})

test('ações administrativas exigem o token de CSRF da própria sessão', async () => {
  const email = 'csrf@example.gov.br'
  await register(email)
  const admin = await login('admin@example.gov.br')
  const otherSession = await login('admin@example.gov.br')
  const id = await pendingId(email, admin.cookie)
  const path = `/admin/registrations/${id}/approve`
  const body = { role: 'requester' }

  const missing = await api(path, {
    method: 'POST',
    cookie: admin.cookie,
    body,
    csrf: null,
  })
  assert.equal(missing.status, 403)
  assert.equal(missing.body.code, 'CSRF_INVALID')

  const fromOtherSession = await api(path, {
    method: 'POST',
    cookie: admin.cookie,
    body,
    csrf: otherSession.body.csrfToken,
  })
  assert.equal(fromOtherSession.status, 403)

  assert.equal(await pendingId(email, admin.cookie), id)

  const valid = await api(path, { method: 'POST', cookie: admin.cookie, body })
  assert.equal(valid.status, 200)
})

test('o token volta igual ao recarregar a página, e o banco guarda só os hashes', async () => {
  const admin = await login('admin@example.gov.br')
  const me = await api('/auth/me', { cookie: admin.cookie })
  assert.equal(me.body.csrfToken, admin.body.csrfToken)

  const sessionToken = admin.cookie.split('=')[1]
  const { rows } = await pool.query<Record<string, string>>(
    `SELECT session_token_hash, csrf_token_hash FROM public.auth_sessions`,
  )
  const stored = JSON.stringify(rows)
  assert.equal(stored.includes(sessionToken), false)
  assert.equal(stored.includes(admin.body.csrfToken), false)
})

test('sair exige CSRF e encerra a sessão no servidor, mesmo que o cookie continue', async () => {
  const admin = await login('admin@example.gov.br')

  const refused = await api('/auth/logout', {
    method: 'POST',
    cookie: admin.cookie,
    csrf: null,
  })
  assert.equal(refused.status, 403)
  assert.equal((await api('/auth/me', { cookie: admin.cookie })).status, 200)

  const done = await api('/auth/logout', { method: 'POST', cookie: admin.cookie })
  assert.equal(done.status, 200)
  assert.match(done.cookie, /^slm_session=$/)

  // O cookie antigo, reenviado, não dá mais acesso.
  assert.equal((await api('/auth/me', { cookie: admin.cookie })).status, 401)
  const again = await api('/auth/logout', {
    method: 'POST',
    cookie: admin.cookie,
    csrf: null,
  })
  assert.equal(again.status, 200)
})

test('login recusado fica auditado, sem senha nem e-mail digitado', async () => {
  const typedPassword = 'senha-digitada-errada'
  const response = await api('/auth/login', {
    method: 'POST',
    body: { identifier: 'admin@example.gov.br', password: typedPassword },
  })
  assert.equal(response.status, 401)

  const unknownEmail = 'desconhecido-total@example.gov.br'
  const unknown = await api('/auth/login', {
    method: 'POST',
    body: { identifier: unknownEmail, password: typedPassword },
  })
  assert.equal(unknown.status, 401)
  assert.deepEqual(unknown.body, response.body)

  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT target_user_id::text AS target, result, details
       FROM public.auth_audit_events
      WHERE action = 'auth.login_failed'
      ORDER BY id DESC
      LIMIT 2`,
  )
  assert.equal(rows[0].result, 'failure')
  assert.equal(rows[0].target, null)
  assert.equal(rows[1].target, adminId)

  const stored = JSON.stringify(rows)
  assert.equal(stored.includes(typedPassword), false)
  assert.equal(stored.includes(unknownEmail), false)

  // O acerto seguinte limpa a contagem da conta.
  assert.equal((await login('admin@example.gov.br')).status, 200)
})

test('após o limite, nem a senha correta entra, e o bloqueio fica auditado', async () => {
  const email = 'bloqueado@example.gov.br'
  await register(email)
  const admin = await login('admin@example.gov.br')
  const id = await pendingId(email, admin.cookie)
  await api(`/admin/registrations/${id}/approve`, {
    method: 'POST',
    cookie: admin.cookie,
    body: { role: 'requester' },
  })

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await api('/auth/login', {
      method: 'POST',
      body: { identifier: email, password: 'senha-errada-repetida' },
    })
    assert.equal(failed.status, 401)
  }

  assert.equal((await login(email)).status, 429)
  assert.ok((await auditActions(id)).includes('auth.login_rate_limited'))
})

test('sessão inativa termina, e a limpeza remove só sessões vencidas, sem tocar na auditoria', async () => {
  const idle = await login('admin@example.gov.br')
  const idleHash = createHash('sha256')
    .update(idle.cookie.split('=')[1])
    .digest('hex')
  await pool.query(
    `UPDATE public.auth_sessions
        SET last_seen_at = now() - interval '3 hours'
      WHERE session_token_hash = $1`,
    [idleHash],
  )
  assert.equal((await api('/auth/me', { cookie: idle.cookie })).status, 401)

  const { rows: ended } = await pool.query<{ reason: string }>(
    `SELECT details->>'reason' AS reason FROM public.auth_audit_events
      WHERE action = 'auth.logout' ORDER BY id DESC LIMIT 1`,
  )
  assert.equal(ended[0].reason, 'idle_timeout')

  const active = await login('admin@example.gov.br')
  const expired = await login('admin@example.gov.br')
  const stale = await login('admin@example.gov.br')
  const hashOf = (cookie: string) =>
    createHash('sha256').update(cookie.split('=')[1]).digest('hex')
  await pool.query(
    `UPDATE public.auth_sessions
        SET created_at = now() - interval '9 hours',
            expires_at = now() - interval '1 hour'
      WHERE session_token_hash = $1`,
    [hashOf(expired.cookie)],
  )
  await pool.query(
    `UPDATE public.auth_sessions
        SET last_seen_at = now() - interval '3 hours'
      WHERE session_token_hash = $1`,
    [hashOf(stale.cookie)],
  )

  const auditBefore = await pool.query<{ total: number }>(
    'SELECT count(*)::int AS total FROM public.auth_audit_events',
  )
  const store = new PostgresSessionStore(() => pool)
  const service = new SessionService(store)
  assert.ok((await service.purgeExpired()) >= 2)

  const remaining = await pool.query<{ session_token_hash: string }>(
    'SELECT session_token_hash FROM public.auth_sessions',
  )
  const hashes = remaining.rows.map((row) => row.session_token_hash)
  assert.ok(hashes.includes(hashOf(active.cookie)))
  assert.ok(!hashes.includes(hashOf(expired.cookie)))
  assert.ok(!hashes.includes(hashOf(stale.cookie)))

  const auditAfter = await pool.query<{ total: number }>(
    'SELECT count(*)::int AS total FROM public.auth_audit_events',
  )
  assert.equal(auditAfter.rows[0].total, auditBefore.rows[0].total)
})

test('recuperação: validade de 10 minutos, erros auditados e bloqueio em 5 tentativas', async () => {
  process.env.PASSWORD_RESET_PEPPER = 'pepper-de-teste'
  const email = 'bloqueado@example.gov.br'
  const recovery = new PasswordRecoveryRepository(() => pool)
  const passwordHash = await hashPassword('nova-senha-de-teste')
  const account = await recovery.createCode(email, hashPasswordRecoveryCode('123456'))
  assert.ok(account)

  const { rows } = await pool.query<{ minutes: number }>(
    `SELECT extract(epoch FROM expires_at - created_at) / 60 AS minutes
       FROM public.password_recovery_codes
      WHERE user_id = $1 AND consumed_at IS NULL`,
    [account.id],
  )
  assert.equal(Math.round(Number(rows[0].minutes)), 10)

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(
      await recovery.resetPassword({ email, code: '000000', passwordHash }),
      false,
    )
  }
  assert.equal(
    await recovery.resetPassword({ email, code: '123456', passwordHash }),
    false,
    'o código certo não vale depois de 5 erros',
  )

  const actions = await auditActions(account.id)
  assert.equal(
    actions.filter((action) => action === 'auth.password_recovery_failed').length,
    5,
  )
})
