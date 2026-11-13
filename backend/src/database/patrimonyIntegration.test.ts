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

// Atas e contratos no Controle de Demandas (migração 021) e taxas do Dashboard, em 12/11/2026.
// API real, PostgreSQL descartável, 001 a 021.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')

let pool: Pool
let server: Server
let baseUrl: string
let admin: Session
let requester: Session
let operator: Session
let sectorA: string
let sectorB: string
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

async function createUser(email: string, role: 'requester' | 'slm_operator'): Promise<Session> {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { fullName: `Pessoa ${email.split('@')[0]}`, email, sector: 'Administração', password, passwordConfirmation: password },
  })
  assert.equal(registered.status, 202, registered.text)
  const pending = await get('/admin/registrations/pending', admin)
  const id = pending.body.registrations.find((item: { email: string }) => item.email === email).id
  assert.equal((await post(`/admin/registrations/${id}/approve`, admin, { role })).status, 200)
  return signIn(email)
}

const migrations = [
  '001_public_schema_snapshot.sql', '002_password_recovery.sql', '003_user_access.sql', '004_flight_passengers.sql',
  '005_operational_modules.sql', '006_integrations.sql', '007_operations_center.sql', '008_attachments.sql',
  '009_module_extensions.sql', '010_monitoring.sql', '011_delivery_forecast.sql', '012_operational_transparency.sql',
  '013_communications.sql', '014_demands.sql', '015_organizational_structure.sql', '016_driver_portal.sql',
  '017_driver_portal_settings.sql', '018_public_api_privileges.sql', '019_email_quota.sql', '020_warehouse_finance.sql',
  '021_contract_instruments.sql', '022_forms_and_links.sql',
]

before(async () => {
  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  for (const file of migrations) await pool.query(schema(file))
  resetAccessSchemaCacheForTests()
  await pool.query(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'patrimonio-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )
  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('patrimonio-admin@example.gov.br')
  requester = await createUser('patrimonio-solicitante@example.gov.br', 'requester')
  operator = await createUser('patrimonio-operador@example.gov.br', 'slm_operator')
})

after(async () => {
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

test('sem a migração 023, o Patrimônio avisa que ela falta e não quebra', async () => {
  const options = await get('/patrimony/options', admin)
  assert.equal(options.status, 200, options.text)
  assert.equal(options.body.ready, false)
  const list = await get('/patrimony/assets', admin)
  assert.equal(list.status, 409)
  assert.match(list.body.message, /migração 023/)

  await pool.query(schema('023_patrimony.sql'))
  const sectors = await pool.query<{ id: string }>(
    `INSERT INTO public.setores (nome, sigla) VALUES ('Diretoria Administrativa', 'DA'), ('Gabinete', 'GAB') RETURNING id::text AS id`,
  )
  sectorA = sectors.rows[0].id
  sectorB = sectors.rows[1].id
  assert.equal((await get('/patrimony/options', admin)).body.ready, true)
})

test('só o Administrador e o Operador SLM da equipe SLM acessam o Patrimônio', async () => {
  assert.equal((await get('/patrimony/assets', requester)).status, 403)
  // O Operador SLM aprovado entra na equipe SLM: tem acesso pelo perfil.
  assert.equal((await get('/patrimony/assets', operator)).status, 200)
  assert.equal((await post('/patrimony/assets', requester, { number: '1', description: 'Mesa' })).status, 403)
  assert.equal((await get('/patrimony/assets', admin)).status, 200)
})

test('cadastro pelo número lido, número único sem pontuação e histórico permanente', async () => {
  const created = await post('/patrimony/assets', admin, {
    number: '000.123-4', description: 'Cadeira giratória', sectorId: sectorA, room: 'Sala 3',
    brand: 'Marca X', registeredOn: '2020-01-10', acquisitionValue: '450,00', invoice: 'NF 99',
  })
  assert.equal(created.status, 201, created.text)
  const duplicate = await post('/patrimony/assets', admin, { number: '0001234', description: 'Outra cadeira' })
  assert.equal(duplicate.status, 409)
  assert.match(duplicate.body.message, /000\.123-4/)

  // O leitor "digita" sem pontuação: a consulta acha o mesmo bem e diz onde está e quando foi patrimoniado.
  const lookup = await get('/patrimony/lookup?number=0001234', admin)
  assert.equal(lookup.status, 200, lookup.text)
  assert.equal(lookup.body.asset.sector, 'Diretoria Administrativa')
  assert.equal(lookup.body.asset.room, 'Sala 3')
  assert.equal(lookup.body.asset.registeredOn, '2020-01-10')
  assert.equal(lookup.body.asset.acquisitionValue, 450)
  assert.equal((await get('/patrimony/lookup?number=999', admin)).body.asset, null)

  const id = created.body.id
  const moved = await put(`/patrimony/assets/${id}/location`, admin, { sectorId: sectorB, room: 'Sala 1', note: 'Mudança do gabinete' })
  assert.equal(moved.status, 200, moved.text)
  const edited = await put(`/patrimony/assets/${id}`, admin, {
    ...lookup.body.asset, sectorId: sectorB, room: 'Sala 1', situation: 'em_manutencao', model: 'Modelo Y',
  })
  assert.equal(edited.status, 200, edited.text)
  const detail = await get(`/patrimony/assets/${id}`, admin)
  assert.equal(detail.body.asset.situationLabel, 'Em manutenção')
  assert.deepEqual(detail.body.history.map((entry: { type: string }) => entry.type), ['situacao', 'mudanca_local', 'cadastro'])
  assert.equal(detail.body.history[1].previousSector, 'Diretoria Administrativa')
  assert.equal(detail.body.history[1].newRoom, 'Sala 1')
  assert.deepEqual(detail.body.history[0].fields, ['Modelo'])
  await assert.rejects(pool.query(`DELETE FROM public.patrimony_movements`), /não pode/)
})

test('robô: importa a planilha, mostra o que já existe e só cadastra as linhas novas', async () => {
  const csv = 'Nº Patrimônio;Descrição do bem;Setor;Sala;Data de tombamento;Situação\r\n' +
    '000.123-4;Cadeira giratória;DA;Sala 3;10/01/2020;Bom\r\n' +
    '5001;Mesa em L;GAB;Sala 2;05/03/2021;Bom\r\n' +
    '5002;Armário de aço;Setor que não existe;;;Inservível\r\n' +
    ';Sem número;;;;\r\n'
  const send = (query: string) =>
    call(`/patrimony/import${query}`, { method: 'POST', session: admin, raw: Buffer.from(csv, 'latin1'), fileName: 'bens.csv' })
  assert.equal((await call('/patrimony/import', { method: 'POST', session: requester, raw: Buffer.from(csv), fileName: 'bens.csv' })).status, 403)

  const preview = await send('')
  assert.equal(preview.status, 200, preview.text)
  const lines = preview.body.lines as { number: string; existing: { sector: string } | null; locationDiffers: boolean; problems: string[]; warnings: string[] }[]
  assert.equal(lines.length, 4)
  assert.equal(lines[0].existing?.sector, 'Gabinete')
  assert.equal(lines[0].locationDiffers, true)
  assert.equal(lines[1].existing, null)
  assert.equal(lines[2].warnings.length, 1)
  assert.deepEqual(lines[3].problems, ['Sem número de patrimônio'])
  assert.equal((await pool.query(`SELECT count(*)::int AS total FROM public.patrimony_assets`)).rows[0].total, 1)

  const imported = await send('?confirm=1')
  assert.equal(imported.status, 201, imported.text)
  assert.deepEqual([imported.body.created, imported.body.existing, imported.body.rejected], [2, 1, 1])
  const table = await get('/patrimony/assets?situation=inservivel', admin)
  assert.deepEqual(table.body.assets.map((asset: { number: string; sector: string | null }) => [asset.number, asset.sector]), [['5002', null]])
  // O bem que já existia não mudou de local pela planilha.
  assert.equal((await get('/patrimony/lookup?number=0001234', admin)).body.asset.sector, 'Gabinete')
  const again = await send('?confirm=1')
  assert.deepEqual([again.body.created, again.body.existing], [0, 3])
})

test('conferência por sala: lê, diz onde o bem deveria estar e lista os que faltam', async () => {
  const check = await post('/patrimony/checks', admin, { title: 'Gabinete sala 2', sectorId: sectorB, room: 'sala 2' })
  assert.equal(check.status, 201, check.text)
  const id = check.body.id
  const read = (number: string) => post(`/patrimony/checks/${id}/reads`, admin, { number })

  const inPlace = await read('5001')
  assert.equal(inPlace.status, 201, inPlace.text)
  assert.equal(inPlace.body.result, 'no_local')
  assert.equal(inPlace.body.asset.registeredOn, '2021-03-05')
  const elsewhere = await read('0001234')
  assert.equal(elsewhere.body.result, 'outro_local')
  assert.equal(elsewhere.body.asset.room, 'Sala 1')
  assert.equal((await read('77777')).body.result, 'nao_cadastrado')
  const repeated = await read('5001')
  assert.equal(repeated.status, 200)
  assert.equal(repeated.body.repeated, true)

  // Registrar que o bem lido está nesta sala.
  assert.equal((await put(`/patrimony/assets/${elsewhere.body.asset.id}/location`, admin, { sectorId: sectorB, room: 'Sala 2' })).status, 200)

  await pool.query(`INSERT INTO public.patrimony_assets (numero, descricao, setor_id, sala, criado_por) VALUES ('5003', 'Ventilador', $1, 'Sala 2', $2)`, [sectorB, admin.id])
  const detail = (await get(`/patrimony/checks/${id}`, admin)).body.check
  assert.equal(detail.reads.length, 3)
  assert.deepEqual(detail.missing.map((asset: { number: string }) => asset.number), ['5003'])

  assert.equal((await post(`/patrimony/checks/${id}/close`, admin, { outcome: 'concluida', comment: 'Ventilador não encontrado' })).status, 200)
  assert.equal((await read('5003')).status, 409)
  const list = (await get('/patrimony/checks', admin)).body.checks
  assert.deepEqual([list[0].read, list[0].inPlace, list[0].issues], [3, 1, 2])
  assert.ok((await get('/patrimony/lookup?number=5001', admin)).body.asset.lastCheckAt)
})

test('a 023 não se desfaz com bens cadastrados', async () => {
  await assert.rejects(pool.query(schema('023_patrimony.rollback.sql')), /não pode ser desfeita/)
})
