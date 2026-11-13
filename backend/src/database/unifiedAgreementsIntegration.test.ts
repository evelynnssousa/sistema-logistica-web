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
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'

// Atas unificadas (migração 024, 13/11/2026): as atas do Almoxarifado viram atas do Controle de
// Demandas, com o gasto preservado, e passam a aceitar utilização que não é entrada de material.
// API real, PostgreSQL descartável, 001 a 023 antes da conversão.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')

let pool: Pool
let server: Server
let baseUrl: string
let admin: Session
let operator: Session
let paperId: string
let activeAgreement: string
let closedAgreement: string
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
  const text = await response.text()
  const body = (response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : {}) as Record<string, any>
  const setCookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  if (setCookie && body.csrfToken) csrfTokens.set(setCookie, body.csrfToken)
  return { status: response.status, body, text, setCookie }
}

const get = (path: string, session: Session) => call(path, { session })
const post = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'POST', session, body })

async function signIn(email: string): Promise<Session> {
  authRateLimits.loginPair.reset(`127.0.0.1|${email}`)
  authRateLimits.loginPair.reset(`::ffff:127.0.0.1|${email}`)
  authRateLimits.loginAccount.reset(email)
  const result = await call('/auth/login', { method: 'POST', body: { identifier: email, password } })
  assert.equal(result.status, 200, `login de ${email}: ${result.text}`)
  return { cookie: result.setCookie, id: result.body.user.id }
}

async function createOperator(email: string): Promise<Session> {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { fullName: 'Operadora do Almoxarifado', email, sector: 'SLM', password, passwordConfirmation: password },
  })
  assert.equal(registered.status, 202, registered.text)
  const pending = await get('/admin/registrations/pending', admin)
  const id = pending.body.registrations.find((item: { email: string }) => item.email === email).id as string
  assert.equal((await post(`/admin/registrations/${id}/approve`, admin, { role: 'slm_operator' })).status, 200)
  const access = await call(`/admin/users/${id}/access`, {
    method: 'PUT', session: admin,
    body: { role: 'slm_operator', slmMember: true, grantedPermissions: [], deniedPermissions: [] },
  })
  assert.equal(access.status, 200, access.text)
  return signIn(email)
}

const entry = (body: Record<string, unknown>) =>
  post('/warehouse/stock-movements', operator, { materialId: paperId, tipo: 'entrada', quantidade: 5, justificativa: 'Compra', ...body })

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
    '021_contract_instruments.sql', '022_forms_and_links.sql', '023_patrimony.sql',
  ]) {
    await pool.query(schema(file))
  }
  resetAccessSchemaCacheForTests()
  await pool.query(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'atas-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )
  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('atas-admin@example.gov.br')

  const unit = await post('/settings/catalog/measurementUnits', admin, { label: 'Resma' })
  assert.equal(unit.status, 201, unit.text)
  const created = await post('/warehouse/materials', admin, { name: 'Papel A4 Atas', unitId: unit.body.option.id })
  assert.equal(created.status, 201, created.text)
  paperId = created.body.id
  operator = await createOperator('atas-operadora@example.gov.br')
})

after(async () => {
  for (const name of ['PASSENGER_DATA_KEY', 'EMAIL_TRANSPORT']) delete process.env[name]
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

test('antes da 024: atas do Almoxarifado continuam como estavam', async () => {
  const active = await post('/warehouse/finance/agreements', operator, {
    numero: 'ATA 7/2026', fornecedor: 'Papelaria Fictícia', objeto: 'Papel', valorTotal: '1000,00',
    vigenciaInicio: '2026-01-01', vigenciaFim: '2099-12-31',
  })
  assert.equal(active.status, 201, active.text)
  activeAgreement = active.body.id
  const closed = await post('/warehouse/finance/agreements', operator, { numero: 'ATA 8/2026', valorTotal: 50, ativo: false })
  assert.equal(closed.status, 201, closed.text)
  closedAgreement = closed.body.id

  assert.equal((await entry({ valorPago: 300, notaFiscal: '55', empenho: '2026NE7', ataId: activeAgreement })).status, 201)
  // Entrada sem valor informado não contava no gasto da ata, e continua sem contar.
  assert.equal((await entry({ ataId: activeAgreement })).status, 201)

  // Outra ata com o mesmo número já existe no Controle de Demandas.
  const sector = await pool.query<{ id: string }>(`INSERT INTO public.demand_sectors (nome) VALUES ('Compras') RETURNING id`)
  await pool.query(
    `INSERT INTO public.contract_instruments (tipo, numero, objeto, categoria, valor_total, setor_responsavel_id, criado_por)
     VALUES ('ata', 'ata 8/2026', 'Outra ata', 'servico', 10, $1, $2)`,
    [sector.rows[0].id, operator.id],
  )

  const summary = await get('/warehouse/finance', admin)
  assert.equal(summary.status, 200, summary.text)
  assert.equal(summary.body.summary.agreementsUnified, false)
  assert.equal(summary.body.summary.agreements.length, 2)
})

test('024: cada ata vira ata do Controle de Demandas, com o gasto preservado e item em reais', async () => {
  await pool.query(schema('024_unified_agreements.sql'))

  const agreements = await pool.query<{ id: string; ativo: boolean; instrumento_id: string | null }>(
    `SELECT id::text AS id, ativo, instrumento_id::text AS instrumento_id FROM public.warehouse_price_agreements`,
  )
  assert.equal(agreements.rows.length, 2)
  assert.ok(agreements.rows.every((row) => row.instrumento_id && !row.ativo))

  const sector = await pool.query<{ id: string }>(`SELECT id FROM public.demand_sectors WHERE nome = 'Almoxarifado'`)
  assert.equal(sector.rows.length, 1, 'setor criado')
  const member = await pool.query(`SELECT 1 FROM public.demand_sector_members WHERE sector_id = $1 AND user_id = $2`, [sector.rows[0].id, operator.id])
  assert.equal(member.rowCount, 1, 'quem cadastrou entra no setor')

  const instruments = await pool.query<{ numero: string; categoria: string; valor_total: string; encerrado: boolean; setor_responsavel_id: string }>(
    `SELECT numero, categoria, valor_total, encerrado, setor_responsavel_id::text AS setor_responsavel_id
       FROM public.contract_instruments WHERE id IN (SELECT instrumento_id FROM public.warehouse_price_agreements)
      ORDER BY numero`,
  )
  assert.deepEqual(instruments.rows.map((row) => [row.numero, row.categoria, Number(row.valor_total), row.encerrado]), [
    ['ATA 7/2026', 'material', 1000, false],
    ['ATA 8/2026 (Almox.)', 'material', 50, true],
  ])
  assert.ok(instruments.rows.every((row) => row.setor_responsavel_id === sector.rows[0].id))

  const id = agreements.rows.find((row) => row.id === activeAgreement)!.instrumento_id!
  const detail = await get(`/demand-instruments/${id}`, operator)
  assert.equal(detail.status, 200, detail.text)
  assert.equal(detail.body.access.edit, true)
  // Regra existente: o Administrador sem perfil de Diretor só consulta atas.
  assert.equal((await get(`/demand-instruments/${id}`, admin)).body.access.edit, false)
  const instrument = detail.body.instrument
  assert.equal(instrument.spent, 300)
  assert.equal(instrument.balance, 700)
  assert.equal(instrument.items.length, 1)
  assert.equal(instrument.items[0].unit, 'R$')
  assert.equal(instrument.usages.length, 1)
  assert.equal(instrument.usages[0].document, 'NF 55 · Empenho 2026NE7')

  // O histórico antigo continua mostrando a ata na movimentação.
  const movements = await get('/warehouse/stock-movements', admin)
  assert.equal(movements.body.movements.filter((item: { agreement: string | null }) => item.agreement === 'ATA 7/2026').length, 2)
})

test('depois da 024: só se cadastram atas em Atas e contratos; uso manual e entrada em reais funcionam', async () => {
  const blocked = await post('/warehouse/finance/agreements', operator, { numero: 'ATA 9/2026', valorTotal: 10 })
  assert.equal(blocked.status, 409, blocked.text)
  assert.equal(blocked.body.code, 'AGREEMENTS_UNIFIED')
  assert.equal((await entry({ valorPago: 10, ataId: activeAgreement })).status, 409, 'ata antiga não aceita mais entradas')
  assert.equal((await entry({ valorPago: 10, ataId: closedAgreement })).status, 409)

  const summary = (await get('/warehouse/finance', admin)).body.summary
  assert.equal(summary.agreementsUnified, true)
  assert.equal(summary.agreements.length, 0)
  const converted = summary.instruments.find((item: { number: string }) => item.number === 'ATA 7/2026')
  assert.equal(converted.spent, 300)
  assert.equal(converted.items[0].byValue, true)
  assert.equal(summary.agreementsTotal, 1000, 'sem contar em dobro')
  assert.equal(summary.agreementsSpent, 300)

  // Utilização que não é material (um serviço, por exemplo), registrada em Atas e contratos.
  const usage = await post(`/demand-instruments/${converted.id}/usages`, operator, {
    itemId: converted.items[0].id, quantity: 150, date: '2026-11-13', document: 'OS 12', note: 'Serviço de entrega',
  })
  assert.equal(usage.status, 201, usage.text)

  // Entrada pelo item em reais: baixa o valor pago, não a quantidade de material.
  assert.equal((await entry({ itemAtaId: converted.items[0].id })).status, 400, 'exige o valor pago')
  assert.equal((await entry({ itemAtaId: converted.items[0].id, valorPago: 600 })).status, 409, 'acima do saldo de R$ 550')
  const paid = await entry({ itemAtaId: converted.items[0].id, valorPago: 250 })
  assert.equal(paid.status, 201, paid.text)

  const after = (await get(`/demand-instruments/${converted.id}`, operator)).body.instrument
  assert.equal(after.spent, 700)
  assert.equal(after.balance, 300)
  assert.equal(after.items[0].balance, 300)

  await assert.rejects(pool.query(schema('024_unified_agreements.rollback.sql')), /não pode ser desfeita/)
})
