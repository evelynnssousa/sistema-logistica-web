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
import type { Permission } from '../auth/permissions.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'

// Portal do Motorista pela API real, em um PostgreSQL descartável.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')

let pool: Pool
let server: Server
let baseUrl: string
let directory: string
let admin: Session
let scheduler: Session
let requester: Session
let driverA: Session
let driverB: Session
let driverIdA: string
let driverIdB: string
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

async function createUser(email: string, role: string = 'requester'): Promise<Session> {
  const id = await register(email)
  const approved = await post(`/admin/registrations/${id}/approve`, admin, { role })
  assert.equal(approved.status, 200, approved.text)
  return signIn(email)
}

async function staff(email: string, grants: Permission[] = ['requests:schedule']): Promise<Session> {
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

/** Viagem real de Frota, agendada pela rota normal. */
async function scheduledTrip(driverId?: string, at?: string) {
  tripCounter += 1
  // Um horário por viagem: nenhuma conflita com a outra sem que o teste peça.
  const when = at ?? new Date(Date.UTC(2031, 4, 1, 13) + tripCounter * 86_400_000).toISOString()
  const created = await post('/fleet/requests', requester, {
    origem: 'Sede', destino: `Fórum ${tripCounter}`, dataHora: when, finalidade: 'Levar documentos ao fórum', passageiros: [{ nome: 'Passageira Teste' }],
  })
  assert.equal(created.status, 201, created.text)
  const id = created.body.id as string
  // A mesma pessoa coordena todas: horários iguais, quando o teste pede, são confirmados aqui.
  const scheduled = await post(`/fleet/requests/${id}/schedule`, scheduler, { dataAgendada: when, confirmarConflito: true })
  assert.equal(scheduled.status, 200, scheduled.text)
  if (driverId) {
    const assigned = await post(`/fleet/requests/${id}/driver`, scheduler, { driverId, notes: 'Retirar a chave na portaria.' })
    assert.equal(assigned.status, 200, assigned.text)
  }
  return id
}

async function historyOf(id: string) {
  const { rows } = await pool.query<{ acao: string; comentario: string | null; detalhes: Record<string, any>; usuario_id: string }>(
    `SELECT acao, comentario, detalhes, usuario_id::text AS usuario_id FROM public.request_history WHERE request_id = $1 ORDER BY created_at, id`,
    [id],
  )
  return rows
}

before(async () => {
  process.env.PASSENGER_DATA_KEY = randomBytes(32).toString('base64')
  process.env.EMAIL_TRANSPORT = 'simulated'
  directory = mkdtempSync(join(tmpdir(), 'slm-motorista-'))
  process.env.ATTACHMENTS_DIR = directory

  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  for (const file of [
    '001_public_schema_snapshot.sql', '002_password_recovery.sql', '003_user_access.sql', '004_flight_passengers.sql',
    '005_operational_modules.sql', '006_integrations.sql', '007_operations_center.sql', '008_attachments.sql',
    '009_module_extensions.sql', '010_monitoring.sql', '011_delivery_forecast.sql', '012_operational_transparency.sql',
    '013_communications.sql', '014_demands.sql', '015_organizational_structure.sql',
  ]) {
    await pool.query(schema(file))
  }
  resetAccessSchemaCacheForTests()
  await pool.query(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'motorista-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )
  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('motorista-admin@example.gov.br')
  requester = await createUser('motorista-solicitante@example.gov.br')
  scheduler = await staff('motorista-agenda@example.gov.br')
})

after(async () => {
  for (const name of ['PASSENGER_DATA_KEY', 'EMAIL_TRANSPORT', 'ATTACHMENTS_DIR']) delete process.env[name]
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
  rmSync(directory, { recursive: true, force: true })
})

// Roda primeiro: o código publicado precede a migração, e a Frota não pode depender dela.
test('sem as migrações 016 e 017, a Frota segue igual, e só o que é novo pede a atualização', async () => {
  const id = await scheduledTrip()
  const detail = await get(`/fleet/requests/${id}`, scheduler)
  assert.equal(detail.status, 200, detail.text)
  assert.deepEqual(detail.body.occurrences, [])
  assert.equal((await get('/fleet/requests', scheduler)).status, 200)
  // Reagendar e cancelar avisam o motorista, se houver: sem a tabela, não podem falhar.
  const moved = await post(`/fleet/requests/${id}/schedule`, scheduler, { dataAgendada: '2035-01-01T13:00:00.000Z', motivoCodigo: 'outro', comentario: 'Mudou a agenda' })
  assert.equal(moved.status, 200, moved.text)
  assert.equal((await post(`/fleet/requests/${id}/start`, scheduler, {})).status, 200)
  assert.equal((await post(`/fleet/requests/${id}/complete`, scheduler, {})).status, 200)

  assert.equal((await get('/fleet/drivers', admin)).status, 503)
  assert.equal((await post(`/fleet/requests/${id}/driver`, scheduler, { driverId: null })).status, 503)

  const pendingId = await register('motorista-cedo@example.gov.br')
  const refused = await post(`/admin/registrations/${pendingId}/approve`, admin, { role: 'driver' })
  assert.ok(refused.status >= 400, 'o perfil não pode ser definido sem a migração')
  const account = await pool.query(`SELECT status FROM public.auth_users WHERE id = $1`, [pendingId])
  assert.equal(account.rows[0].status, 'pending', 'e a aprovação foi desfeita')

  // A migração se desfaz enquanto vazia, e volta sem resíduos.
  await pool.query(schema('016_driver_portal.sql'))
  await pool.query(schema('016_driver_portal.rollback.sql'))
  await pool.query(schema('016_driver_portal.sql'))
  await pool.query(schema('017_driver_portal_settings.sql'))
  await pool.query(schema('017_driver_portal_settings.rollback.sql'))
  await pool.query(schema('017_driver_portal_settings.sql'))
  const unprotected = await pool.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`,
  )
  assert.deepEqual(unprotected.rows, [], 'toda tabela nova tem RLS')
})

test('perfil Motorista: só administrador define, e o perfil não aceita equipe nem permissões', async () => {
  const onlyApprover = await createUser('motorista-aprovador@example.gov.br')
  const grant = await put(`/admin/users/${onlyApprover.id}/access`, admin, { role: 'requester', slmMember: false, grantedPermissions: ['users:approve'], deniedPermissions: [] })
  assert.equal(grant.status, 200, grant.text)
  const pendingId = await register('motorista-por-aprovador@example.gov.br')
  assert.equal((await post(`/admin/registrations/${pendingId}/approve`, onlyApprover, { role: 'driver' })).status, 403)
  assert.equal((await post(`/admin/registrations/${pendingId}/approve`, admin, { role: 'driver', setup: { slmMember: true } })).status, 400)
  assert.equal((await post(`/admin/registrations/${pendingId}/approve`, admin, { role: 'driver', setup: { grantedPermissions: ['fleet:schedule'] } })).status, 400)
  assert.equal((await post(`/admin/registrations/${pendingId}/approve`, admin, { role: 'driver' })).status, 200)

  const account = await signIn('motorista-por-aprovador@example.gov.br')
  const me = await get('/auth/me', account)
  assert.equal(me.body.user.role, 'driver')
  assert.deepEqual(me.body.user.permissions, ['driver_portal:access'])
  assert.equal(me.body.user.slmMember, false)

  const body = (extra: object) => ({ role: 'driver', slmMember: false, grantedPermissions: [], deniedPermissions: [], ...extra })
  assert.equal((await put(`/admin/users/${account.id}/access`, admin, body({ slmMember: true }))).status, 400)
  assert.equal((await put(`/admin/users/${account.id}/access`, admin, body({ grantedPermissions: ['users:manage'] }))).status, 400)
  assert.equal((await put(`/admin/users/${account.id}/access`, admin, body({ deniedPermissions: ['driver_portal:access'] }))).status, 400)

  // Nem gravando direto no banco: a restrição recusa, e o cálculo ignoraria.
  await assert.rejects(pool.query(`UPDATE public.auth_user_access SET granted_permissions = '{users:manage}' WHERE user_id = $1`, [account.id]))
  await assert.rejects(pool.query(`UPDATE public.auth_user_access SET slm_member = true WHERE user_id = $1`, [account.id]))
})

test('cadastro de motoristas: só quem administra a Frota, com conta de perfil Motorista', async () => {
  const a = await registerDriver('motorista-a@example.gov.br', 'Motorista Alfa')
  const b = await registerDriver('motorista-b@example.gov.br', 'Motorista Beta')
  driverA = a.session
  driverB = b.session
  driverIdA = a.id
  driverIdB = b.id

  assert.equal((await get('/fleet/drivers', requester)).status, 403)
  assert.equal((await post('/fleet/drivers', requester, { name: 'Tentativa' })).status, 403)
  assert.equal((await post('/fleet/drivers', scheduler, { name: 'Sem fleet:manage' })).status, 403)
  assert.equal((await post('/fleet/drivers', driverA, { name: 'O próprio motorista' })).status, 403)

  // Só conta de perfil Motorista, e uma só para cada cadastro.
  assert.equal((await post('/fleet/drivers', admin, { name: 'Conta errada', userId: requester.id })).status, 400)
  assert.equal((await post('/fleet/drivers', admin, { name: 'Conta repetida', userId: driverA.id })).status, 409)
  const withRegistration = await post('/fleet/drivers', admin, { name: 'Sem conta ainda', registration: 'M-100' })
  assert.equal(withRegistration.status, 201, withRegistration.text)
  assert.equal((await post('/fleet/drivers', admin, { name: 'Matrícula repetida', registration: 'm-100' })).status, 409)

  // Sem conta não recebe viagem, e as listas mostram o que falta.
  const assignable = await get('/fleet/drivers/assignable', scheduler)
  assert.deepEqual(assignable.body.drivers.map((item: { name: string }) => item.name).sort(), ['Motorista Alfa', 'Motorista Beta'])
  assert.equal(JSON.stringify(assignable.body).includes('@'), false, 'só nomes')
  const trip = await scheduledTrip()
  assert.equal((await post(`/fleet/requests/${trip}/driver`, scheduler, { driverId: withRegistration.body.id })).status, 400)

  const audit = await pool.query(`SELECT 1 FROM public.auth_audit_events WHERE action = 'fleet.driver_changed' AND target_resource_id = $1`, [driverIdA])
  assert.equal(audit.rows.length, 1)
})

test('o motorista não alcança nenhuma área administrativa, por nenhuma rota', async () => {
  const trip = await scheduledTrip()
  const denied: [string, string][] = [
    ['GET', '/dashboard/summary'],
    ['GET', '/maintenance/requests'],
    ['POST', '/maintenance/requests'],
    ['GET', '/fleet/requests'],
    ['POST', '/fleet/requests'],
    ['GET', `/fleet/requests/${trip}`],
    ['POST', `/fleet/requests/${trip}/schedule`],
    ['POST', `/fleet/requests/${trip}/driver`],
    ['POST', `/fleet/requests/${trip}/start`],
    ['POST', `/fleet/requests/${trip}/complete`],
    ['GET', `/fleet/requests/${trip}/execution`],
    ['POST', `/fleet/requests/${trip}/execution-correction`],
    ['GET', '/fleet/drivers'],
    ['GET', '/fleet/drivers/assignable'],
    ['GET', '/fleet/vehicles'],
    ['GET', '/flights/requests'],
    ['GET', '/warehouse/requests'],
    ['GET', '/warehouse/materials'],
    ['GET', '/demands'],
    ['GET', '/demands/context'],
    ['GET', '/settings/parameters'],
    ['GET', '/admin/users'],
    ['GET', '/admin/audit'],
    ['GET', '/reports/summary'],
    ['GET', '/calendar/events'],
    ['GET', '/search?q=Sede'],
    ['GET', '/catalog'],
    ['GET', '/operations/capabilities'],
    ['GET', '/slm/overview'],
    ['GET', `/attachments/resources/service_request/${trip}`],
  ]
  for (const [method, path] of denied) {
    const result = await call(path, { method, session: driverA, body: method === 'POST' ? {} : undefined })
    assert.equal(result.status, 403, `${method} ${path} respondeu ${result.status}`)
  }
  // Sessão e avisos continuam funcionando.
  assert.equal((await get('/auth/me', driverA)).status, 200)
  assert.equal((await get('/notifications', driverA)).status, 200)
  assert.equal((await get('/driver/me', driverA)).status, 200)

  // Nem atribuir a si mesmo, nem mudar o próprio perfil.
  assert.equal((await post(`/fleet/requests/${trip}/driver`, driverA, { driverId: driverIdA })).status, 403)
  assert.equal((await put(`/admin/users/${driverA.id}/access`, driverA, { role: 'administrator', slmMember: false, grantedPermissions: [], deniedPermissions: [] })).status, 403)
  const still = await get('/auth/me', driverA)
  assert.equal(still.body.user.role, 'driver')
})

test('o portal é só de motoristas, e quem não tem cadastro ativo não vê viagens', async () => {
  for (const session of [admin, scheduler, requester]) {
    assert.equal((await get('/driver/me', session)).status, 403)
    assert.equal((await get('/driver/trips', session)).status, 403)
  }
  assert.equal((await call('/driver/trips')).status, 401)

  const unlinked = await createUser('motorista-sem-cadastro@example.gov.br', 'driver')
  const me = await get('/driver/me', unlinked)
  assert.equal(me.status, 200)
  assert.equal(me.body.linked, false)
  assert.equal((await get('/driver/trips', unlinked)).status, 403)
})

test('atribuição: só em viagem agendada, por quem agenda, e o motorista é avisado', async () => {
  const created = await post('/fleet/requests', requester, { origem: 'Sede', destino: 'Sem agenda', dataHora: '2032-01-01T13:00:00.000Z', finalidade: 'Sem agendamento ainda' })
  assert.equal((await post(`/fleet/requests/${created.body.id}/driver`, scheduler, { driverId: driverIdA })).status, 409)

  const trip = await scheduledTrip()
  assert.equal((await post(`/fleet/requests/${trip}/driver`, requester, { driverId: driverIdA })).status, 403)
  const before = (await get('/notifications', driverA)).body.total as number
  assert.equal((await post(`/fleet/requests/${trip}/driver`, scheduler, { driverId: driverIdA, notes: 'Levar o crachá.' })).status, 200)

  const notices = (await get('/notifications', driverA)).body
  assert.equal(notices.total, before + 1)
  assert.match(notices.notifications[0].message, /Nova viagem atribuída/)
  assert.equal(notices.notifications[0].link, '/motorista')

  const history = await historyOf(trip)
  assert.ok(history.some((entry) => entry.acao === 'motorista_atribuido' && entry.usuario_id === scheduler.id))
  const audit = await pool.query(`SELECT details FROM public.auth_audit_events WHERE action = 'fleet.trip_driver_assigned' AND target_resource_id = $1`, [trip])
  assert.equal(audit.rows[0].details.to, 'Motorista Alfa')

  // O mesmo horário para o mesmo motorista pede confirmação.
  const scheduledAt = (await get(`/fleet/requests/${trip}`, scheduler)).body.request.scheduledAt as string
  const clash = await scheduledTrip(undefined, scheduledAt)
  const refused = await post(`/fleet/requests/${clash}/driver`, scheduler, { driverId: driverIdA })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.code, 'SCHEDULE_CONFLICT')
  assert.equal(refused.body.conflicts[0].reason, 'driver')
  assert.equal((await post(`/fleet/requests/${clash}/driver`, scheduler, { driverId: driverIdA, confirmConflicts: true })).status, 200)
})

test('isolamento: cada motorista vê e altera só as próprias viagens', async () => {
  const mine = await scheduledTrip(driverIdA)
  const other = await scheduledTrip(driverIdB)
  const notAssigned = await scheduledTrip()

  const list = async (session: Session) => {
    const ids: string[] = []
    for (const group of ['proximas', 'agendadas', 'em_andamento', 'concluidas', 'canceladas']) {
      const result = await get(`/driver/trips?group=${group}`, session)
      assert.equal(result.status, 200, result.text)
      ids.push(...result.body.trips.map((item: { id: string }) => item.id))
    }
    return ids
  }
  const seenByA = await list(driverA)
  assert.ok(seenByA.includes(mine))
  assert.ok(!seenByA.includes(other))
  assert.ok(!seenByA.includes(notAssigned))
  assert.ok((await list(driverB)).includes(other))

  // Por chamada direta, a de outro responde como inexistente, e nada muda.
  for (const id of [other, notAssigned]) {
    assert.equal((await get(`/driver/trips/${id}`, driverA)).status, 404)
    assert.equal((await post(`/driver/trips/${id}/start`, driverA)).status, 404)
    assert.equal((await post(`/driver/trips/${id}/finish`, driverA)).status, 404)
    assert.equal((await post(`/driver/trips/${id}/occurrences`, driverA, { categoria: 'outra', descricao: 'Tentativa' })).status, 404)
  }
  const untouched = await pool.query(`SELECT status, execucao_inicio FROM public.service_requests WHERE id = $1`, [other])
  assert.equal(untouched.rows[0].status, 'agendado')
  assert.equal(untouched.rows[0].execucao_inicio, null)

  // Enviar outro motorista no corpo ou no filtro não muda o alcance.
  const spoofed = await get(`/driver/trips?group=proximas&driverId=${driverIdB}&motorista_id=${driverIdB}`, driverA)
  assert.ok(!spoofed.body.trips.some((item: { id: string }) => item.id === other))
})

test('a viagem mostra o necessário, sem dados internos ou de contato', async () => {
  const trip = await scheduledTrip(driverIdA)
  assert.equal((await post(`/fleet/requests/${trip}/internal-notes`, scheduler, { text: 'nota-interna-secreta' })).status >= 200, true)
  const detail = await get(`/driver/trips/${trip}`, driverA)
  assert.equal(detail.status, 200, detail.text)
  const { trip: shown } = detail.body
  assert.equal(shown.origin, 'Sede')
  assert.match(shown.destination, /^Fórum/)
  assert.equal(shown.notes, 'Retirar a chave na portaria.')
  assert.deepEqual(shown.passengers, ['Passageira Teste'])
  assert.equal(shown.requester, 'Pessoa motorista-solicitante')
  assert.equal(shown.canStart, true)
  const text = JSON.stringify(detail.body)
  assert.equal(text.includes('@example.gov.br'), false, 'sem e-mail')
  assert.equal(text.includes('nota-interna-secreta'), false, 'sem nota interna')
})

test('iniciar: horário do servidor, sem duplicar, e a Frota vê na hora', async () => {
  const trip = await scheduledTrip(driverIdA)
  const before = Date.now()
  // Horário enviado pelo navegador é ignorado.
  const started = await post(`/driver/trips/${trip}/start`, driverA, { inicioReal: '2001-01-01T00:00:00.000Z', startedAt: '2001-01-01T00:00:00.000Z' })
  assert.equal(started.status, 200, started.text)
  assert.equal(started.body.status, 'em_andamento')
  const startedAt = new Date(started.body.startedAt).getTime()
  assert.ok(startedAt >= before - 5_000 && startedAt <= Date.now() + 5_000, 'horário do servidor')

  assert.equal((await post(`/driver/trips/${trip}/start`, driverA)).status, 409, 'não inicia duas vezes')
  const history = await historyOf(trip)
  assert.equal(history.filter((entry) => entry.acao === 'iniciada').length, 1)
  const entry = history.find((item) => item.acao === 'iniciada')!
  assert.equal(entry.usuario_id, driverA.id)
  assert.equal(entry.detalhes.origem, 'portal_motorista')
  assert.equal(entry.detalhes.motorista, 'Motorista Alfa')

  // A mesma solicitação, na tela da Frota.
  const fleet = await get(`/fleet/requests/${trip}`, scheduler)
  assert.equal(fleet.body.request.status, 'em_andamento')
  assert.ok(fleet.body.request.startedAt)
  assert.ok(fleet.body.history.some((item: { action: string }) => item.action === 'iniciada'))
  const list = await get('/fleet/requests', scheduler)
  assert.equal(list.body.requests.find((item: { id: string }) => item.id === trip).driverName, 'Motorista Alfa')
  const execution = await get(`/fleet/requests/${trip}/execution`, scheduler)
  assert.equal(execution.body.driver.name, 'Motorista Alfa')
  assert.equal(new Date(execution.body.startedAt).getTime(), startedAt)
  const audit = await pool.query(`SELECT actor_user_id::text AS actor, details FROM public.auth_audit_events WHERE action = 'request.started' AND target_resource_id = $1`, [trip])
  assert.equal(audit.rows[0]?.actor, driverA.id)
  assert.equal(audit.rows[0]?.details.via, 'portal_motorista')
})

test('dois inícios ao mesmo tempo: só um vale', async () => {
  const trip = await scheduledTrip(driverIdA)
  const results = await Promise.all([post(`/driver/trips/${trip}/start`, driverA), post(`/driver/trips/${trip}/start`, driverA)])
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 409])
  assert.equal((await historyOf(trip)).filter((entry) => entry.acao === 'iniciada').length, 1)
})

test('finalizar: só depois de iniciar, com o tempo efetivo, sem repetir', async () => {
  const trip = await scheduledTrip(driverIdA)
  assert.equal((await post(`/driver/trips/${trip}/finish`, driverA)).status, 409, 'ainda não começou')
  assert.equal((await post(`/driver/trips/${trip}/start`, driverA)).status, 200)
  await pool.query(`UPDATE public.service_requests SET execucao_inicio = now() - interval '90 minutes' WHERE id = $1`, [trip])

  const finished = await post(`/driver/trips/${trip}/finish`, driverA, { fimReal: '2001-01-01T00:00:00.000Z' })
  assert.equal(finished.status, 200, finished.text)
  assert.equal(finished.body.status, 'concluido')
  assert.equal(finished.body.durationMinutes, 90)
  assert.ok(new Date(finished.body.finishedAt).getFullYear() > 2001, 'horário do navegador ignorado')
  assert.equal((await post(`/driver/trips/${trip}/finish`, driverA)).status, 409, 'não finaliza duas vezes')
  assert.equal((await post(`/driver/trips/${trip}/start`, driverA)).status, 409, 'nem recomeça')

  const entry = (await historyOf(trip)).find((item) => item.acao === 'concluida')!
  assert.equal(entry.usuario_id, driverA.id)
  assert.equal(entry.detalhes.duracaoMinutos, 90)
  const fleet = await get(`/fleet/requests/${trip}`, scheduler)
  assert.equal(fleet.body.request.status, 'concluido')
  assert.ok(fleet.body.request.concludedAt)
  const execution = await get(`/fleet/requests/${trip}/execution`, scheduler)
  assert.equal(execution.body.durationMinutes, 90)
})

test('a referência das 7h às 19h identifica, e nunca impede', async () => {
  const trip = await scheduledTrip(driverIdA)
  assert.equal((await post(`/driver/trips/${trip}/start`, driverA)).status, 200)
  // 23h em São Paulo: fora da referência.
  await pool.query(`UPDATE public.service_requests SET execucao_inicio = '2026-03-10T02:00:00Z' WHERE id = $1`, [trip])
  const current = await get(`/driver/trips/${trip}`, driverA)
  assert.equal(current.body.trip.exceedsJourney, true)
  const finished = await post(`/driver/trips/${trip}/finish`, driverA)
  assert.equal(finished.status, 200, 'finaliza mesmo fora da referência')
  assert.equal((await historyOf(trip)).find((item) => item.acao === 'concluida')!.detalhes.foraDaReferencia, true)
  assert.equal((await get(`/fleet/requests/${trip}/execution`, scheduler)).body.exceedsJourney, true)
})

test('ocorrências: da viagem certa, com anexo, para a equipe e não para o solicitante', async () => {
  const trip = await scheduledTrip(driverIdA)
  const path = `/driver/trips/${trip}/occurrences`
  assert.equal((await post(path, driverA, { categoria: 'invalida', descricao: 'Texto' })).status, 400)
  assert.equal((await post(path, driverA, { categoria: 'veiculo', descricao: 'x' })).status, 400)
  assert.equal((await post(path, driverA, { categoria: 'atraso', descricao: 'Trânsito intenso' })).status, 400, 'atraso pede os minutos')

  const created = await post(path, driverA, { categoria: 'veiculo', descricao: 'Pneu furado na via', motoristaId: driverIdB, createdAt: '2001-01-01T00:00:00Z' })
  assert.equal(created.status, 201, created.text)
  assert.equal((await post(path, driverA, { categoria: 'atraso', descricao: 'Trânsito intenso', atrasoMinutos: 25 })).status, 201)

  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
  const file = `${path}/${created.body.id}/attachments`
  const headers = { 'x-file-name': encodeURIComponent('foto-do-pneu.pdf') }
  const uploaded = await call(file, { method: 'POST', session: driverA, raw: pdf, headers })
  assert.equal(uploaded.status, 201, uploaded.text)
  assert.equal((await call(file, { method: 'POST', session: driverB, raw: pdf, headers })).status, 404, 'outro motorista não anexa')

  const own = await get(`/driver/trips/${trip}`, driverA)
  assert.equal(own.body.occurrences.length, 2)
  assert.equal(own.body.occurrences[0].category, 'veiculo')
  assert.deepEqual(own.body.occurrences[0].attachments.map((item: { name: string }) => item.name), ['foto-do-pneu.pdf'])

  const stored = await pool.query(
    `SELECT o.motorista_id::text AS motorista, o.registrado_por::text AS usuario, o.created_at FROM public.request_occurrences o WHERE o.id = $1`,
    [created.body.id],
  )
  assert.equal(stored.rows[0].motorista, driverIdA, 'o motorista vem da sessão')
  assert.equal(stored.rows[0].usuario, driverA.id)
  assert.ok(new Date(stored.rows[0].created_at).getFullYear() > 2001, 'data automática')

  // A equipe consulta, com o anexo.
  const execution = await get(`/fleet/requests/${trip}/execution`, scheduler)
  assert.equal(execution.body.occurrences.length, 2)
  assert.equal(execution.body.occurrences[0].driver, 'Motorista Alfa')
  const attachmentId = execution.body.occurrences[0].attachments[0].id
  assert.equal((await get(`/attachments/files/${attachmentId}/content`, scheduler)).status, 200)
  assert.ok((await get(`/fleet/requests/${trip}`, scheduler)).body.history.some((item: { action: string }) => item.action === 'ocorrencia_motorista'))
  const teamNotice = await get('/notifications', scheduler)
  assert.ok(teamNotice.body.notifications.some((item: { message: string }) => /Ocorrência|Atraso/.test(item.message)))

  // O solicitante acompanha a própria solicitação, sem o relato do motorista nem o arquivo.
  const seenByRequester = await get(`/fleet/requests/${trip}`, requester)
  assert.equal(seenByRequester.status, 200)
  assert.deepEqual(seenByRequester.body.occurrences, [])
  assert.equal(JSON.stringify(seenByRequester.body).includes('Pneu furado'), false)
  assert.equal(JSON.stringify(seenByRequester.body).includes('Motorista Alfa'), false)
  assert.equal((await get(`/fleet/requests/${trip}/execution`, requester)).status, 403)
  assert.equal((await get(`/attachments/files/${attachmentId}/content`, requester)).status, 404)
})

test('correção de horários: autorizada, com motivo, preservando o original', async () => {
  const trip = await scheduledTrip(driverIdA)
  assert.equal((await post(`/fleet/requests/${trip}/execution-correction`, admin, { start: '2026-01-01T12:00:00Z', reason: 'Ainda sem início' })).status, 409)
  const started = await post(`/driver/trips/${trip}/start`, driverA)
  const finished = await post(`/driver/trips/${trip}/finish`, driverA)
  const originalStart = started.body.startedAt as string
  const originalEnd = finished.body.finishedAt as string
  const earlier = new Date(Date.parse(originalStart) - 3_600_000).toISOString()

  const path = `/fleet/requests/${trip}/execution-correction`
  const valid = { start: earlier, reason: 'O motorista esqueceu de iniciar na saída.' }
  assert.equal((await post(path, driverA, valid)).status, 403, 'o motorista não corrige')
  assert.equal((await post(path, requester, valid)).status, 403)
  assert.equal((await post(path, scheduler, valid)).status, 403, 'agendar não autoriza corrigir')
  assert.equal((await post(path, admin, { start: earlier })).status, 400, 'exige motivo')
  assert.equal((await post(path, admin, { reason: 'Sem horário nenhum' })).status, 400)
  assert.equal((await post(path, admin, { start: '2099-01-01T00:00:00Z', reason: 'No futuro' })).status, 400)
  assert.equal((await post(path, admin, { end: earlier, reason: 'Fim antes do início' })).status, 400)

  const authorized = await staff('motorista-corrige@example.gov.br', ['fleet:execution_correct'])
  assert.equal((await post(path, authorized, valid)).status, 200)

  const execution = (await get(`/fleet/requests/${trip}/execution`, scheduler)).body
  assert.equal(new Date(execution.startedAt).toISOString(), earlier)
  assert.equal(execution.corrections.length, 1)
  assert.equal(new Date(execution.corrections[0].previousStart).toISOString(), new Date(originalStart).toISOString(), 'o original fica guardado')
  assert.equal(new Date(execution.corrections[0].previousEnd).toISOString(), new Date(originalEnd).toISOString())
  assert.equal(execution.corrections[0].user, 'Pessoa motorista-corrige')

  // O registro original também segue no histórico, e a correção entra nele.
  const history = await historyOf(trip)
  assert.equal(new Date(history.find((item) => item.acao === 'iniciada')!.detalhes.inicioReal).toISOString(), new Date(originalStart).toISOString())
  const correction = history.find((item) => item.acao === 'execucao_corrigida')!
  assert.equal(correction.usuario_id, authorized.id)
  assert.equal(correction.detalhes.alteracoes[0].campo, 'Início efetivo')
  const audit = await pool.query(`SELECT actor_user_id::text AS actor FROM public.auth_audit_events WHERE action = 'fleet.execution_corrected' AND target_resource_id = $1`, [trip])
  assert.equal(audit.rows[0]?.actor, authorized.id)

  // O registro da correção não muda nem é apagado, nem por SQL direto.
  await assert.rejects(pool.query(`UPDATE public.fleet_execution_corrections SET motivo = 'Outro' WHERE request_id = $1`, [trip]))
  await assert.rejects(pool.query(`DELETE FROM public.fleet_execution_corrections WHERE request_id = $1`, [trip]))
})

test('avisos: alteração, reagendamento e cancelamento chegam ao motorista da viagem', async () => {
  const trip = await scheduledTrip(driverIdB)
  const messages = async () => (await get('/notifications', driverB)).body.notifications.map((item: { message: string }) => item.message) as string[]

  const moved = await post(`/fleet/requests/${trip}/schedule`, scheduler, { dataAgendada: '2036-03-03T13:00:00.000Z', motivoCodigo: 'outro', comentario: 'Mudança na agenda do fórum' })
  assert.equal(moved.status, 200, moved.text)
  assert.ok((await messages()).some((message) => /Viagem reagendada/.test(message)))
  assert.equal((await get(`/driver/trips/${trip}`, driverB)).body.trip.status, 'reagendado')

  const notes = await post(`/fleet/requests/${trip}/driver`, scheduler, { driverId: driverIdB, notes: 'Nova orientação.' })
  assert.equal(notes.status, 200, notes.text)
  assert.ok((await messages()).some((message) => /informações de uma viagem/.test(message)))
  assert.equal((await get(`/driver/trips/${trip}`, driverB)).body.trip.notes, 'Nova orientação.')

  const cancelled = await post(`/fleet/requests/${trip}/cancel`, admin, { motivoCodigo: 'outro', motivo: 'motivo-interno-do-cancelamento' })
  assert.equal(cancelled.status, 200, cancelled.text)
  assert.ok((await messages()).some((message) => /foi cancelada/.test(message)))

  const group = await get('/driver/trips?group=canceladas', driverB)
  assert.ok(group.body.trips.some((item: { id: string }) => item.id === trip))
  assert.equal(JSON.stringify(group.body).includes('motivo-interno-do-cancelamento'), false)
  assert.equal((await post(`/driver/trips/${trip}/start`, driverB)).status, 409, 'cancelada não inicia')
  assert.equal((await post(`/driver/trips/${trip}/occurrences`, driverB, { categoria: 'outra', descricao: 'Depois de cancelada' })).status, 409)
})

test('reatribuir tira a viagem do motorista anterior; depois de iniciada, não muda mais', async () => {
  const trip = await scheduledTrip(driverIdA)
  assert.equal((await post(`/fleet/requests/${trip}/driver`, scheduler, { driverId: driverIdB })).status, 200)
  assert.equal((await get(`/driver/trips/${trip}`, driverA)).status, 404)
  assert.equal((await get(`/driver/trips/${trip}`, driverB)).status, 200)
  const notices = (await get('/notifications', driverA)).body.notifications as { message: string }[]
  assert.ok(notices.some((item) => /deixou de estar atribuída/.test(item.message)))

  assert.equal((await post(`/driver/trips/${trip}/start`, driverB)).status, 200)
  assert.equal((await post(`/fleet/requests/${trip}/driver`, scheduler, { driverId: driverIdA })).status, 409)
  assert.equal((await post(`/fleet/requests/${trip}/driver`, scheduler, { driverId: null })).status, 409)
  assert.equal((await post(`/driver/trips/${trip}/finish`, driverB)).status, 200)
})

test('histórico individual: cada um vê o próprio, com horários e ocorrências', async () => {
  const trip = await scheduledTrip(driverIdB)
  await post(`/driver/trips/${trip}/start`, driverB)
  await post(`/driver/trips/${trip}/occurrences`, driverB, { categoria: 'percurso', descricao: 'Desvio por obra na via' })
  await post(`/driver/trips/${trip}/finish`, driverB)

  const own = await get('/driver/history', driverB)
  assert.equal(own.status, 200)
  const item = own.body.trips.find((entry: { id: string }) => entry.id === trip)
  assert.ok(item.scheduledAt && item.startedAt && item.finishedAt)
  assert.equal(item.status, 'concluido')
  assert.equal(item.occurrences[0].description, 'Desvio por obra na via')
  assert.ok(!(await get('/driver/history', driverA)).body.trips.some((entry: { id: string }) => entry.id === trip))
  assert.equal((await get('/driver/history', admin)).status, 403)
})

test('desativar: exige encerrar as viagens, e tira o acesso ao portal', async () => {
  const leaving = await registerDriver('motorista-saindo@example.gov.br', 'Motorista Saindo')
  const trip = await scheduledTrip(leaving.id)
  const deactivate = { name: 'Motorista Saindo', userId: leaving.session.id, active: false }
  assert.equal((await patch(`/fleet/drivers/${leaving.id}`, admin, deactivate)).status, 409)
  assert.equal((await patch(`/fleet/drivers/${leaving.id}`, admin, { ...deactivate, active: true, userId: null })).status, 409, 'nem desvincular')

  assert.equal((await post(`/fleet/requests/${trip}/driver`, scheduler, { driverId: driverIdA })).status, 200)
  assert.equal((await patch(`/fleet/drivers/${leaving.id}`, admin, deactivate)).status, 200)
  assert.equal((await get('/driver/me', leaving.session)).body.linked, false)
  assert.equal((await get('/driver/trips', leaving.session)).status, 403)

  // Deixar de ser motorista nos Usuários tira o portal na hora, sem novo login.
  const changing = await registerDriver('motorista-muda@example.gov.br', 'Motorista Muda')
  const changed = await put(`/admin/users/${changing.session.id}/access`, admin, { role: 'requester', slmMember: false, grantedPermissions: [], deniedPermissions: [] })
  assert.equal(changed.status, 200, changed.text)
  assert.equal((await get('/driver/me', changing.session)).status, 403)
  const trip2 = await scheduledTrip()
  assert.equal((await post(`/fleet/requests/${trip2}/driver`, scheduler, { driverId: changing.id })).status, 400, 'e não recebe mais viagens')
})

test('a Frota segue funcionando pela equipe: início e fim com permissão, como antes', async () => {
  // Procedimento excepcional já existente: a equipe registra a execução, com auditoria.
  const trip = await scheduledTrip(driverIdA)
  assert.equal((await post(`/fleet/requests/${trip}/start`, scheduler, { comentario: 'Registrado pela equipe' })).status, 200)
  assert.equal((await get(`/driver/trips/${trip}`, driverA)).body.trip.status, 'em_andamento')
  assert.equal((await post(`/driver/trips/${trip}/finish`, driverA)).status, 200, 'e o motorista pode finalizar')
  const operatorOccurrence = await scheduledTrip()
  assert.equal((await post(`/fleet/requests/${operatorOccurrence}/occurrences`, scheduler, { tipo: 'ocorrencia', descricao: 'Registrada pela equipe' })).status, 201)
  assert.equal((await get(`/fleet/requests/${operatorOccurrence}`, requester)).body.occurrences.length, 1, 'as da equipe seguem como antes')
})
