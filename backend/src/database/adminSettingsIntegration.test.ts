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
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'
import { setProfileAdjustments } from '../auth/permissions.js'

// Administração do sistema em Configurações (13/11/2026). API real, PostgreSQL descartável, 001 a 022.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')

let pool: Pool
let server: Server
let baseUrl: string
let admin: Session
let requester: Session
const csrfTokens = new Map<string, string>()

type Session = { cookie: string; id: string }

async function call(path: string, options: { method?: string; body?: unknown; session?: Session } = {}) {
  const method = options.method ?? 'GET'
  const cookie = options.session?.cookie
  const token = cookie && method !== 'GET' ? csrfTokens.get(cookie) : undefined
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(token ? { 'x-csrf-token': token } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8')
  const type = response.headers.get('content-type') ?? ''
  const body = (type.includes('json') ? JSON.parse(text) : {}) as Record<string, any>
  const setCookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  if (setCookie && body.csrfToken) csrfTokens.set(setCookie, body.csrfToken)
  return { status: response.status, body, text, setCookie }
}

const get = (path: string, session: Session) => call(path, { session })
const post = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'POST', session, body })
const put = (path: string, session: Session, body: unknown) => call(path, { method: 'PUT', session, body })

async function signIn(email: string): Promise<Session> {
  authRateLimits.loginPair.reset(`127.0.0.1|${email}`)
  authRateLimits.loginPair.reset(`::ffff:127.0.0.1|${email}`)
  authRateLimits.loginAccount.reset(email)
  const result = await call('/auth/login', { method: 'POST', body: { identifier: email, password } })
  assert.equal(result.status, 200, `login de ${email}: ${result.text}`)
  return { cookie: result.setCookie, id: result.body.user.id }
}

async function createUser(email: string, role = 'requester'): Promise<Session> {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { fullName: `Pessoa ${email.split('@')[0]}`, email, sector: 'Protocolo', password, passwordConfirmation: password },
  })
  assert.equal(registered.status, 202, registered.text)
  const pending = await get('/admin/registrations/pending', admin)
  const id = pending.body.registrations.find((item: { email: string }) => item.email === email).id as string
  const approved = await post(`/admin/registrations/${id}/approve`, admin, { role })
  assert.equal(approved.status, 200, approved.text)
  return signIn(email)
}

before(async () => {
  process.env.PASSENGER_DATA_KEY = randomBytes(32).toString('base64')
  process.env.EMAIL_TRANSPORT = 'simulated'
  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  for (const file of [
    '001_public_schema_snapshot.sql', '002_password_recovery.sql', '003_user_access.sql', '004_flight_passengers.sql',
    '005_operational_modules.sql', '006_integrations.sql', '007_operations_center.sql', '008_attachments.sql',
    '009_module_extensions.sql', '010_monitoring.sql', '011_delivery_forecast.sql', '012_operational_transparency.sql',
    '013_communications.sql', '014_demands.sql', '015_organizational_structure.sql', '016_driver_portal.sql',
    '017_driver_portal_settings.sql', '018_public_api_privileges.sql', '019_email_quota.sql', '020_warehouse_finance.sql',
    '021_contract_instruments.sql', '022_forms_and_links.sql',
  ]) {
    await pool.query(schema(file))
  }
  resetAccessSchemaCacheForTests()
  await pool.query(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'admin-config@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )
  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('admin-config@example.gov.br')
  requester = await createUser('pessoa-config@example.gov.br')
})

after(async () => {
  setProfileAdjustments({})
  for (const name of ['PASSENGER_DATA_KEY', 'EMAIL_TRANSPORT']) delete process.env[name]
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

const save = (section: string, body: unknown, session = admin) => put(`/settings/parameters/${section}`, session, body)

test('só quem administra as configurações grava as novas seções', async () => {
  assert.equal((await save('announcement', { active: true, text: 'Teste' }, requester)).status, 403)
  assert.equal((await save('holidays', { list: [{ date: '2026-02-30', name: 'Inválido' }] })).status, 400)
})

test('aviso geral e mensagens: na tela de entrada sem sessão e em /system/info', async () => {
  assert.equal((await save('announcement', { active: true, text: 'Almoxarifado fechado dia 20', tone: 'warning', until: '2099-12-31' })).status, 200)
  assert.equal((await save('texts', { loginMessage: 'Use o e-mail institucional.', homeMessage: 'Bem-vindo ao SLM.' })).status, 200)
  const screen = await fetch(`${baseUrl}/api/public/screen`).then((response) => response.json())
  assert.equal(screen.loginMessage, 'Use o e-mail institucional.')
  assert.equal(screen.announcement.text, 'Almoxarifado fechado dia 20')
  const info = await get('/system/info', requester)
  assert.equal(info.body.homeMessage, 'Bem-vindo ao SLM.')
  assert.equal(info.body.announcement.tone, 'warning')
  assert.equal((await fetch(`${baseUrl}/api/system/info`)).status, 401)
  assert.equal((await save('announcement', { active: true, text: 'Vencido', until: '2020-01-01' })).status, 200)
  assert.equal((await get('/system/info', requester)).body.announcement, null)
})

test('domínios do cadastro: a lista da tela vale para novos pedidos de conta', async () => {
  assert.equal((await save('registration', { allowedDomains: ['jucesp.sp.gov.br'] })).status, 200)
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const refused = await call('/auth/register', {
    method: 'POST',
    body: { fullName: 'Pessoa de Fora', email: 'fora@example.gov.br', sector: 'Protocolo', password, passwordConfirmation: password },
  })
  assert.equal(refused.status, 400)
  assert.equal((await save('registration', { allowedDomains: [] })).status, 200)
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const accepted = await call('/auth/register', {
    method: 'POST',
    body: { fullName: 'Pessoa de Fora', email: 'fora@example.gov.br', sector: 'Protocolo', password, passwordConfirmation: password },
  })
  assert.equal(accepted.status, 202, accepted.text)
})

test('módulo desligado: sai do /system/info e não recebe pedido novo; religado, volta', async () => {
  assert.equal((await save('modules', { maintenance: false, demands: false })).status, 200)
  assert.equal((await get('/system/info', requester)).body.modules.maintenance, false)
  const blocked = await post('/maintenance/requests', requester, {})
  assert.equal(blocked.status, 409)
  assert.match(blocked.text, /desligado/)
  assert.equal((await post('/warehouse/requests', requester, { items: [] })).status, 400, 'o Almoxarifado continua ligado')
  assert.equal((await save('modules', {})).status, 200)
  assert.notEqual((await post('/maintenance/requests', requester, {})).status, 409)
})

test('permissões padrão: o ajuste vale para as contas do perfil, e nada administrativo passa', async () => {
  const permissions = async () => (await get('/auth/me', requester)).body.user.permissions as string[]
  assert.equal((await permissions()).includes('reports:read'), false)
  assert.equal((await save('profileDefaults', { requester: { add: ['users:manage'] } })).status, 400)
  assert.equal((await save('profileDefaults', { requester: { add: ['reports:read'], remove: ['flights:create'] } })).status, 200)
  const adjusted = await permissions()
  assert.equal(adjusted.includes('reports:read'), true)
  assert.equal(adjusted.includes('flights:create'), false)
  const options = (await get('/settings/parameters', admin)).body.options.profileDefaults
  assert.ok(options.base.requester.includes('flights:create'), 'o padrão do código continua visível')
  assert.equal((await save('profileDefaults', {})).status, 200)
  assert.equal((await permissions()).includes('reports:read'), false)
})
