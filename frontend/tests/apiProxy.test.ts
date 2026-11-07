import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { onRequest, parseBackendOrigin, proxyRequest, targetUrl } from '../functions/api/[[path]].ts'

// Proxy do Cloudflare Pages contra uma API local de teste. Nada sai da máquina.

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }

let server: Server
let backendOrigin: string
let lastSeen: Seen | null = null
let handler: (seen: Seen, response: ServerResponse) => void = (_seen, response) => response.end()

const secret = randomBytes(24).toString('hex')
const pagesUrl = 'https://slm-teste.pages.dev'
const binary = randomBytes(70_000)

before(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    lastSeen = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks) }
    handler(lastSeen, response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  backendOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => new Promise<void>((done) => server.close(() => done())))

const env = () => ({ BACKEND_ORIGIN: backendOrigin, BACKEND_PROXY_SECRET: secret })
const call = (path: string, init: RequestInit = {}, environment: Record<string, string> = env()) =>
  proxyRequest(new Request(`${pagesUrl}${path}`, init), environment)

test('GET: método, caminho e consulta exatamente como pedidos', async () => {
  handler = (_seen, response) => {
    response.setHeader('content-type', 'application/json')
    response.end('{"success":true}')
  }
  const response = await call('/api/demands?status=aberta&status=em%20andamento&busca=%C3%A1gua+fria&vazio=')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { success: true })
  assert.equal(lastSeen?.method, 'GET')
  assert.equal(lastSeen?.url, '/api/demands?status=aberta&status=em%20andamento&busca=%C3%A1gua+fria&vazio=')
  assert.equal(lastSeen?.body.length, 0)
})

test('POST: corpo, cookie de sessão e x-csrf-token chegam à API', async () => {
  handler = (_seen, response) => {
    response.statusCode = 201
    response.end()
  }
  const body = JSON.stringify({ title: 'Lâmpada', quantidade: 2 })
  const response = await call('/api/maintenance/requests', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: 'slm_session=abc; outro=1',
      'x-csrf-token': 'token-csrf-de-teste',
      accept: 'application/json',
    },
    body,
  })
  assert.equal(response.status, 201)
  assert.equal(lastSeen?.method, 'POST')
  assert.equal(lastSeen?.body.toString(), body)
  assert.equal(lastSeen?.headers['content-type'], 'application/json')
  assert.equal(lastSeen?.headers.cookie, 'slm_session=abc; outro=1')
  assert.equal(lastSeen?.headers['x-csrf-token'], 'token-csrf-de-teste')
  assert.equal(lastSeen?.headers['x-slm-proxy-secret'], secret)
})

test('Set-Cookie: cada cookie volta separado e sem alteração', async () => {
  const session = 'slm_session=valor; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=3600; Expires=Wed, 01 Jan 2031 00:00:00 GMT'
  const other = 'preferencia=1; Path=/; SameSite=Strict'
  handler = (_seen, response) => {
    response.setHeader('set-cookie', [session, other])
    response.setHeader('content-type', 'application/json')
    response.end('{}')
  }
  const response = await call('/api/auth/login', { method: 'POST', body: '{}' })
  assert.deepEqual(response.headers.getSetCookie(), [session, other])
})

test('anexos: envio binário com nome do arquivo, e download com os cabeçalhos da API', async () => {
  handler = (seen, response) => {
    if (seen.method === 'POST') {
      response.statusCode = 201
      response.end(JSON.stringify({ size: seen.body.length }))
      return
    }
    response.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': String(binary.length),
      'content-disposition': "attachment; filename*=UTF-8''relat%C3%B3rio.pdf",
      'content-security-policy': "sandbox; default-src 'none'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    })
    response.end(binary)
  }
  const sent = await call('/api/attachments/resources/service_request/1?categoria=outro', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('relatório.pdf') },
    body: binary,
  })
  assert.equal(sent.status, 201)
  assert.deepEqual(lastSeen?.body, binary)
  assert.equal(lastSeen?.headers['x-file-name'], encodeURIComponent('relatório.pdf'))
  assert.equal(lastSeen?.url, '/api/attachments/resources/service_request/1?categoria=outro')

  const file = await call('/api/attachments/files/1/content')
  assert.equal(file.status, 200)
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), binary)
  assert.equal(file.headers.get('content-disposition'), "attachment; filename*=UTF-8''relat%C3%B3rio.pdf")
  assert.equal(file.headers.get('content-security-policy'), "sandbox; default-src 'none'")
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(file.headers.get('cache-control'), 'no-store')
})

test('IP e encaminhamento: só o CF-Connecting-IP vale; o que o cliente forja é descartado', async () => {
  handler = (_seen, response) => response.end()
  await call('/api/health', {
    headers: {
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '10.0.0.1',
      'x-real-ip': '10.0.0.2',
      'x-slm-client-ip': '10.0.0.3',
      'x-slm-proxy-secret': 'segredo-forjado',
      forwarded: 'for=10.0.0.4',
      'x-forwarded-host': 'outro.example',
    },
  })
  const headers = lastSeen!.headers
  assert.equal(headers['x-slm-client-ip'], '203.0.113.7')
  assert.equal(headers['x-forwarded-for'], '203.0.113.7')
  assert.equal(headers['x-real-ip'], undefined)
  assert.equal(headers.forwarded, undefined)
  assert.equal(headers['x-slm-proxy-secret'], secret)
  assert.equal(headers['x-forwarded-proto'], 'https')
  assert.equal(headers['x-forwarded-host'], 'slm-teste.pages.dev')
  assert.equal(headers['cf-connecting-ip'], undefined, 'cabeçalhos internos do Cloudflare não seguem')
  assert.equal(headers.host, new URL(backendOrigin).host)

  // Sem CF-Connecting-IP (chamada fora do Cloudflare), nenhum IP é afirmado.
  await call('/api/health', { headers: { 'x-forwarded-for': '10.0.0.1' } })
  assert.equal(lastSeen!.headers['x-slm-client-ip'], undefined)
  assert.equal(lastSeen!.headers['x-forwarded-for'], undefined)
})

test('o segredo do proxy nunca volta ao navegador', async () => {
  handler = (seen, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, echoed: seen.headers['x-slm-proxy-secret'] ? 'sim' : 'não' }))
  }
  const response = await call('/api/health')
  const text = `${await response.text()} ${JSON.stringify([...response.headers])}`
  assert.equal(text.includes(secret), false)
})

test('redirecionamento da API não é seguido pelo proxy', async () => {
  handler = (_seen, response) => {
    response.writeHead(302, { location: 'https://outro.example/' })
    response.end()
  }
  const response = await call('/api/qualquer')
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), 'https://outro.example/')
})

test('API indisponível: resposta genérica, sem endereço nem detalhe interno', async () => {
  const closed = createServer()
  closed.listen(0, '127.0.0.1')
  await once(closed, 'listening')
  const port = (closed.address() as AddressInfo).port
  await new Promise<void>((done) => closed.close(() => done()))

  const offline = await call('/api/health', {}, { BACKEND_ORIGIN: `http://127.0.0.1:${port}` })
  assert.equal(offline.status, 503)
  const body = await offline.text()
  assert.match(body, /API_UNAVAILABLE/)
  assert.equal(body.includes(String(port)), false)
  assert.equal(body.includes('127.0.0.1'), false)

  // Sem resposta dentro do limite.
  handler = () => undefined
  const slow = await call('/api/health', {}, { BACKEND_ORIGIN: backendOrigin, BACKEND_TIMEOUT_MS: '150' })
  assert.equal(slow.status, 503)

  // Página de erro da plataforma (HTML) é substituída; erro da própria API (JSON) passa.
  handler = (_seen, response) => {
    response.writeHead(502, { 'content-type': 'text/html' })
    response.end('<html>Bad gateway em servidor-interno-17</html>')
  }
  const gateway = await call('/api/health')
  assert.equal(gateway.status, 503)
  assert.equal((await gateway.text()).includes('servidor-interno'), false)

  handler = (_seen, response) => {
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end('{"success":false,"code":"ATTACHMENT_STORAGE_UNAVAILABLE"}')
  }
  const own = await call('/api/health')
  assert.equal(own.status, 503)
  assert.match(await own.text(), /ATTACHMENT_STORAGE_UNAVAILABLE/)
})

test('configuração inválida: nada é encaminhado', async () => {
  let calls = 0
  const spy: typeof fetch = async () => {
    calls += 1
    return new Response(null)
  }
  for (const value of [
    undefined,
    '',
    'onrender.com',
    'http://slm-api.onrender.com',
    'ftp://slm-api.onrender.com',
    'https://slm-api.onrender.com/api',
    'https://usuario:senha@slm-api.onrender.com',
    'https://slm-api.onrender.com?destino=x',
    'https://slm-api.onrender.com#x',
  ]) {
    assert.equal(parseBackendOrigin(value), null, String(value))
    const response = await proxyRequest(new Request(`${pagesUrl}/api/health`), { BACKEND_ORIGIN: value }, spy)
    assert.equal(response.status, 503)
    assert.match(await response.text(), /API_NOT_CONFIGURED/)
  }
  assert.equal(calls, 0)
  assert.equal(parseBackendOrigin('https://slm-api.onrender.com')?.href, 'https://slm-api.onrender.com/')
  assert.equal(parseBackendOrigin('https://slm-api.onrender.com/')?.href, 'https://slm-api.onrender.com/')
  assert.equal(parseBackendOrigin('http://127.0.0.1:3901')?.href, 'http://127.0.0.1:3901/')
})

test('destino: o cliente nunca escolhe o host, nem saindo de /api', async () => {
  const origin = new URL('https://slm-api.onrender.com')
  const targets: string[] = []
  const spy: typeof fetch = async (input) => {
    targets.push(String(input))
    return new Response('{}', { headers: { 'content-type': 'application/json' } })
  }
  const environment = { BACKEND_ORIGIN: origin.origin }
  for (const path of [
    '/api/health',
    '/api/@evil.example/x',
    '/api/..%2F..%2Fadmin',
    '/api/%2F%2Fevil.example',
    '/api/http://evil.example',
    '/api/x?url=https://evil.example',
  ]) {
    const response = await proxyRequest(new Request(`${pagesUrl}${path}`, { headers: { host: 'evil.example' } }), environment, spy)
    assert.equal(response.status, 200, path)
  }
  assert.ok(targets.every((target) => new URL(target).origin === origin.origin), targets.join('\n'))

  for (const path of ['/', '/assets/app.js', '/apix', '/outra/api/health']) {
    assert.equal(targetUrl(origin, new URL(`${pagesUrl}${path}`)), null, path)
  }
  const sneaky = new URL(`${pagesUrl}/api/x`)
  sneaky.pathname = '//evil.example/api'
  assert.equal(targetUrl(origin, sneaky), null)
})

test('onRequest: a função publicada usa o ambiente do Cloudflare', async () => {
  handler = (_seen, response) => response.end('ok')
  const response = await onRequest({ request: new Request(`${pagesUrl}/api/health`), env: env() })
  assert.equal(await response.text(), 'ok')
})

test('_headers publica os mesmos cabeçalhos de segurança do vite preview', () => {
  const headers = readFileSync(resolve(import.meta.dirname, '../public/_headers'), 'utf8')
  const vite = readFileSync(resolve(import.meta.dirname, '../vite.config.ts'), 'utf8')
  const csp = /Content-Security-Policy: (.+)/.exec(headers)?.[1].trim()
  const viteDirectives = [...vite.matchAll(/"([a-z-]+ [^"]+)",?/g)].map((match) => match[1])
  assert.deepEqual(csp?.split('; '), viteDirectives)
  for (const line of ['X-Content-Type-Options: nosniff', 'Referrer-Policy: strict-origin-when-cross-origin', 'X-Frame-Options: DENY']) {
    assert.ok(headers.includes(line), line)
  }
})
