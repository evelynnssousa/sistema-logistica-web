import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { after, before, test } from 'node:test'
import type { Pool } from 'pg'
import { onRequest } from '../functions/api/[[path]].ts'

// A API real, em PostgreSQL descartável, atrás da Pages Function. Um servidor local faz o papel
// do Cloudflare: recebe o navegador, define CF-Connecting-IP e chama onRequest. Nada sai da máquina.

const root = resolve(import.meta.dirname, '../..')
const password = randomBytes(24).toString('hex')
const proxySecret = randomBytes(24).toString('hex')
const clientIp = '203.0.113.9'
const schema = (file: string) => readFileSync(resolve(root, 'backend/database/schema', file), 'utf8')
const pngBytes = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), randomBytes(50_000)])

let pool: Pool
let api: Server
let edge: Server
let apiUrl: string
let edgeUrl: string
let directory: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let authRateLimits: any

type Session = { cookie: string; csrf: string; id: string }

async function call(path: string, options: { method?: string; body?: unknown; raw?: Buffer; name?: string; session?: Session; csrf?: boolean } = {}) {
  const method = options.method ?? 'GET'
  const response = await fetch(`${edgeUrl}/api${path}`, {
    method,
    headers: {
      'content-type': options.raw ? 'application/octet-stream' : 'application/json',
      ...(options.name ? { 'x-file-name': encodeURIComponent(options.name) } : {}),
      ...(options.session ? { cookie: options.session.cookie } : {}),
      ...(options.session && options.csrf !== false && method !== 'GET' ? { 'x-csrf-token': options.session.csrf } : {}),
    },
    body: options.raw ? new Uint8Array(options.raw) : options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const buffer = Buffer.from(await response.arrayBuffer())
  let body: Record<string, any> = {} // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    body = JSON.parse(buffer.toString('utf8'))
  } catch {
    // Conteúdo de arquivo.
  }
  return { status: response.status, body, buffer, headers: response.headers, text: buffer.toString('utf8') }
}

async function signIn(email: string): Promise<Session> {
  authRateLimits.loginPair.reset(`${clientIp}|${email}`)
  authRateLimits.loginAccount.reset(email)
  const result = await call('/auth/login', { method: 'POST', body: { identifier: email, password } })
  assert.equal(result.status, 200, result.text)
  const cookies = result.headers.getSetCookie()
  assert.equal(cookies.length, 1)
  assert.match(cookies[0], /^slm_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict/)
  return { cookie: cookies[0].split(';')[0], csrf: result.body.csrfToken, id: result.body.user.id }
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'slm-proxy-anexos-'))
  // Antes de carregar a API: o middleware do proxy lê o ambiente ao iniciar.
  process.env.PROXY_SHARED_SECRET = proxySecret
  process.env.ATTACHMENTS_DIR = directory

  const { Pool: PgPool } = await import('pg')
  const { default: app } = await import('../../backend/src/app.ts')
  const { hashPassword } = await import('../../backend/src/auth/password.ts')
  const { requireDisposableDatabaseUrl } = await import('../../backend/src/database/databaseSafety.ts')
  const { setDatabasePoolForTests } = await import('../../backend/src/database/pool.ts')
  const { resetAccessSchemaCacheForTests } = await import('../../backend/src/database/accessSchema.ts')
  ;({ authRateLimits } = await import('../../backend/src/security/authRateLimits.ts'))

  pool = new PgPool({ connectionString: requireDisposableDatabaseUrl() })
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
     VALUES ('Administradora', 'proxy-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )
  setDatabasePoolForTests(pool)

  api = app.listen(0, '127.0.0.1')
  await once(api, 'listening')
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`

  const env = { BACKEND_ORIGIN: apiUrl, BACKEND_PROXY_SECRET: proxySecret }
  edge = createServer(async (incoming, outgoing) => {
    const headers = new Headers()
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(name, value)
    }
    headers.set('cf-connecting-ip', clientIp)
    const hasBody = !['GET', 'HEAD'].includes(incoming.method ?? 'GET')
    const request = new Request(`https://slm-teste.pages.dev${incoming.url}`, {
      method: incoming.method,
      headers,
      body: hasBody ? (Readable.toWeb(incoming) as unknown as ReadableStream) : undefined,
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit)
    const response = await onRequest({ request, env })
    const out: Record<string, string | string[]> = {}
    response.headers.forEach((value, name) => {
      if (name !== 'set-cookie') out[name] = value
    })
    const cookies = response.headers.getSetCookie()
    if (cookies.length) out['set-cookie'] = cookies
    outgoing.writeHead(response.status, out)
    if (response.body) Readable.fromWeb(response.body as unknown as WebReadableStream).pipe(outgoing)
    else outgoing.end()
  })
  edge.listen(0, '127.0.0.1')
  await once(edge, 'listening')
  edgeUrl = `http://127.0.0.1:${(edge.address() as AddressInfo).port}`
})

after(async () => {
  delete process.env.PROXY_SHARED_SECRET
  delete process.env.ATTACHMENTS_DIR
  await new Promise((done) => edge?.close(done))
  await new Promise((done) => api?.close(done))
  await pool?.end()
  rmSync(directory, { recursive: true, force: true })
})

test('entrada, sessão, CSRF e saída pelo proxy', async () => {
  const admin = await signIn('proxy-admin@example.gov.br')

  const me = await call('/auth/me', { session: admin })
  assert.equal(me.status, 200, me.text)
  assert.equal(me.headers.get('cache-control'), 'no-store')
  assert.ok(me.headers.get('content-security-policy'), 'os cabeçalhos de segurança da API chegam ao navegador')

  // Sem o token de CSRF, a escrita é recusada mesmo com a sessão válida.
  const refused = await call('/settings/catalog/floors', { method: 'POST', session: admin, body: { label: '1º andar' }, csrf: false })
  assert.equal(refused.status, 403, refused.text)
  const created = await call('/settings/catalog/floors', { method: 'POST', session: admin, body: { label: '1º andar' } })
  assert.equal(created.status, 201, created.text)

  assert.equal((await call('/auth/logout', { method: 'POST', session: admin, csrf: false })).status, 403)
  const logout = await call('/auth/logout', { method: 'POST', session: admin })
  assert.equal(logout.status, 200)
  assert.match(logout.headers.getSetCookie()[0], /^slm_session=; Path=\/; HttpOnly; SameSite=Strict.*Max-Age=0/)
  assert.equal((await call('/auth/me', { session: admin })).status, 401)
})

test('anexos: envio e download pelo proxy, com o mesmo conteúdo e os cabeçalhos da API', async () => {
  const admin = await signIn('proxy-admin@example.gov.br')
  const option = async (category: string, label: string) => {
    const created = await call(`/settings/catalog/${category}`, { method: 'POST', session: admin, body: { label } })
    assert.equal(created.status, 201, created.text)
    return created.body.option.id as string
  }
  const floor = await option('floors', 'Andar do proxy')
  const service = await option('serviceTypes', 'Elétrica')
  await option('sectors', 'TI')

  const request = await call('/maintenance/requests', {
    method: 'POST',
    session: admin,
    body: { andarId: floor, tipoServicoId: service, localServico: 'Sala 1', descricao: 'Lâmpada queimada' },
  })
  assert.equal(request.status, 201, request.text)

  const sent = await call(`/attachments/resources/service_request/${request.body.id}?categoria=fotografia_antes`, {
    method: 'POST',
    session: admin,
    raw: pngBytes,
    name: 'foto da sala.png',
  })
  assert.equal(sent.status, 201, sent.text)

  const file = await call(`/attachments/files/${sent.body.id}/content`, { session: admin })
  assert.equal(file.status, 200)
  assert.deepEqual(file.buffer, pngBytes)
  assert.equal(file.headers.get('content-length'), String(pngBytes.length))
  assert.match(file.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''foto%20da%20sala\.png/)
  assert.match(file.headers.get('content-security-policy') ?? '', /sandbox/)
  assert.equal((await call(`/attachments/files/${sent.body.id}/content`)).status, 401)
})

test('fora do proxy: a API recusa a chamada direta, e só a verificação de saúde responde', async () => {
  const direct = await fetch(`${apiUrl}/api/auth/me`, { headers: { 'x-slm-client-ip': '10.9.9.9' } })
  assert.equal(direct.status, 403)
  assert.equal((await fetch(`${apiUrl}/api/health`)).status, 200)
  const forged = await fetch(`${apiUrl}/api/auth/me`, { headers: { 'x-slm-proxy-secret': 'adivinhado' } })
  assert.equal(forged.status, 403)
})

test('o limite por IP usa o IP do navegador informado pelo Cloudflare', async () => {
  const email = 'proxy-admin@example.gov.br'
  authRateLimits.loginPair.reset(`${clientIp}|${email}`)
  authRateLimits.loginAccount.reset(email)
  const failed = await call('/auth/login', { method: 'POST', body: { identifier: email, password: 'senha-errada-de-teste' } })
  assert.equal(failed.status, 401, failed.text)
  const key = `${clientIp}|${email}`
  assert.equal(authRateLimits.loginPair.check(key).remaining, 4, 'a falha conta para o IP do navegador')
  for (const other of ['127.0.0.1', '::ffff:127.0.0.1']) {
    assert.equal(authRateLimits.loginPair.check(`${other}|${email}`).remaining, 5, 'e não para o endereço do proxy')
  }
  authRateLimits.loginPair.reset(key)
  authRateLimits.loginAccount.reset(email)
})
