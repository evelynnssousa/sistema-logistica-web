import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { Pool } from 'pg'
import app from '../app.js'
import { hashPassword } from '../auth/password.js'
import { defaultSessionIdleTimeoutMs } from '../auth/session.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'

// Ciclo da sessão pela API real, com a mesma estrutura de banco que o ambiente real tem hoje:
// só as migrações 001 e 002. A auditoria da queda de sessão está em docs/AUDITORIA_SESSAO_LOGIN.md.

const password = randomBytes(24).toString('hex')
const adminEmail = 'sessao-admin@example.gov.br'
const operatorEmail = 'sessao-comum@example.gov.br'

let pool: Pool
let server: Server
let baseUrl: string

async function call(path: string, options: { method?: string; cookie?: string; csrf?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
    setCookie: response.headers.get('set-cookie') ?? '',
  }
}

async function signIn(email: string) {
  authRateLimits.loginPair.reset(`127.0.0.1|${email}`)
  authRateLimits.loginPair.reset(`::ffff:127.0.0.1|${email}`)
  authRateLimits.loginAccount.reset(email)
  const result = await call('/auth/login', { method: 'POST', body: { identifier: email, password } })
  assert.equal(result.status, 200)
  return { cookie: result.setCookie.split(';')[0], csrf: result.body.csrfToken as string, raw: result.setCookie, user: result.body.user }
}

before(async () => {
  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  for (const file of ['001_public_schema_snapshot.sql', '002_password_recovery.sql']) {
    await pool.query(readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8'))
  }
  resetAccessSchemaCacheForTests()

  const hash = await hashPassword(password)
  await pool.query(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, permissions, decided_at)
     VALUES ('Administradora', $1, 'TI', $3, 'approved', 'admin', '{}', now()),
            ('Pessoa Comum', $2, 'Protocolo', $3, 'approved', 'operator', '{}', now())`,
    [adminEmail, operatorEmail, hash],
  )

  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

test('administrador e usuário comum: o cookie do login vale nas consultas seguintes', async () => {
  for (const [email, role] of [[adminEmail, 'administrator'], [operatorEmail, 'requester']]) {
    const session = await signIn(email)
    assert.match(session.raw, /HttpOnly/)
    assert.match(session.raw, /SameSite=Strict/)
    assert.match(session.raw, /Path=\//)
    assert.doesNotMatch(session.raw, /Domain=/)
    assert.equal(session.user.role, role)

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const me = await call('/auth/me', { cookie: session.cookie })
      assert.equal(me.status, 200)
      assert.equal(me.body.user.email, email)
      assert.equal(me.body.csrfToken, session.csrf, 'recarregar a página recebe o mesmo token de CSRF')
      assert.equal(me.setCookie, '', 'consulta válida não mexe no cookie')
    }
  }
})

test('validade da sessão: 8 horas no cookie e no banco, sem renovação escondida', async () => {
  const session = await signIn(adminEmail)
  const maxAge = Number(/Max-Age=(\d+)/.exec(session.raw)?.[1])
  assert.ok(maxAge > 8 * 3600 - 60 && maxAge <= 8 * 3600)

  const before = await pool.query<{ ttl: number }>(
    `SELECT extract(epoch FROM expires_at - created_at)::int AS ttl FROM public.auth_sessions ORDER BY created_at DESC LIMIT 1`,
  )
  assert.equal(before.rows[0].ttl, 8 * 3600)
})

test('sem cookie: 401, sem tocar em cookie nenhum', async () => {
  const anonymous = await call('/auth/me')
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.setCookie, '', 'limpar aqui apagaria a sessão de um login concluído no intervalo')
  assert.equal((await call('/maintenance/requests')).status, 401)
})

test('cookie inválido, repetido ou encerrado: 401, e esse cookie é limpo', async () => {
  const invalid = await call('/auth/me', { cookie: 'slm_session=invalido' })
  assert.equal(invalid.status, 401)
  assert.match(invalid.setCookie, /Max-Age=0/)

  const session = await signIn(adminEmail)
  const conflicting = await call('/auth/me', { cookie: `${session.cookie}; slm_session=${'C'.repeat(43)}` })
  assert.equal(conflicting.status, 401, 'tokens diferentes continuam recusados')
  assert.match(conflicting.setCookie, /Max-Age=0/)

  const unknown = await call('/auth/me', { cookie: `slm_session=${'B'.repeat(43)}` })
  assert.equal(unknown.status, 401)
  assert.match(unknown.setCookie, /Max-Age=0/)
})

test('o mesmo cookie repetido é a mesma sessão, e não a derruba', async () => {
  const session = await signIn(adminEmail)
  const repeated = await call('/auth/me', { cookie: `${session.cookie}; ${session.cookie}` })
  assert.equal(repeated.status, 200)
  assert.equal(repeated.setCookie, '', 'não pode mandar apagar uma sessão válida')
  assert.equal((await call('/notifications/unread-count', { cookie: `${session.cookie}; ${session.cookie}` })).setCookie, '')
  assert.equal((await call('/auth/me', { cookie: session.cookie })).status, 200)
})

test('logout encerra a sessão no banco, e o mesmo cookie deixa de valer', async () => {
  const session = await signIn(operatorEmail)
  assert.equal((await call('/auth/logout', { method: 'POST', cookie: session.cookie })).status, 403, 'exige CSRF')
  assert.equal((await call('/auth/me', { cookie: session.cookie })).status, 200)

  const done = await call('/auth/logout', { method: 'POST', cookie: session.cookie, csrf: session.csrf })
  assert.equal(done.status, 200)
  assert.match(done.setCookie, /Max-Age=0/)
  assert.equal((await call('/auth/me', { cookie: session.cookie })).status, 401)
})

test('expiração efetiva: sessão vencida ou inativa não vale e registra o motivo', async () => {
  const expired = await signIn(operatorEmail)
  await pool.query(`UPDATE public.auth_sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [expired.user.id])
  const afterExpiry = await call('/auth/me', { cookie: expired.cookie })
  assert.equal(afterExpiry.status, 401)
  assert.match(afterExpiry.setCookie, /Max-Age=0/)

  const idle = await signIn(operatorEmail)
  await pool.query(
    `UPDATE public.auth_sessions SET last_seen_at = now() - make_interval(secs => $2)
      WHERE user_id = $1 AND expires_at > now()`,
    [idle.user.id, defaultSessionIdleTimeoutMs / 1000 + 1],
  )
  assert.equal((await call('/auth/me', { cookie: idle.cookie })).status, 401)
  const reasons = await pool.query<{ reason: string }>(
    `SELECT details->>'reason' AS reason FROM public.auth_audit_events
      WHERE action = 'auth.logout' AND target_user_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
    [idle.user.id],
  )
  assert.equal(reasons.rows[0].reason, 'idle_timeout')
})

test('atividade dentro do prazo mantém a sessão sem estender a validade', async () => {
  const session = await signIn(adminEmail)
  const expiresAt = async () =>
    (
      await pool.query<{ expires_at: Date }>(
        `SELECT expires_at FROM public.auth_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [session.user.id],
      )
    ).rows[0].expires_at.getTime()
  const original = await expiresAt()

  await pool.query(
    `UPDATE public.auth_sessions SET last_seen_at = now() - interval '10 minutes' WHERE user_id = $1`,
    [session.user.id],
  )
  assert.equal((await call('/auth/me', { cookie: session.cookie })).status, 200)
  const seen = await pool.query<{ recent: boolean }>(
    `SELECT last_seen_at > now() - interval '1 minute' AS recent FROM public.auth_sessions
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [session.user.id],
  )
  assert.equal(seen.rows[0].recent, true)
  assert.equal(await expiresAt(), original)
})

test('conta desativada perde o acesso, e erro do banco não derruba a sessão', async () => {
  const session = await signIn(operatorEmail)

  const query = pool.query.bind(pool)
  pool.query = (async () => {
    throw new Error('banco indisponível')
  }) as unknown as typeof pool.query
  try {
    const down = await call('/auth/me', { cookie: session.cookie })
    assert.equal(down.status, 503)
    assert.equal(down.setCookie, '', 'indisponibilidade não apaga o cookie')
  } finally {
    pool.query = query
  }
  assert.equal((await call('/auth/me', { cookie: session.cookie })).status, 200)

  await pool.query(`UPDATE public.auth_users SET status = 'inactive' WHERE email = $1`, [operatorEmail])
  assert.equal((await call('/auth/me', { cookie: session.cookie })).status, 401)
  await pool.query(`UPDATE public.auth_users SET status = 'approved' WHERE email = $1`, [operatorEmail])
})
