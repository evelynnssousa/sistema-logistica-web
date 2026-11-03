import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { Pool } from 'pg'
import app from '../app.js'
import { hashPassword } from '../auth/password.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'

// Simula a aplicação da migração 003 em um banco com dados, enquanto a API está no ar.
// Roda somente em um PostgreSQL descartável.

// Nova a cada execução: nenhuma credencial de teste fica no repositório.
const password = randomBytes(24).toString('hex')
let pool: Pool
let server: Server
let baseUrl: string
const ids: Record<string, string> = {}

async function applySchema(file: string) {
  const client = await pool.connect()
  await client.query(
    readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8'),
  )
  client.release(true)
}

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: email, password }),
  })
  const body = (await response.json()) as Record<string, any>
  return {
    status: response.status,
    cookie: (response.headers.get('set-cookie') ?? '').split(';')[0],
    csrf: body.csrfToken as string,
    user: body.user,
  }
}

async function me(cookie: string) {
  const response = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

before(async () => {
  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  await applySchema('001_public_schema_snapshot.sql')
  await applySchema('002_password_recovery.sql')
  resetAccessSchemaCacheForTests()

  const hash = await hashPassword(password)
  const accounts: Array<[string, string, string | null, string[], string]> = [
    ['admin', 'admin', 'admin', [], 'approved'],
    ['operador', 'operador', 'operator', ['maintenance:read', 'maintenance:write'], 'approved'],
    ['solicitante', 'solicitante', 'operator', ['maintenance:read'], 'approved'],
    ['cpf', 'cpf', 'operator', ['flights:read', 'flights:cpf:read'], 'approved'],
    ['configura', 'configura', 'operator', ['settings:write'], 'approved'],
    ['inativo', 'inativo', 'operator', ['maintenance:write'], 'inactive'],
    ['pendente', 'pendente', null, [], 'pending'],
    ['rejeitado', 'rejeitado', null, [], 'rejected'],
  ]
  for (const [key, name, role, permissions, status] of accounts) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO public.auth_users
        (full_name, email, sector, password_hash, status, role, permissions, decided_at)
       VALUES ($1, $2, 'CPC', $3, $4, $5, $6, CASE WHEN $4 = 'pending' THEN NULL ELSE now() END)
       RETURNING id::text AS id`,
      [`Pessoa ${name}`, `${name}@example.gov.br`, hash, status, role, permissions],
    )
    ids[key] = rows[0].id
  }

  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

test('antes da migração: login e permissões vêm das colunas antigas', async () => {
  const admin = await login('admin@example.gov.br')
  assert.equal(admin.status, 200)
  assert.equal(admin.user.role, 'administrator')
  assert.ok(admin.user.permissions.includes('users:manage'))

  assert.equal((await login('operador@example.gov.br')).user.role, 'slm_operator')
  assert.equal((await login('cpf@example.gov.br')).user.role, 'requester')
})

test('aplicar a 003 e a 004 preserva usuários, sessões, auditoria e acessos', async () => {
  const admin = await login('admin@example.gov.br')
  const operator = await login('operador@example.gov.br')
  const before = {
    users: await pool.query('SELECT id, email, status, role, permissions, password_hash FROM public.auth_users ORDER BY id'),
    sessions: await pool.query('SELECT session_token_hash, csrf_token_hash, expires_at FROM public.auth_sessions ORDER BY id'),
    audit: await pool.query('SELECT id, action FROM public.auth_audit_events ORDER BY id'),
  }

  await applySchema('003_user_access.sql')
  await applySchema('004_flight_passengers.sql')
  resetAccessSchemaCacheForTests()

  assert.deepEqual(
    (await pool.query('SELECT id, email, status, role, permissions, password_hash FROM public.auth_users ORDER BY id')).rows,
    before.users.rows,
  )
  assert.deepEqual(
    (await pool.query('SELECT session_token_hash, csrf_token_hash, expires_at FROM public.auth_sessions ORDER BY id')).rows,
    before.sessions.rows,
  )
  assert.deepEqual(
    (await pool.query('SELECT id, action FROM public.auth_audit_events ORDER BY id')).rows,
    before.audit.rows,
  )

  // Sessões abertas continuam valendo, com o mesmo perfil.
  const adminMe = await me(admin.cookie)
  assert.equal(adminMe.status, 200)
  assert.equal(adminMe.body.user.role, 'administrator')
  assert.equal((await me(operator.cookie)).body.user.role, 'slm_operator')
})

test('a migração classifica cada conta sem conceder privilégios novos', async () => {
  const { rows } = await pool.query<{
    user_id: string
    profile: string
    slm_member: boolean
    granted_permissions: string[]
  }>('SELECT user_id::text AS user_id, profile, slm_member, granted_permissions FROM public.auth_user_access')
  const byId = new Map(rows.map((row) => [row.user_id, row]))

  assert.equal(byId.get(ids.admin)?.profile, 'administrator')
  assert.equal(byId.get(ids.admin)?.slm_member, false)
  assert.deepEqual(byId.get(ids.admin)?.granted_permissions, [])

  assert.equal(byId.get(ids.operador)?.profile, 'slm_operator')
  assert.equal(byId.get(ids.operador)?.slm_member, true)

  assert.equal(byId.get(ids.solicitante)?.profile, 'requester')
  assert.equal(byId.get(ids.solicitante)?.slm_member, false)

  assert.equal(byId.get(ids.cpf)?.profile, 'requester')
  assert.deepEqual(byId.get(ids.cpf)?.granted_permissions, ['flights:cpf:read'])

  assert.deepEqual(byId.get(ids.configura)?.granted_permissions, ['settings:manage'])
  assert.equal(byId.get(ids.inativo)?.profile, 'slm_operator')

  assert.equal(byId.has(ids.pendente), false)
  assert.equal(byId.has(ids.rejeitado), false)
})

test('depois da migração, as mesmas contas entram com o mesmo perfil e a edição funciona', async () => {
  assert.equal((await login('solicitante@example.gov.br')).user.role, 'requester')
  const cpf = await login('cpf@example.gov.br')
  assert.ok(cpf.user.permissions.includes('flights:cpf:read'))
  assert.equal((await login('inativo@example.gov.br')).status, 401)

  // Conta criada pelo CLI de administrador depois da migração não tem linha na tabela nova.
  const hash = await hashPassword(password)
  await pool.query(
    `INSERT INTO public.auth_users
      (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Admin CLI', 'cli@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [hash],
  )
  assert.equal((await login('cli@example.gov.br')).user.role, 'administrator')

  const admin = await login('admin@example.gov.br')
  const response = await fetch(`${baseUrl}/api/admin/users/${ids.solicitante}/access`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      cookie: admin.cookie,
      'x-csrf-token': admin.csrf,
    },
    body: JSON.stringify({
      role: 'requester',
      slmMember: true,
      grantedPermissions: ['reports:read'],
      deniedPermissions: [],
    }),
  })
  assert.equal(response.status, 200)
})

test('desfazer a migração não afeta o restante', async () => {
  await pool.query('DROP TABLE public.auth_user_access')
  resetAccessSchemaCacheForTests()

  const admin = await login('admin@example.gov.br')
  assert.equal(admin.status, 200)
  assert.equal(admin.user.role, 'administrator')
  assert.equal((await login('solicitante@example.gov.br')).user.role, 'requester')
})
