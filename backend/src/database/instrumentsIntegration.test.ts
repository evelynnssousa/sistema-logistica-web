import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { Pool } from 'pg'
import app from '../app.js'
import { hashPassword } from '../auth/password.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { openRenewalDemands } from './instrumentRepository.js'
import { setDatabasePoolForTests } from './pool.js'

// Atas e contratos no Controle de Demandas (migração 021) e taxas do Dashboard, em 12/11/2026.
// API real, PostgreSQL descartável, 001 a 021.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')

let pool: Pool
let server: Server
let baseUrl: string
let directory: string
let admin: Session
let leadA: Session
let memberA: Session
let memberB: Session
let outsider: Session
let sectorA: string
let sectorB: string
let sectorC: string
let ataId: string
let itemId: string
const csrfTokens = new Map<string, string>()

type Session = { cookie: string; id: string }

async function call(path: string, options: { method?: string; body?: unknown; session?: Session; raw?: Buffer; fileName?: string } = {}) {
  const method = options.method ?? 'GET'
  const cookie = options.session?.cookie
  const token = cookie && method !== 'GET' ? csrfTokens.get(cookie) : undefined
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      'content-type': options.raw ? 'application/octet-stream' : 'application/json',
      ...(options.fileName ? { 'x-file-name': encodeURIComponent(options.fileName) } : {}),
      ...(cookie ? { cookie } : {}),
      ...(token ? { 'x-csrf-token': token } : {}),
    },
    body: options.raw ? new Uint8Array(options.raw) : options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const buffer = Buffer.from(await response.arrayBuffer())
  const text = buffer.toString('utf8')
  const setCookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  let body: Record<string, any> = {} // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    body = JSON.parse(text)
  } catch {
    // Conteúdo de arquivo.
  }
  if (setCookie && body.csrfToken) csrfTokens.set(setCookie, body.csrfToken)
  return { status: response.status, body, text, buffer, setCookie }
}

const get = (path: string, session: Session) => call(path, { session })
const post = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'POST', session, body })
const put = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'PUT', session, body })

async function signIn(email: string): Promise<Session> {
  authRateLimits.loginPair.reset(`127.0.0.1|${email}`)
  authRateLimits.loginPair.reset(`::ffff:127.0.0.1|${email}`)
  authRateLimits.loginAccount.reset(email)
  const result = await call('/auth/login', { method: 'POST', body: { identifier: email, password } })
  assert.equal(result.status, 200, `login de ${email}: ${result.text}`)
  return { cookie: result.setCookie, id: result.body.user.id }
}

async function createUser(email: string): Promise<Session> {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { fullName: `Pessoa ${email.split('@')[0]}`, email, sector: 'Administração', password, passwordConfirmation: password },
  })
  assert.equal(registered.status, 202, registered.text)
  const pending = await get('/admin/registrations/pending', admin)
  const id = pending.body.registrations.find((item: { email: string }) => item.email === email).id
  assert.equal((await post(`/admin/registrations/${id}/approve`, admin, { role: 'requester' })).status, 200)
  return signIn(email)
}

async function member(sectorId: string, user: Session, role: 'colaborador' | 'responsavel') {
  const result = await put(`/demands/settings/sectors/${sectorId}/members/${user.id}`, admin, { role })
  assert.equal(result.status, 200, result.text)
}

function ataBody(extra: Record<string, unknown> = {}) {
  return {
    type: 'ata',
    number: '12/2026',
    subject: 'Registro de preços de papel A4',
    category: 'material',
    supplier: 'Papelaria Fictícia',
    process: 'SEI 0001/2026',
    total: '10000',
    validFrom: '2026-01-01',
    validUntil: '2099-12-31',
    responsibleSectorId: sectorA,
    sharedSectorIds: [sectorB],
    noticeDays: 90,
    ...extra,
  }
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'slm-atas-'))
  process.env.ATTACHMENTS_DIR = directory
  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  for (const file of [
    '001_public_schema_snapshot.sql', '002_password_recovery.sql', '003_user_access.sql', '004_flight_passengers.sql',
    '005_operational_modules.sql', '006_integrations.sql', '007_operations_center.sql', '008_attachments.sql',
    '009_module_extensions.sql', '010_monitoring.sql', '011_delivery_forecast.sql', '012_operational_transparency.sql',
    '013_communications.sql', '014_demands.sql', '015_organizational_structure.sql', '016_driver_portal.sql',
    '017_driver_portal_settings.sql', '018_public_api_privileges.sql', '019_email_quota.sql', '020_warehouse_finance.sql',
    '021_contract_instruments.sql',
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

  const sector = async (name: string) => {
    const created = await post('/demands/settings/sectors', admin, { name })
    assert.equal(created.status, 201, created.text)
    return created.body.id as string
  }
  sectorA = await sector('Setor Compras')
  sectorB = await sector('Setor Contratos')
  sectorC = await sector('Setor Outro')
  leadA = await createUser('atas-chefe-a@example.gov.br')
  memberA = await createUser('atas-membro-a@example.gov.br')
  memberB = await createUser('atas-membro-b@example.gov.br')
  outsider = await createUser('atas-fora@example.gov.br')
  await member(sectorA, leadA, 'responsavel')
  await member(sectorA, memberA, 'colaborador')
  await member(sectorB, memberB, 'colaborador')
  await member(sectorC, outsider, 'colaborador')
})

after(async () => {
  delete process.env.ATTACHMENTS_DIR
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
  rmSync(directory, { recursive: true, force: true })
})

test('cadastro: só para o próprio setor; número único por tipo; administrador só consulta', async () => {
  assert.equal((await post('/demand-instruments', memberA, ataBody({ responsibleSectorId: sectorC }))).status, 403)
  assert.equal((await post('/demand-instruments', admin, ataBody())).status, 403, 'administrador sem perfil de Diretor só consulta')
  assert.equal((await post('/demand-instruments', memberA, ataBody({ validFrom: '2026-05-01', validUntil: '2026-04-01' }))).status, 400)
  const created = await post('/demand-instruments', memberA, ataBody())
  assert.equal(created.status, 201, created.text)
  ataId = created.body.id
  assert.equal((await post('/demand-instruments', leadA, ataBody({ number: '12/2026 ' }))).status, 409)
  // O mesmo número como contrato é outro instrumento.
  assert.equal((await post('/demand-instruments', leadA, ataBody({ type: 'contrato', category: 'servico' }))).status, 201)
})

test('acesso: setor responsável e compartilhado veem e alteram; outro setor não encontra', async () => {
  assert.equal((await get(`/demand-instruments/${ataId}`, memberB)).body.access.edit, true)
  assert.equal((await get(`/demand-instruments/${ataId}`, outsider)).status, 404)
  assert.equal((await put(`/demand-instruments/${ataId}`, outsider, ataBody())).status, 404)
  const consult = await get(`/demand-instruments/${ataId}`, admin)
  assert.equal(consult.status, 200)
  assert.equal(consult.body.access.edit, false)
  assert.equal((await get('/demand-instruments', outsider)).body.instruments.length, 0)
  assert.equal((await get('/demand-instruments', memberB)).body.instruments.length, 2, 'os dois compartilhados com o setor B')
  assert.equal((await get('/demand-instruments?type=contrato', memberA)).body.instruments.length, 1)
})

test('itens e utilizações: saldo por item, nunca acima do registrado, valor pela quantidade', async () => {
  const item = await post(`/demand-instruments/${ataId}/items`, memberA, {
    itemNumber: '1', description: 'Papel A4 75 g', unit: 'resma', registered: '1000', unitPrice: '25,50',
  })
  assert.equal(item.status, 201, item.text)
  itemId = item.body.id
  const usage = await post(`/demand-instruments/${ataId}/usages`, memberB, {
    itemId, quantity: 100, date: '2026-11-10', document: '2026NE0001',
  })
  assert.equal(usage.status, 201, usage.text)
  assert.equal((await post(`/demand-instruments/${ataId}/usages`, memberA, { itemId, quantity: 901, date: '2026-11-10' })).status, 409)
  assert.equal((await put(`/demand-instruments/${ataId}/items/${itemId}`, memberA, {
    description: 'Papel A4 75 g', unit: 'resma', registered: '50', unitPrice: '25.5',
  })).status, 409, 'registrado não fica abaixo do utilizado')

  const detail = (await get(`/demand-instruments/${ataId}`, memberA)).body.instrument
  assert.equal(detail.items[0].balance, 900)
  assert.equal(detail.items[0].usedValue, 2550)
  assert.equal(detail.spent, 2550)
  assert.equal(detail.balance, 7450)
  assert.equal(detail.usedPercent, 25.5)
  await assert.rejects(pool.query(`UPDATE public.contract_instrument_usages SET quantidade = 1`))
  await assert.rejects(pool.query(`DELETE FROM public.contract_instrument_usages`))
})

test('aditivos: prorrogação muda a vigência; acréscimo muda o valor; histórico permanente', async () => {
  assert.equal((await post(`/demand-instruments/${ataId}/amendments`, memberA, { type: 'prorrogacao', description: 'Sem data' })).status, 400)
  assert.equal(
    (await post(`/demand-instruments/${ataId}/amendments`, memberA, { type: 'prorrogacao', newEnd: '2099-01-01', description: 'Antes do fim' })).status,
    400,
  )
  const extended = await post(`/demand-instruments/${ataId}/amendments`, memberA, {
    type: 'prorrogacao', number: '1º TA', signedAt: '2026-11-01', newEnd: '2100-06-30', description: 'Prorrogação por 6 meses',
  })
  assert.equal(extended.status, 201, extended.text)
  const added = await post(`/demand-instruments/${ataId}/amendments`, memberA, { type: 'acrescimo', newValue: '12500', description: 'Acréscimo de 25%' })
  assert.equal(added.status, 201, added.text)
  const detail = (await get(`/demand-instruments/${ataId}`, memberA)).body.instrument
  assert.equal(detail.validUntil, '2100-06-30')
  assert.equal(detail.total, 12500)
  assert.equal(detail.amendments.length, 2)
  await assert.rejects(pool.query(`DELETE FROM public.contract_instrument_amendments`))
})

test('anexos: PDF da ata, sem URL pública, e só para quem vê o instrumento', async () => {
  const uploaded = await call(`/demand-instruments/${ataId}/attachments`, { method: 'POST', session: memberA, raw: pdf, fileName: 'ata-12-2026.pdf' })
  assert.equal(uploaded.status, 201, uploaded.text)
  const path = `/demand-instruments/${ataId}/attachments/${uploaded.body.id}`
  const download = await get(path, memberB)
  assert.equal(download.status, 200)
  assert.ok(download.buffer.equals(pdf))
  assert.equal((await get(path, outsider)).status, 404)
  assert.equal((await post(`${path}/remove`, memberB, { reason: 'Versão errada' })).status, 200)
  assert.equal((await get(path, memberA)).status, 404)
  await assert.rejects(pool.query(`DELETE FROM public.contract_instrument_attachments`))
})

test('vínculo com a demanda: só com instrumento visível; aparece nos dois lados', async () => {
  const categories = await get('/demands/options', memberA)
  const demand = await post('/demands', memberA, {
    title: 'Comprar papel pela ata', description: 'Pedido do trimestre', categoryId: categories.body.categories[0].id,
    originSectorId: sectorA, responsibleSectorId: sectorA,
  })
  assert.equal(demand.status, 201, demand.text)
  const contractOfC = await post('/demand-instruments', outsider, ataBody({ number: 'C-1', responsibleSectorId: sectorC, sharedSectorIds: [] }))
  assert.equal(contractOfC.status, 201, contractOfC.text)
  assert.equal((await put(`/demands/${demand.body.id}/instrument`, memberA, { instrumentId: contractOfC.body.id })).status, 400)
  assert.equal((await put(`/demands/${demand.body.id}/instrument`, memberA, { instrumentId: ataId })).status, 200)
  assert.equal((await get(`/demands/${demand.body.id}`, memberA)).body.instrument.number, '12/2026')
  const linked = (await get(`/demand-instruments/${ataId}`, memberA)).body.instrument.demands
  assert.deepEqual(linked.map((item: { title: string }) => item.title), ['Comprar papel pela ata'])
  // Quem vê a ata por compartilhamento não vê a demanda de outro setor.
  assert.equal((await get(`/demand-instruments/${ataId}`, memberB)).body.instrument.demands.length, 0)
  const options = (await get('/demand-instruments/options', memberA)).body.instruments
  assert.ok(options.every((item: { id: string }) => item.id !== contractOfC.body.id))
})

test('renovação: demanda aberta uma vez ao entrar no prazo de aviso, e de novo só após prorrogar', async () => {
  const created = await post('/demand-instruments', leadA, ataBody({
    number: 'R-1', validUntil: '2026-12-31', noticeDays: 60, managerId: memberA.id, sharedSectorIds: [],
  }))
  assert.equal(created.status, 201, created.text)
  const id = created.body.id
  assert.equal(await openRenewalDemands('2026-10-31'), 0)
  assert.equal(await openRenewalDemands('2026-11-01'), 1)
  assert.equal(await openRenewalDemands('2026-11-02'), 0, 'uma vez por vigência')
  const detail = (await get(`/demand-instruments/${id}`, leadA)).body.instrument
  assert.ok(detail.renewalDemand)
  const demand = (await get(`/demands/${detail.renewalDemand.id}`, memberA)).body
  assert.match(demand.demand.title, /^Renovar ata R-1/)
  assert.equal(demand.demand.responsibleId, memberA.id)
  assert.equal(demand.demand.dueDate, '2026-12-31')
  assert.equal(demand.instrument.id, id)

  assert.equal((await post(`/demand-instruments/${id}/amendments`, leadA, { type: 'prorrogacao', newEnd: '2027-12-31', description: 'Prorrogada' })).status, 201)
  assert.equal(await openRenewalDemands('2026-11-03'), 0)
  assert.equal(await openRenewalDemands('2027-11-01'), 1)
})

test('dashboard: taxas de desempenho presentes, sem base dão porcentagem nula', async () => {
  const summary = await get('/dashboard/summary', admin)
  assert.equal(summary.status, 200, summary.text)
  assert.equal(summary.body.rates.onTime.percent, null)
  assert.equal(summary.body.rates.cancelled.eligible, 0)
  assert.ok(summary.body.rates.warehouseComplete)
})

test('a 021 não se desfaz com atas cadastradas', async () => {
  await assert.rejects(pool.query(schema('021_contract_instruments.rollback.sql')), /não pode ser desfeita/)
})
