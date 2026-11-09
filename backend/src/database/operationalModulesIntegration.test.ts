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
import {
  generatePasswordRecoveryToken,
  hashPasswordRecoveryToken,
} from '../auth/passwordRecovery.js'
import type { Permission } from '../auth/permissions.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'

// Fluxos completos dos módulos, pela API real, em um PostgreSQL descartável.

const password = randomBytes(24).toString('hex')
const schema = (file: string) =>
  readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')

// Números sem dono: base fictícia com dígitos verificadores calculados.
const fictionalCpf = '00000000191'
const secondFictionalCpf = '00000000272'
const thirdFictionalCpf = '00000000353'

let pool: Pool
let server: Server
let baseUrl: string
const csrfTokens = new Map<string, string>()

type Session = { cookie: string; id: string }

async function call(
  path: string,
  options: { method?: string; body?: unknown; session?: Session } = {},
) {
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
  const setCookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  const body = JSON.parse(text) as Record<string, any>
  if (setCookie && body.csrfToken) csrfTokens.set(setCookie, body.csrfToken)
  return { status: response.status, body, text, setCookie }
}

const post = (path: string, session: Session, body: unknown = {}) =>
  call(path, { method: 'POST', session, body })
const patch = (path: string, session: Session, body: unknown) =>
  call(path, { method: 'PATCH', session, body })
const put = (path: string, session: Session, body: unknown) =>
  call(path, { method: 'PUT', session, body })

async function signIn(email: string): Promise<Session> {
  authRateLimits.loginPair.reset(`127.0.0.1|${email}`)
  authRateLimits.loginPair.reset(`::ffff:127.0.0.1|${email}`)
  authRateLimits.loginAccount.reset(email)
  const result = await call('/auth/login', {
    method: 'POST',
    body: { identifier: email, password },
  })
  assert.equal(result.status, 200, `login de ${email}`)
  return { cookie: result.setCookie, id: result.body.user.id }
}

let admin: Session

async function createUser(
  email: string,
  role: 'requester' | 'slm_operator' | 'administrator' = 'requester',
  sector = 'Protocolo',
): Promise<Session> {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const registered = await call('/auth/register', {
    method: 'POST',
    body: {
      fullName: `Pessoa ${email.split('@')[0]}`,
      email,
      sector,
      password,
      passwordConfirmation: password,
    },
  })
  assert.equal(registered.status, 202)
  const pending = await call('/admin/registrations/pending', { session: admin })
  const id = pending.body.registrations.find(
    (registration: { email: string }) => registration.email === email,
  ).id
  assert.equal(
    (await post(`/admin/registrations/${id}/approve`, admin, { role })).status,
    200,
  )
  return signIn(email)
}

function setAccess(
  userId: string,
  access: {
    role: string
    slmMember?: boolean
    grantedPermissions?: Permission[]
    deniedPermissions?: Permission[]
  },
) {
  return put(`/admin/users/${userId}/access`, admin, {
    slmMember: false,
    grantedPermissions: [],
    deniedPermissions: [],
    ...access,
  })
}

async function staff(
  email: string,
  grants: Permission[] = [],
  sector = 'CPC',
  denied: Permission[] = [],
): Promise<Session> {
  const user = await createUser(email, 'slm_operator', sector)
  const result = await setAccess(user.id, {
    role: 'slm_operator',
    slmMember: true,
    grantedPermissions: grants,
    deniedPermissions: denied,
  })
  assert.equal(result.status, 200, result.text)
  return user
}

async function auditActions(resourceId: string) {
  const { rows } = await pool.query<{ action: string; actor: string | null }>(
    `SELECT action, actor_user_id::text AS actor FROM public.auth_audit_events
      WHERE target_resource_id = $1 ORDER BY id`,
    [resourceId],
  )
  return rows
}

const options: Record<string, string> = {}

async function option(category: string, label: string) {
  const created = await post(`/settings/catalog/${category}`, admin, { label })
  assert.equal(created.status, 201, created.text)
  options[label] = created.body.option.id
  return created.body.option.id as string
}

before(async () => {
  process.env.PASSENGER_DATA_KEY = randomBytes(32).toString('base64')
  process.env.PASSWORD_RESET_PEPPER = randomBytes(16).toString('hex')

  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  const setup = await pool.connect()
  for (const file of [
    '001_public_schema_snapshot.sql',
    '002_password_recovery.sql',
    '003_user_access.sql',
    '004_flight_passengers.sql',
    '005_operational_modules.sql',
  ]) {
    await setup.query(schema(file))
  }
  setup.release(true)
  resetAccessSchemaCacheForTests()

  await pool.query(
    `INSERT INTO public.auth_users
      (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'modulos-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )

  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('modulos-admin@example.gov.br')

  await option('floors', '1º andar')
  await option('serviceTypes', 'Elétrica')
  await option('measurementUnits', 'Unidade')
  await option('warehouseCategories', 'Papelaria')
  await option('sectors', 'Protocolo')
  await option('sectors', 'CPC')
})

after(async () => {
  delete process.env.PASSENGER_DATA_KEY
  delete process.env.PASSWORD_RESET_PEPPER
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

function maintenanceBody(extra: Record<string, unknown> = {}) {
  return {
    andarId: options['1º andar'],
    tipoServicoId: options['Elétrica'],
    localServico: 'Sala de arquivo',
    descricao: 'Lâmpada queimada',
    ...extra,
  }
}

function fleetBody(extra: Record<string, unknown> = {}) {
  return {
    origem: 'Sede',
    destino: 'Fórum',
    dataHora: '2027-03-10T13:00:00.000Z',
    finalidade: 'Entrega de documentos',
    passageiros: [{ nome: 'Pessoa Fictícia' }],
    ...extra,
  }
}

function flightBody(extra: Record<string, unknown> = {}) {
  return {
    andarId: options['1º andar'],
    tipoViagem: 'ida_volta',
    ida: { origem: 'GRU', destino: 'BSB', data: '2027-04-01', horario: '08:00' },
    volta: { origem: 'BSB', destino: 'GRU', data: '2027-04-03', horario: '18:00' },
    bagagem: 'Bagagem de mão',
    passageiros: [{ nome: 'Passageira Fictícia', cpf: fictionalCpf }],
    ...extra,
  }
}

test('configurações: permissão, duplicidade, edição, desativação e reativação', async () => {
  const requester = await createUser('cfg-solicitante@example.gov.br')

  assert.equal((await call('/settings/catalog', { session: requester })).status, 403)
  assert.equal(
    (await post('/settings/catalog/floors', requester, { label: 'Invasão' })).status,
    403,
  )

  const forOperator = await staff('cfg-operadora@example.gov.br')
  assert.equal((await post('/settings/catalog/floors', forOperator, { label: 'X' })).status, 403)

  // Variações de maiúsculas e espaços contam como duplicidade.
  assert.equal((await post('/settings/catalog/floors', admin, { label: ' 1º ANDAR ' })).status, 409)
  assert.equal((await post('/settings/catalog/inexistente', admin, { label: 'X' })).status, 404)
  assert.equal((await post('/settings/catalog/floors', admin, { label: '  ' })).status, 400)

  const id = await option('floors', 'Térreo')
  const other = await option('floors', 'Subsolo')
  assert.equal(
    (await patch(`/settings/catalog/floors/${other}`, admin, { label: 'térreo' })).status,
    409,
  )
  assert.equal(
    (await patch(`/settings/catalog/floors/${other}`, admin, { label: 'Subsolo 1' })).status,
    200,
  )

  // Formulários recebem só as ativas, inclusive para quem não administra.
  const deactivated = await post(`/settings/catalog/floors/${id}/deactivate`, admin)
  assert.equal(deactivated.body.option.active, false)
  const active = await call('/catalog', { session: requester })
  assert.equal(active.body.catalog.floors.some((item: { id: string }) => item.id === id), false)
  const all = await call('/settings/catalog', { session: admin })
  assert.equal(all.body.catalog.floors.some((item: { id: string }) => item.id === id), true)

  // Opção desativada não entra em novos registros.
  assert.equal(
    (await post('/maintenance/requests', requester, maintenanceBody({ andarId: id }))).status,
    400,
  )

  assert.equal((await post(`/settings/catalog/floors/${id}/activate`, admin)).status, 200)
  assert.deepEqual(
    (await auditActions(id)).map((event) => event.action),
    ['settings.created', 'settings.deactivated', 'settings.activated'],
  )
})

test('desativar ou renomear uma opção não muda os registros antigos', async () => {
  const requester = await createUser('historico@example.gov.br')
  const typeId = await option('serviceTypes', 'Hidráulica')
  const created = await post(
    '/maintenance/requests',
    requester,
    maintenanceBody({ tipoServicoId: typeId }),
  )
  assert.equal(created.status, 201, created.text)

  await patch(`/settings/catalog/serviceTypes/${typeId}`, admin, { label: 'Encanamento' })
  await post(`/settings/catalog/serviceTypes/${typeId}/deactivate`, admin)

  const detail = await call(`/maintenance/requests/${created.body.id}`, { session: requester })
  assert.equal(detail.body.request.serviceType, 'Hidráulica')
  assert.match(detail.body.request.title, /^Hidráulica/)
})

test('manutenção: fluxo completo, com responsáveis, histórico e auditoria', async () => {
  const requester = await createUser('mnt-solicitante@example.gov.br')
  const scheduler = await staff('mnt-agendadora@example.gov.br', ['requests:schedule'])

  const created = await post('/maintenance/requests', requester, maintenanceBody())
  assert.equal(created.status, 201, created.text)
  const path = `/maintenance/requests/${created.body.id}`

  let detail = await call(path, { session: requester })
  assert.equal(detail.body.request.status, 'aguardando_agendamento')
  assert.equal(detail.body.request.requester.id, requester.id)
  assert.equal(detail.body.request.sector, 'Protocolo')
  assert.equal(detail.body.request.floor, '1º andar')
  assert.equal(detail.body.actions.schedule, false)

  // Não pode pular etapas.
  assert.equal((await post(`${path}/start`, scheduler)).status, 409)
  assert.equal((await post(`${path}/complete`, scheduler)).status, 409)

  assert.equal(
    (await post(`${path}/schedule`, scheduler, { dataAgendada: 'amanhã' })).status,
    400,
  )
  const scheduled = await post(`${path}/schedule`, scheduler, {
    dataAgendada: '2027-03-01T13:00:00.000Z',
    dataFim: '2027-03-01T15:00:00.000Z',
  })
  assert.equal(scheduled.body.status, 'agendado')

  // Reagendar exige motivo e muda o status.
  assert.equal(
    (await post(`${path}/schedule`, scheduler, { dataAgendada: '2027-03-02T13:00:00.000Z' })).status,
    400,
  )
  const rescheduled = await post(`${path}/schedule`, scheduler, {
    dataAgendada: '2027-03-02T13:00:00.000Z',
    comentario: 'Equipe indisponível',
  })
  assert.equal(rescheduled.body.status, 'reagendado')

  assert.equal((await post(`${path}/start`, scheduler)).body.status, 'em_andamento')
  assert.equal(
    (await post(`${path}/schedule`, scheduler, { dataAgendada: '2027-03-05T13:00:00.000Z' })).status,
    409,
  )
  assert.equal(
    (await post(`${path}/complete`, scheduler, { comentario: 'Lâmpada trocada' })).body.status,
    'concluido',
  )

  // Encerrada: nada mais muda.
  assert.equal((await post(`${path}/start`, scheduler)).status, 409)
  assert.equal((await post(`${path}/cancel`, scheduler, { motivo: 'Desistência' })).status, 409)
  assert.equal((await patch(path, scheduler, { descricao: 'Mudou' })).status, 409)

  detail = await call(path, { session: requester })
  assert.equal(detail.body.request.status, 'concluido')
  assert.equal(detail.body.request.responsibleId, scheduler.id)
  assert.equal(detail.body.request.scheduledBy, 'Pessoa mnt-agendadora')
  assert.ok(detail.body.request.startedAt && detail.body.request.finishedAt)
  assert.deepEqual(
    detail.body.history.map((entry: { action: string }) => entry.action),
    ['criada', 'agendada', 'reagendada', 'iniciada', 'concluida'],
  )
  assert.deepEqual(
    (await auditActions(created.body.id)).map((event) => event.action),
    [
      'request.created',
      'request.scheduled',
      'request.rescheduled',
      'request.started',
      'request.completed',
    ],
  )
})

test('manutenção: edição registra os campos alterados, e cancelar exige motivo', async () => {
  const requester = await createUser('mnt-edicao@example.gov.br')
  const operator = await staff('mnt-edicao-op@example.gov.br')
  const created = await post('/maintenance/requests', requester, maintenanceBody())
  const path = `/maintenance/requests/${created.body.id}`

  assert.equal((await patch(path, requester, { descricao: 'Sem permissão' })).status, 403)
  assert.equal((await patch(path, operator, { descricao: 'Duas lâmpadas queimadas' })).status, 200)

  const detail = await call(path, { session: requester })
  assert.equal(detail.body.request.description, 'Duas lâmpadas queimadas')
  const edit = detail.body.history.find((entry: { action: string }) => entry.action === 'editada')
  assert.deepEqual(edit.details.campos, ['descricao'])

  assert.equal((await post(`${path}/cancel`, requester, { motivo: 'Sem permissão' })).status, 403)
  assert.equal((await post(`${path}/cancel`, operator, {})).status, 400)
  assert.equal((await post(`${path}/cancel`, operator, { motivo: 'Resolvido' })).body.status, 'cancelado')
  const cancelled = await call(path, { session: requester })
  assert.equal(cancelled.body.request.cancelReason, 'Resolvido')
})

test('solicitante vê só o que é dele; identidade e setor nunca vêm do corpo', async () => {
  const first = await createUser('dono@example.gov.br', 'requester', 'Protocolo')
  const second = await createUser('outro@example.gov.br', 'requester', 'Protocolo')
  const created = await post(
    '/maintenance/requests',
    first,
    maintenanceBody({
      solicitanteId: second.id,
      solicitante_id: second.id,
      status: 'concluido',
      setor_nome: 'Forjado',
    }),
  )
  const path = `/maintenance/requests/${created.body.id}`

  const detail = await call(path, { session: first })
  assert.equal(detail.body.request.requester.id, first.id)
  assert.equal(detail.body.request.status, 'aguardando_agendamento')
  assert.equal(detail.body.request.sector, 'Protocolo')

  // Sem acesso: 404, para não revelar que existe.
  assert.equal((await call(path, { session: second })).status, 404)
  const others = await call('/maintenance/requests', { session: second })
  assert.equal(others.body.requests.length, 0)
  const mine = await call('/maintenance/requests', { session: first })
  assert.equal(mine.body.total, 1)

  // A identificação de outro módulo não abre o recurso.
  assert.equal((await call(`/fleet/requests/${created.body.id}`, { session: first })).status, 404)
})

test('abrir em nome de outro setor exige equipe SLM e concessão, mesmo para administrador', async () => {
  const body = maintenanceBody({ setorId: options['CPC'] })

  const requester = await createUser('nome-solicitante@example.gov.br', 'requester', 'Protocolo')
  assert.equal((await post('/maintenance/requests', requester, body)).status, 403)
  assert.equal(
    (await call('/operations/capabilities', { session: requester })).body.canActOnBehalf,
    false,
  )

  const withoutGrant = await staff('nome-sem@example.gov.br', [], 'Protocolo')
  assert.equal((await post('/maintenance/requests', withoutGrant, body)).status, 403)

  // Administrador fora da SLM também não, e o setor dele próprio continua aceito.
  assert.equal((await post('/maintenance/requests', admin, body)).status, 403)
  assert.equal((await post('/maintenance/requests', admin, maintenanceBody())).status, 201)

  const allowed = await staff('nome-com@example.gov.br', ['requests:create_on_behalf'], 'Protocolo')
  assert.equal(
    (await call('/operations/capabilities', { session: allowed })).body.canActOnBehalf,
    true,
  )
  const created = await post('/maintenance/requests', allowed, body)
  assert.equal(created.status, 201, created.text)

  const detail = await call(`/maintenance/requests/${created.body.id}`, { session: allowed })
  assert.equal(detail.body.request.onBehalf, true)
  assert.equal(detail.body.request.sector, 'CPC')
  assert.equal(detail.body.request.sectorId, options['CPC'])
  assert.equal(detail.body.request.openedBy, 'Pessoa nome-com')
})

test('agendar: Solicitante nunca; Operador SLM da equipe pelo perfil; Administrador só na equipe SLM', async () => {
  const requester = await createUser('ag-solicitante@example.gov.br')
  // Operador SLM com o agendamento retirado individualmente.
  const operatorWithout = await staff('ag-sem@example.gov.br', [], 'CPC', ['requests:schedule'])
  const created = await post('/maintenance/requests', requester, maintenanceBody())
  const path = `/maintenance/requests/${created.body.id}/schedule`
  const body = { dataAgendada: '2027-03-01T13:00:00.000Z' }

  assert.equal((await post(path, requester, body)).status, 403)
  assert.equal((await post(path, operatorWithout, body)).status, 403)
  // Responsável precisa ser elegível. Quem agenda é da SLM, pelo perfil, sem concessão (P-08).
  const scheduler = await staff('ag-agendador@example.gov.br')
  assert.equal((await post(path, scheduler, { ...body, responsavelId: requester.id })).status, 400)
  assert.equal((await post(path, scheduler, { ...body, responsavelId: operatorWithout.id })).status, 200)

  const operatorRevoked = await staff('ag-revogada@example.gov.br')
  await setAccess(operatorRevoked.id, { role: 'slm_operator', slmMember: true, deniedPermissions: ['requests:schedule'] })
  assert.equal(
    (await post(path, operatorRevoked, { ...body, comentario: 'Novo horário' })).status,
    403,
  )

  // P-08: Administrador fora da equipe SLM não agenda, e a recusa não altera a solicitação.
  const outsider = await createUser('ag-admin-externo@example.gov.br')
  assert.equal((await setAccess(outsider.id, { role: 'administrator' })).status, 200)
  const external = await signIn('ag-admin-externo@example.gov.br')
  const before = await call(`/maintenance/requests/${created.body.id}`, { session: admin })
  assert.equal((await post(path, external, { ...body, comentario: 'Tentativa externa' })).status, 403)
  assert.equal((await post(path, external, { dataAgendada: '2027-04-01T13:00:00.000Z' })).status, 403)
  const after = await call(`/maintenance/requests/${created.body.id}`, { session: admin })
  assert.equal(JSON.stringify(after.body.request), JSON.stringify(before.body.request), 'nada muda')
  // A tentativa recusada fica na auditoria: quem, qual operação, qual registro e quando.
  const denied = await pool.query<{ operation: string; at: Date }>(
    `SELECT details->>'operation' AS operation, occurred_at AS at FROM public.auth_audit_events
      WHERE action = 'access.denied' AND result = 'denied' AND actor_user_id = $1 AND target_resource_id = $2`,
    [external.id, created.body.id],
  )
  assert.equal(denied.rows.length, 2)
  assert.equal(denied.rows[0].operation, 'maintenance.schedule')
  assert.ok(denied.rows[0].at instanceof Date)

  const assignees = await call('/operations/assignees', { session: operatorWithout })
  assert.ok(assignees.body.assignees.some((item: { id: string }) => item.id === scheduler.id))
  assert.equal(assignees.body.assignees.some((item: { id: string }) => item.id === requester.id), false)
  assert.equal(JSON.stringify(assignees.body).includes('@'), false)
})

test('frota: solicitação, execução real, ocorrências, atrasos e conclusão', async () => {
  const requester = await createUser('frota-solicitante@example.gov.br')
  const operator = await staff('frota-op@example.gov.br', ['requests:schedule'])

  assert.equal((await post('/fleet/requests', requester, fleetBody({ origem: '' }))).status, 400)
  const created = await post('/fleet/requests', requester, fleetBody())
  assert.equal(created.status, 201, created.text)
  const path = `/fleet/requests/${created.body.id}`

  assert.equal(
    (await post(`${path}/occurrences`, operator, { tipo: 'ocorrencia', descricao: 'Antes' })).status,
    409,
  )

  await post(`${path}/schedule`, operator, { dataAgendada: '2027-03-10T13:00:00.000Z' })
  const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  assert.equal(
    (await post(`${path}/start`, operator, {
      inicioReal: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })).status,
    400,
    'início no futuro',
  )
  assert.equal((await post(`${path}/start`, operator, { inicioReal: startedAt })).status, 200)

  assert.equal(
    (await post(`${path}/occurrences`, requester, { tipo: 'ocorrencia', descricao: 'Tentativa' })).status,
    403,
  )
  assert.equal((await post(`${path}/occurrences`, operator, { tipo: 'atraso', descricao: 'Trânsito' })).status, 400)
  assert.equal(
    (await post(`${path}/occurrences`, operator, { tipo: 'atraso', descricao: 'Trânsito', atrasoMinutos: 25 })).status,
    201,
  )
  assert.equal(
    (await post(`${path}/occurrences`, operator, { tipo: 'ocorrencia', descricao: 'Pneu furado' })).status,
    201,
  )

  assert.equal(
    (await post(`${path}/complete`, operator, {
      fimReal: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    })).status,
    400,
    'término antes do início',
  )
  const finishedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  assert.equal((await post(`${path}/complete`, operator, { fimReal: finishedAt })).body.status, 'concluido')

  const detail = await call(path, { session: requester })
  assert.equal(detail.body.request.details.origem, 'Sede')
  assert.equal(detail.body.request.startedAt, startedAt)
  assert.equal(detail.body.request.finishedAt, finishedAt)
  assert.deepEqual(
    detail.body.occurrences.map((item: { type: string; delayMinutes: number | null }) => [item.type, item.delayMinutes]),
    [['atraso', 25], ['ocorrencia', null]],
  )
})

test('agenda: usa os agendamentos dos módulos, sem Passagens e conforme a permissão', async () => {
  const operator = await staff('agenda-op@example.gov.br', ['requests:schedule'])
  const requester = await createUser('agenda-solicitante@example.gov.br')

  const maintenance = await post('/maintenance/requests', requester, maintenanceBody())
  const fleet = await post('/fleet/requests', requester, fleetBody())
  const unscheduled = await post('/fleet/requests', requester, fleetBody())
  await post(`/maintenance/requests/${maintenance.body.id}/schedule`, operator, {
    dataAgendada: '2031-06-10T13:00:00.000Z',
  })
  await post(`/fleet/requests/${fleet.body.id}/schedule`, operator, {
    motivoCodigo: 'conflito_agenda',
    dataAgendada: '2031-06-11T13:00:00.000Z',
  })

  const range = 'from=2031-06-01T00:00:00.000Z&to=2031-07-01T00:00:00.000Z'
  const events = await call(`/calendar/events?${range}`, { session: operator })
  assert.deepEqual(
    events.body.events.map((event: { id: string }) => event.id),
    [maintenance.body.id, fleet.body.id],
  )
  assert.equal(events.body.events.some((event: { id: string }) => event.id === unscheduled.body.id), false)

  const onlyFleet = await call(`/calendar/events?${range}&modules=fleet`, { session: operator })
  assert.deepEqual(onlyFleet.body.events.map((event: { module: string }) => event.module), ['fleet'])

  assert.equal((await call(`/calendar/events?${range}`, { session: requester })).status, 403)
  assert.equal((await call('/calendar/events', { session: operator })).status, 400)

  // Fora do período não aparece, e reagendar move o mesmo registro.
  await post(`/fleet/requests/${fleet.body.id}/schedule`, operator, {
    motivoCodigo: 'conflito_agenda',
    dataAgendada: '2031-08-01T13:00:00.000Z',
    comentario: 'Adiado',
  })
  const moved = await call(`/calendar/events?${range}`, { session: operator })
  assert.equal(moved.body.events.length, 1)
})

test('passagens: CPF cifrado no banco, mascarado na API e completo só com concessão auditada', async () => {
  const requester = await createUser('voo-solicitante@example.gov.br')
  const created = await post('/flights/requests', requester, flightBody({ cpf: fictionalCpf }))
  assert.equal(created.status, 201, created.text)
  const path = `/flights/requests/${created.body.id}`

  const stored = await pool.query(
    `SELECT to_jsonb(p) AS passenger FROM public.flight_request_passengers p WHERE request_id = $1`,
    [created.body.id],
  )
  assert.equal(stored.rows[0].passenger.cpf, null)
  assert.ok(!JSON.stringify(stored.rows[0].passenger).includes(fictionalCpf))

  const request = await pool.query(
    `SELECT to_jsonb(r) AS row FROM public.service_requests r WHERE id = $1`,
    [created.body.id],
  )
  assert.ok(!JSON.stringify(request.rows[0].row).includes(fictionalCpf), 'CPF em service_requests')

  const history = await pool.query(
    `SELECT to_jsonb(h) AS row FROM public.request_history h WHERE request_id = $1`,
    [created.body.id],
  )
  assert.ok(!JSON.stringify(history.rows).includes(fictionalCpf), 'CPF no histórico')

  const detail = await call(path, { session: requester })
  assert.equal(detail.body.request.status, 'em_cotacao')
  assert.ok(!detail.text.includes(fictionalCpf))
  const passenger = detail.body.passengers[0]
  assert.equal(passenger.cpfMasked, '***.000.001-**')

  const cpfPath = `/flights/passengers/${passenger.id}/cpf`
  // Solicitante, operador sem concessão e administrador fora da SLM: recusados e auditados.
  assert.equal((await call(cpfPath, { session: requester })).status, 403)
  const operatorWithout = await staff('voo-sem@example.gov.br')
  assert.equal((await call(cpfPath, { session: operatorWithout })).status, 403)
  assert.equal((await call(cpfPath, { session: admin })).status, 403)
  assert.equal(
    (await setAccess(requester.id, { role: 'requester', grantedPermissions: ['flights:cpf:read'] })).status,
    400,
    'Solicitante não recebe a permissão',
  )

  const authorized = await staff('voo-com@example.gov.br', ['flights:cpf:read'])
  const read = await call(cpfPath, { session: authorized })
  assert.equal(read.status, 200, read.text)
  assert.equal(read.body.cpf, fictionalCpf)

  const events = await auditActions(passenger.id)
  assert.deepEqual(
    events.map((event) => event.action),
    ['flights.cpf_read_denied', 'flights.cpf_read_denied', 'flights.cpf_read_denied', 'flights.cpf_read'],
  )
  const auditText = await pool.query(
    `SELECT details::text AS details FROM public.auth_audit_events WHERE target_resource_id = $1`,
    [passenger.id],
  )
  assert.ok(!JSON.stringify(auditText.rows).includes(fictionalCpf))

  // Saída da SLM revoga a consulta, e voltar não restaura.
  await setAccess(authorized.id, { role: 'slm_operator', slmMember: false }).catch(() => {})
  await setAccess(authorized.id, { role: 'requester' })
  assert.equal((await call(cpfPath, { session: authorized })).status, 403)
  await setAccess(authorized.id, { role: 'slm_operator', slmMember: true })
  assert.equal((await call(cpfPath, { session: authorized })).status, 403)
})

test('passagens: limite de dez passageiros, somente volta, status e edição da lista', async () => {
  const requester = await createUser('voo-fluxo@example.gov.br')
  const operator = await staff('voo-fluxo-op@example.gov.br')

  const eleven = Array.from({ length: 11 }, () => ({ nome: 'Pessoa', cpf: fictionalCpf }))
  assert.equal(
    (await post('/flights/requests', requester, flightBody({ passageiros: eleven }))).status,
    400,
  )

  const returnOnly = await post(
    '/flights/requests',
    requester,
    flightBody({ tipoViagem: 'somente_volta', ida: undefined }),
  )
  assert.equal(returnOnly.status, 201, returnOnly.text)
  const onlyDetail = await call(`/flights/requests/${returnOnly.body.id}`, { session: requester })
  assert.equal(onlyDetail.body.request.details.ida, null)
  assert.equal(onlyDetail.body.request.title, 'BSB → GRU')

  const created = await post(
    '/flights/requests',
    requester,
    flightBody({
      passageiros: [
        { nome: 'Primeira Fictícia', cpf: fictionalCpf },
        { nome: 'Segunda Fictícia', cpf: secondFictionalCpf },
      ],
    }),
  )
  const path = `/flights/requests/${created.body.id}`

  // Passagens não têm agendamento nem atalho de status.
  assert.equal((await post(`${path}/advance`, requester, { status: 'aguardando_aprovacao' })).status, 403)
  assert.equal((await post(`${path}/advance`, operator, { status: 'emitida' })).status, 409)

  const before = await call(path, { session: operator })
  const [first] = before.body.passengers

  // Mantém a primeira sem reenviar o CPF, remove a segunda e inclui outra.
  const replaced = await put(`${path}/passengers`, operator, {
    passageiros: [
      { id: first.id, nome: 'Primeira Corrigida' },
      { nome: 'Terceira Fictícia', cpf: thirdFictionalCpf },
    ],
  })
  assert.equal(replaced.status, 200, replaced.text)
  assert.deepEqual(
    replaced.body.passengers.map((item: { name: string; cpfMasked: string }) => [item.name, item.cpfMasked]),
    [['Primeira Corrigida', '***.000.001-**'], ['Terceira Fictícia', '***.000.003-**']],
  )
  assert.equal(
    (await put(`${path}/passengers`, operator, {
      passageiros: [{ id: '00000000-0000-4000-8000-000000000000', nome: 'Outra pessoa' }],
    })).status,
    404,
  )

  for (const status of ['aguardando_aprovacao', 'em_emissao', 'emitida']) {
    assert.equal((await post(`${path}/advance`, operator, { status })).body.status, status)
  }
  assert.equal((await post(`${path}/advance`, operator, { status: 'emitida' })).status, 409)
  assert.equal((await post(`${path}/cancel`, operator, { motivo: 'Tarde demais' })).status, 409)
  assert.equal(
    (await put(`${path}/passengers`, operator, { passageiros: [{ nome: 'Nova', cpf: fictionalCpf }] })).status,
    409,
  )

  const final = await call(path, { session: requester })
  assert.equal(final.body.request.status, 'emitida')
  assert.deepEqual(
    final.body.history.map((entry: { action: string }) => entry.action),
    ['criada', 'passageiros_alterados', 'status_alterado', 'status_alterado', 'status_alterado'],
  )
})

test('sem a chave de proteção, nenhum passageiro é gravado', async () => {
  const requester = await createUser('voo-sem-chave@example.gov.br')
  const key = process.env.PASSENGER_DATA_KEY
  delete process.env.PASSENGER_DATA_KEY
  try {
    const before = await pool.query(`SELECT count(*)::int AS total FROM public.service_requests`)
    const refused = await post('/flights/requests', requester, flightBody())
    assert.equal(refused.status, 503)
    assert.equal(refused.body.code, 'CPF_PROTECTION_UNAVAILABLE')
    const after = await pool.query(`SELECT count(*)::int AS total FROM public.service_requests`)
    assert.equal(after.rows[0].total, before.rows[0].total)
  } finally {
    process.env.PASSENGER_DATA_KEY = key
  }
})

test('registros de status antigo aparecem traduzidos e seguem o fluxo', async () => {
  const requester = await createUser('legado@example.gov.br')
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO public.service_requests (tipo, solicitante_id, titulo)
     VALUES ('manutencao', $1, 'Registro antigo') RETURNING id::text AS id`,
    [requester.id],
  )
  const path = `/maintenance/requests/${rows[0].id}`

  const detail = await call(path, { session: requester })
  assert.equal(detail.body.request.status, 'aguardando_agendamento')

  const filtered = await call('/maintenance/requests?status=aguardando_agendamento', { session: requester })
  assert.ok(filtered.body.requests.some((item: { id: string }) => item.id === rows[0].id))

  const scheduler = await staff('legado-agendador@example.gov.br', ['requests:schedule'])
  assert.equal(
    (await post(`${path}/schedule`, scheduler, { dataAgendada: '2027-05-01T12:00:00.000Z' })).body.status,
    'agendado',
  )
})

test('almoxarifado: pedido interno, pedido externo, central e permissões', async () => {
  const requester = await createUser('alm-solicitante@example.gov.br')
  const other = await createUser('alm-outro@example.gov.br')
  const manager = await staff('alm-gestora@example.gov.br', ['warehouse:manage'])
  // Operador SLM com a gestão do Almoxarifado retirada individualmente.
  const operator = await staff('alm-operadora@example.gov.br', [], 'CPC', ['warehouse:manage'])

  // Catálogo só com warehouse:manage, e unidade padronizada.
  assert.equal((await post('/warehouse/materials', operator, { name: 'X' })).status, 403)
  assert.equal((await post('/warehouse/materials', manager, { name: 'Sem unidade' })).status, 400)
  const paper = await post('/warehouse/materials', manager, {
    name: 'Papel A4',
    code: 'ALM-1',
    unitId: options['Unidade'],
    categoryId: options['Papelaria'],
  })
  assert.equal(paper.status, 201, paper.text)
  const pens = await post('/warehouse/materials', manager, { name: 'Caneta', unitId: options['Unidade'] })
  assert.equal((await post('/warehouse/materials', manager, { name: ' papel a4 ', unitId: options['Unidade'] })).status, 409)

  const internal = await post('/warehouse/requests', requester, {
    note: 'Para o protocolo',
    solicitanteId: other.id,
    items: [
      { materialId: paper.body.id, requested: 5, fulfilled: 5 },
      { materialId: pens.body.id, requested: 10 },
    ],
  })
  assert.equal(internal.status, 201, internal.text)
  assert.equal((await post('/warehouse/requests', requester, { items: [] })).status, 400)
  assert.equal(
    (await post('/warehouse/requests', requester, {
      items: [{ materialId: paper.body.id, requested: 1 }, { materialId: paper.body.id, requested: 2 }],
    })).status,
    400,
  )

  const internalPath = `/warehouse/requests/${internal.body.id}`
  const detail = await call(internalPath, { session: requester })
  assert.equal(detail.body.request.origin, 'interna')
  assert.equal(detail.body.request.requesterId, requester.id)
  assert.equal(detail.body.request.sector, 'Protocolo')
  // Solicitante não informa quantidade atendida.
  assert.ok(detail.body.items.every((item: { fulfilled: number }) => item.fulfilled === 0))

  // Quem pede vê só o próprio; não mexe no status nem registra pedido externo.
  assert.equal((await call(internalPath, { session: other })).status, 404)
  assert.equal((await post(`${internalPath}/status`, requester, { status: 'em_analise' })).status, 403)
  assert.equal(
    (await post('/warehouse/external-requests', requester, { sectorId: options['CPC'], items: [] })).status,
    403,
  )

  const external = await post('/warehouse/external-requests', manager, {
    externalReference: 'GOV-2027-0001',
    externalRequester: 'Pessoa do Setor',
    sectorId: options['CPC'],
    items: [{ materialId: paper.body.id, requested: 3 }],
  })
  assert.equal(external.status, 201, external.text)

  const central = await call('/warehouse/requests', { session: manager })
  const origins = central.body.requests.map((item: { origin: string }) => item.origin)
  assert.ok(origins.includes('interna') && origins.includes('governamental'))

  const filtered = await call('/warehouse/requests?origin=governamental&search=GOV-2027', { session: manager })
  assert.deepEqual(filtered.body.requests.map((item: { id: string }) => item.id), [external.body.id])
  const own = await call('/warehouse/requests', { session: requester })
  assert.deepEqual(own.body.requests.map((item: { id: string }) => item.id), [internal.body.id])

  // Editar a cópia local: a referência fica registrada no histórico local.
  const externalPath = `/warehouse/requests/${external.body.id}`
  assert.equal(
    (await patch(externalPath, manager, {
      externalReference: 'GOV-2027-0002',
      externalRequester: 'Pessoa do Setor',
      note: 'Conferido',
    })).status,
    200,
  )
  const edited = await call(externalPath, { session: manager })
  assert.equal(edited.body.request.externalReference, 'GOV-2027-0002')
  assert.deepEqual(edited.body.history.at(-1).details.campos, ['observacao', 'referenciaExterna'])

  // Pedido interno não recebe referência externa.
  await patch(internalPath, manager, { externalReference: 'NAO-VALE', note: 'Observação' })
  assert.equal((await call(internalPath, { session: manager })).body.request.externalReference, null)

  // Status coerente com as quantidades.
  assert.equal((await post(`${internalPath}/deliver`, manager, { receivedBy: 'Pessoa' })).status, 409)
  assert.equal((await post(`${internalPath}/status`, manager, { status: 'atendido' })).status, 409)
  assert.equal((await post(`${internalPath}/status`, manager, { status: 'em_analise' })).status, 200)
  assert.equal((await post(`${internalPath}/status`, manager, { status: 'rejeitado' })).status, 400)

  assert.equal(
    (await put(`${internalPath}/items`, manager, {
      items: [{ materialId: paper.body.id, requested: 5, fulfilled: 6 }],
    })).status,
    400,
    'atendida maior que solicitada',
  )
  assert.equal(
    (await put(`${internalPath}/items`, manager, {
      items: [
        { materialId: paper.body.id, requested: 5, fulfilled: 5 },
        { materialId: pens.body.id, requested: 10, fulfilled: 4 },
      ],
    })).status,
    200,
  )
  assert.equal((await post(`${internalPath}/status`, manager, { status: 'atendido' })).status, 409)
  assert.equal((await post(`${internalPath}/status`, manager, { status: 'atendido_parcial' })).status, 200)

  assert.equal((await post(`${internalPath}/deliver`, manager, {})).status, 400)
  assert.equal(
    (await post(`${internalPath}/deliver`, manager, { receivedBy: 'Pessoa Recebedora' })).status,
    200,
  )
  assert.equal((await post(`${internalPath}/status`, manager, { status: 'cancelado', comment: 'Tarde' })).status, 409)
  assert.equal((await patch(internalPath, manager, { note: 'Tarde' })).status, 409)

  const delivered = await call(internalPath, { session: requester })
  assert.equal(delivered.body.request.status, 'entregue')
  assert.equal(delivered.body.request.receivedBy, 'Pessoa Recebedora')
  assert.equal(delivered.body.request.deliveredBy, 'Pessoa alm-gestora')
  assert.equal(delivered.body.request.attendedBy, 'Pessoa alm-gestora')
  assert.deepEqual(
    delivered.body.history.map((entry: { action: string }) => entry.action),
    ['criado', 'editado', 'status_alterado', 'itens_alterados', 'status_alterado', 'entregue'],
  )
  assert.deepEqual(
    (await auditActions(internal.body.id)).map((event) => event.action),
    [
      'warehouse.request_created',
      'warehouse.request_updated',
      'warehouse.status_changed',
      'warehouse.request_updated',
      'warehouse.status_changed',
      'warehouse.delivered',
    ],
  )

  // Material inativo: some do catálogo de quem pede, mas continua nos pedidos antigos.
  assert.equal(
    (await patch(`/warehouse/materials/${pens.body.id}`, manager, {
      name: 'Caneta azul',
      unitId: options['Unidade'],
      active: false,
    })).status,
    200,
  )
  const available = await call('/warehouse/materials', { session: requester })
  assert.equal(available.body.materials.some((item: { id: string }) => item.id === pens.body.id), false)
  const withInactive = await call('/warehouse/materials?inactive=true', { session: manager })
  assert.equal(withInactive.body.materials.some((item: { id: string }) => item.id === pens.body.id), true)
  const ignored = await call('/warehouse/materials?inactive=true', { session: requester })
  assert.equal(ignored.body.materials.some((item: { id: string }) => item.id === pens.body.id), false)
  assert.equal(
    (await post('/warehouse/requests', requester, { items: [{ materialId: pens.body.id, requested: 1 }] })).status,
    400,
  )
  const old = await call(internalPath, { session: requester })
  assert.ok(old.body.items.some((item: { material: string }) => item.material === 'Caneta'))
})

test('conferência de inventário: quantidades, diferença, situação e encerramento', async () => {
  const manager = await staff('inv-gestora@example.gov.br', ['warehouse:manage'])
  const requester = await createUser('inv-solicitante@example.gov.br')
  const first = await post('/warehouse/materials', manager, { name: 'Grampo', unitId: options['Unidade'] })
  const second = await post('/warehouse/materials', manager, { name: 'Clipe', unitId: options['Unidade'] })

  assert.equal((await call('/warehouse/inventory-checks', { session: requester })).status, 403)

  const created = await post('/warehouse/inventory-checks', manager, {
    title: 'Conferência de teste',
    referenceDate: '2027-01-31',
    items: [
      { materialId: first.body.id, governmentQuantity: 10 },
      { materialId: second.body.id, governmentQuantity: 5 },
    ],
  })
  assert.equal(created.status, 201, created.text)
  const path = `/warehouse/inventory-checks/${created.body.id}`

  assert.equal((await post(`${path}/close`, manager, { outcome: 'concluida' })).status, 409)

  await put(`${path}/items/${first.body.id}`, manager, { governmentQuantity: 10, countedQuantity: 10 })
  await put(`${path}/items/${second.body.id}`, manager, {
    governmentQuantity: 5,
    countedQuantity: 3,
    note: 'Faltam duas caixas',
  })

  const check = (await call(path, { session: manager })).body.check
  const byName = Object.fromEntries(
    check.items.map((item: { material: string }) => [item.material, item]),
  )
  assert.equal(byName['Grampo'].situation, 'confere')
  assert.equal(byName['Grampo'].difference, 0)
  assert.equal(byName['Clipe'].situation, 'divergente')
  assert.equal(byName['Clipe'].difference, -2)

  assert.equal((await post(`${path}/close`, manager, { outcome: 'cancelada' })).status, 400)
  assert.equal((await post(`${path}/close`, manager, { outcome: 'concluida' })).status, 200)
  assert.equal(
    (await put(`${path}/items/${first.body.id}`, manager, { governmentQuantity: 1, countedQuantity: 1 })).status,
    409,
  )

  const list = await call('/warehouse/inventory-checks', { session: manager })
  const listed = list.body.checks.find((item: { id: string }) => item.id === created.body.id)
  assert.equal(listed.status, 'concluida')
  assert.equal(listed.divergent, 1)
  assert.equal(listed.counted, 2)
  assert.equal(listed.closedBy, 'Pessoa inv-gestora')

  // A tabela de materiais não muda: o sistema não afirma controlar o estoque oficial.
  const stock = await pool.query(`SELECT estoque_atual FROM public.materials WHERE id = $1`, [second.body.id])
  assert.equal(Number(stock.rows[0].estoque_atual), 0)
})

test('painel e relatórios: dados reais, no alcance de cada pessoa', async () => {
  const requester = await createUser('painel-solicitante@example.gov.br', 'requester', 'Protocolo')
  const other = await createUser('painel-outro@example.gov.br', 'requester', 'Protocolo')
  const operator = await staff('painel-op@example.gov.br')

  await post('/maintenance/requests', requester, maintenanceBody())
  await post('/fleet/requests', other, fleetBody())
  await post('/flights/requests', other, flightBody())

  const own = await call('/dashboard/summary', { session: requester })
  assert.equal(own.status, 200, own.text)
  assert.equal(own.body.totals.requests, 1)
  assert.equal(own.body.totals.awaitingSchedule, 1)
  assert.equal(own.body.byModule.maintenance.aguardando_agendamento, 1)
  assert.equal(own.body.recent.length, 1)
  assert.equal(own.body.recent[0].requester, 'Pessoa painel-solicitante')
  // A série por mês segue o mesmo alcance: só a solicitação da própria pessoa.
  assert.equal(
    own.body.byPeriod.reduce((total: number, row: { total: number }) => total + row.total, 0),
    1,
  )

  const all = await call('/dashboard/summary', { session: operator })
  assert.ok(all.body.totals.requests >= 3)
  assert.ok(all.body.byModule.flights.em_cotacao >= 1)

  const onlyFleet = await call('/dashboard/summary?module=fleet', { session: operator })
  assert.deepEqual(Object.keys(onlyFleet.body.byModule), ['fleet'])
  assert.equal(onlyFleet.body.warehouse, null)

  const future = await call('/dashboard/summary?from=2099-01-01', { session: operator })
  assert.equal(future.body.totals.requests, 0)
  assert.equal((await call('/dashboard/summary?from=ontem', { session: operator })).status, 400)

  // Sem permissão de um módulo, os números dele não vêm.
  const limited = await createUser('painel-limitado@example.gov.br', 'requester', 'Protocolo')
  await setAccess(limited.id, { role: 'requester', deniedPermissions: ['maintenance:read'] })
  await post('/maintenance/requests', limited, maintenanceBody())
  const withoutModule = await call('/dashboard/summary', { session: limited })
  assert.equal('maintenance' in withoutModule.body.byModule, false)
  assert.equal(withoutModule.body.recent.length, 0)

  assert.equal((await call('/reports/summary', { session: requester })).status, 403)
  const report = await call('/reports/summary', { session: operator })
  assert.equal(report.status, 200, report.text)
  assert.ok(report.body.byPeriod.length >= 1)
  assert.ok(report.body.bySector.some((row: { sector: string }) => row.sector === 'Protocolo'))
  assert.ok(Array.isArray(report.body.materials))
})

test('histórico e auditoria não podem ser alterados nem apagados', async () => {
  const requester = await createUser('imutavel@example.gov.br')
  const created = await post('/maintenance/requests', requester, maintenanceBody())

  await assert.rejects(pool.query(`UPDATE public.request_history SET acao = 'x' WHERE request_id = $1`, [created.body.id]))
  await assert.rejects(pool.query(`DELETE FROM public.request_history WHERE request_id = $1`, [created.body.id]))
  await assert.rejects(pool.query(`UPDATE public.auth_audit_events SET action = 'x' WHERE target_resource_id = $1`, [created.body.id]))
  await assert.rejects(pool.query(`DELETE FROM public.auth_audit_events WHERE target_resource_id = $1`, [created.body.id]))

  // Excluir uma conta só anula a referência: o evento permanece.
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status)
     VALUES ('Para excluir', 'para-excluir@example.gov.br', 'TI', 'x', 'pending') RETURNING id::text AS id`,
  )
  await pool.query(
    `INSERT INTO public.auth_audit_events (actor_user_id, action, result) VALUES ($1, 'teste.exclusao', 'success')`,
    [rows[0].id],
  )
  await pool.query(`DELETE FROM public.auth_users WHERE id = $1`, [rows[0].id])
  const kept = await pool.query(`SELECT actor_user_id FROM public.auth_audit_events WHERE action = 'teste.exclusao'`)
  assert.equal(kept.rows.length, 1)
  assert.equal(kept.rows[0].actor_user_id, null)

  // A API não oferece escrita em auditoria.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await call('/admin/audit', { method, session: admin, body: {} })).status, 404)
  }
})

test('auditoria: filtros por ação, resultado, pessoa e período', async () => {
  const requester = await createUser('filtro-auditoria@example.gov.br')
  await post('/maintenance/requests', requester, maintenanceBody())

  const byAction = await call('/admin/audit?action=request', { session: admin })
  assert.ok(byAction.body.events.length > 0)
  assert.ok(byAction.body.events.every((event: { action: string }) => event.action.startsWith('request.')))

  const byPerson = await call('/admin/audit?person=filtro-auditoria', { session: admin })
  assert.ok(byPerson.body.events.length > 0)

  const wildcard = await call(`/admin/audit?person=${encodeURIComponent('%')}`, { session: admin })
  assert.equal(wildcard.body.events.length, 0)

  const byResult = await call('/admin/audit?result=denied', { session: admin })
  assert.ok(byResult.body.events.every((event: { result: string }) => event.result === 'denied'))

  const future = await call('/admin/audit?from=2099-01-01', { session: admin })
  assert.equal(future.body.events.length, 0)
})

test('sessões: consultar, sair dos outros dispositivos e encerramento administrativo', async () => {
  const user = await createUser('sessoes@example.gov.br')
  const second = await signIn('sessoes@example.gov.br')

  const list = await call('/auth/sessions', { session: user })
  assert.equal(list.body.sessions.length, 2)
  assert.equal(list.body.sessions.filter((item: { current: boolean }) => item.current).length, 1)
  assert.ok(!list.text.includes('hash'))

  const revoked = await post('/auth/sessions/revoke-others', user)
  assert.equal(revoked.body.total, 1)
  assert.equal((await call('/auth/me', { session: second })).status, 401)
  assert.equal((await call('/auth/me', { session: user })).status, 200)

  // Exige CSRF, como toda escrita.
  const withoutCsrf = await fetch(`${baseUrl}/api/auth/sessions/revoke-others`, {
    method: 'POST',
    headers: { cookie: user.cookie },
  })
  assert.equal(withoutCsrf.status, 403)

  assert.equal((await post(`/admin/users/${user.id}/sessions/revoke`, user)).status, 403)
  assert.equal((await post(`/admin/users/${admin.id}/sessions/revoke`, admin)).status, 403)

  const revokedByAdmin = await post(`/admin/users/${user.id}/sessions/revoke`, admin)
  assert.equal(revokedByAdmin.body.total, 1)
  assert.equal((await call('/auth/me', { session: user })).status, 401)
  const events = await pool.query(
    `SELECT actor_user_id::text AS actor FROM public.auth_audit_events
      WHERE action = 'auth.sessions_revoked' AND target_user_id = $1 ORDER BY id DESC LIMIT 1`,
    [user.id],
  )
  assert.equal(events.rows[0].actor, admin.id)

  // Quem administra usuários sem ser Administrador não atinge administradores.
  const manager = await createUser('sessoes-gestora@example.gov.br')
  await setAccess(manager.id, { role: 'requester', grantedPermissions: ['users:manage'] })
  assert.equal((await post(`/admin/users/${admin.id}/sessions/revoke`, manager)).status, 403)
})

test('recuperação por link: uso único, prazo e encerramento das sessões', async () => {
  const user = await createUser('link@example.gov.br')
  const token = generatePasswordRecoveryToken()
  await pool.query(
    `INSERT INTO public.password_recovery_codes (user_id, code_hash, expires_at)
     VALUES ($1, $2, now() + interval '10 minutes')`,
    [user.id, hashPasswordRecoveryToken(token)],
  )

  const reset = (value: string, newPassword: string) =>
    call('/auth/password-recovery/reset-link', {
      method: 'POST',
      body: { token: value, password: newPassword, passwordConfirmation: newPassword },
    })

  const newPassword = randomBytes(20).toString('hex')
  assert.equal((await reset('curto', newPassword)).status, 400)
  assert.equal((await reset(generatePasswordRecoveryToken(), newPassword)).status, 400)
  assert.equal((await reset(token, 'curta')).status, 400)

  const done = await reset(token, newPassword)
  assert.equal(done.status, 200, done.text)
  assert.equal((await call('/auth/me', { session: user })).status, 401)
  assert.equal((await reset(token, randomBytes(20).toString('hex'))).status, 400, 'uso único')

  const login = await call('/auth/login', {
    method: 'POST',
    body: { identifier: 'link@example.gov.br', password: newPassword },
  })
  assert.equal(login.status, 200)

  const expired = generatePasswordRecoveryToken()
  await pool.query(
    `INSERT INTO public.password_recovery_codes (user_id, code_hash, created_at, expires_at)
     VALUES ($1, $2, now() - interval '1 hour', now() - interval '30 minutes')`,
    [user.id, hashPasswordRecoveryToken(expired)],
  )
  assert.equal((await reset(expired, randomBytes(20).toString('hex'))).status, 400, 'expirado')
})

test('a migração 005 é revertida sem resíduos, e recusa a reversão se houver dados', async () => {
  // Com dados dos módulos, a reversão para e nada muda.
  await assert.rejects(pool.query(schema('005_operational_modules.rollback.sql')), /interrompida/)
  await pool.query('ROLLBACK')

  // Em um schema limpo: aplica, reverte e confere que a estrutura volta a ser a anterior.
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  for (const file of [
    '001_public_schema_snapshot.sql',
    '002_password_recovery.sql',
    '003_user_access.sql',
    '004_flight_passengers.sql',
  ]) {
    await pool.query(schema(file))
  }
  const snapshot = async () => {
    const { rows } = await pool.query(
      `SELECT 'col' AS kind, table_name || '.' || column_name || ':' || data_type || ':' || is_nullable AS name
         FROM information_schema.columns WHERE table_schema = 'public'
       UNION ALL
       SELECT 'con', conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid)
         FROM pg_constraint WHERE connamespace = 'public'::regnamespace
       UNION ALL
       SELECT 'idx', indexname FROM pg_indexes WHERE schemaname = 'public'
       UNION ALL
       SELECT 'trg', tgrelid::regclass::text || '.' || tgname
         FROM pg_trigger WHERE NOT tgisinternal
       UNION ALL
       SELECT 'fn', proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       ORDER BY 1, 2`,
    )
    return rows.map((row) => `${row.kind} ${row.name}`)
  }

  const original = await snapshot()
  await pool.query(schema('005_operational_modules.sql'))
  assert.notDeepEqual(await snapshot(), original)
  await pool.query(schema('005_operational_modules.rollback.sql'))
  assert.deepEqual(await snapshot(), original)

  // Migração interrompe se já houver CPF em texto na tabela de passageiros.
  const { rows: users } = await pool.query<{ id: string }>(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status)
     VALUES ('Reversão', 'reversao@example.gov.br', 'TI', 'x', 'pending') RETURNING id::text AS id`,
  )
  const { rows: requests } = await pool.query<{ id: string }>(
    `INSERT INTO public.service_requests (tipo, solicitante_id, titulo)
     VALUES ('passagem', $1, 'Viagem') RETURNING id::text AS id`,
    [users[0].id],
  )
  await pool.query(
    `INSERT INTO public.flight_request_passengers (request_id, full_name, cpf)
     VALUES ($1, 'Pessoa Fictícia', $2)`,
    [requests[0].id, fictionalCpf],
  )
  await assert.rejects(pool.query(schema('005_operational_modules.sql')), /interrompida/)
  await pool.query('ROLLBACK')
  await pool.query(`DELETE FROM public.flight_request_passengers`)
  await pool.query(schema('005_operational_modules.sql'))
  const privileges = await pool.query(
    `SELECT count(*)::int AS total FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity`,
  )
  assert.equal(privileges.rows[0].total, 0, 'toda tabela com RLS')
})
