import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import express from 'express'
import { requireAuthentication } from '../middleware/requireAuthentication.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { csrfTokenMatches, deriveCsrfToken, hashCsrfToken } from './csrf.js'

const sessionToken = 'a'.repeat(43)
const otherSessionToken = 'b'.repeat(43)

test('o token é estável para a sessão e diferente entre sessões', () => {
  assert.equal(deriveCsrfToken(sessionToken), deriveCsrfToken(sessionToken))
  assert.notEqual(
    deriveCsrfToken(sessionToken),
    deriveCsrfToken(otherSessionToken),
  )
  assert.equal(deriveCsrfToken(sessionToken).includes(sessionToken), false)
})

test('só aceita o token cujo hash foi guardado', () => {
  const token = deriveCsrfToken(sessionToken)
  const hash = hashCsrfToken(token)

  assert.equal(csrfTokenMatches(token, hash), true)
  assert.equal(csrfTokenMatches(deriveCsrfToken(otherSessionToken), hash), false)
  assert.equal(csrfTokenMatches('', hash), false)
  assert.equal(csrfTokenMatches(undefined, hash), false)
  assert.equal(csrfTokenMatches(token, undefined), false)
  assert.equal(csrfTokenMatches(token, 'hash-mal-formado'), false)
})

test('o middleware bloqueia escrita sem token e libera leitura e token correto', async () => {
  const csrfToken = deriveCsrfToken(sessionToken)
  const app = express()
  const protectedRoutes = [
    requireAuthentication({
      resolve: async () => ({
        userId: 'user-id',
        role: 'administrator' as const,
        permissions: [],
        slmMember: false,
        sector: 'CPC',
        expiresAt: Date.now() + 60_000,
        csrfTokenHash: hashCsrfToken(csrfToken),
      }),
    }),
    requireCsrf,
  ]
  app.get('/acao', ...protectedRoutes, (_request, response) => {
    response.json({ success: true })
  })
  app.post('/acao', ...protectedRoutes, (_request, response) => {
    response.json({ success: true })
  })

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Sem endereço.')
  const url = `http://127.0.0.1:${address.port}/acao`
  const cookie = `slm_session=${sessionToken}`

  try {
    const read = await fetch(url, { headers: { cookie } })
    assert.equal(read.status, 200)

    const withoutToken = await fetch(url, { method: 'POST', headers: { cookie } })
    assert.equal(withoutToken.status, 403)
    assert.equal(((await withoutToken.json()) as { code: string }).code, 'CSRF_INVALID')

    const wrongToken = await fetch(url, {
      method: 'POST',
      headers: { cookie, 'X-CSRF-Token': deriveCsrfToken(otherSessionToken) },
    })
    assert.equal(wrongToken.status, 403)

    const validToken = await fetch(url, {
      method: 'POST',
      headers: { cookie, 'X-CSRF-Token': csrfToken },
    })
    assert.equal(validToken.status, 200)
  } finally {
    await new Promise((done) => server.close(done))
  }
})

test('o middleware recusa quando a sessão não tem hash conhecido', async () => {
  const app = express()
  app.post('/acao', requireCsrf, (_request, response) => {
    response.json({ success: true })
  })

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Sem endereço.')

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/acao`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': deriveCsrfToken(sessionToken) },
    })
    assert.equal(response.status, 403)
  } finally {
    await new Promise((done) => server.close(done))
  }
})
