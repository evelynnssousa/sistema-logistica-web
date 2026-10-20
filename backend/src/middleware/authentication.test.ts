import assert from 'node:assert/strict'
import { once } from 'node:events'
import express from 'express'
import { test } from 'node:test'
import type { ResolvedSession } from '../auth/session.js'
import { requireAuthentication } from './requireAuthentication.js'
import type { SessionResolver } from './requireAuthentication.js'
import { requireAuthorization } from './requireAuthorization.js'

const token = 'x'.repeat(43)
const operatorSession: ResolvedSession = {
  userId: 'trusted-user-from-session-store',
  role: 'slm_operator',
  expiresAt: Date.now() + 60_000,
}

async function startTestServer(sessions: SessionResolver) {
  const app = express()
  app.use(express.json())

  app.get(
    '/admin',
    requireAuthentication(sessions),
    requireAuthorization('administrator'),
    (_request, response) => response.json({ success: true }),
  )
  app.post(
    '/operator',
    requireAuthentication(sessions),
    requireAuthorization('slm_operator'),
    (_request, response) =>
      response.json(response.locals.authenticatedUser),
  )

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Nao foi possivel iniciar o servidor de teste.')
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

test('requires a server-resolved session and checks authorization separately', async () => {
  const server = await startTestServer({
    resolve: async (receivedToken) =>
      receivedToken === token ? operatorSession : null,
  })

  try {
    const anonymousResponse = await fetch(`${server.url}/admin`)
    assert.equal(anonymousResponse.status, 401)

    const forbiddenResponse = await fetch(`${server.url}/admin`, {
      headers: { Cookie: `slm_session=${token}` },
    })
    assert.equal(forbiddenResponse.status, 403)

    const operatorResponse = await fetch(`${server.url}/operator`, {
      method: 'POST',
      headers: {
        Cookie: `slm_session=${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: 'forged-user', role: 'administrator' }),
    })
    assert.equal(operatorResponse.status, 200)
    assert.deepEqual(await operatorResponse.json(), {
      userId: 'trusted-user-from-session-store',
      role: 'slm_operator',
    })
  } finally {
    await server.close()
  }
})

test('does not expose session-store errors to HTTP clients', async () => {
  const server = await startTestServer({
    resolve: async () => {
      throw new Error('private store failure')
    },
  })

  try {
    const response = await fetch(`${server.url}/operator`, {
      method: 'POST',
      headers: { Cookie: `slm_session=${token}` },
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      success: false,
      message: 'Serviço de autenticação indisponível.',
    })
  } finally {
    await server.close()
  }
})