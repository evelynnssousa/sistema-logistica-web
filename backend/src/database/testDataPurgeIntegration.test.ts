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

// Atas e contratos no Controle de Demandas (migração 021) e taxas do Dashboard, em 12/11/2026.
// API real, PostgreSQL descartável, 001 a 021.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')

let pool: Pool
let server: Server
let baseUrl: string
let admin: Session
let requester: Session
const csrfTokens = new Map<string, string>()

type Session = { cookie: string; id: string }

async function call(path: string, options: { method?: string; body?: unknown; session?: Session; raw?: Buffer; fileName?: string } = {}) {
  const method = options.method ?? 'GET'
  const cookie = options.session?.cookie
  const token = cookie && method !== 'GET' ? csrfTokens.get(cookie) : undefined
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      'content-type': options.raw ? 'application/octet-stream' : 'application/json',
      ...(options.fileName ? { 'x-file-name': encodeURIComponent(options.fileName) } : {}),
      ...(cookie ? { cookie } : {}),
      ...(token ? { 'x-csrf-token': token } : {}),
    },
    body: options.raw ? new Uint8Array(options.raw) : options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const buffer = Buffer.from(await response.arrayBuffer())
  const text = buffer.toString('utf8')
  const setCookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  let body: Record<string, any> = {} // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    body = JSON.parse(text)
  } catch {
    // Conteúdo de arquivo.
  }
  if (setCookie && body.csrfToken) csrfTokens.set(setCookie, body.csrfToken)
  return { status: response.status, body, text, buffer, setCookie }
}

const get = (path: string, session: Session) => call(path, { session })
const post = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'POST', session, body })
const put = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'PUT', session, body })

async function signIn(email: string): Promise<Session> {
  authRateLimits.loginPair.reset(`127.0.0.1|${email}`)
  authRateLimits.loginPair.reset(`::ffff:127.0.0.1|${email}`)
  authRateLimits.loginAccount.reset(email)
  const result = await call('/auth/login', { method: 'POST', body: { identifier: email, password } })
  assert.equal(result.status, 200, `login de ${email}: ${result.text}`)
  return { cookie: result.setCookie, id: result.body.user.id }
}

async function createUser(email: string, role: 'requester' | 'slm_operator'): Promise<Session> {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { fullName: `Pessoa ${email.split('@')[0]}`, email, sector: 'Administração', password, passwordConfirmation: password },
  })
  assert.equal(registered.status, 202, registered.text)
  const pending = await get('/admin/registrations/pending', admin)
  const id = pending.body.registrations.find((item: { email: string }) => item.email === email).id
  assert.equal((await post(`/admin/registrations/${id}/approve`, admin, { role })).status, 200)
  return signIn(email)
}

const migrations = [
  '001_public_schema_snapshot.sql', '002_password_recovery.sql', '003_user_access.sql', '004_flight_passengers.sql',
  '005_operational_modules.sql', '006_integrations.sql', '007_operations_center.sql', '008_attachments.sql',
  '009_module_extensions.sql', '010_monitoring.sql', '011_delivery_forecast.sql', '012_operational_transparency.sql',
  '013_communications.sql', '014_demands.sql', '015_organizational_structure.sql', '016_driver_portal.sql',
  '017_driver_portal_settings.sql', '018_public_api_privileges.sql', '019_email_quota.sql', '020_warehouse_finance.sql',
  '021_contract_instruments.sql', '022_forms_and_links.sql', '023_patrimony.sql', '024_unified_agreements.sql',
]

before(async () => {
  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  for (const file of migrations) await pool.query(schema(file))
  resetAccessSchemaCacheForTests()
  await pool.query(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'limpeza-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )
  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('limpeza-admin@example.gov.br')
  requester = await createUser('limpeza-solicitante@example.gov.br', 'requester')
})

after(async () => {
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

async function seedRequest(tipo: 'manutencao' | 'frota') {
  const { rows } = await pool.query<{ id: string; codigo: string }>(
    `INSERT INTO public.service_requests (tipo, solicitante_id, titulo) VALUES ($1, $2, 'Teste') RETURNING id::text AS id, protocolo_codigo AS codigo`,
    [tipo, requester.id],
  )
  const id = rows[0].id
  await pool.query(`INSERT INTO public.request_history (request_id, usuario_id, acao) VALUES ($1, $2, 'criada')`, [id, requester.id])
  await pool.query(`INSERT INTO public.request_internal_notes (request_id, autor_id, texto) VALUES ($1, $2, 'Nota de teste')`, [id, admin.id])
  const event = await pool.query<{ id: string }>(
    `INSERT INTO public.integration_events (event_key, event_type, module, resource_id, protocol)
     VALUES ($1, 'request_received', $2, $3, $4) RETURNING id::text AS id`,
    [`teste:${id}`, tipo === 'manutencao' ? 'maintenance' : 'fleet', id, rows[0].codigo],
  )
  await pool.query(
    `INSERT INTO public.user_notifications (user_id, event_id, category, title, message) VALUES ($1, $2, 'pendencia', 'Aviso', 'Aviso de teste')`,
    [requester.id, event.rows[0].id],
  )
  return rows[0]
}

const count = async (table: string) => (await pool.query(`SELECT count(*)::int AS total FROM public.${table}`)).rows[0].total as number

test('limpeza: só o Administrador; prévia, cópia e frase de confirmação', async () => {
  assert.equal((await get('/admin/test-data', requester)).status, 403)
  const info = await get('/admin/test-data', admin)
  assert.equal(info.status, 200, info.text)
  assert.equal(info.body.environment, 'local')
  assert.equal(info.body.confirmation, 'APAGAR DADOS DE TESTE')
  assert.equal((await get('/admin/test-data?groups=inexistente', admin)).status, 400)
  assert.equal((await post('/admin/test-data/purge', admin, { groups: ['maintenance'], confirmation: 'APAGAR DADOS DE TESTE' })).status, 400)
})

test('limpar só a Manutenção: a Frota fica, a numeração da Manutenção volta e nada se repete', async () => {
  const man1 = await seedRequest('manutencao')
  const man2 = await seedRequest('manutencao')
  const fro1 = await seedRequest('frota')
  assert.match(man2.codigo, /^MAN-\d{4}-00002$/)
  await pool.query(`INSERT INTO public.material_requests (origem, status, solicitante_id, registrado_por) VALUES ('interna', 'pendente', $1, $1)`, [requester.id])
  await pool.query(`INSERT INTO public.patrimony_assets (numero, descricao, criado_por) VALUES ('1', 'Mesa', $1)`, [admin.id])
  await pool.query(`INSERT INTO public.patrimony_movements (asset_id, tipo, usuario_id) SELECT id, 'cadastro', $1 FROM public.patrimony_assets`, [admin.id])

  const preview = await get('/admin/test-data?groups=maintenance', admin)
  assert.equal(preview.status, 200, preview.text)
  assert.equal(preview.body.preview.counts.service_requests, 2)
  assert.equal(preview.body.preview.counts.request_history, 2)

  const copy = await get('/admin/test-data/copy?groups=maintenance', admin)
  assert.equal(copy.status, 200)
  const file = JSON.parse(copy.text)
  assert.equal(file.tables.service_requests.length, 2)
  assert.deepEqual(file.tables.service_requests.map((row: { id: string }) => row.id).sort(), [man1.id, man2.id].sort())

  const wrongPhrase = await post('/admin/test-data/purge', admin, { groups: ['maintenance'], fingerprint: file.fingerprint, confirmation: 'apagar' })
  assert.equal(wrongPhrase.status, 400)
  assert.match(wrongPhrase.body.message, /APAGAR DADOS DE TESTE/)

  // Algo mudou depois da cópia: a limpeza recusa e nada sai.
  await pool.query(`INSERT INTO public.request_internal_notes (request_id, autor_id, texto) VALUES ($1, $2, 'Depois da cópia')`, [man1.id, admin.id])
  const outdated = await post('/admin/test-data/purge', admin, { groups: ['maintenance'], fingerprint: file.fingerprint, confirmation: 'APAGAR DADOS DE TESTE' })
  assert.equal(outdated.status, 409)
  assert.equal(await count('service_requests'), 3)

  const fresh = JSON.parse((await get('/admin/test-data/copy?groups=maintenance', admin)).text)
  const done = await post('/admin/test-data/purge', admin, { groups: ['maintenance'], fingerprint: fresh.fingerprint, confirmation: 'APAGAR DADOS DE TESTE' })
  assert.equal(done.status, 200, done.text)
  assert.equal(done.body.counts.service_requests, 2)
  const left = await pool.query(`SELECT tipo FROM public.service_requests`)
  assert.deepEqual(left.rows.map((row) => row.tipo), ['frota'])
  assert.equal(await count('request_history'), 1)
  assert.equal(await count('material_requests'), 1)
  assert.equal(await count('patrimony_assets'), 1)
  assert.equal((await pool.query(`SELECT count(*)::int AS total FROM public.integration_events WHERE resource_id = $1`, [man1.id])).rows[0].total, 0)

  // A próxima Manutenção volta a 00001; a Frota continua de onde estava.
  assert.match((await seedRequest('manutencao')).codigo, /^MAN-\d{4}-00001$/)
  assert.match((await seedRequest('frota')).codigo, /^FRO-\d{4}-00002$/)
  void fro1

  // As travas voltaram: o histórico segue impossível de apagar fora da limpeza.
  await assert.rejects(pool.query(`DELETE FROM public.request_history`), /não pode|permitid|alterad/i)

  // A auditoria registra a limpeza e não é apagada.
  const audit = await pool.query(`SELECT details FROM public.auth_audit_events WHERE action = 'settings.test_data_purged'`)
  assert.equal(audit.rowCount, 1)
  assert.deepEqual(audit.rows[0].details.groups, ['maintenance'])
})

test('excluir uma solicitação: só ela sai, com cópia, protocolo digitado e sem reaproveitar o número', async () => {
  const keep = await seedRequest('manutencao')
  const gone = await seedRequest('manutencao')
  const path = `/admin/test-data/record/solicitacao/${gone.id}`

  assert.equal((await get(path, requester)).status, 403)
  assert.equal((await get('/admin/test-data/record/solicitacao/00000000-0000-0000-0000-000000000000', admin)).status, 404)
  const info = await get(path, admin)
  assert.equal(info.status, 200, info.text)
  assert.equal(info.body.confirmation, gone.codigo)
  assert.equal(info.body.preview.counts.service_requests, 1)

  const copy = await get(`${path}/copy`, admin)
  const file = JSON.parse(copy.text)
  assert.deepEqual(file.tables.service_requests.map((row: { id: string }) => row.id), [gone.id])
  assert.equal((await post(`${path}/purge`, admin, { fingerprint: file.fingerprint, confirmation: 'APAGAR DADOS DE TESTE' })).status, 400)
  const done = await post(`${path}/purge`, admin, { fingerprint: file.fingerprint, confirmation: gone.codigo.toLowerCase() })
  assert.equal(done.status, 200, done.text)
  assert.equal(done.body.total > 0, true)

  const left = await pool.query(`SELECT id FROM public.service_requests WHERE id = ANY($1::uuid[])`, [[keep.id, gone.id]])
  assert.deepEqual(left.rows.map((row) => row.id), [keep.id])
  // O número da excluída não volta: a próxima segue adiante.
  const next = await seedRequest('manutencao')
  assert.notEqual(next.codigo, gone.codigo)
  const audit = await pool.query(`SELECT details FROM public.auth_audit_events WHERE action = 'settings.test_data_purged' AND details->>'scope' = 'single'`)
  assert.equal(audit.rows[0]?.details.protocol, gone.codigo)
})

test('limpar tudo: zera solicitações, pedidos, patrimônio e a numeração', async () => {
  const all = ['maintenance', 'fleet', 'flights', 'warehouse_requests', 'warehouse_stock', 'demands', 'patrimony']
  const copy = JSON.parse((await get(`/admin/test-data/copy?groups=${all.join(',')}`, admin)).text)
  const done = await post('/admin/test-data/purge', admin, { groups: all, fingerprint: copy.fingerprint, confirmation: 'APAGAR DADOS DE TESTE' })
  assert.equal(done.status, 200, done.text)
  for (const table of ['service_requests', 'material_requests', 'patrimony_assets', 'patrimony_movements', 'request_history']) {
    assert.equal(await count(table), 0, table)
  }
  assert.equal(await count('protocol_counters'), 0)
  assert.match((await seedRequest('frota')).codigo, /^FRO-\d{4}-00001$/)
  const legacy = await pool.query(`INSERT INTO public.material_requests (origem, status, solicitante_id, registrado_por) VALUES ('interna', 'pendente', $1, $1) RETURNING protocolo, protocolo_codigo`, [requester.id])
  assert.equal(Number(legacy.rows[0].protocolo), 1)
  assert.match(legacy.rows[0].protocolo_codigo, /^ALM-\d{4}-00001$/)
  assert.ok((await count('auth_audit_events')) > 0)
})
