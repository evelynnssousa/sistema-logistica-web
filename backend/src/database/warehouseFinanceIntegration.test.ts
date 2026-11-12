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
import { allSheetsText, readXlsx, sheetNamesOf } from '../reports/xlsxReader.testSupport.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'

// Valores do Almoxarifado (migração 020) e baixa automática na entrega, em 12/11/2026.
// API real, PostgreSQL descartável, 001 a 020.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')

let pool: Pool
let server: Server
let baseUrl: string
let admin: Session
let operator: Session
let noValues: Session
let requester: Session
let unitId: string
let paperId: string
let agreementId: string
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

async function createUser(email: string, role = 'requester'): Promise<Session> {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { fullName: `Pessoa ${email.split('@')[0]}`, email, sector: 'Protocolo', password, passwordConfirmation: password },
  })
  assert.equal(registered.status, 202, registered.text)
  const pending = await get('/admin/registrations/pending', admin)
  const id = pending.body.registrations.find((item: { email: string }) => item.email === email).id as string
  const approved = await post(`/admin/registrations/${id}/approve`, admin, { role })
  assert.equal(approved.status, 200, approved.text)
  return signIn(email)
}

async function staff(email: string, denied: Permission[] = []): Promise<Session> {
  const user = await createUser(email, 'slm_operator')
  const result = await put(`/admin/users/${user.id}/access`, admin, {
    role: 'slm_operator', slmMember: true, grantedPermissions: [], deniedPermissions: denied,
  })
  assert.equal(result.status, 200, result.text)
  return signIn(email)
}

async function material(name: string) {
  const created = await post('/warehouse/materials', admin, { name, unitId })
  assert.equal(created.status, 201, created.text)
  return created.body.id as string
}

async function stockOf(id: string, session = admin) {
  const stock = await get('/warehouse/stock', session)
  assert.equal(stock.status, 200, stock.text)
  return stock.body.items.find((item: { id: string }) => item.id === id)
}

/** Pedido interno atendido e entregue: a entrega dá baixa automática. */
async function deliver(materialId: string, requested: number, fulfilled: number) {
  const created = await post('/warehouse/requests', requester, { items: [{ materialId, requested }] })
  assert.equal(created.status, 201, created.text)
  const path = `/warehouse/requests/${created.body.id}`
  assert.equal((await put(`${path}/items`, operator, { items: [{ materialId, requested, fulfilled }] })).status, 200)
  const status = fulfilled < requested ? 'atendido_parcial' : 'atendido'
  if (status === 'atendido_parcial') {
    await pool.query(`UPDATE public.material_request_items SET motivo_codigo = 'falta', motivo_nome = 'Falta' WHERE material_request_id = $1`, [created.body.id])
  }
  const changed = await post(`${path}/status`, operator, { status })
  assert.equal(changed.status, 200, changed.text)
  const delivered = await post(`${path}/deliver`, operator, { receivedBy: 'Pessoa Recebedora' })
  assert.equal(delivered.status, 200, delivered.text)
  return created.body.id as string
}

async function download(path: string, session: Session) {
  const response = await fetch(`${baseUrl}/api${path}`, { headers: { cookie: session.cookie } })
  return { status: response.status, file: Buffer.from(await response.arrayBuffer()) }
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
    '017_driver_portal_settings.sql', '018_public_api_privileges.sql', '019_email_quota.sql', '020_warehouse_finance.sql',
  ]) {
    await pool.query(schema(file))
  }
  resetAccessSchemaCacheForTests()
  await pool.query(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'valores-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )
  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('valores-admin@example.gov.br')

  const unit = await post('/settings/catalog/measurementUnits', admin, { label: 'Resma' })
  assert.equal(unit.status, 201, unit.text)
  unitId = unit.body.option.id
  paperId = await material('Papel A4 Valores')
  operator = await staff('valores-operadora@example.gov.br')
  noValues = await staff('valores-sem@example.gov.br', ['warehouse:finance'])
  requester = await createUser('valores-pede@example.gov.br')
})

after(async () => {
  for (const name of ['PASSENGER_DATA_KEY', 'EMAIL_TRANSPORT']) delete process.env[name]
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

test('permissão: Administrador e Operador SLM veem valores; Solicitante e quem teve a permissão retirada, não', async () => {
  const me = async (session: Session) => ((await get('/auth/me', session)).body.user.permissions as string[]).includes('warehouse:finance')
  assert.equal(await me(admin), true)
  assert.equal(await me(operator), true)
  assert.equal(await me(noValues), false)
  assert.equal(await me(requester), false)
  assert.equal((await get('/warehouse/finance', requester)).status, 403)
  assert.equal((await get('/warehouse/finance', noValues)).status, 403)
  assert.equal((await post('/warehouse/finance/agreements', noValues, { numero: 'X', valorTotal: 1 })).status, 403)
})

test('atas: cadastro, número único e validação', async () => {
  const created = await post('/warehouse/finance/agreements', admin, {
    numero: 'ATA 12/2026', fornecedor: 'Papelaria Fictícia', objeto: 'Papel', valorTotal: '1000,00',
    vigenciaInicio: '2026-01-01', vigenciaFim: '2099-12-31',
  })
  assert.equal(created.status, 201, created.text)
  agreementId = created.body.id
  assert.equal((await post('/warehouse/finance/agreements', admin, { numero: 'ata 12/2026 ', valorTotal: 5 })).status, 409)
  assert.equal((await post('/warehouse/finance/agreements', admin, { numero: 'ATA 13', valorTotal: 'abc' })).status, 400)
  assert.equal(
    (await post('/warehouse/finance/agreements', admin, { numero: 'ATA 14', valorTotal: 1, vigenciaInicio: '2026-05-01', vigenciaFim: '2026-04-01' })).status,
    400,
  )
  const list = await get('/warehouse/finance/agreements', operator)
  assert.equal(list.status, 200)
  assert.equal(list.body.agreements[0].situation, 'vigente')
})

test('entradas com valor: custo médio ponderado, nota, empenho, fornecedor e ata', async () => {
  const first = await post('/warehouse/stock-movements', admin, {
    materialId: paperId, tipo: 'entrada', quantidade: 10, justificativa: 'Compra 1',
    valorPago: '200', notaFiscal: 'NF 123', empenho: '2026NE0001', fornecedor: 'Papelaria Fictícia', ataId: agreementId,
  })
  assert.equal(first.status, 201, first.text)
  const second = await post('/warehouse/stock-movements', operator, {
    materialId: paperId, tipo: 'entrada', quantidade: 10, justificativa: 'Compra 2', valorPago: 300,
  })
  assert.equal(second.status, 201, second.text)

  const item = await stockOf(paperId)
  assert.equal(item.current, 20)
  assert.equal(item.stockValue, 500)
  assert.equal(item.averageCost, 25)

  // Saída não recebe valor digitado; quem não vê valores não registra valores e não os vê.
  assert.equal((await post('/warehouse/stock-movements', admin, { materialId: paperId, tipo: 'saida', quantidade: 1, justificativa: 'x', valorPago: 1 })).status, 400)
  assert.equal((await post('/warehouse/stock-movements', noValues, { materialId: paperId, tipo: 'entrada', quantidade: 1, justificativa: 'x', valorPago: 1 })).status, 403)
  const hidden = await stockOf(paperId, noValues)
  assert.equal('stockValue' in hidden, false)
  assert.equal('averageCost' in hidden, false)
  const hiddenMovements = await get('/warehouse/stock-movements', noValues)
  assert.equal(hiddenMovements.status, 200)
  assert.ok(!hiddenMovements.text.includes('NF 123'))
  assert.ok(!hiddenMovements.text.includes('"value"'))

  const movements = await get('/warehouse/stock-movements', admin)
  const firstEntry = movements.body.movements.find((movement: { reason: string }) => movement.reason === 'Compra 1')
  assert.equal(firstEntry.value, 200)
  assert.equal(firstEntry.valueInformed, true)
  assert.equal(firstEntry.invoice, 'NF 123')
  assert.equal(firstEntry.commitment, '2026NE0001')
  assert.equal(firstEntry.agreement, 'ATA 12/2026')
})

test('entrega: baixa automática pelo custo médio, e nunca falha por falta de saldo', async () => {
  const id = await deliver(paperId, 4, 4)
  let item = await stockOf(paperId)
  assert.equal(item.current, 16)
  assert.equal(item.stockValue, 400)
  assert.equal(item.averageCost, 25)
  const exit = await pool.query(
    `SELECT tipo, quantidade, valor_total, motivo FROM public.stock_movements WHERE material_request_id = $1`,
    [id],
  )
  assert.equal(exit.rows.length, 1)
  assert.equal(exit.rows[0].tipo, 'saida')
  assert.equal(Number(exit.rows[0].quantidade), 4)
  assert.equal(Number(exit.rows[0].valor_total), 100)
  assert.match(exit.rows[0].motivo, /Baixa automática da entrega do pedido/)

  // Pede 30 com 16 em estoque: sai o que há, o valor zera junto, e a justificativa diz o que faltou.
  const short = await deliver(paperId, 30, 30)
  item = await stockOf(paperId)
  assert.equal(item.current, 0)
  assert.equal(item.stockValue, 0)
  const shortExit = await pool.query(`SELECT quantidade, valor_total, motivo FROM public.stock_movements WHERE material_request_id = $1`, [short])
  assert.equal(Number(shortExit.rows[0].quantidade), 16)
  assert.equal(Number(shortExit.rows[0].valor_total), 400)
  assert.match(shortExit.rows[0].motivo, /insuficiente: baixado 16 de 30/)

  // Sem saldo nenhum: a entrega acontece e nada é baixado.
  const none = await deliver(paperId, 2, 2)
  assert.equal((await pool.query(`SELECT 1 FROM public.stock_movements WHERE material_request_id = $1`, [none])).rows.length, 0)
})

test('valor do saldo existente: registrado, permanente e só com saldo', async () => {
  const pens = await material('Caneta Valores')
  // Entrada de quem não vê valores: entra sem valor (sem custo médio anterior, vale zero).
  assert.equal((await post('/warehouse/stock-movements', noValues, { materialId: pens, tipo: 'entrada', quantidade: 3, justificativa: 'Saldo antigo' })).status, 201)
  assert.equal((await stockOf(pens)).stockValue, 0)
  const set = await put(`/warehouse/stock/${pens}/value`, admin, { valor: '90', justificativa: 'Valor do inventário' })
  assert.equal(set.status, 200, set.text)
  const item = await stockOf(pens)
  assert.equal(item.stockValue, 90)
  assert.equal(item.averageCost, 30)
  assert.equal((await put(`/warehouse/stock/${pens}/value`, noValues, { valor: '1', justificativa: 'x' })).status, 403)
  assert.equal((await put(`/warehouse/stock/${paperId}/value`, admin, { valor: '10', justificativa: 'Sem saldo' })).status, 409)
  await assert.rejects(pool.query(`UPDATE public.material_value_adjustments SET valor_novo = 1`))
  await assert.rejects(pool.query(`DELETE FROM public.material_value_adjustments`))
})

test('painel: valor em estoque, compras, consumo, atas, mais caros e consumo por setor', async () => {
  const result = await get('/warehouse/finance', admin)
  assert.equal(result.status, 200, result.text)
  const summary = result.body.summary
  assert.equal(summary.stockValue, 90)
  assert.equal(summary.purchases, 500)
  assert.equal(summary.consumption, 500)
  assert.equal(summary.agreementsTotal, 1000)
  assert.equal(summary.agreementsSpent, 200)
  assert.equal(summary.agreementsBalance, 800)
  assert.equal(summary.agreements[0].usedPercent, 20)
  assert.equal(summary.monthly.length, 1)
  assert.equal(summary.mostExpensive[0].name, 'Caneta Valores')
  assert.equal(summary.mostExpensive[0].averageCost, 30)
  const paper = summary.mostExpensive.find((item: { name: string }) => item.name === 'Papel A4 Valores')
  assert.equal(paper.lastPrice, 30)
  assert.equal(summary.topSpend[0].value, 500)
  assert.equal(summary.bySector.reduce((total: number, row: { value: number }) => total + row.value, 0), 500)
  assert.equal(summary.materialsWithoutValue, 0)
  assert.equal((await get('/warehouse/finance?from=2026-05-01&to=2026-04-01', admin)).status, 400)
})

test('planilha: abas financeiras só para quem vê valores', async () => {
  const range = `from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`
  const full = await download(`/reports/warehouse/spreadsheet?${range}`, admin)
  assert.equal(full.status, 200)
  const files = readXlsx(full.file)
  for (const sheet of ['Financeiro', 'Atas', 'Entradas com valor', 'Saídas com valor']) {
    assert.ok(sheetNamesOf(files).includes(sheet), `faltou a aba ${sheet}`)
  }
  const text = allSheetsText(files)
  for (const expected of ['NF 123', '2026NE0001', 'ATA 12/2026', 'Custo médio (R$)']) assert.ok(text.includes(expected), `faltou ${expected}`)

  const partial = readXlsx((await download(`/reports/warehouse/spreadsheet?${range}`, noValues)).file)
  assert.equal(sheetNamesOf(partial).includes('Financeiro'), false)
  assert.ok(!allSheetsText(partial).includes('NF 123'))
})

test('auditoria sem valores, e a 020 não se desfaz com valores registrados', async () => {
  const audit = await pool.query<{ action: string; details: Record<string, string> }>(
    `SELECT action, details FROM public.auth_audit_events WHERE action IN ('warehouse.agreement_saved', 'warehouse.value_set')`,
  )
  assert.ok(audit.rows.length >= 2)
  assert.ok(audit.rows.every((row) => !JSON.stringify(row.details).match(/1000|90|valor/i)))
  await assert.rejects(pool.query(schema('020_warehouse_finance.rollback.sql')), /não pode ser desfeita/)
})
