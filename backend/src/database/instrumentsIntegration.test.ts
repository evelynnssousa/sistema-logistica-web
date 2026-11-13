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
import { RobotRepository } from './robotRepository.js'
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
    '021_contract_instruments.sql', '022_forms_and_links.sql',
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

test('ligação com o Almoxarifado: a entrada pelo item da ata baixa o saldo dele e aparece em Valores', async () => {
  const unit = await post('/settings/catalog/measurementUnits', admin, { label: 'Resma' })
  assert.equal(unit.status, 201, unit.text)
  const material = await post('/warehouse/materials', admin, { name: 'Papel Ligado', unitId: unit.body.option.id })
  assert.equal(material.status, 201, material.text)
  const options = (await get('/warehouse/finance/instruments', admin)).body.instruments
  const ata = options.find((item: { id: string }) => item.id === ataId)
  assert.ok(ata, 'a ata de materiais aparece para o Almoxarifado')
  const before = ata.items[0].balance

  assert.equal((await post('/warehouse/stock-movements', admin, {
    materialId: material.body.id, tipo: 'entrada', quantidade: before + 1, justificativa: 'Acima do saldo', itemAtaId: itemId,
  })).status, 409)
  const entry = await post('/warehouse/stock-movements', admin, {
    materialId: material.body.id, tipo: 'entrada', quantidade: 20, justificativa: 'Compra pela ata', notaFiscal: '555', itemAtaId: itemId,
  })
  assert.equal(entry.status, 201, entry.text)

  const detail = (await get(`/demand-instruments/${ataId}`, memberA)).body.instrument
  assert.equal(detail.items[0].balance, before - 20)
  const usage = detail.usages.find((item: { document: string | null }) => item.document === 'NF 555')
  assert.ok(usage)
  assert.equal(usage.value, 510)
  const stock = (await get('/warehouse/stock', admin)).body.items.find((item: { id: string }) => item.id === material.body.id)
  assert.equal(stock.stockValue, 510, 'sem valor digitado, vale o preço da ata')
  const movements = (await get('/warehouse/stock-movements', admin)).body.movements
  assert.equal(movements.find((item: { reason: string }) => item.reason === 'Compra pela ata').agreement, 'Ata 12/2026')
  const summary = (await get('/warehouse/finance', admin)).body.summary
  assert.ok(summary.instruments.some((item: { id: string }) => item.id === ataId))
})

test('pesquisa geral: demandas e atas só do setor da pessoa ou compartilhadas', async () => {
  const search = async (session: Session, term: string) => (await get(`/search?q=${encodeURIComponent(term)}`, session)).body.results
  const own = await search(memberA, 'Comprar papel')
  assert.equal(own.demands.hits[0].title, 'Comprar papel pela ata')
  assert.equal(own.demands.hits[0].link.startsWith('/demandas/'), true)
  // Outro setor: não encontra a demanda nem a ata do setor A, só a sua própria ata.
  const other = await search(outsider, 'papel')
  assert.equal(other.demands, undefined)
  assert.ok((other.instruments?.hits ?? []).every((hit: { title: string }) => !hit.title.includes('12/2026')))
  // Compartilhada com o setor B: a ata aparece; a demanda do setor A, não.
  const shared = await search(memberB, 'papel')
  assert.ok(shared.instruments.hits.some((hit: { title: string }) => hit.title.includes('12/2026')))
  assert.equal(shared.demands, undefined)
  // Filtro por módulo e pessoa sem vínculo com o Controle de Demandas.
  assert.equal(Object.keys(await search(memberA, 'Comprar papel')).includes('demands'), true)
  const onlyDemands = (await get('/search?q=papel&module=demands', memberA)).body.results
  assert.deepEqual(Object.keys(onlyDemands).sort(), ['demands', 'instruments'])
})

test('localização do material: interna, e o inventário segue a ordem dos armários', async () => {
  const unit = await post('/settings/catalog/measurementUnits', admin, { label: 'Caixa' })
  assert.equal(unit.status, 201, unit.text)
  const create = async (name: string, location: string) => {
    const created = await post('/warehouse/materials', admin, { name, unitId: unit.body.option.id, location })
    assert.equal(created.status, 201, created.text)
    return created.body.id as string
  }
  const pencil = await create('Lápis grafite', 'Armário 2')
  const clip = await create('Clipe', 'Armário 1')
  const tape = await create('Fita adesiva', 'Armário 1')
  assert.equal(
    (await call(`/warehouse/materials/${pencil}`, { method: 'PATCH', session: admin, body: { name: 'Lápis grafite', unitId: unit.body.option.id, location: 'Armário 3' } })).status,
    200,
  )
  const listed = (await get('/warehouse/materials', admin)).body.materials.find((item: { id: string }) => item.id === pencil)
  assert.equal(listed.location, 'Armário 3')
  // Quem só pede materiais não vê onde ficam.
  const forRequester = (await get('/warehouse/materials', memberA)).body.materials.find((item: { id: string }) => item.id === pencil)
  assert.equal('location' in forRequester, false)

  const check = await post('/warehouse/inventory-checks', admin, {
    title: 'Contagem por armário', referenceDate: '2026-11-13',
    items: [pencil, tape, clip].map((materialId) => ({ materialId, governmentQuantity: 1 })),
  })
  assert.equal(check.status, 201, check.text)
  const detail = (await get(`/warehouse/inventory-checks/${check.body.id}`, admin)).body.check
  assert.deepEqual(
    detail.items.map((item: { location: string; material: string }) => `${item.location}: ${item.material}`),
    ['Armário 1: Clipe', 'Armário 1: Fita adesiva', 'Armário 3: Lápis grafite'],
  )
  const byLocation = (await get('/warehouse/stock?order=location', admin)).body.items.map((item: { name: string }) => item.name)
  assert.ok(byLocation.indexOf('Clipe') < byLocation.indexOf('Lápis grafite'))
})

test('robô: lê a planilha do governo, compara com o catálogo e não grava nada', async () => {
  const sheet = (text: string, session: Session, query = '', fileName = 'saldo.csv') =>
    call(`/warehouse/robot/sheet${query}`, { method: 'POST', session, raw: Buffer.from(text, 'latin1'), fileName })
  const csv = 'Relatório de saldo\r\n\r\nCódigo;Descrição do material;Saldo\r\n;LÁPIS GRAFITE;1.250\r\n;Fita adesiva larga;2\r\n;Grampeador industrial;1\r\n;Total geral;1.253\r\n'

  assert.equal((await sheet(csv, memberA)).status, 403)
  const before = (await pool.query(`SELECT count(*)::int AS total FROM public.inventory_checks`)).rows[0].total

  const read = await sheet(csv, admin)
  assert.equal(read.status, 200, read.text)
  assert.equal(read.body.kind, 'csv')
  assert.deepEqual(read.body.columns, { headerRow: 2, code: 0, description: 1, quantity: 2, unit: null })
  const byLine = Object.fromEntries(read.body.lines.map((line: { description: string; quantity: number; match: { status: string } }) => [line.description, [line.match.status, line.quantity]]))
  assert.deepEqual(byLine, {
    'LÁPIS GRAFITE': ['name', 1250],
    'Fita adesiva larga': ['suggested', 2],
    'Grampeador industrial': ['none', 1],
  })
  assert.ok(read.body.catalog.some((entry: { name: string; location: string }) => entry.name === 'Lápis grafite' && entry.location === 'Armário 3'))

  // Colunas trocadas na tela: sem a quantidade, as linhas vêm sem número.
  const noQuantity = await sheet(csv, admin, '?header=2&description=1&code=none&quantity=none')
  assert.equal(noQuantity.status, 200, noQuantity.text)
  assert.ok(noQuantity.body.lines.every((line: { quantity: number | null }) => line.quantity === null))
  assert.equal((await sheet(csv, admin, '?description=9')).status, 400)

  const oldXls = await call('/warehouse/robot/sheet', {
    method: 'POST', session: admin, fileName: 'a.xls',
    raw: Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]),
  })
  assert.equal(oldXls.status, 400)
  assert.match(oldXls.body.message, /salve como \.xlsx/)
  const tooBig = await call('/warehouse/robot/sheet', { method: 'POST', session: admin, fileName: 'a.csv', raw: Buffer.alloc(6 * 1024 * 1024, 65) })
  assert.equal(tooBig.status, 413)

  // Ler a planilha não cria conferência: isso só acontece pela rota de sempre, depois da confirmação.
  assert.equal((await pool.query(`SELECT count(*)::int AS total FROM public.inventory_checks`)).rows[0].total, before)
})

test('robô: reposição, resumo semanal desligado por padrão e publicado uma vez por semana', async () => {
  assert.equal((await get('/warehouse/robot/restock?months=3', memberA)).status, 403)
  const restock = await get('/warehouse/robot/restock?months=3', admin)
  assert.equal(restock.status, 200, restock.text)
  assert.ok(Array.isArray(restock.body.suggestions))
  assert.equal((await get('/warehouse/robot/restock?months=5', admin)).status, 400)

  const summary = await get('/warehouse/robot/weekly-summary', admin)
  assert.equal(summary.status, 200, summary.text)
  assert.equal(summary.body.enabled, false)
  assert.equal(typeof summary.body.summary.belowMinimum, 'number')

  const robot = new RobotRepository()
  const monday = new Date('2026-11-16T12:00:00Z')
  assert.equal(await robot.publishWeeklySummary(monday), false)

  const saved = await put('/settings/parameters/notifications', admin, { disabled: {}, pendingReminderDays: null, warehouseWeeklySummary: true })
  assert.equal(saved.status, 200, saved.text)
  assert.equal((await get('/warehouse/robot/weekly-summary', admin)).body.enabled, true)
  // Terça-feira, ou segunda antes das 7h: não sai.
  assert.equal(await robot.publishWeeklySummary(new Date('2026-11-17T12:00:00Z')), false)
  assert.equal(await robot.publishWeeklySummary(new Date('2026-11-16T09:00:00Z')), false)
  assert.equal(await robot.publishWeeklySummary(monday), true)
  assert.equal(await robot.publishWeeklySummary(new Date('2026-11-16T18:00:00Z')), true)
  const events = await pool.query(`SELECT payload FROM public.integration_events WHERE event_key = 'warehouse-weekly:2026-W47'`)
  assert.equal(events.rowCount, 1)
  await put('/settings/parameters/notifications', admin, { disabled: {}, pendingReminderDays: null, warehouseWeeklySummary: false })
})

test('a 021 não se desfaz com atas cadastradas', async () => {
  await assert.rejects(pool.query(schema('021_contract_instruments.rollback.sql')), /não pode ser desfeita/)
})
