import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import express from 'express'
import { parseTrustProxy } from './securityHeaders.js'
import { proxySecretProblem, trustedProxy } from './trustedProxy.js'

// O IP do cliente só vem do proxy do Cloudflare quando ele prova quem é.

const secret = randomBytes(24).toString('hex')

async function serve(environment: NodeJS.ProcessEnv, run: (url: string) => Promise<void>) {
  const app = express()
  app.set('trust proxy', parseTrustProxy(environment.TRUST_PROXY))
  app.use(trustedProxy(environment))
  app.get('/api/health', (request, response) => response.json({ ip: request.ip }))
  app.get('/api/eco', (request, response) => response.json({ ip: request.ip }))
  const server: Server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    await new Promise((done) => server.close(done))
  }
}

const ipOf = async (url: string, headers: Record<string, string> = {}) => {
  const response = await fetch(url, { headers })
  return { status: response.status, body: (await response.json()) as { ip?: string; message?: string } }
}

test('sem PROXY_SHARED_SECRET nada muda: cabeçalhos do cliente são ignorados', async () => {
  await serve({}, async (url) => {
    const result = await ipOf(`${url}/api/eco`, { 'x-slm-client-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' })
    assert.equal(result.status, 200)
    assert.notEqual(result.body.ip, '203.0.113.7')
    assert.notEqual(result.body.ip, '198.51.100.1')
  })
})

test('com o segredo: chamada direta recusada, exceto a verificação de saúde', async () => {
  await serve({ PROXY_SHARED_SECRET: secret }, async (url) => {
    const direct = await ipOf(`${url}/api/eco`, { 'x-slm-client-ip': '203.0.113.7' })
    assert.equal(direct.status, 403)
    assert.equal(JSON.stringify(direct.body).includes(secret), false)
    assert.equal((await ipOf(`${url}/api/eco`, { 'x-slm-proxy-secret': 'errado' })).status, 403)
    assert.equal((await ipOf(`${url}/api/eco`, { 'x-slm-proxy-secret': `${secret}x` })).status, 403)

    const health = await ipOf(`${url}/api/health`, { 'x-slm-client-ip': '203.0.113.7' })
    assert.equal(health.status, 200)
    assert.notEqual(health.body.ip, '203.0.113.7', 'sem o segredo, o IP informado não vale')
  })
})

test('com o segredo correto, o IP vem de X-SLM-Client-IP, e só se for um IP', async () => {
  await serve({ PROXY_SHARED_SECRET: secret }, async (url) => {
    const viaProxy = { 'x-slm-proxy-secret': secret }
    assert.equal((await ipOf(`${url}/api/eco`, { ...viaProxy, 'x-slm-client-ip': '203.0.113.7' })).body.ip, '203.0.113.7')
    assert.equal((await ipOf(`${url}/api/eco`, { ...viaProxy, 'x-slm-client-ip': '2001:db8::1' })).body.ip, '2001:db8::1')
    const garbage = await ipOf(`${url}/api/eco`, { ...viaProxy, 'x-slm-client-ip': '203.0.113.7, 10.0.0.1' })
    assert.equal(garbage.status, 200)
    assert.notEqual(garbage.body.ip, '203.0.113.7, 10.0.0.1')
    // X-Forwarded-For continua sem valor sem TRUST_PROXY.
    assert.notEqual((await ipOf(`${url}/api/eco`, { ...viaProxy, 'x-forwarded-for': '198.51.100.1' })).body.ip, '198.51.100.1')
  })
})

test('segredo fraco: a API não inicia', () => {
  assert.throws(() => trustedProxy({ PROXY_SHARED_SECRET: 'curto' }), /32 caracteres/)
  assert.equal(proxySecretProblem(undefined), 'ausente')
  assert.match(proxySecretProblem('a'.repeat(31)) ?? '', /curto/)
  assert.equal(proxySecretProblem(secret), null)
})
