import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { Pool } from 'pg'
import app from '../app.js'
import { hashPassword } from '../auth/password.js'
import type { Permission } from '../auth/permissions.js'
import { defaultDriverSettings, defaultOccurrenceTypes } from '../requests/driverPortalRules.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'

// Configurações do Portal do Motorista: cada parâmetro precisa mudar o comportamento do portal, pela API real.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')

let pool: Pool
let server: Server
let baseUrl: string
let directory: string
let admin: Session
let scheduler: Session
let requester: Session
let driver: Session
let otherDriver: Session
let driverId: string
let otherDriverId: string
const csrfTokens = new Map<string, string>()

type Session = { cookie: string; id: string }

async function call(path: string, options: { method?: string; body?: unknown; session?: Session; raw?: Buffer; headers?: Record<string, string> } = {}) {
  const method = options.method ?? 'GET'
  const cookie = options.session?.cookie
  const token = cookie && method !== 'GET' ? csrfTokens.get(cookie) : undefined
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      ...(options.raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }),
      ...(options.headers ?? {}),
      ...(cookie ? { cookie } : {}),
      ...(token ? { 'x-csrf-token': token } : {}),
    },
    body: options.raw ? new Uint8Array(options.raw) : (options.body === undefined ? undefined : JSON.stringify(options.body)),
  })
  const text = await response.text()
  const type = response.headers.get('content-type') ?? ''
  const body = (type.includes('json') ? JSON.parse(text) : {}) as Record<string, any>
  const setCookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  if (setCookie && body.csrfToken) csrfTokens.set(setCookie, body.csrfToken)
  return { status: response.status, body, text, setCookie }
}

const get = (path: string, session: Session) => call(path, { session })
const post = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'POST', session, body })
const put = (path: string, session: Session, body: unknown) => call(path, { method: 'PUT', session, body })
const patch = (path: string, session: Session, body: unknown) => call(path, { method: 'PATCH', session, body })

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

async function staff(email: string, grants: Permission[]) {
  const user = await createUser(email, 'slm_operator')
  const result = await put(`/admin/users/${user.id}/access`, admin, { role: 'slm_operator', slmMember: true, grantedPermissions: grants, deniedPermissions: [] })
  assert.equal(result.status, 200, result.text)
  return user
}

async function registerDriver(email: string, name: string) {
  const session = await createUser(email, 'driver')
  const created = await post('/fleet/drivers', admin, { name, userId: session.id })
  assert.equal(created.status, 201, created.text)
  return { session, id: created.body.id as string }
}

let tripCounter = 0

async function scheduledTrip(assignedDriver: string | null = driverId, extra: Record<string, unknown> = {}) {
  tripCounter += 1
  const when = new Date(Date.UTC(2032, 4, 1, 13) + tripCounter * 86_400_000).toISOString()
  const created = await post('/fleet/requests', requester, {
    origem: 'Sede', destino: `Fórum ${tripCounter}`, dataHora: when, finalidade: 'Levar documentos ao fórum', passageiros: [{ nome: 'Passageira Teste' }], ...extra,
  })
  assert.equal(created.status, 201, created.text)
  const id = created.body.id as string
  const scheduled = await post(`/fleet/requests/${id}/schedule`, scheduler, { dataAgendada: when, confirmarConflito: true })
  assert.equal(scheduled.status, 200, scheduled.text)
  if (assignedDriver) {
    const assigned = await post(`/fleet/requests/${id}/driver`, scheduler, { driverId: assignedDriver, notes: 'Retirar a chave na portaria.', confirmConflicts: true })
    assert.equal(assigned.status, 200, assigned.text)
  }
  return id
}

/** Qualquer horário fica dentro: o teste não depende da hora em que roda. */
const wholeDay = { start: '00:00', end: '23:59', weekdays: [0, 1, 2, 3, 4, 5, 6] }

/** Todos os dias menos hoje: qualquer horário de hoje fica fora, em São Paulo. */
function everyDayButToday() {
  const today = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date()),
  )
  return { ...wholeDay, weekdays: [0, 1, 2, 3, 4, 5, 6].filter((day) => day !== today) }
}

async function save(section: keyof typeof defaultDriverSettings, patchValue: object, session = admin) {
  const result = await put(`/settings/parameters/${section}`, session, { ...defaultDriverSettings[section], ...patchValue })
  assert.equal(result.status, 200, result.text)
  return result.body.value
}

/** Direto na tabela: a rota é paginada, e os avisos antigos sairiam da conta. */
async function notices(session: Session) {
  const result = await pool.query<{ message: string; link: string }>(
    `SELECT message, link FROM public.user_notifications WHERE user_id = $1 ORDER BY created_at DESC`,
    [session.id],
  )
  return result.rows
}

const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const upload = (trip: string, occurrence: string, file: Buffer, name: string, session = driver) =>
  call(`/driver/trips/${trip}/occurrences/${occurrence}/attachments`, { method: 'POST', session, raw: file, headers: { 'x-file-name': encodeURIComponent(name) } })

before(async () => {
  process.env.PASSENGER_DATA_KEY = randomBytes(32).toString('base64')
  process.env.EMAIL_TRANSPORT = 'simulated'
  directory = mkdtempSync(join(tmpdir(), 'slm-portal-config-'))
  process.env.ATTACHMENTS_DIR = directory

  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  for (const file of [
    '001_public_schema_snapshot.sql', '002_password_recovery.sql', '003_user_access.sql', '004_flight_passengers.sql',
    '005_operational_modules.sql', '006_integrations.sql', '007_operations_center.sql', '008_attachments.sql',
    '009_module_extensions.sql', '010_monitoring.sql', '011_delivery_forecast.sql', '012_operational_transparency.sql',
    '013_communications.sql', '014_demands.sql', '015_organizational_structure.sql', '016_driver_portal.sql',
  ]) {
    await pool.query(schema(file))
  }
  resetAccessSchemaCacheForTests()
  await pool.query(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'portal-config-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )
  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('portal-config-admin@example.gov.br')
  requester = await createUser('portal-config-solicitante@example.gov.br')
  scheduler = await staff('portal-config-agenda@example.gov.br', ['requests:schedule'])
  const first = await registerDriver('portal-config-motorista@example.gov.br', 'Motorista Config')
  driver = first.session
  driverId = first.id
  const second = await registerDriver('portal-config-outro@example.gov.br', 'Motorista Outro')
  otherDriver = second.session
  otherDriverId = second.id
})

after(async () => {
  for (const name of ['PASSENGER_DATA_KEY', 'EMAIL_TRANSPORT', 'ATTACHMENTS_DIR']) delete process.env[name]
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
  rmSync(directory, { recursive: true, force: true })
})

// Cada teste parte dos padrões, exceto o histórico, que não muda.
beforeEach(async () => {
  await pool.query(`DELETE FROM public.system_settings WHERE secao LIKE 'driver%'`)
})

// Roda primeiro: o código publicado precede a migração.
test('sem a migração 017, a Frota segue igual, e a tela mostra os padrões', async () => {
  const trip = await scheduledTrip(null)
  assert.equal((await post(`/fleet/requests/${trip}/start`, scheduler, {})).status, 200)
  assert.equal((await post(`/fleet/requests/${trip}/complete`, scheduler, {})).status, 200)

  const types = await get('/settings/driver-occurrence-types', admin)
  assert.equal(types.status, 200, types.text)
  assert.deepEqual(types.body.types, defaultOccurrenceTypes)
  assert.equal((await post('/settings/driver-occurrence-types', admin, { label: 'Antes da migração' })).status, 503)
  assert.equal((await get('/driver/trips', driver)).status, 503, 'o portal pede a atualização em vez de errar')

  await pool.query(schema('017_driver_portal_settings.sql'))
  await pool.query(schema('017_driver_portal_settings.rollback.sql'))
  await pool.query(schema('017_driver_portal_settings.sql'))
  const unprotected = await pool.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`,
  )
  assert.deepEqual(unprotected.rows, [], 'toda tabela nova tem RLS')
})

test('o cadastro inicial do banco é o mesmo dos padrões documentados no código', async () => {
  const types = await get('/settings/driver-occurrence-types', admin)
  assert.deepEqual(types.body.types, defaultOccurrenceTypes)
  assert.deepEqual(types.body.types.map((type: { label: string }) => type.label), [
    'Atraso', 'Problema mecânico', 'Alteração de percurso', 'Impedimento de realização da viagem', 'Problema no local de destino', 'Outros',
  ])
})

test('permissões: só quem tem settings:manage altera, e o backend confere em toda operação', async () => {
  const reader = await staff('portal-config-leitor@example.gov.br', [])
  const authorized = await staff('portal-config-autorizado@example.gov.br', ['settings:manage'])
  const journey = { ...defaultDriverSettings.driverJourney, start: '09:00' }
  const type = { label: 'Tentativa' }

  for (const session of [requester, scheduler, reader, driver]) {
    assert.equal((await put('/settings/parameters/driverJourney', session, journey)).status, 403)
    assert.equal((await post('/settings/driver-occurrence-types', session, type)).status, 403)
    assert.equal((await patch('/settings/driver-occurrence-types/outra', session, { label: 'Mudou' })).status, 403)
  }
  assert.equal((await call('/settings/parameters/driverJourney', { method: 'PUT', body: journey })).status, 401)

  // O motorista não lê a área administrativa, nem por esta rota, e não existe exclusão de tipo.
  assert.equal((await get('/settings/parameters', driver)).status, 403)
  assert.equal((await get('/settings/history?section=driverPortal', driver)).status, 403)
  assert.equal((await get('/settings/driver-occurrence-types', driver)).status, 403)
  assert.equal((await get('/settings/parameters', requester)).status, 403)
  assert.equal((await call('/settings/driver-occurrence-types/outra', { method: 'DELETE', session: admin })).status, 404)

  assert.equal((await put('/settings/parameters/driverJourney', authorized, journey)).status, 200)
  assert.equal((await get('/driver/me', driver)).body.portal.journey.start, '09:00')
})

test('persistência e histórico: sobrevive a sair e entrar, com autor, data e valores', async () => {
  const before = (await get('/settings/history?section=driverPortal', admin)).body.history.length as number
  await save('driverJourney', { start: '06:30', end: '15:30', weekdays: [1, 2, 3, 4, 5], breakMinutes: 60, expectedMinutes: 480 })
  await save('driverJourney', { start: '08:00', end: '17:00', weekdays: [1, 2, 3, 4, 5], breakMinutes: 60, expectedMinutes: 480 })

  const logout = await post('/auth/logout', admin)
  assert.ok(logout.status < 400, logout.text)
  admin = await signIn('portal-config-admin@example.gov.br')
  driver = await signIn('portal-config-motorista@example.gov.br')

  const stored = (await get('/settings/parameters', admin)).body.settings.driverJourney
  assert.equal(stored.start, '08:00')
  assert.deepEqual(stored.weekdays, [1, 2, 3, 4, 5])
  const portal = (await get('/driver/me', driver)).body.portal.journey
  assert.equal(portal.end, '17:00')
  assert.equal(portal.breakMinutes, 60)

  const history = (await get('/settings/history?section=driverPortal', admin)).body.history
  assert.equal(history.length, before + 2)
  assert.equal(history[0].section, 'driverJourney')
  assert.equal(history[0].user, 'Administradora')
  assert.equal(history[0].before.start, '06:30')
  assert.equal(history[0].after.start, '08:00')
  assert.ok(history[0].at)
  const audit = await pool.query(`SELECT 1 FROM public.auth_audit_events WHERE details->>'section' = 'driverJourney'`)
  assert.ok(audit.rows.length >= 2)

  await assert.rejects(pool.query(`UPDATE public.settings_change_history SET valor_novo = '{}' WHERE secao = 'driverJourney'`))
  await assert.rejects(pool.query(`DELETE FROM public.settings_change_history WHERE secao = 'driverJourney'`))
})

test('valores inválidos são recusados e nada muda', async () => {
  await save('driverJourney', { start: '08:00', end: '17:00' })
  for (const body of [
    { ...defaultDriverSettings.driverJourney, start: '18:00', end: '08:00' },
    { ...defaultDriverSettings.driverJourney, weekdays: [] },
  ]) {
    assert.equal((await put('/settings/parameters/driverJourney', admin, body)).status, 400)
  }
  assert.equal((await put('/settings/parameters/driverDisplay', admin, { ...defaultDriverSettings.driverDisplay, fields: { ...defaultDriverSettings.driverDisplay.fields, destination: 'hidden' } })).status, 400)
  assert.equal((await put('/settings/parameters/driverInventada', admin, {})).status, 404)
  assert.equal((await get('/driver/me', driver)).body.portal.journey.start, '08:00')
})

test('jornada: mudar não reescreve as viagens anteriores, e vale para as seguintes', async () => {
  await save('driverJourney', wholeDay)
  const old = await scheduledTrip()
  assert.equal((await post(`/driver/trips/${old}/start`, driver)).status, 200)
  assert.equal((await post(`/driver/trips/${old}/finish`, driver)).status, 200)
  const historyBefore = await pool.query(`SELECT detalhes FROM public.request_history WHERE request_id = $1 ORDER BY created_at, id`, [old])
  const storedBefore = (await pool.query(`SELECT execucao_inicio, execucao_fim, execucao_registro FROM public.service_requests WHERE id = $1`, [old])).rows[0]
  assert.equal((await get(`/driver/trips/${old}`, driver)).body.trip.exceedsJourney, false)

  await save('driverJourney', { ...everyDayButToday(), start: '10:00', end: '11:00' })

  const seen = (await get(`/driver/trips/${old}`, driver)).body.trip
  assert.equal(seen.exceedsJourney, false, 'continua dentro da jornada vigente quando começou')
  assert.deepEqual(seen.journeyReference, { start: '00:00', end: '23:59' })
  assert.equal((await get(`/fleet/requests/${old}/execution`, scheduler)).body.exceedsJourney, false)
  assert.deepEqual((await pool.query(`SELECT detalhes FROM public.request_history WHERE request_id = $1 ORDER BY created_at, id`, [old])).rows, historyBefore.rows)
  assert.deepEqual((await pool.query(`SELECT execucao_inicio, execucao_fim, execucao_registro FROM public.service_requests WHERE id = $1`, [old])).rows[0], storedBefore)

  const next = await scheduledTrip()
  assert.equal((await post(`/driver/trips/${next}/start`, driver)).status, 200)
  const running = (await get(`/driver/trips/${next}`, driver)).body.trip
  assert.equal(running.exceedsJourney, true, 'hoje está fora dos dias da nova jornada')
  assert.deepEqual(running.journeyReference, { start: '10:00', end: '11:00' })
  const started = await pool.query(`SELECT detalhes FROM public.request_history WHERE request_id = $1 AND acao = 'iniciada'`, [next])
  assert.equal(started.rows[0].detalhes.foraDaReferencia, true)

  // Viagem em andamento fica com a jornada do início, mesmo que a configuração mude de novo.
  await save('driverJourney', wholeDay)
  assert.equal((await get(`/driver/trips/${next}`, driver)).body.trip.exceedsJourney, true)
  assert.equal((await post(`/driver/trips/${next}/finish`, driver)).status, 200)
})

test('jornada: viagem iniciada pela equipe também guarda a jornada vigente', async () => {
  await save('driverJourney', wholeDay)
  const trip = await scheduledTrip()
  assert.equal((await post(`/fleet/requests/${trip}/start`, scheduler, {})).status, 200)
  await save('driverJourney', everyDayButToday())
  const execution = (await get(`/fleet/requests/${trip}/execution`, scheduler)).body
  assert.equal(execution.exceedsJourney, false)
  assert.deepEqual(execution.journeyReference, { start: '00:00', end: '23:59' })
})

test('dias de funcionamento: fora deles a viagem é identificada, conforme a data de São Paulo', async () => {
  await save('driverJourney', everyDayButToday())
  const trip = await scheduledTrip()
  const shown = (await get(`/driver/trips/${trip}`, driver)).body.trip
  assert.equal(shown.outsideJourneyNow, true)
  assert.equal(shown.canStart, true, 'identificar não impede')

  await save('driverJourney', wholeDay)
  assert.equal((await get(`/driver/trips/${trip}`, driver)).body.trip.outsideJourneyNow, false)
})

test('duração prevista: a viagem que passa dela e do intervalo fica identificada', async () => {
  await save('driverJourney', { ...wholeDay, expectedMinutes: 60, breakMinutes: 30 })
  const trip = await scheduledTrip()
  assert.equal((await post(`/driver/trips/${trip}/start`, driver)).status, 200)
  assert.equal((await get(`/driver/trips/${trip}`, driver)).body.trip.exceedsJourney, false)
  await pool.query(`UPDATE public.service_requests SET execucao_inicio = now() - interval '91 minutes' WHERE id = $1`, [trip])
  assert.equal((await get(`/driver/trips/${trip}`, driver)).body.trip.exceedsJourney, true)
})

test('fora da jornada: justificativa exigida, guardada para a equipe e fora do alcance do solicitante', async () => {
  await save('driverJourney', { ...everyDayButToday(), outsideStart: 'justify', outsideFinish: 'justify' })
  const trip = await scheduledTrip()

  const refused = await post(`/driver/trips/${trip}/start`, driver)
  assert.equal(refused.status, 400)
  assert.equal(refused.body.code, 'JOURNEY_JUSTIFICATION_REQUIRED')
  assert.equal((await pool.query(`SELECT status FROM public.service_requests WHERE id = $1`, [trip])).rows[0].status, 'agendado', 'nada foi registrado')

  assert.equal((await post(`/driver/trips/${trip}/start`, driver, { justificativa: 'Audiência antecipada pelo fórum' })).status, 200)
  assert.equal((await post(`/driver/trips/${trip}/finish`, driver)).status, 400, 'o término também pede')
  assert.equal((await post(`/driver/trips/${trip}/finish`, driver, { justificativa: 'Trânsito na volta' })).status, 200)

  const execution = (await get(`/fleet/requests/${trip}/execution`, scheduler)).body
  assert.equal(execution.startRecord.justificativa, 'Audiência antecipada pelo fórum')
  assert.equal(execution.finishRecord.justificativa, 'Trânsito na volta')
  const team = await get(`/fleet/requests/${trip}`, scheduler)
  assert.ok(team.body.history.some((item: { action: string }) => item.action === 'execucao_dados_motorista'))

  const seenByRequester = JSON.stringify((await get(`/fleet/requests/${trip}`, requester)).body)
  assert.equal(seenByRequester.includes('Audiência antecipada'), false)
  assert.equal(seenByRequester.includes('Trânsito na volta'), false)
  assert.equal((await get(`/fleet/requests/${trip}/execution`, requester)).status, 403)
})

test('sem permissão de registro excepcional: não inicia fora da jornada, mas sempre finaliza, e a equipe segue podendo', async () => {
  await save('driverJourney', wholeDay)
  const running = await scheduledTrip()
  assert.equal((await post(`/driver/trips/${running}/start`, driver)).status, 200)

  await save('driverJourney', { ...everyDayButToday(), allowOutsideStart: false })
  const blocked = await scheduledTrip()
  const shown = (await get(`/driver/trips/${blocked}`, driver)).body.trip
  assert.equal(shown.canStart, false)
  assert.equal(shown.startBlockedByJourney, true)
  assert.equal((await post(`/driver/trips/${blocked}/start`, driver)).status, 409)

  assert.equal((await post(`/driver/trips/${running}/finish`, driver)).status, 200, 'viagem em andamento sempre encerra')
  const occurrence = await post(`/driver/trips/${blocked}/occurrences`, driver, { categoria: 'outra', descricao: 'Ocorrência fora da jornada' })
  assert.equal(occurrence.status, 201, 'relatar um problema nunca é impedido pela jornada')
  assert.equal((await post(`/fleet/requests/${blocked}/start`, scheduler, { comentario: 'Registro excepcional' })).status, 200)
  assert.equal((await post(`/driver/trips/${blocked}/finish`, driver)).status, 200)

  await save('driverJourney', { ...wholeDay, allowOutsideStart: false })
  const inside = await scheduledTrip()
  assert.equal((await post(`/driver/trips/${inside}/start`, driver)).status, 200, 'dentro da jornada segue normal')
  assert.equal((await post(`/driver/trips/${inside}/finish`, driver)).status, 200)
})

test('informações obrigatórias: valem ao iniciar e ao finalizar, e a equipe consulta', async () => {
  await save('driverExecution', { startFields: ['vehicle', 'odometer', 'notes'], finishFields: ['odometer', 'notes'] })
  const trip = await scheduledTrip()
  const shown = (await get(`/driver/trips/${trip}`, driver)).body.trip
  assert.equal(shown.startNeedsVehicle, true)

  assert.equal((await post(`/driver/trips/${trip}/start`, driver)).status, 400)
  assert.equal((await post(`/driver/trips/${trip}/start`, driver, { hodometro: 1000, observacao: 'Tudo certo' })).status, 400, 'falta o veículo')
  const started = await post(`/driver/trips/${trip}/start`, driver, { hodometro: 1000, observacao: 'Tudo certo', veiculo: 'Van 2', inicioReal: '2001-01-01T00:00:00Z' })
  assert.equal(started.status, 200, started.text)
  assert.ok(new Date(started.body.startedAt).getFullYear() > 2001, 'horário segue o do servidor')

  assert.equal((await post(`/driver/trips/${trip}/finish`, driver, { hodometro: 999, observacao: 'Fim' })).status, 400, 'hodômetro não volta')
  assert.equal((await post(`/driver/trips/${trip}/finish`, driver, { hodometro: 1040, observacao: 'Fim' })).status, 200)

  const execution = (await get(`/fleet/requests/${trip}/execution`, scheduler)).body
  assert.deepEqual(execution.startRecord, { hodometro: 1000, observacao: 'Tudo certo', veiculo: 'Van 2' })
  assert.deepEqual(execution.finishRecord, { hodometro: 1040, observacao: 'Fim' })

  // Com o veículo já na viagem, não é pedido de novo.
  const withVehicle = await scheduledTrip(driverId, { veiculo: 'Van institucional' })
  assert.equal((await get(`/driver/trips/${withVehicle}`, driver)).body.trip.startNeedsVehicle, false)
  assert.equal((await post(`/driver/trips/${withVehicle}/start`, driver, { hodometro: 5, observacao: 'Ok' })).status, 200)
})

test('situações exibidas: a oculta some do portal, e a viagem em andamento nunca some', async () => {
  const cancelled = await scheduledTrip()
  assert.equal((await post(`/fleet/requests/${cancelled}/cancel`, admin, { motivoCodigo: 'outro', motivo: 'Audiência desmarcada' })).status, 200)
  assert.ok((await get('/driver/trips?group=canceladas', driver)).body.trips.some((item: { id: string }) => item.id === cancelled))
  assert.ok((await get('/driver/history', driver)).body.trips.some((item: { id: string }) => item.id === cancelled))

  const stored = await save('driverExecution', { visibleGroups: ['concluidas'] })
  assert.deepEqual(stored.visibleGroups, ['proximas', 'em_andamento', 'concluidas'])
  assert.deepEqual((await get('/driver/me', driver)).body.portal.execution.visibleGroups, ['proximas', 'em_andamento', 'concluidas'])

  const hidden = await get('/driver/trips?group=canceladas', driver)
  assert.equal(hidden.body.group, 'proximas')
  assert.equal(hidden.body.trips.some((item: { id: string }) => item.id === cancelled), false)
  assert.equal(Object.hasOwn(hidden.body.counts, 'canceladas'), false)
  assert.equal((await get('/driver/history', driver)).body.trips.some((item: { id: string }) => item.id === cancelled), false)
})

test('próximas viagens: o período editável separa as próximas das agendadas', async () => {
  // As datas destes testes estão anos à frente. Uma janela curta as manda para "agendadas".
  const trip = await scheduledTrip()
  const inGroup = async (group: string) => (await get(`/driver/trips?group=${group}`, driver)).body.trips.some((item: { id: string }) => item.id === trip)
  await pool.query(`UPDATE public.service_requests SET data_agendada = now() + interval '5 days' WHERE id = $1`, [trip])
  assert.equal(await inGroup('proximas'), true, 'padrão de 7 dias')
  await save('driverExecution', { upcomingDays: 2 })
  assert.equal(await inGroup('proximas'), false)
  assert.equal(await inGroup('agendadas'), true)
})

test('tipos de ocorrência: incluir, editar e desativar, sem tocar no que já foi registrado', async () => {
  const created = await post('/settings/driver-occurrence-types', admin, { label: 'Acidente de trânsito', requiresJustification: true, allowsAttachments: false })
  assert.equal(created.status, 201, created.text)
  const key = created.body.type.key as string
  assert.equal(key, 'acidente_de_transito')
  assert.equal((await post('/settings/driver-occurrence-types', admin, { label: 'acidente de trânsito' })).status, 409, 'nome repetido')

  const offered = async () => (await get('/driver/me', driver)).body.portal.occurrences.types as { key: string; label: string; requiresJustification: boolean }[]
  assert.equal((await offered()).find((item) => item.key === key)?.requiresJustification, true)

  const trip = await scheduledTrip()
  const path = `/driver/trips/${trip}/occurrences`
  assert.equal((await post(path, driver, { categoria: key, descricao: 'Batida leve na via' })).status, 400, 'exige justificativa')
  const first = await post(path, driver, { categoria: key, descricao: 'Batida leve na via', justificativa: 'Veículo à frente freou' })
  assert.equal(first.status, 201, first.text)

  // O tipo não permite anexo, e o backend confere.
  assert.equal((await upload(trip, first.body.id, pdf, 'a.pdf')).status, 403)

  const edited = await patch(`/settings/driver-occurrence-types/${key}`, admin, { label: 'Colisão', active: true, requiresJustification: false, allowsAttachments: true, asksDelay: false })
  assert.equal(edited.status, 200, edited.text)
  assert.equal(edited.body.type.key, key, 'a chave não muda')
  assert.equal((await upload(trip, first.body.id, pdf, 'a.pdf')).status, 201, 'agora permite')
  assert.equal((await post(path, driver, { categoria: key, descricao: 'Sem justificativa agora' })).status, 201)

  const second = await get(`/driver/trips/${trip}`, driver)
  assert.equal(second.body.occurrences[0].categoryLabel, 'Acidente de trânsito', 'o registro guarda o nome da época')
  assert.equal(second.body.occurrences[0].justification, 'Veículo à frente freou')
  assert.equal(second.body.occurrences[1].categoryLabel, 'Colisão')

  const off = await patch(`/settings/driver-occurrence-types/${key}`, admin, { label: 'Colisão', active: false, requiresJustification: false, allowsAttachments: true, asksDelay: false })
  assert.equal(off.status, 200, off.text)
  assert.equal((await offered()).some((item) => item.key === key), false, 'sai das escolhas')
  assert.equal((await post(path, driver, { categoria: key, descricao: 'Tipo desativado' })).status, 400)

  const history = (await get(`/driver/trips/${trip}`, driver)).body.occurrences
  assert.equal(history.length, 2, 'as ocorrências continuam')
  const team = (await get(`/fleet/requests/${trip}/execution`, scheduler)).body.occurrences
  assert.equal(team[0].categoryLabel, 'Acidente de trânsito')
  assert.equal(team[0].justification, 'Veículo à frente freou')

  // Nem por SQL: tipo usado não é apagado.
  await assert.rejects(pool.query(`DELETE FROM public.driver_occurrence_types WHERE chave = $1`, [key]))

  const changes = (await get('/settings/history?section=driverPortal', admin)).body.history.filter((item: { section: string }) => item.section === 'driverOccurrenceTypes')
  assert.equal(changes[0].before.active, true)
  assert.equal(changes[0].after.active, false)
  assert.equal(changes[0].user, 'Administradora')
  assert.ok(changes.some((item: { before: unknown; after: { label: string } }) => item.before === null && item.after.label === 'Acidente de trânsito'))
})

test('tipos de ocorrência: o minuto de atraso é escolha do tipo, e ao menos um fica ativo', async () => {
  const trip = await scheduledTrip()
  const path = `/driver/trips/${trip}/occurrences`
  assert.equal((await post(path, driver, { categoria: 'atraso', descricao: 'Trânsito intenso' })).status, 400)
  const delayed = await post(path, driver, { categoria: 'atraso', descricao: 'Trânsito intenso', atrasoMinutos: 25 })
  assert.equal(delayed.status, 201, delayed.text)
  const stored = await pool.query(`SELECT tipo, atraso_minutos, categoria_nome FROM public.request_occurrences WHERE id = $1`, [delayed.body.id])
  assert.deepEqual(stored.rows[0], { tipo: 'atraso', atraso_minutos: 25, categoria_nome: 'Atraso' })

  const list = (await get('/settings/driver-occurrence-types', admin)).body.types as { key: string; label: string }[]
  const touched: string[] = []
  try {
    for (const type of list) {
      const result = await patch(`/settings/driver-occurrence-types/${type.key}`, admin, { label: type.label, active: false })
      if (result.status === 200) touched.push(type.key)
      else assert.equal(result.status, 400, result.text)
    }
    assert.equal(touched.length, list.length - 1, 'o último ativo é mantido')
  } finally {
    for (const type of list.filter((item) => touched.includes(item.key))) {
      const original = defaultOccurrenceTypes.find((item) => item.key === type.key)
      await patch(`/settings/driver-occurrence-types/${type.key}`, admin, original ? { ...original, key: undefined } : { label: type.label, active: false })
    }
    for (const original of defaultOccurrenceTypes) {
      await patch(`/settings/driver-occurrence-types/${original.key}`, admin, { label: original.label, active: true, requiresJustification: false, allowsAttachments: true, asksDelay: original.asksDelay })
    }
  }
})

test('notificações ao motorista: cada regra liga e desliga o próprio evento', async () => {
  const count = async (pattern: RegExp) => (await notices(otherDriver)).filter((item) => pattern.test(item.message)).length
  const rules = () => structuredClone(defaultDriverSettings.driverNotifications.rules)
  const assign = async (trip: string, notes: string | null = null) => {
    const result = await post(`/fleet/requests/${trip}/driver`, scheduler, { driverId: otherDriverId, notes, confirmConflicts: true })
    assert.equal(result.status, 200, result.text)
  }

  // Atribuição: desligada, sem aviso nem e-mail.
  const noticesBefore = await count(/Nova viagem atribuída/)
  await save('driverNotifications', { rules: { ...rules(), trip_assigned: { driver: false, team: false } } })
  const silent = await scheduledTrip(null)
  await assign(silent)
  assert.equal(await count(/Nova viagem atribuída/), noticesBefore)
  const email = await pool.query(`SELECT 1 FROM public.email_deliveries WHERE template_key = 'trip_assigned' AND subject LIKE $1`, [`%${silent}%`])
  assert.equal(email.rows.length, 0)
  assert.ok((await pool.query(`SELECT 1 FROM public.request_history WHERE request_id = $1 AND acao = 'motorista_atribuido'`, [silent])).rows.length === 1, 'o histórico registra de qualquer forma')

  // Ligada de novo, volta a avisar.
  await save('driverNotifications', { rules: rules() })
  const loud = await scheduledTrip(null)
  await assign(loud)
  assert.equal(await count(/Nova viagem atribuída/), noticesBefore + 1)

  // Reagendamento e cancelamento.
  await save('driverNotifications', { rules: { ...rules(), trip_rescheduled: { driver: false, team: false }, trip_cancelled: { driver: false, team: false } } })
  const moved = await count(/Viagem reagendada/)
  const cancelled = await count(/foi cancelada/)
  assert.equal((await post(`/fleet/requests/${loud}/schedule`, scheduler, { dataAgendada: '2037-01-01T13:00:00.000Z', motivoCodigo: 'outro', comentario: 'Mudou', confirmarConflito: true })).status, 200)
  assert.equal(await count(/Viagem reagendada/), moved)
  assert.equal((await post(`/fleet/requests/${loud}/cancel`, admin, { motivoCodigo: 'outro', motivo: 'Desmarcada' })).status, 200)
  assert.equal(await count(/foi cancelada/), cancelled)

  await save('driverNotifications', { rules: rules() })
  const third = await scheduledTrip(null)
  await assign(third)
  assert.equal((await post(`/fleet/requests/${third}/schedule`, scheduler, { dataAgendada: '2037-02-01T13:00:00.000Z', motivoCodigo: 'outro', comentario: 'Mudou', confirmarConflito: true })).status, 200)
  assert.equal(await count(/Viagem reagendada/), moved + 1)
  assert.equal((await post(`/fleet/requests/${third}/cancel`, admin, { motivoCodigo: 'outro', motivo: 'Desmarcada' })).status, 200)
  assert.equal(await count(/foi cancelada/), cancelled + 1)
})

test('notificações: alteração de destino e de horário têm regras próprias', async () => {
  const rules = () => structuredClone(defaultDriverSettings.driverNotifications.rules)
  const updates = async () => (await notices(otherDriver)).filter((item) => /informações de uma viagem/.test(item.message)).length
  const trip = await scheduledTrip(otherDriverId)
  const current = (await get(`/fleet/requests/${trip}`, admin)).body.request.details as Record<string, unknown>
  const edit = async (change: Record<string, unknown>) => {
    const result = await patch(`/fleet/requests/${trip}`, admin, { ...current, ...change, justificativa: 'Ajuste combinado' })
    assert.equal(result.status, 200, result.text)
  }

  await save('driverNotifications', { rules: { ...rules(), destination_changed: { driver: false, team: false } } })
  let before = await updates()
  await edit({ destino: 'Novo destino A' })
  assert.equal(await updates(), before, 'destino desligado')

  await save('driverNotifications', { rules: rules() })
  before = await updates()
  await edit({ destino: 'Novo destino B' })
  assert.equal(await updates(), before + 1, 'destino ligado')

  await save('driverNotifications', { rules: { ...rules(), time_changed: { driver: false, team: false } } })
  before = await updates()
  await edit({ destino: 'Novo destino B', dataHora: '2038-01-01T13:00:00.000Z' })
  assert.equal(await updates(), before, 'horário desligado')

  // Desligar outras alterações não cala as de horário.
  await save('driverNotifications', { rules: { ...rules(), other_changed: { driver: false, team: false } } })
  before = await updates()
  await edit({ destino: 'Novo destino B', dataHora: '2038-02-01T13:00:00.000Z' })
  assert.equal(await updates(), before + 1, 'horário ligado')
})

test('notificações à equipe: início, término e ocorrência seguem a configuração', async () => {
  const rules = () => structuredClone(defaultDriverSettings.driverNotifications.rules)
  const team = async (pattern: RegExp) => (await notices(scheduler)).filter((item) => pattern.test(item.message)).length

  const startedBefore = await team(/Viagem iniciada em uma viagem/)
  const finishedBefore = await team(/Viagem finalizada em uma viagem/)
  const occurrenceBefore = await team(/Ocorrência registrada/)

  // Padrão: início e término não avisam a equipe; ocorrência avisa.
  const first = await scheduledTrip()
  await post(`/driver/trips/${first}/start`, driver)
  await post(`/driver/trips/${first}/occurrences`, driver, { categoria: 'outra', descricao: 'Relato padrão' })
  await post(`/driver/trips/${first}/finish`, driver)
  assert.equal(await team(/Viagem iniciada em uma viagem/), startedBefore)
  assert.equal(await team(/Viagem finalizada em uma viagem/), finishedBefore)
  assert.equal(await team(/Ocorrência registrada/), occurrenceBefore + 1)

  await save('driverNotifications', {
    rules: {
      ...rules(),
      trip_started: { driver: false, team: true },
      trip_finished: { driver: false, team: true },
      occurrence: { driver: false, team: false },
      trip_assigned: { driver: true, team: true },
    },
  })
  const assignedBefore = await team(/Nova viagem atribuída em uma viagem/)
  const second = await scheduledTrip()
  await post(`/driver/trips/${second}/start`, driver)
  await post(`/driver/trips/${second}/occurrences`, driver, { categoria: 'outra', descricao: 'Relato sem aviso' })
  await post(`/driver/trips/${second}/finish`, driver)
  assert.equal(await team(/Viagem iniciada em uma viagem/), startedBefore + 1)
  assert.equal(await team(/Viagem finalizada em uma viagem/), finishedBefore + 1)
  assert.equal(await team(/Ocorrência registrada/), occurrenceBefore + 1, 'ocorrência desligada')
  // Quem atribuiu não recebe o aviso do próprio ato: outra pessoa da equipe, sim.
  assert.equal(await team(/Nova viagem atribuída em uma viagem/), assignedBefore)
  const adminNotices = (await notices(admin)).filter((item) => /Nova viagem atribuída em uma viagem/.test(item.message))
  assert.ok(adminNotices.length >= 1)
  assert.match(adminNotices[0].link, /\/frota\//, 'a equipe abre a solicitação, e não o portal')

  // O e-mail usa o modelo do catálogo e a fila geral.
  const queued = await pool.query(`SELECT 1 FROM public.integration_events WHERE event_type = 'trip_portal_notice' LIMIT 1`)
  assert.equal(queued.rows.length, 1)

  // O solicitante segue recebendo o andamento, pois essa regra não é do portal.
  const seen = await notices(requester)
  assert.ok(seen.some((item) => /Atendimento iniciado/.test(item.message)))
  assert.equal(seen.some((item) => /em uma viagem com motorista/.test(item.message)), false)
})

test('acesso: desativar o portal corta viagens e registros na API, sem novo login', async () => {
  const trip = await scheduledTrip()
  await save('driverAccess', { portalEnabled: false })

  const me = await get('/driver/me', driver)
  assert.equal(me.status, 200, 'a tela consegue explicar a situação')
  assert.equal(me.body.portal.enabled, false)
  for (const [method, path] of [
    ['GET', '/driver/trips'],
    ['GET', '/driver/history'],
    ['GET', `/driver/trips/${trip}`],
    ['POST', `/driver/trips/${trip}/start`],
    ['POST', `/driver/trips/${trip}/finish`],
    ['POST', `/driver/trips/${trip}/occurrences`],
  ] as const) {
    const result = await call(path, { method, session: driver, body: method === 'POST' ? {} : undefined })
    assert.equal(result.status, 403, `${method} ${path}`)
  }
  assert.equal((await get('/notifications', driver)).status, 200, 'os avisos continuam')

  // A Frota não para.
  assert.equal((await post(`/fleet/requests/${trip}/start`, scheduler, {})).status, 200)
  assert.equal((await post(`/fleet/requests/${trip}/complete`, scheduler, {})).status, 200)

  await save('driverAccess', { portalEnabled: true })
  assert.equal((await get('/driver/trips', driver)).status, 200)
})

test('acesso: ocorrências e anexos desligados são recusados pelo backend', async () => {
  const trip = await scheduledTrip()
  const path = `/driver/trips/${trip}/occurrences`
  const existing = await post(path, driver, { categoria: 'outra', descricao: 'Antes de desativar' })
  assert.equal((await upload(trip, existing.body.id, pdf, 'a.pdf')).status, 201)

  await save('driverAccess', { attachmentsEnabled: false })
  assert.equal((await get('/driver/me', driver)).body.attachments.enabled, false)
  assert.equal((await upload(trip, existing.body.id, pdf, 'b.pdf')).status, 403)

  await save('driverAccess', { allowPhotos: false })
  assert.deepEqual((await get('/driver/me', driver)).body.attachments.allowedKinds, ['pdf', 'docx', 'xlsx', 'txt'])
  assert.equal((await upload(trip, existing.body.id, png, 'foto.png')).status, 400, 'fotografia recusada')
  assert.equal((await upload(trip, existing.body.id, pdf, 'c.pdf')).status, 201)

  await save('driverAccess', { allowDocuments: false })
  assert.equal((await upload(trip, existing.body.id, pdf, 'd.pdf')).status, 400, 'documento recusado')
  assert.equal((await upload(trip, existing.body.id, png, 'foto.png')).status, 201)

  await save('driverAccess', { occurrencesEnabled: false })
  const me = (await get('/driver/me', driver)).body
  assert.equal(me.portal.occurrences.enabled, false)
  assert.deepEqual(me.portal.occurrences.types, [])
  assert.equal((await get(`/driver/trips/${trip}`, driver)).body.trip.canReportOccurrence, false)
  assert.equal((await post(path, driver, { categoria: 'outra', descricao: 'Depois de desativar' })).status, 403)
  assert.equal((await upload(trip, existing.body.id, pdf, 'e.pdf')).status, 403)

  const kept = (await get(`/driver/trips/${trip}`, driver)).body.occurrences
  assert.equal(kept.length, 1, 'a ocorrência antiga continua')
  assert.equal(kept[0].attachments.length, 3)
})

test('nenhuma configuração abre viagens de terceiros ou módulos administrativos', async () => {
  // O máximo de abertura que a tela oferece.
  await save('driverAccess', { portalEnabled: true, occurrencesEnabled: true, attachmentsEnabled: true, allowDocuments: true, allowPhotos: true })
  await save('driverJourney', { ...wholeDay, allowOutsideStart: true })
  await save('driverExecution', {})
  // Campo inventado para tentar abrir acesso é descartado, e não muda nada.
  const injected = await put('/settings/parameters/driverAccess', admin, {
    ...defaultDriverSettings.driverAccess, seeOtherDrivers: true, allowedRoutes: ['/fleet'], isolation: false,
  })
  assert.equal(injected.status, 200)
  assert.deepEqual(Object.keys(injected.body.value).sort(), Object.keys(defaultDriverSettings.driverAccess).sort())

  const others = await scheduledTrip(otherDriverId)
  assert.equal((await get(`/driver/trips/${others}`, driver)).status, 404)
  assert.equal((await post(`/driver/trips/${others}/start`, driver)).status, 404)
  assert.equal((await post(`/driver/trips/${others}/occurrences`, driver, { categoria: 'outra', descricao: 'Tentativa' })).status, 404)
  for (const path of ['/fleet/requests', '/fleet/drivers', '/settings/parameters', '/settings/catalog', '/admin/users', '/dashboard/summary']) {
    assert.equal((await get(path, driver)).status, 403, path)
  }
  assert.deepEqual((await get('/auth/me', driver)).body.user.permissions, ['driver_portal:access'])
})

test('visualização: campo oculto não sai da API, e as mensagens seguem a ativação', async () => {
  const display = structuredClone(defaultDriverSettings.driverDisplay)
  await save('driverDisplay', {
    fields: { ...display.fields, origin: 'hidden', requester: 'hidden', passengers: 'hidden', notes: 'details', vehicle: 'card' },
    notices: [{ text: 'Use o crachá', active: true }, { text: 'Rascunho interno', active: false }],
    guidance: { active: true, text: 'Confira os documentos antes de sair' },
    contact: { active: true, name: 'Central de Frota', phone: '(11) 3333-4444', email: 'frota@example.gov.br', hours: 'Das 7h às 19h' },
  })
  const trip = await scheduledTrip()
  const shown = (await get(`/driver/trips/${trip}`, driver)).body.trip
  assert.equal(shown.origin, null)
  assert.equal(shown.requester, null)
  assert.deepEqual(shown.passengers, [])
  assert.match(shown.destination, /^Fórum/, 'o destino é obrigatório')
  assert.equal(shown.title, shown.destination, 'o título não entrega a saída')
  const text = JSON.stringify((await get(`/driver/trips/${trip}`, driver)).body)
  for (const hiddenValue of ['Sede', 'Pessoa portal-config-solicitante', 'Passageira Teste']) {
    assert.equal(text.includes(hiddenValue), false, hiddenValue)
  }

  const me = (await get('/driver/me', driver)).body
  assert.deepEqual(me.portal.display.notices, ['Use o crachá'])
  assert.equal(me.portal.display.guidance, 'Confira os documentos antes de sair')
  assert.equal(me.portal.display.contact.phone, '(11) 3333-4444')
  assert.equal(me.portal.display.fields.vehicle, 'card')
  const profile = JSON.stringify(me)
  for (const internal of ['Rascunho interno', 'driverNotifications', '"rules"', 'trip_assigned']) {
    assert.equal(profile.includes(internal), false, internal)
  }

  await save('driverDisplay', { guidance: { active: false, text: 'Confira os documentos antes de sair' }, contact: { ...display.contact, active: false, phone: '11' } })
  const off = (await get('/driver/me', driver)).body.portal.display
  assert.equal(off.guidance, null)
  assert.equal(off.contact, null)
  assert.deepEqual(off.notices, [])

  // A Frota continua vendo tudo: esconder é só do portal.
  assert.equal((await get(`/fleet/requests/${trip}`, scheduler)).body.request.details.origem, 'Sede')
})

// Por último: depende de haver registros.
test('a migração não se desfaz depois de haver registros', async () => {
  await assert.rejects(pool.query(schema('017_driver_portal_settings.rollback.sql')), /não pode ser desfeita/)
  assert.ok((await pool.query(`SELECT to_regclass('public.driver_occurrence_types') IS NOT NULL AS ok`)).rows[0].ok)
})
