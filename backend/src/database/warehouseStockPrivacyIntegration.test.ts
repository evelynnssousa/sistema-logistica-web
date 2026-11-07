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
import type { Permission } from '../auth/permissions.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'

// Supercomando 17: warehouse:manage fora do alcance de Solicitante e Motorista, e sigilo do
// estoque para quem não administra o Almoxarifado. API real, PostgreSQL descartável, 001 a 018.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')

// Valores distintos, para procurar nas respostas: nenhum deles pode chegar a um Solicitante.
const stockEntry = 98765
const stockReserved = 54321
const stockMinimum = 87654

let pool: Pool
let server: Server
let baseUrl: string
let admin: Session
let unitId: string
let sectorId: string
let materialId: string
const materialName = 'Grampeador Sigilo'
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

async function register(email: string) {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { fullName: `Pessoa ${email.split('@')[0]}`, email, sector: 'Protocolo', password, passwordConfirmation: password },
  })
  assert.equal(registered.status, 202, registered.text)
  const pending = await get('/admin/registrations/pending', admin)
  return pending.body.registrations.find((item: { email: string }) => item.email === email).id as string
}

async function createUser(email: string, role = 'requester'): Promise<Session> {
  const id = await register(email)
  const approved = await post(`/admin/registrations/${id}/approve`, admin, { role })
  assert.equal(approved.status, 200, approved.text)
  return signIn(email)
}

async function staff(email: string, grants: Permission[]): Promise<Session> {
  const user = await createUser(email, 'slm_operator')
  const result = await put(`/admin/users/${user.id}/access`, admin, { role: 'slm_operator', slmMember: true, grantedPermissions: grants, deniedPermissions: [] })
  assert.equal(result.status, 200, result.text)
  return user
}

async function permissionsOf(session: Session) {
  const me = await get('/auth/me', session)
  assert.equal(me.status, 200, me.text)
  return me.body.user.permissions as string[]
}

/** Grava a concessão direto no banco, sem passar pela API: o cenário da alteração indevida. */
async function writeGrantDirectly(userId: string, grants: string[], slmMember: boolean) {
  await pool.query(
    `UPDATE public.auth_user_access SET granted_permissions = $2, slm_member = $3 WHERE user_id = $1`,
    [userId, grants, slmMember],
  )
}

async function storedGrants(userId: string) {
  const { rows } = await pool.query<{ granted_permissions: string[] }>(
    `SELECT granted_permissions FROM public.auth_user_access WHERE user_id = $1`,
    [userId],
  )
  return rows[0]?.granted_permissions ?? []
}

const forbiddenKey = /stock|saldo|estoque|balance|reserv|minimum|available|lastMovement|^current$|^entries$|^exits$/i

/** Nenhuma chave de estoque em nenhum nível, e nenhum dos valores gravados no estoque. */
function assertNoStock(label: string, response: { status: number; body: unknown; text: string }) {
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`))
    else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        assert.equal(forbiddenKey.test(key), false, `${label}: chave de estoque ${path}.${key}`)
        visit(inner, `${path}.${key}`)
      }
    }
  }
  visit(response.body, '')
  for (const secret of [stockEntry, stockReserved, stockMinimum]) {
    assert.equal(response.text.includes(String(secret)), false, `${label}: valor do estoque ${secret} na resposta`)
  }
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
    '017_driver_portal_settings.sql', '018_public_api_privileges.sql',
  ]) {
    await pool.query(schema(file))
  }
  resetAccessSchemaCacheForTests()
  // A conta inicial é administradora fora da equipe SLM, como no banco real.
  await pool.query(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'sigilo-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )
  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('sigilo-admin@example.gov.br')

  const option = async (category: string, label: string) => {
    const created = await post(`/settings/catalog/${category}`, admin, { label })
    assert.equal(created.status, 201, created.text)
    return created.body.option.id as string
  }
  unitId = await option('measurementUnits', 'Unidade')
  sectorId = await option('sectors', 'Protocolo')
  const category = await option('warehouseCategories', 'Expediente')
  const material = await post('/warehouse/materials', admin, {
    code: 'EXP-001', name: materialName, description: 'Grampeador de mesa', unitId, categoryId: category,
  })
  assert.equal(material.status, 201, material.text)
  materialId = material.body.id

  // Estoque interno com saldo, mínimo e reserva, além de inventário e controle interno: tudo o
  // que poderia vazar por resposta, indicador, pesquisa ou auditoria.
  assert.equal((await post('/warehouse/stock-movements', admin, { materialId, tipo: 'entrada', quantidade: stockEntry, justificativa: 'Carga inicial' })).status, 201)
  assert.equal((await put(`/warehouse/stock/${materialId}/minimum`, admin, { minimo: stockMinimum })).status, 200)
  const reserved = await put(`/warehouse/stock/${materialId}/reserved`, admin, { reservada: stockReserved, justificativa: 'Reserva prioritária' })
  assert.equal(reserved.status, 200, reserved.text)
  const check = await post('/warehouse/inventory-checks', admin, {
    title: 'Conferência sigilo', referenceDate: '2027-02-01', items: [{ materialId, governmentQuantity: stockEntry }],
  })
  assert.equal(check.status, 201, check.text)
  assert.equal((await put(`/warehouse/inventory-checks/${check.body.id}/items/${materialId}`, admin, { governmentQuantity: stockEntry, countedQuantity: stockEntry })).status, 200)
})

after(async () => {
  for (const name of ['PASSENGER_DATA_KEY', 'EMAIL_TRANSPORT']) delete process.env[name]
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

test('Solicitante não recebe warehouse:manage: a concessão é recusada e auditada', async () => {
  const requester = await createUser('sigilo-solicitante-concessao@example.gov.br')
  for (const slmMember of [false, true]) {
    const refused = await put(`/admin/users/${requester.id}/access`, admin, {
      role: 'requester', slmMember, grantedPermissions: ['warehouse:manage'], deniedPermissions: [],
    })
    assert.equal(refused.status, 400, `slmMember=${slmMember}: ${refused.text}`)
  }
  assert.deepEqual(await storedGrants(requester.id), [])
  assert.equal((await permissionsOf(requester)).includes('warehouse:manage'), false)

  // Na aprovação do cadastro também.
  const pendingId = await register('sigilo-solicitante-aprovacao@example.gov.br')
  const atApproval = await post(`/admin/registrations/${pendingId}/approve`, admin, {
    role: 'requester', setup: { grantedPermissions: ['warehouse:manage'] },
  })
  assert.equal(atApproval.status, 400, atApproval.text)
  const stillPending = await get('/admin/registrations/pending', admin)
  assert.ok(stillPending.body.registrations.some((item: { id: string }) => item.id === pendingId), 'continua pendente')

  // As tentativas ficam na auditoria, com quem tentou, para quem e o que foi recusado.
  const audit = await pool.query<{ target_user_id: string; result: string; details: Record<string, unknown> }>(
    `SELECT target_user_id::text, result, details FROM public.auth_audit_events
      WHERE action = 'access.denied' AND actor_user_id = $1 AND details->>'operation' = 'user.permission_grant'
      ORDER BY occurred_at`,
    [admin.id],
  )
  // Com slmMember=true a recusa vem antes, pela regra do perfil (Solicitante fora da SLM).
  assert.equal(audit.rows.filter((row) => row.target_user_id === requester.id).length, 1)
  assert.ok(audit.rows.some((row) => row.target_user_id === pendingId))
  for (const row of audit.rows) {
    assert.equal(row.result, 'denied')
    assert.deepEqual(row.details.refused, ['warehouse:manage'])
    assert.equal(row.details.role, 'requester')
  }

  // A tela recebe do servidor a mesma regra: restrita, inelegível para Solicitante e Motorista.
  const catalog = (await get('/admin/permissions', admin)).body
  assert.ok(catalog.restricted.includes('warehouse:manage'))
  const eligible = (role: string, slmMember: boolean) =>
    catalog.eligibility.find((entry: { role: string; slmMember: boolean }) => entry.role === role && entry.slmMember === slmMember).eligible as string[]
  for (const slmMember of [false, true]) {
    assert.equal(eligible('requester', slmMember).includes('warehouse:manage'), false)
    assert.equal(eligible('driver', slmMember).includes('warehouse:manage'), false)
    assert.equal(eligible('administrator', slmMember).includes('warehouse:manage'), true)
  }
  assert.equal(eligible('slm_operator', true).includes('warehouse:manage'), true)
})

test('Motorista não recebe warehouse:manage, nem por concessão nem por dado gravado', async () => {
  const pendingId = await register('sigilo-motorista-aprovacao@example.gov.br')
  const atApproval = await post(`/admin/registrations/${pendingId}/approve`, admin, {
    role: 'driver', setup: { grantedPermissions: ['warehouse:manage'] },
  })
  assert.equal(atApproval.status, 400, atApproval.text)

  const driver = await createUser('sigilo-motorista@example.gov.br', 'driver')
  const refused = await put(`/admin/users/${driver.id}/access`, admin, {
    role: 'driver', slmMember: false, grantedPermissions: ['warehouse:manage'], deniedPermissions: [],
  })
  assert.equal(refused.status, 400, refused.text)

  // O próprio banco recusa concessões no perfil Motorista (auth_user_access_driver_exclusive).
  await assert.rejects(writeGrantDirectly(driver.id, ['warehouse:manage'], false), /auth_user_access_driver_exclusive/)
  const permissions = await permissionsOf(driver)
  assert.equal(permissions.includes('warehouse:manage'), false)
  assert.equal((await get('/warehouse/stock', driver)).status, 403)
  assert.equal((await get('/warehouse/stock-movements', driver)).status, 403)
  assert.equal((await post('/warehouse/materials', driver, { name: 'Indevido', unitId })).status, 403)
})

test('alteração direta no banco não dá ao Solicitante acesso efetivo ao Almoxarifado', async () => {
  const requester = await createUser('sigilo-solicitante-banco@example.gov.br')
  const created = await post('/warehouse/requests', requester, { items: [{ materialId, requested: 1 }] })
  assert.equal(created.status, 201, created.text)

  // O banco não aceita Solicitante na equipe SLM; a concessão, sim. Gravada sem passar pela API:
  await assert.rejects(writeGrantDirectly(requester.id, ['warehouse:manage'], true), /check/)
  await writeGrantDirectly(requester.id, ['warehouse:manage', 'warehouse:forecast', 'requests:schedule'], false)
  assert.deepEqual(await storedGrants(requester.id), ['warehouse:manage', 'warehouse:forecast', 'requests:schedule'])
  const permissions = await permissionsOf(requester)
  for (const permission of ['warehouse:manage', 'warehouse:forecast', 'requests:schedule']) {
    assert.equal(permissions.includes(permission), false, permission)
  }

  for (const path of [
    '/warehouse/stock', '/warehouse/stock?belowMinimum=true', '/warehouse/stock-movements',
    `/warehouse/stock-movements?materialId=${materialId}`, '/warehouse/inventory-checks',
    '/warehouse/control-records', '/warehouse/control-form',
  ]) {
    const refused = await get(path, requester)
    assert.equal(refused.status, 403, path)
    assertNoStock(path, refused)
  }
  assert.equal((await post('/warehouse/materials', requester, { name: 'Indevido', unitId })).status, 403)
  assert.equal((await post('/warehouse/stock-movements', requester, { materialId, tipo: 'saida', quantidade: 1, justificativa: 'Indevida' })).status, 403)
  assert.equal((await put(`/warehouse/stock/${materialId}/reserved`, requester, { reservada: 1, justificativa: 'Indevida' })).status, 403)
  assert.equal((await post('/warehouse/external-requests', requester, { sectorId, items: [{ materialId, requested: 1 }] })).status, 403)
  assert.equal((await post(`/warehouse/requests/${created.body.id}/status`, requester, { status: 'atendido' })).status, 403)

  // Previsão: continua recusada e auditada, mesmo com as duas permissões gravadas.
  const forecast = await put(`/warehouse/requests/${created.body.id}/delivery-forecast`, requester, { date: '2031-04-10' })
  assert.equal(forecast.status, 403)
  const audit = await pool.query(
    `SELECT details FROM public.auth_audit_events WHERE action = 'access.denied' AND actor_user_id = $1 AND target_resource_id = $2`,
    [requester.id, created.body.id],
  )
  assert.equal(audit.rows.length, 1)
  assert.deepEqual(audit.rows[0].details.missing, ['warehouse:manage', 'warehouse:forecast'])
})

test('Solicitante não vê nem infere o estoque por nenhuma resposta da API', async () => {
  const requester = await createUser('sigilo-solicitante-consulta@example.gov.br')

  // Catálogo: só o que identifica o material.
  const allowedMaterialKeys = ['id', 'code', 'name', 'description', 'unit', 'categoryId', 'category', 'active']
  for (const path of ['/warehouse/materials', `/warehouse/materials?search=${encodeURIComponent('Grampeador')}`, '/warehouse/materials?inactive=true']) {
    const listed = await get(path, requester)
    assert.equal(listed.status, 200, listed.text)
    assertNoStock(path, listed)
    const found = listed.body.materials.find((item: { id: string }) => item.id === materialId)
    assert.ok(found, `${path}: o material é identificável`)
    assert.deepEqual(Object.keys(found).sort(), [...allowedMaterialKeys].sort())
  }
  // Filtros de disponibilidade não existem: parâmetros inventados não mudam o resultado.
  const plain = (await get('/warehouse/materials', requester)).text
  for (const query of ['available=true', 'disponivel=true', 'inStock=true', 'belowMinimum=true', 'semEstoque=true']) {
    assert.equal((await get(`/warehouse/materials?${query}`, requester)).text, plain, query)
  }

  // Pedido acima de qualquer saldo: aceito, sem mensagem que revele disponibilidade.
  const huge = await post('/warehouse/requests', requester, { items: [{ materialId, requested: 9_999_999 }] })
  assert.equal(huge.status, 201, huge.text)
  assertNoStock('pedido acima do saldo', huge)
  const small = await post('/warehouse/requests', requester, { items: [{ materialId, requested: 1 }] })
  assert.equal(small.status, 201, small.text)
  assert.deepEqual(Object.keys(huge.body).sort(), Object.keys(small.body).sort(), 'mesma resposta, com ou sem saldo')

  // Atendimento parcial: o Solicitante vê o motivo neutro, sem saldo.
  const path = `/warehouse/requests/${small.body.id}`
  const items = await put(`${path}/items`, admin, { items: [{ materialId, requested: 1, fulfilled: 0, reasonCode: 'criterios_internos', note: `Saldo ${stockEntry}` }] })
  assert.equal(items.status, 200, items.text)

  for (const route of [
    '/warehouse/requests', path, `${path}/report?format=csv`, `${path}/report?format=pdf`,
    `/search?q=${encodeURIComponent(materialName)}`, '/search?q=EXP-001', '/search?q=Conferência',
    `/search?q=${encodeURIComponent(materialName)}&category=materials`, '/dashboard/summary', '/dashboard/summary?module=warehouse',
    `/communications/material_request/${small.body.id}`, `/attachments/resources/material_request/${small.body.id}`,
  ]) {
    const response = await get(route, requester)
    assert.ok([200, 403, 404].includes(response.status), `${route}: ${response.status} ${response.text}`)
    assertNoStock(route, response)
  }
  const detail = await get(path, requester)
  assert.equal(detail.status, 200)
  assert.deepEqual(
    Object.keys(detail.body.items[0]).sort(),
    ['fulfilled', 'id', 'material', 'materialId', 'notProvided', 'reason', 'requested', 'unit'],
  )
  assert.equal(detail.text.includes('Saldo'), false, 'a observação interna não chega ao Solicitante')
  const search = await get(`/search?q=${encodeURIComponent(materialName)}`, requester)
  assert.equal(search.body.results.inventoryChecks, undefined, 'sem a categoria de conferências')
  const hit = search.body.results.materials.hits.find((item: { id: string }) => item.id === materialId)
  assert.ok(hit)
  assert.equal(hit.link, '/almoxarifado/nova')

  // Relatórios e indicadores: sem a permissão, recusados; o painel não traz estoque.
  for (const route of ['/reports/summary', '/reports/operational', '/reports/operational?module=warehouse']) {
    const refused = await get(route, requester)
    assert.equal(refused.status, 403, route)
    assertNoStock(route, refused)
  }
})

test('com concessões comuns (relatórios, todos os pedidos, auditoria), o Solicitante continua sem estoque', async () => {
  const requester = await createUser('sigilo-solicitante-concessoes@example.gov.br')
  const granted = await put(`/admin/users/${requester.id}/access`, admin, {
    role: 'requester', slmMember: false, grantedPermissions: ['reports:read', 'requests:read_all', 'audit:read'], deniedPermissions: [],
  })
  assert.equal(granted.status, 200, granted.text)

  const summary = await get('/reports/summary?module=warehouse', requester)
  assert.equal(summary.status, 200, summary.text)
  assert.deepEqual(summary.body.materials, [], 'totais por material são indicador interno')
  assertNoStock('/reports/summary', summary)

  const operational = await get('/reports/operational?module=warehouse', requester)
  assert.equal(operational.status, 200, operational.text)
  assert.equal(operational.body.stockFlow, null)
  assert.equal(operational.body.inventory, null)
  const { stockFlow: _stockFlow, ...rest } = operational.body
  assertNoStock('/reports/operational', { ...operational, body: rest })

  // Auditoria: os eventos do estoque não aparecem, nem pela existência; a administradora os vê.
  const stockActions = ['warehouse.stock_movement', 'warehouse.reserve_changed', 'warehouse.inventory_created', 'warehouse.inventory_item_updated']
  const actionsFor = async (session: Session) => {
    const seen: string[] = []
    let text = ''
    for (let page = 1; page <= 20; page += 1) {
      const listed = await get(`/admin/audit?page=${page}`, session)
      assert.equal(listed.status, 200, listed.text)
      text += listed.text
      seen.push(...listed.body.events.map((event: { action: string }) => event.action))
      if (!listed.body.hasMore) break
    }
    return { seen, text }
  }
  const asRequester = await actionsFor(requester)
  for (const action of stockActions) assert.equal(asRequester.seen.includes(action), false, action)
  assertNoStock('/admin/audit', { status: 200, body: {}, text: asRequester.text })
  const filtered = await get('/admin/audit?action=warehouse.stock', requester)
  assert.deepEqual(filtered.body.events, [])

  const asAdmin = await actionsFor(admin)
  for (const action of stockActions) assert.ok(asAdmin.seen.includes(action), `administradora vê ${action}`)
})

test('administrador fora da SLM e Operador SLM autorizado continuam no estoque; previsão e agendamento só com a SLM', async () => {
  const me = (await get('/auth/me', admin)).body.user
  assert.equal(me.slmMember, false)
  assert.ok(me.permissions.includes('warehouse:manage'))
  assert.equal(me.permissions.includes('warehouse:forecast'), false)
  assert.equal(me.permissions.includes('requests:schedule'), false)

  const stock = await get('/warehouse/stock', admin)
  assert.equal(stock.status, 200)
  const row = stock.body.items.find((item: { id: string }) => item.id === materialId)
  assert.equal(row.current, stockEntry)
  assert.equal(row.reserved, stockReserved)
  assert.equal((await get('/warehouse/inventory-checks', admin)).status, 200)
  assert.equal((await get('/warehouse/control-records', admin)).status, 200)
  assert.ok((await get('/reports/operational', admin)).body.stockFlow.length >= 1)

  // Operador SLM: com a concessão, administra o estoque; sem ela, não.
  const operator = await staff('sigilo-operador@example.gov.br', ['warehouse:manage'])
  assert.equal((await get('/warehouse/stock', operator)).status, 200)
  const plainOperator = await staff('sigilo-operador-sem@example.gov.br', [])
  assert.equal((await get('/warehouse/stock', plainOperator)).status, 403)
  assert.equal((await permissionsOf(plainOperator)).includes('warehouse:manage'), false)

  // Ao deixar a equipe SLM (ou o perfil), o servidor retira a concessão.
  const demoted = await put(`/admin/users/${operator.id}/access`, admin, {
    role: 'requester', slmMember: false, grantedPermissions: ['warehouse:manage'], deniedPermissions: [],
  })
  assert.equal(demoted.status, 200, demoted.text)
  assert.equal((await storedGrants(operator.id)).includes('warehouse:manage'), false)
  assert.equal((await get('/warehouse/stock', operator)).status, 403)

  // Previsão: o administrador fora da SLM é recusado e auditado; o operador com as duas, não.
  const asker = await createUser('sigilo-pede@example.gov.br')
  const created = await post('/warehouse/requests', asker, { items: [{ materialId, requested: 1 }] })
  assert.equal(created.status, 201, created.text)
  const forecastPath = `/warehouse/requests/${created.body.id}/delivery-forecast`
  assert.equal((await put(forecastPath, admin, { date: '2031-05-10' })).status, 403)
  const audit = await pool.query(
    `SELECT 1 FROM public.auth_audit_events WHERE action = 'access.denied' AND actor_user_id = $1 AND target_resource_id = $2`,
    [admin.id, created.body.id],
  )
  assert.equal(audit.rows.length, 1)
  const onlyManage = await staff('sigilo-operador-gestao@example.gov.br', ['warehouse:manage'])
  assert.equal((await put(forecastPath, onlyManage, { date: '2031-05-10' })).status, 403)
  const forecaster = await staff('sigilo-operador-previsao@example.gov.br', ['warehouse:manage', 'warehouse:forecast'])
  const allowed = await put(forecastPath, forecaster, { date: '2031-05-10' })
  assert.equal(allowed.status, 200, allowed.text)

  // Agendamento: o administrador fora da SLM não recebe, nem por concessão.
  const adminCatalog = (await get('/admin/permissions', admin)).body
  const eligibleOutside = adminCatalog.eligibility.find((entry: { role: string; slmMember: boolean }) => entry.role === 'administrator' && !entry.slmMember).eligible as string[]
  assert.equal(eligibleOutside.includes('requests:schedule'), false)
  assert.equal(eligibleOutside.includes('warehouse:forecast'), false)
})
