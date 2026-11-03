import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { after, before, test } from 'node:test'
import app from '../app.js'
import apiRouter from './index.js'
import { routeAccessMap } from './routeAccessMap.js'

// Não usa banco: nenhuma destas requisições passa da verificação de sessão.

type RouterLayer = {
  route?: { path: string; methods: Record<string, boolean> }
  handle?: { stack?: RouterLayer[] }
}

/** Lê as rotas do próprio Express, e não de uma lista mantida à mão. */
function registeredRoutes() {
  const routes: string[] = []
  const visit = (layers: RouterLayer[]) => {
    for (const layer of layers) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          routes.push(`${method.toUpperCase()} ${layer.route.path}`)
        }
      } else if (layer.handle?.stack) {
        visit(layer.handle.stack)
      }
    }
  }
  visit((apiRouter as unknown as { stack: RouterLayer[] }).stack)
  return routes.sort()
}

const protectedRoutes = routeAccessMap.filter((route) => route.access !== 'public')

let server: Server
let baseUrl: string

before(async () => {
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Sem endereço.')
  baseUrl = `http://127.0.0.1:${address.port}/api`
})

after(async () => {
  await new Promise((done) => server.close(done))
})

function concretePath(path: string) {
  return path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000')
}

test('toda rota da API está classificada no mapa de acesso, e o mapa não tem rota inexistente', () => {
  const mapped = routeAccessMap.map((route) => `${route.method} ${route.path}`).sort()

  assert.deepEqual(registeredRoutes(), mapped)
})

test('as rotas públicas são só as de entrada, recuperação e saúde', () => {
  const publicRoutes = routeAccessMap
    .filter((route) => route.access === 'public')
    .map((route) => route.path)
    .sort()

  assert.deepEqual(publicRoutes, [
    '/auth/login',
    '/auth/logout',
    '/auth/password-recovery/request',
    '/auth/password-recovery/reset',
    '/auth/register',
    '/health',
  ])
})

test('toda rota protegida exige sessão', async () => {
  for (const route of protectedRoutes) {
    const response = await fetch(`${baseUrl}${concretePath(route.path)}`, {
      method: route.method,
    })
    assert.equal(response.status, 401, `${route.method} ${route.path}`)
    assert.deepEqual(await response.json(), {
      success: false,
      message: 'Autenticação necessária.',
    })
  }
})

test('sessão forjada ou mal formada não é aceita em nenhuma rota protegida', async () => {
  for (const cookie of [
    'slm_session=forjada',
    `slm_session=${'a'.repeat(44)}`,
    'session=qualquer; role=administrator',
  ]) {
    for (const route of protectedRoutes) {
      const response = await fetch(`${baseUrl}${concretePath(route.path)}`, {
        method: route.method,
        headers: { cookie },
      })
      assert.equal(response.status, 401, `${route.method} ${route.path} ${cookie}`)
    }
  }
})

test('variações de caminho e de método não contornam a sessão', async () => {
  for (const path of [
    '/ADMIN/USERS',
    '/admin/users/',
    '/Admin/Audit',
    '/FLIGHTS/passengers/00000000-0000-4000-8000-000000000000/cpf',
  ]) {
    const response = await fetch(`${baseUrl}${path}`)
    assert.equal(response.status, 401, path)
  }

  const head = await fetch(`${baseUrl}/admin/users`, { method: 'HEAD' })
  assert.equal(head.status, 401)

  const override = await fetch(`${baseUrl}/admin/users`, {
    headers: { 'x-http-method-override': 'OPTIONS', 'x-original-url': '/api/health' },
  })
  assert.equal(override.status, 401)
})

test('módulos sem API respondem 404 ou exigem sessão, e nunca entregam dados', async () => {
  for (const path of [
    '/settings',
    '/maintenance',
    '/fleet',
    '/warehouse',
    '/calendar',
    '/reports',
    '/requests',
    '/setores',
    '/materials',
  ]) {
    const response = await fetch(`${baseUrl}${path}`)
    assert.equal(response.status, 404, path)
  }
})

test('o subcaminho de rotas protegidas não fica aberto', async () => {
  for (const path of [
    '/admin/users/qualquer/coisa',
    '/admin/registrations/qualquer',
    '/flights/qualquer',
  ]) {
    const response = await fetch(`${baseUrl}${path}`)
    assert.equal(response.status, 401, path)
  }
})
