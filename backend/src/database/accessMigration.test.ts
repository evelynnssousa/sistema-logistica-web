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

// Estrutura do schema, sem a tabela da 004, para comparar antes e depois da 003.
async function structure() {
  const columns = await pool.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'flight_request_passengers'
      ORDER BY 1, 2`,
  )
  const triggers = await pool.query(
    `SELECT t.tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal AND c.relname <> 'flight_request_passengers'
      ORDER BY 1, 2`,
  )
  const functions = await pool.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' ORDER BY 1`,
  )
  return { columns: columns.rows, triggers: triggers.rows, functions: functions.rows }
}

let structureBefore: Awaited<ReturnType<typeof structure>>

async function applySchema(file: string) {
  // Conexão própria, descartada ao final: a migração que falha deixa a transação aberta.
  const client = await pool.connect()
  try {
    await client.query(
      readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8'),
    )
  } finally {
    client.release(true)
  }
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
  // Os papéis do Supabase existem no banco real: a migração precisa retirar o acesso deles.
  await pool.query(`DO $roles$
    DECLARE api_role name;
    BEGIN
      FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
          EXECUTE format('CREATE ROLE %I NOLOGIN', api_role);
        END IF;
      END LOOP;
    END $roles$`)
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
    // Mesma composição da conta fictícia do banco real: inativa, com as permissões antigas.
    ['sol', 'sol', 'operator', [
      'maintenance:read', 'fleet:read', 'flights:read', 'warehouse:read',
      'maintenance:write', 'fleet:write', 'flights:write', 'warehouse:write',
    ], 'inactive'],
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

test('antes da migração: as colunas antigas valem, mas ninguém é da equipe SLM', async () => {
  const admin = await login('admin@example.gov.br')
  assert.equal(admin.status, 200)
  assert.equal(admin.user.role, 'administrator')
  assert.ok(admin.user.permissions.includes('users:manage'))
  assert.equal(admin.user.permissions.includes('flights:cpf:read'), false)

  const operator = await login('operador@example.gov.br')
  assert.equal(operator.user.role, 'slm_operator')
  assert.equal(operator.user.slmMember, false)
  assert.equal(operator.user.permissions.includes('requests:schedule'), false)
  assert.equal(operator.user.permissions.includes('warehouse:manage'), false)

  const cpf = await login('cpf@example.gov.br')
  assert.equal(cpf.user.role, 'requester')
  assert.equal(cpf.user.permissions.includes('flights:cpf:read'), false)
})

test('a 003 é interrompida se houver operador ativo com escrita, sem deixar resíduos', async () => {
  structureBefore = await structure()

  await assert.rejects(
    () => applySchema('003_user_access.sql'),
    /operadores ativos com permissão de escrita/,
  )

  assert.deepEqual(await structure(), structureBefore)
  const table = await pool.query(`SELECT to_regclass('public.auth_user_access') AS t`)
  assert.equal(table.rows[0].t, null)
})

test('resolvido o bloqueio, a 003 e a 004 preservam usuários, sessões e auditoria', async () => {
  await pool.query(`UPDATE public.auth_users SET status = 'inactive' WHERE id = $1`, [ids.operador])

  const admin = await login('admin@example.gov.br')
  const requester = await login('solicitante@example.gov.br')
  const before = {
    users: await pool.query('SELECT id, email, status, role, permissions, password_hash, updated_at FROM public.auth_users ORDER BY id'),
    sessions: await pool.query('SELECT session_token_hash, csrf_token_hash, expires_at FROM public.auth_sessions ORDER BY id'),
    audit: await pool.query('SELECT id, action FROM public.auth_audit_events ORDER BY id'),
  }

  await applySchema('003_user_access.sql')
  await applySchema('004_flight_passengers.sql')
  resetAccessSchemaCacheForTests()

  assert.deepEqual(
    (await pool.query('SELECT id, email, status, role, permissions, password_hash, updated_at FROM public.auth_users ORDER BY id')).rows,
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
  assert.equal((await me(requester.cookie)).body.user.role, 'requester')
})

test('o backfill não inclui ninguém na SLM nem concede permissões especiais', async () => {
  const { rows } = await pool.query<{
    user_id: string
    profile: string
    slm_member: boolean
    granted_permissions: string[]
    denied_permissions: string[]
  }>('SELECT user_id::text AS user_id, profile, slm_member, granted_permissions, denied_permissions FROM public.auth_user_access')
  const byId = new Map(rows.map((row) => [row.user_id, row]))

  assert.equal(rows.some((row) => row.slm_member), false, 'ninguém na equipe SLM')
  assert.equal(
    rows.some((row) => row.granted_permissions.some((permission) =>
      ['requests:schedule', 'requests:create_on_behalf', 'flights:cpf:read', 'warehouse:manage'].includes(permission),
    )),
    false,
    'nenhuma concessão especial ou de armazém',
  )

  assert.equal(byId.get(ids.admin)?.profile, 'administrator')
  assert.deepEqual(byId.get(ids.admin)?.granted_permissions, [])

  assert.equal(byId.get(ids.solicitante)?.profile, 'requester')
  assert.equal(byId.get(ids.cpf)?.profile, 'requester')
  assert.deepEqual(byId.get(ids.cpf)?.granted_permissions, [])
  assert.deepEqual(byId.get(ids.configura)?.granted_permissions, ['settings:manage'])

  assert.equal(byId.has(ids.pendente), false)
  assert.equal(byId.has(ids.rejeitado), false)
})

test('conta inativa como a de Sol Citante fica como está: inativa, fora da SLM e sem concessões', async () => {
  const { rows } = await pool.query(
    `SELECT a.profile, a.slm_member, a.granted_permissions, a.denied_permissions,
            u.status, u.role, u.permissions
       FROM public.auth_users u JOIN public.auth_user_access a ON a.user_id = u.id
      WHERE u.id = $1`,
    [ids.sol],
  )
  assert.equal(rows[0].profile, 'requester')
  assert.equal(rows[0].slm_member, false)
  assert.deepEqual(rows[0].granted_permissions, [])
  assert.deepEqual(rows[0].denied_permissions, [])

  assert.equal(rows[0].status, 'inactive', 'continua inativa')
  assert.equal(rows[0].role, 'operator', 'auth_users não foi alterada')
  assert.equal(rows[0].permissions.length, 8)

  const signedIn = await login('sol@example.gov.br')
  assert.equal(signedIn.status, 401)
})

test('a tabela e a função novas ficam fora do alcance da API pública', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const { rows } = await pool.query(
      `SELECT has_table_privilege($1, 'public.auth_user_access', 'SELECT') AS leitura,
              has_table_privilege($1, 'public.auth_user_access', 'UPDATE') AS escrita,
              has_function_privilege($1, 'public.assert_user_access_coherent()', 'EXECUTE') AS execucao`,
      [role],
    )
    assert.deepEqual(rows[0], { leitura: false, escrita: false, execucao: false }, role)
  }

  const rls = await pool.query(
    `SELECT relrowsecurity AS ativo FROM pg_class WHERE oid = 'public.auth_user_access'::regclass`,
  )
  assert.equal(rls.rows[0].ativo, true)
})

test('a consulta de divergências do pós-migração não aponta nenhuma conta', async () => {
  const { rows } = await pool.query(
    `SELECT u.id FROM public.auth_users u
       JOIN public.auth_user_access a ON a.user_id = u.id
      WHERE u.role IS DISTINCT FROM
            CASE WHEN a.profile = 'administrator' THEN 'admin' ELSE 'operator' END`,
  )
  assert.equal(rows.length, 0)
})

test('executar a 003 de novo falha sem duplicar nem alterar nada', async () => {
  const before = await pool.query('SELECT * FROM public.auth_user_access ORDER BY user_id')

  await assert.rejects(() => applySchema('003_user_access.sql'))

  assert.deepEqual(
    (await pool.query('SELECT * FROM public.auth_user_access ORDER BY user_id')).rows,
    before.rows,
  )
})

test('depois da migração, as contas entram com o perfil esperado e a edição funciona', async () => {
  assert.equal((await login('solicitante@example.gov.br')).user.role, 'requester')
  const cpf = await login('cpf@example.gov.br')
  assert.equal(cpf.user.permissions.includes('flights:cpf:read'), false)
  assert.equal((await login('operador@example.gov.br')).status, 401)

  // Conta criada pelo CLI antes de ele conhecer a tabela nova continua funcionando.
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
      role: 'slm_operator',
      slmMember: true,
      grantedPermissions: ['reports:read'],
      deniedPermissions: [],
    }),
  })
  assert.equal(response.status, 200)
})

test('a reversão volta à estrutura anterior, sem objetos residuais', async () => {
  const auditBefore = await pool.query('SELECT count(*)::int AS n FROM public.auth_audit_events')

  await applySchema('003_user_access.rollback.sql')
  resetAccessSchemaCacheForTests()

  assert.deepEqual(await structure(), structureBefore)
  const residual = await pool.query(
    `SELECT to_regclass('public.auth_user_access') AS tabela,
            to_regprocedure('public.assert_user_access_coherent()') AS funcao`,
  )
  assert.deepEqual(residual.rows[0], { tabela: null, funcao: null })

  const auditAfter = await pool.query('SELECT count(*)::int AS n FROM public.auth_audit_events')
  assert.equal(auditAfter.rows[0].n, auditBefore.rows[0].n)

  const admin = await login('admin@example.gov.br')
  assert.equal(admin.status, 200)
  assert.equal(admin.user.role, 'administrator')

  // Sem a tabela, o fallback continua sem equipe SLM e sem permissões especiais.
  const operator = await login('solicitante@example.gov.br')
  assert.equal(operator.user.slmMember, false)
  assert.equal(operator.user.permissions.includes('requests:schedule'), false)
})

test('reaplicar depois de reverter funciona', async () => {
  await pool.query(`UPDATE public.auth_users SET status = 'inactive' WHERE id = $1`, [ids.solicitante])
  await applySchema('003_user_access.sql')
  resetAccessSchemaCacheForTests()

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM public.auth_user_access WHERE slm_member`,
  )
  assert.equal(rows[0].n, 0)
})
