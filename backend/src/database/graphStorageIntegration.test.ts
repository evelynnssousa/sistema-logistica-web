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
import { FakeGraph, fakeSecret, fakeSettings, json } from '../attachments/fakeGraph.testSupport.js'
import { GraphDriveStorage, uploadFragmentUnit } from '../attachments/graphDriveStorage.js'
import { setAttachmentStorageForTests } from '../attachments/storage.js'
import { hashPassword } from '../auth/password.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'

// Anexos no SharePoint simulado, pela API real e em um PostgreSQL descartável. O Graph é falso:
// nenhuma conta Microsoft é usada e nenhuma conexão sai da máquina.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')
const pngBytes = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), randomBytes(uploadFragmentUnit + 500)])

let pool: Pool
let server: Server
let baseUrl: string
let graph: FakeGraph
const csrfTokens = new Map<string, string>()

type Session = { cookie: string; id: string }

async function call(path: string, options: { method?: string; body?: unknown; session?: Session; raw?: Buffer; name?: string } = {}) {
  const method = options.method ?? 'GET'
  const cookie = options.session?.cookie
  const token = cookie && method !== 'GET' ? csrfTokens.get(cookie) : undefined
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      'content-type': options.raw ? 'application/octet-stream' : 'application/json',
      ...(options.name ? { 'x-file-name': encodeURIComponent(options.name) } : {}),
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
    // Conteúdo do arquivo.
  }
  if (setCookie && body.csrfToken) csrfTokens.set(setCookie, body.csrfToken)
  return { status: response.status, body, text, buffer, headers: response.headers, setCookie }
}

const post = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'POST', session, body })

async function signIn(email: string): Promise<Session> {
  authRateLimits.loginPair.reset(`127.0.0.1|${email}`)
  authRateLimits.loginPair.reset(`::ffff:127.0.0.1|${email}`)
  authRateLimits.loginAccount.reset(email)
  const result = await call('/auth/login', { method: 'POST', body: { identifier: email, password } })
  assert.equal(result.status, 200, `login de ${email}`)
  return { cookie: result.setCookie, id: result.body.user.id }
}

let admin: Session

async function createUser(email: string, role: 'requester' | 'slm_operator' = 'requester'): Promise<Session> {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { fullName: `Pessoa ${email.split('@')[0]}`, email, sector: 'Protocolo', password, passwordConfirmation: password },
  })
  assert.equal(registered.status, 202, registered.text)
  const pending = await call('/admin/registrations/pending', { session: admin })
  const id = pending.body.registrations.find((item: { email: string }) => item.email === email).id
  assert.equal((await post(`/admin/registrations/${id}/approve`, admin, { role })).status, 200)
  const user = await signIn(email)
  if (role === 'slm_operator') {
    const access = await call(`/admin/users/${user.id}/access`, {
      method: 'PUT',
      session: admin,
      body: { role, slmMember: true, grantedPermissions: [], deniedPermissions: [] },
    })
    assert.equal(access.status, 200, access.text)
  }
  return user
}

const options: Record<string, string> = {}
async function option(category: string, label: string) {
  const created = await post(`/settings/catalog/${category}`, admin, { label })
  assert.equal(created.status, 201, created.text)
  options[label] = created.body.option.id
}

let requester: Session
let operator: Session
let stranger: Session

async function newRequest() {
  const created = await post('/maintenance/requests', requester, {
    andarId: options['1º andar'],
    tipoServicoId: options['Elétrica'],
    localServico: 'Sala de arquivo',
    descricao: 'Lâmpada queimada',
  })
  assert.equal(created.status, 201, created.text)
  return created.body.id as string
}

const upload = (session: Session, requestId: string, content = pngBytes, name = 'foto.png') =>
  call(`/attachments/resources/service_request/${requestId}?categoria=fotografia_antes`, {
    method: 'POST',
    session,
    raw: content,
    name,
  })

const download = (session: Session | undefined, id: string) => call(`/attachments/files/${id}/content`, { session })

const storedKey = async (id: string) =>
  (await pool.query<{ storage_key: string }>(`SELECT storage_key FROM public.request_attachments WHERE id = $1`, [id])).rows[0].storage_key

/** O navegador nunca vê endereço do SharePoint, URL temporária, token ou segredo. */
function assertNothingLeaked(result: { text: string; headers: Headers }) {
  const everything = `${result.text} ${JSON.stringify([...result.headers.entries()])}`
  for (const forbidden of ['sharepoint.com', 'graph.microsoft.com', 'tempauth', fakeSecret, ...graph.issuedTokens]) {
    assert.equal(everything.includes(forbidden), false, `vazou: ${forbidden.slice(0, 16)}`)
  }
}

before(async () => {
  graph = new FakeGraph()
  setAttachmentStorageForTests(
    new GraphDriveStorage(fakeSettings, {
      fetcher: graph.fetch,
      now: graph.now,
      sleep: graph.sleep,
      fragmentBytes: uploadFragmentUnit,
      maxAttempts: 3,
    }),
  )

  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  for (const file of [
    '001_public_schema_snapshot.sql', '002_password_recovery.sql', '003_user_access.sql', '004_flight_passengers.sql',
    '005_operational_modules.sql', '006_integrations.sql', '007_operations_center.sql', '008_attachments.sql',
  ]) {
    await pool.query(schema(file))
  }
  resetAccessSchemaCacheForTests()
  await pool.query(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'graph-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )
  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('graph-admin@example.gov.br')
  await option('floors', '1º andar')
  await option('serviceTypes', 'Elétrica')
  await option('sectors', 'Protocolo')
  requester = await createUser('graph-solicitante@example.gov.br')
  operator = await createUser('graph-operadora@example.gov.br', 'slm_operator')
  stranger = await createUser('graph-estranho@example.gov.br')
})

after(async () => {
  setAttachmentStorageForTests(undefined)
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

test('SharePoint simulado: envio, download pelo servidor e registros preservados', async () => {
  const requestId = await newRequest()
  const sent = await upload(requester, requestId)
  assert.equal(sent.status, 201, sent.text)
  assertNothingLeaked(sent)

  const key = await storedKey(sent.body.id)
  assert.deepEqual(graph.files.get(graph.pathOf(key)), pngBytes, 'o arquivo está na biblioteca, pela chave do servidor')
  assert.ok(!graph.pathOf(key).includes('foto'), 'o nome original não vai para o SharePoint')

  const row = await pool.query(
    `SELECT nome_original, sha256, tamanho_bytes::int AS tamanho FROM public.request_attachments WHERE id = $1`,
    [sent.body.id],
  )
  assert.equal(row.rows[0].nome_original, 'foto.png')
  assert.equal(row.rows[0].tamanho, pngBytes.length)
  assert.match(row.rows[0].sha256, /^[0-9a-f]{64}$/)

  const file = await download(requester, sent.body.id)
  assert.equal(file.status, 200)
  assert.deepEqual(file.buffer, pngBytes)
  assert.match(file.headers.get('content-disposition') ?? '', /^attachment/)
  assert.equal(file.headers.get('location'), null)
  assertNothingLeaked(file)

  const audit = await pool.query(`SELECT action FROM public.auth_audit_events WHERE target_resource_id = $1`, [requestId])
  const actions = audit.rows.map((item) => item.action)
  assert.ok(actions.includes('attachment.uploaded') && actions.includes('attachment.downloaded'))
  const history = await call(`/maintenance/requests/${requestId}`, { session: requester })
  assert.ok(history.body.history.some((entry: { action: string }) => entry.action === 'anexo_incluido'))
})

test('sem autorização: nenhuma chamada ao SharePoint', async () => {
  const requestId = await newRequest()
  const sent = await upload(requester, requestId)
  assert.equal(sent.status, 201, sent.text)
  const before = graph.requests.length

  assert.equal((await download(undefined, sent.body.id)).status, 401)
  assert.equal((await download(stranger, sent.body.id)).status, 404)
  assert.equal((await upload(stranger, requestId)).status, 404)
  assert.equal((await call(`/attachments/resources/service_request/${requestId}`, { session: stranger })).status, 404)
  assert.equal(graph.requests.length, before, 'a permissão é conferida antes de qualquer acesso ao armazenamento')
})

test('SharePoint indisponível ou limitando: 503 ao navegador, sem registro órfão e sem detalhes', async () => {
  const requestId = await newRequest()
  graph.fail(/:\/createUploadSession$/, () => json(503, {}), 3)
  const refused = await upload(requester, requestId)
  assert.equal(refused.status, 503, refused.text)
  assert.equal(refused.body.code, 'ATTACHMENT_STORAGE_UNAVAILABLE')
  assertNothingLeaked(refused)

  graph.fail(/:\/createUploadSession$/, () => json(429, {}, { 'retry-after': '600' }))
  assert.equal((await upload(requester, requestId)).status, 503)
  const rows = await pool.query(`SELECT count(*)::int AS total FROM public.request_attachments WHERE request_id = $1`, [requestId])
  assert.equal(rows.rows[0].total, 0)

  const sent = await upload(requester, requestId)
  assert.equal(sent.status, 201)
  graph.fail(/:\/content$/, () => json(503, {}), 3)
  const unavailable = await download(requester, sent.body.id)
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.headers.get('content-disposition'), null)
  assertNothingLeaked(unavailable)
})

test('arquivo alterado no SharePoint: o SHA-256 não confere e o conteúdo não é entregue', async () => {
  const requestId = await newRequest()
  const small = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const sent = await upload(requester, requestId, small)
  assert.equal(sent.status, 201, sent.text)
  const key = await storedKey(sent.body.id)
  graph.files.set(graph.pathOf(key), Buffer.from('89504e470d0a1a0a0000000d49484453', 'hex'))

  const result = await download(requester, sent.body.id)
  assert.equal(result.status, 503)
  assert.notDeepEqual(result.buffer, small)
  assert.equal(result.headers.get('content-disposition'), null)
})

test('remoção lógica: o registro e o arquivo no SharePoint permanecem', async () => {
  const requestId = await newRequest()
  const sent = await upload(requester, requestId)
  assert.equal(sent.status, 201, sent.text)
  const key = await storedKey(sent.body.id)
  const deletesBefore = graph.requests.filter((request) => request.method === 'DELETE').length

  const removed = await post(`/attachments/files/${sent.body.id}/remove`, operator, { justificativa: 'Foto de outra sala' })
  assert.equal(removed.status, 200, removed.text)
  assert.equal((await download(requester, sent.body.id)).status, 404)
  assert.ok(graph.files.has(graph.pathOf(key)), 'nada é apagado no SharePoint')
  assert.equal(graph.requests.filter((request) => request.method === 'DELETE').length, deletesBefore)
  const row = await pool.query(`SELECT removido_em IS NOT NULL AS removido FROM public.request_attachments WHERE id = $1`, [sent.body.id])
  assert.equal(row.rows[0].removido, true)
})
