import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import app from '../app.js'

test('GET /api/health keeps its current response without database config', async () => {
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')

  try {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Nao foi possivel iniciar o servidor de teste.')
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      success: true,
      message: 'API do Sistema de Serviços de Logística e Manutenção funcionando.',
      environment: 'development',
    })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
})