import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'
import express from 'express'
import { Pool } from 'pg'
import app from '../app.js'
import { hashPassword } from '../auth/password.js'
import { isRestrictedPermission, permissionsForProfile } from '../auth/permissions.js'
import type { Permission } from '../auth/permissions.js'
import {
  canReadRequest,
  canScheduleRequest,
  resolveRequestOwnership,
} from '../auth/requestPolicy.js'
import type { RequestModule } from '../auth/requestPolicy.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requirePermission, requireSlmMember } from '../middleware/requirePermission.js'
import { routeAccessMap } from '../routes/routeAccessMap.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'

// Roda em um PostgreSQL descartável, com as migrações 003, 004 e 005 aplicadas.
// Ver backend/database/POSTGRES_INTEGRATION_TESTS.md.

// Nova a cada execução: nenhuma credencial de teste fica no repositório.
const password = randomBytes(24).toString('hex')
// Dígitos verificadores inválidos de propósito: não pode ser o CPF de ninguém.
const fullCpf = '11122233300'

let pool: Pool
let server: Server
let policyServer: Server
let baseUrl: string
let policyUrl: string
let adminId: string
const csrfTokens = new Map<string, string>()

type Session = { cookie: string; id: string }

async function call(
  path: string,
  options: { method?: string; body?: unknown; session?: Session; csrf?: boolean } = {},
) {
  const method = options.method ?? 'GET'
  const cookie = options.session?.cookie
  const token = cookie && options.csrf !== false && method !== 'GET'
    ? csrfTokens.get(cookie)
    : undefined
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
  // Rotas de planilha devolvem o arquivo (.xlsx), não JSON: o corpo fica vazio e o status vale.
  const isJson = (response.headers.get('content-type') ?? '').includes('json')
  const body = (isJson ? JSON.parse(text) : {}) as Record<string, any>
  if (setCookie && body.csrfToken) csrfTokens.set(setCookie, body.csrfToken)
  return { status: response.status, body, text, setCookie }
}

async function signIn(email: string): Promise<Session> {
  const result = await call('/auth/login', {
    method: 'POST',
    body: { identifier: email, password },
  })
  assert.equal(result.status, 200, `login de ${email}`)
  return { cookie: result.setCookie, id: result.body.user.id }
}

let admin: Session

/** Cria uma conta pelo fluxo real de cadastro e aprovação. */
async function createUser(
  email: string,
  role: 'requester' | 'slm_operator' | 'administrator' = 'requester',
  sector = 'Protocolo',
): Promise<Session> {
  // Este arquivo cria muitas contas. O limite em si é testado em apiSecurity.test.ts.
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
  const approved = await call(`/admin/registrations/${id}/approve`, {
    method: 'POST',
    session: admin,
    body: { role },
  })
  assert.equal(approved.status, 200)
  return signIn(email)
}

function setAccess(
  actor: Session,
  userId: string,
  access: {
    role?: string
    slmMember?: boolean
    grantedPermissions?: Permission[]
    deniedPermissions?: Permission[]
  },
) {
  return call(`/admin/users/${userId}/access`, {
    method: 'PUT',
    session: actor,
    body: {
      role: 'requester',
      slmMember: false,
      grantedPermissions: [],
      deniedPermissions: [],
      ...access,
    },
  })
}

async function auditFor(targetUserId: string) {
  const { rows } = await pool.query<{ action: string; actor: string | null }>(
    `SELECT action, actor_user_id::text AS actor FROM public.auth_audit_events
      WHERE target_user_id = $1 ORDER BY id`,
    [targetUserId],
  )
  return rows
}

async function createFlightRequest(requesterId: string) {
  const request = await pool.query<{ id: string }>(
    `INSERT INTO public.service_requests (tipo, solicitante_id, titulo)
     VALUES ('passagem', $1, 'Viagem de teste')
     RETURNING id::text AS id`,
    [requesterId],
  )
  const passenger = await pool.query<{ id: string }>(
    `INSERT INTO public.flight_request_passengers (request_id, full_name, cpf)
     VALUES ($1, 'Passageira de Teste', $2)
     RETURNING id::text AS id`,
    [request.rows[0].id, fullCpf],
  )
  return { requestId: request.rows[0].id, passengerId: passenger.rows[0].id }
}

// As rotas dos módulos virão em etapas seguintes. Aqui, as regras são exercidas pela
// mesma sessão e identidade reais, resolvidas pelo middleware da aplicação.
function policyRoute(path: string, body: Record<string, unknown>, cookie: string) {
  return fetch(`${policyUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
}

before(async () => {
  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  const setup = await pool.connect()
  for (const file of [
    '001_public_schema_snapshot.sql',
    '002_password_recovery.sql',
    '003_user_access.sql',
    '004_flight_passengers.sql',
    '005_operational_modules.sql',
    '006_integrations.sql',
    '007_operations_center.sql',
    '008_attachments.sql',
    '009_module_extensions.sql',
    '010_monitoring.sql',
    '011_delivery_forecast.sql',
    '012_operational_transparency.sql',
    '013_communications.sql',
    '014_demands.sql',
    '015_organizational_structure.sql',
    '016_driver_portal.sql',
    '017_driver_portal_settings.sql',
    '018_public_api_privileges.sql',
  ]) {
    await setup.query(
      readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8'),
    )
  }
  setup.release(true)
  resetAccessSchemaCacheForTests()

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO public.auth_users
      (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())
     RETURNING id::text AS id`,
    [await hashPassword(password)],
  )
  adminId = rows[0].id

  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const policyApp = express()
  policyApp.use(express.json())
  const identityOf = (response: express.Response) =>
    response.locals.authenticatedUser as AuthenticatedIdentity
  policyApp.post('/criar', requireAuth, (request, response) => {
    // Só o módulo e o setor de destino vêm do corpo. O restante é lido da sessão.
    const ownership = resolveRequestOwnership(identityOf(response), {
      module: request.body.module as RequestModule,
      targetSector: request.body.targetSector,
    })
    response.status(ownership ? 200 : 403).json(ownership ?? {})
  })
  policyApp.post('/exclusiva-slm', requireAuth, requireSlmMember, (_request, response) => {
    response.json({})
  })
  policyApp.post('/agendar', requireAuth, (request, response) => {
    const allowed = canScheduleRequest(
      identityOf(response),
      request.body.module as RequestModule,
    )
    response.status(allowed ? 200 : 403).json({})
  })
  policyApp.post(
    '/ler',
    requireAuth,
    requirePermission('maintenance:read'),
    (request, response) => {
      const allowed = canReadRequest(identityOf(response), {
        module: 'maintenance',
        requesterId: request.body.requesterId,
      })
      response.status(allowed ? 200 : 403).json({})
    },
  )
  policyApp.use(errorHandler)
  policyServer = policyApp.listen(0, '127.0.0.1')
  await once(policyServer, 'listening')
  policyUrl = `http://127.0.0.1:${(policyServer.address() as AddressInfo).port}`

  admin = await signIn('admin@example.gov.br')
})

after(async () => {
  if (server) await new Promise((done) => server.close(done))
  if (policyServer) await new Promise((done) => policyServer.close(done))
  await pool.end()
})

// 1
test('administrador consulta, pesquisa, filtra e edita usuários', async () => {
  const user = await createUser('gerenciada@example.gov.br')

  const search = await call('/admin/users?search=gerenciada', { session: admin })
  assert.equal(search.status, 200)
  assert.equal(search.body.total, 1)
  assert.equal(search.body.users[0].email, 'gerenciada@example.gov.br')
  assert.equal(search.text.includes('password_hash'), false)
  assert.equal(search.text.includes('argon2'), false)

  const wildcard = await call('/admin/users?search=%25', { session: admin })
  assert.equal(wildcard.body.total, 0, 'curinga digitado é texto comum')

  const byRole = await call('/admin/users?role=administrator', { session: admin })
  assert.ok(byRole.body.users.every((item: { role: string }) => item.role === 'administrator'))
  assert.ok(byRole.body.users.some((item: { id: string }) => item.id === adminId))

  const byStatus = await call('/admin/users?status=inactive', { session: admin })
  assert.ok(byStatus.body.users.every((item: { status: string }) => item.status === 'inactive'))

  const edited = await call(`/admin/users/${user.id}`, {
    method: 'PATCH',
    session: admin,
    body: { name: 'Nome Atualizado', email: 'gerenciada@example.gov.br', sector: 'RH' },
  })
  assert.equal(edited.status, 200)
  assert.equal(edited.body.user.name, 'Nome Atualizado')
  assert.equal(edited.body.user.sector, 'RH')

  const details = await call(`/admin/users/${user.id}`, { session: admin })
  assert.equal(details.body.user.sector, 'RH')
  assert.equal(details.text.includes('argon2'), false)

  const audit = await auditFor(user.id)
  assert.ok(audit.some((row) => row.action === 'user.updated' && row.actor === adminId))
  const fields = await pool.query(
    `SELECT details FROM public.auth_audit_events
      WHERE target_user_id = $1 AND action = 'user.updated'`,
    [user.id],
  )
  assert.equal(JSON.stringify(fields.rows).includes('Nome Atualizado'), false)
})

test('e-mail repetido na edição responde 409, sem expor o banco', async () => {
  const user = await createUser('edita-email@example.gov.br')

  const repeated = await call(`/admin/users/${user.id}`, {
    method: 'PATCH',
    session: admin,
    body: { name: 'Pessoa', email: 'admin@example.gov.br', sector: 'RH' },
  })
  assert.equal(repeated.status, 409)
  assert.doesNotMatch(repeated.text, /auth_users|duplicate|constraint/i)
})

// 2
test('solicitante não vê solicitações de terceiros', async () => {
  const owner = await createUser('dona-solicitacao@example.gov.br')
  const stranger = await createUser('terceira@example.gov.br')
  const { requestId } = await createFlightRequest(owner.id)

  const fromOwner = await call(`/flights/requests/${requestId}/passengers`, { session: owner })
  assert.equal(fromOwner.status, 200)

  const fromStranger = await call(`/flights/requests/${requestId}/passengers`, { session: stranger })
  assert.equal(fromStranger.status, 404)
  assert.equal(fromStranger.text.includes('Passageira'), false)

  assert.equal(
    (await policyRoute('/ler', { requesterId: owner.id }, stranger.cookie)).status,
    403,
  )
  assert.equal(
    (await policyRoute('/ler', { requesterId: stranger.id }, stranger.cookie)).status,
    200,
  )
})

// 3
test('solicitante não acessa nenhuma rota administrativa', async () => {
  const requester = await createUser('sem-admin@example.gov.br')

  for (const [method, path, body] of [
    ['GET', '/admin/users'],
    ['GET', `/admin/users/${adminId}`],
    ['GET', `/admin/users/${adminId}/history`],
    ['GET', '/admin/permissions'],
    ['GET', '/admin/audit'],
    ['GET', '/admin/registrations/pending'],
    ['PATCH', `/admin/users/${adminId}`, { name: 'Invadido', email: 'a@example.gov.br', sector: 'XX' }],
    ['PUT', `/admin/users/${adminId}/access`, { role: 'requester', slmMember: false, grantedPermissions: [], deniedPermissions: [] }],
    ['POST', `/admin/users/${adminId}/deactivate`],
    ['POST', `/admin/registrations/${adminId}/approve`, { role: 'administrator' }],
  ] as const) {
    const result = await call(path, { method, session: requester, body })
    assert.equal(result.status, 403, `${method} ${path}`)
  }

  const anonymous = await call('/admin/users')
  assert.equal(anonymous.status, 401)
})

test('escrita administrativa exige CSRF mesmo com permissão', async () => {
  const user = await createUser('alvo-csrf@example.gov.br')

  const refused = await call(`/admin/users/${user.id}/deactivate`, {
    method: 'POST',
    session: admin,
    csrf: false,
  })
  assert.equal(refused.status, 403)
  assert.equal(refused.body.code, 'CSRF_INVALID')
  assert.equal((await call('/auth/me', { session: user })).status, 200)
})

// 4
test('quem não é da SLM não abre solicitação em nome de outro setor, mesmo sendo do CPC', async () => {
  const fromCpc = await createUser('setor-cpc@example.gov.br', 'requester', 'CPC')
  const body = { module: 'maintenance', ownSector: 'CPC', targetSector: 'RH' }

  assert.equal((await call('/auth/me', { session: fromCpc })).body.user.slmMember, false)
  assert.equal((await policyRoute('/criar', body, fromCpc.cookie)).status, 403)
  assert.equal(
    (await policyRoute('/criar', { ...body, targetSector: 'CPC' }, fromCpc.cookie)).status,
    200,
  )

  // A concessão sem elegibilidade é recusada e, forçada no banco, também não vale.
  const refused = await setAccess(admin, fromCpc.id, {
    grantedPermissions: ['requests:create_on_behalf'],
  })
  assert.equal(refused.status, 400)
  await pool.query(
    `UPDATE public.auth_user_access SET granted_permissions = '{requests:create_on_behalf}'
      WHERE user_id = $1`,
    [fromCpc.id],
  )
  assert.equal((await policyRoute('/criar', body, fromCpc.cookie)).status, 403)
})

// 5
test('usuário não autorizado não agenda', async () => {
  const requester = await createUser('nao-agenda@example.gov.br')

  assert.equal(
    (await policyRoute('/agendar', { module: 'maintenance' }, requester.cookie)).status,
    403,
  )
})

// 6
test('operador SLM com concessões abre em nome de outros setores, agenda e vê todas as solicitações', async () => {
  const operator = await createUser('operadora@example.gov.br', 'slm_operator', 'CPC')
  const owner = await createUser('solicitante-rh@example.gov.br', 'requester', 'RH')
  const { requestId } = await createFlightRequest(owner.id)

  const me = await call('/auth/me', { session: operator })
  assert.equal(me.body.user.role, 'slm_operator')
  assert.equal(me.body.user.slmMember, true)

  // O perfil não concede abrir em nome de outro setor; agendar vem do perfil, na equipe SLM.
  const body = { module: 'maintenance', ownSector: 'CPC', targetSector: 'RH' }
  assert.equal((await policyRoute('/criar', body, operator.cookie)).status, 403)
  assert.equal((await policyRoute('/agendar', { module: 'fleet' }, operator.cookie)).status, 200)

  await setAccess(admin, operator.id, {
    role: 'slm_operator',
    slmMember: true,
    grantedPermissions: ['requests:create_on_behalf', 'requests:schedule'],
  })
  assert.equal((await policyRoute('/criar', body, operator.cookie)).status, 200)
  assert.equal((await policyRoute('/agendar', { module: 'fleet' }, operator.cookie)).status, 200)
  assert.equal(
    (await policyRoute('/ler', { requesterId: owner.id }, operator.cookie)).status,
    200,
  )
  assert.equal(
    (await call(`/flights/requests/${requestId}/passengers`, { session: operator })).status,
    200,
  )

  // Operador não administra usuários.
  assert.equal((await call('/admin/users', { session: operator })).status, 403)
})

// 7
test('sem flights:cpf:read, a API não entrega o CPF completo, e a tentativa é auditada', async () => {
  const owner = await createUser('sem-cpf@example.gov.br')
  const operator = await createUser('operador-sem-cpf@example.gov.br', 'slm_operator')
  const { requestId, passengerId } = await createFlightRequest(owner.id)

  for (const session of [owner, operator, admin]) {
    const refused = await call(`/flights/passengers/${passengerId}/cpf`, { session })
    assert.equal(refused.status, 403)
    assert.equal(refused.text.includes(fullCpf), false)
  }

  const list = await call(`/flights/requests/${requestId}/passengers`, { session: owner })
  assert.equal(list.status, 200)
  assert.equal(list.body.passengers[0].cpfMasked, '***.222.333-**')
  assert.equal(list.text.includes(fullCpf), false)

  const denied = await pool.query(
    `SELECT result FROM public.auth_audit_events
      WHERE action = 'flights.cpf_read_denied' AND target_resource_id = $1`,
    [passengerId],
  )
  assert.equal(denied.rowCount, 3)
  assert.equal(denied.rows[0].result, 'denied')
})

// 8
test('com flights:cpf:read, consulta o CPF, com auditoria e sem o número nos registros', async () => {
  const owner = await createUser('titular@example.gov.br')
  const reader = await createUser('leitora-cpf@example.gov.br', 'slm_operator')
  const { requestId, passengerId } = await createFlightRequest(owner.id)
  assert.equal(
    (await setAccess(admin, reader.id, {
      role: 'slm_operator',
      slmMember: true,
      grantedPermissions: ['flights:cpf:read'],
    })).status,
    200,
  )

  const logs: string[] = []
  const originalWarn = console.warn
  console.warn = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '))
  }
  let read
  try {
    read = await call(`/flights/passengers/${passengerId}/cpf`, { session: reader })
  } finally {
    console.warn = originalWarn
  }
  assert.equal(read.status, 200)
  assert.equal(read.body.cpf, fullCpf)
  assert.equal(logs.join().includes(fullCpf), false)

  const { rows } = await pool.query<Record<string, any>>(
    `SELECT actor_user_id::text AS actor, occurred_at, target_resource_id, details
       FROM public.auth_audit_events
      WHERE action = 'flights.cpf_read' AND target_resource_id = $1`,
    [passengerId],
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].actor, reader.id)
  assert.ok(rows[0].occurred_at instanceof Date)
  assert.equal(rows[0].details.operation, 'flights.passenger.cpf.read')
  assert.equal(rows[0].details.requestId, requestId)
  assert.equal(JSON.stringify(rows).includes(fullCpf), false)
})

test('se a auditoria falhar, o CPF não é devolvido', async () => {
  const owner = await createUser('titular-falha@example.gov.br')
  const reader = await createUser('leitora-falha@example.gov.br', 'slm_operator')
  const { passengerId } = await createFlightRequest(owner.id)
  await setAccess(admin, reader.id, {
    role: 'slm_operator',
    slmMember: true,
    grantedPermissions: ['flights:cpf:read'],
  })

  await pool.query(
    `CREATE FUNCTION public.block_cpf_audit() RETURNS trigger LANGUAGE plpgsql AS
     $$ BEGIN IF NEW.action = 'flights.cpf_read' THEN RAISE EXCEPTION 'bloqueado'; END IF; RETURN NEW; END $$;
     CREATE TRIGGER block_cpf_audit BEFORE INSERT ON public.auth_audit_events
       FOR EACH ROW EXECUTE FUNCTION public.block_cpf_audit();`,
  )
  try {
    const originalWarn = console.warn
    console.warn = () => {}
    const read = await call(`/flights/passengers/${passengerId}/cpf`, { session: reader })
    console.warn = originalWarn
    assert.equal(read.status, 503)
    assert.equal(read.text.includes(fullCpf), false)
  } finally {
    await pool.query(
      `DROP TRIGGER block_cpf_audit ON public.auth_audit_events;
       DROP FUNCTION public.block_cpf_audit();`,
    )
  }
})

test('editar permissões ou promover a administrador não concede CPF', async () => {
  const owner = await createUser('titular-promovida@example.gov.br')
  const { passengerId } = await createFlightRequest(owner.id)
  const promoted = await createUser('promovida@example.gov.br')

  assert.equal(
    (await setAccess(admin, promoted.id, {
      role: 'administrator',
      grantedPermissions: ['reports:read'],
    })).status,
    200,
  )

  const me = await call('/auth/me', { session: promoted })
  assert.equal(me.body.user.role, 'administrator')
  assert.equal(me.body.user.permissions.includes('flights:cpf:read'), false)
  assert.equal(
    (await call(`/flights/passengers/${passengerId}/cpf`, { session: promoted })).status,
    403,
  )
})

// 9
test('permissões individuais somam e retiram, sem promover a administrador', async () => {
  const user = await createUser('individual@example.gov.br')

  const before = await call('/auth/me', { session: user })
  assert.equal(before.body.user.permissions.includes('users:read'), false)

  await setAccess(admin, user.id, {
    grantedPermissions: ['users:read'],
    deniedPermissions: ['fleet:create'],
  })

  const me = await call('/auth/me', { session: user })
  assert.equal(me.body.user.role, 'requester')
  assert.ok(me.body.user.permissions.includes('users:read'))
  assert.equal(me.body.user.permissions.includes('fleet:create'), false)
  assert.ok(me.body.user.permissions.includes('maintenance:create'))

  // A concessão vale para o que foi concedido, e só para isso.
  assert.equal((await call('/admin/users', { session: user })).status, 200)
  assert.equal(
    (await call(`/admin/users/${adminId}/deactivate`, { method: 'POST', session: user })).status,
    403,
  )
  assert.equal(
    (await policyRoute('/criar', { module: 'fleet', ownSector: 'X', targetSector: 'X' }, user.cookie)).status,
    403,
  )

  const conflict = await setAccess(admin, user.id, {
    grantedPermissions: ['reports:read'],
    deniedPermissions: ['reports:read'],
  })
  assert.equal(conflict.status, 400)

  const unknown = await call(`/admin/users/${user.id}/access`, {
    method: 'PUT',
    session: admin,
    body: {
      role: 'requester',
      slmMember: false,
      grantedPermissions: ['superusuario'],
      deniedPermissions: [],
    },
  })
  assert.equal(unknown.status, 400)
})

// 10
test('alterações de permissão valem na sessão aberta, sem novo login', async () => {
  const user = await createUser('sem-relogin@example.gov.br')

  assert.equal((await call('/admin/users', { session: user })).status, 403)

  await setAccess(admin, user.id, { grantedPermissions: ['users:read'] })
  assert.equal((await call('/admin/users', { session: user })).status, 200)

  await setAccess(admin, user.id, { grantedPermissions: [] })
  assert.equal((await call('/admin/users', { session: user })).status, 403)

  await setAccess(admin, user.id, {
    role: 'slm_operator',
    slmMember: true,
    grantedPermissions: ['requests:schedule'],
  })
  assert.equal(
    (await policyRoute('/agendar', { module: 'maintenance' }, user.cookie)).status,
    200,
  )
  await setAccess(admin, user.id, { role: 'requester', slmMember: false })
  assert.equal(
    (await policyRoute('/agendar', { module: 'maintenance' }, user.cookie)).status,
    403,
  )
})

// 11
test('conta desativada perde o acesso na hora, e a reativada exige novo login', async () => {
  const user = await createUser('desativada@example.gov.br')

  const deactivated = await call(`/admin/users/${user.id}/deactivate`, {
    method: 'POST',
    session: admin,
  })
  assert.equal(deactivated.status, 200)
  assert.equal(deactivated.body.user.status, 'inactive')

  assert.equal((await call('/auth/me', { session: user })).status, 401)
  assert.equal((await policyRoute('/ler', { requesterId: user.id }, user.cookie)).status, 401)
  const refused = await call('/auth/login', {
    method: 'POST',
    body: { identifier: 'desativada@example.gov.br', password },
  })
  assert.equal(refused.status, 401)

  const activated = await call(`/admin/users/${user.id}/activate`, {
    method: 'POST',
    session: admin,
  })
  assert.equal(activated.status, 200)
  assert.equal((await call('/auth/me', { session: user })).status, 401, 'sessão antiga não volta')
  await signIn('desativada@example.gov.br')

  const actions = (await auditFor(user.id)).map((row) => row.action)
  assert.ok(actions.includes('account.inactive'))
  assert.ok(actions.includes('account.activated'))
})

// 12
test('o último administrador não pode ser removido', async () => {
  // Isola o cenário: rebaixa os demais administradores criados por outros testes.
  const others = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM public.auth_users
      WHERE role = 'admin' AND status = 'approved' AND id <> $1`,
    [adminId],
  )
  for (const { id } of others.rows) {
    await setAccess(admin, id, { role: 'requester' })
  }

  const self = await setAccess(admin, adminId, { role: 'requester' })
  assert.equal(self.status, 403)

  // Nem uma retirada gravada direto no banco tira do último administrador o essencial.
  await pool.query(
    `UPDATE public.auth_user_access
        SET denied_permissions = '{users:read,users:approve,users:manage,audit:read,settings:read,settings:manage}'
      WHERE user_id = $1`,
    [adminId],
  )
  const lastAdmin = (await call('/auth/me', { session: admin })).body.user.permissions
  for (const permission of ['users:read', 'users:approve', 'users:manage', 'audit:read', 'settings:read', 'settings:manage']) {
    assert.ok(lastAdmin.includes(permission), permission)
  }
  assert.equal((await call('/admin/users', { session: admin })).status, 200)
  await pool.query(
    `UPDATE public.auth_user_access SET denied_permissions = '{}' WHERE user_id = $1`,
    [adminId],
  )

  const selfDeactivated = await call(`/admin/users/${adminId}/deactivate`, {
    method: 'POST',
    session: admin,
  })
  assert.equal(selfDeactivated.status, 403)

  // Quem só tem users:manage não alcança administradores, mesmo chamando o repositório.
  const { UserRepository } = await import('./userRepository.js')
  const backup = await createUser('gestora-usuarios@example.gov.br')
  await setAccess(admin, backup.id, { grantedPermissions: ['users:manage'] })
  const backupMe = await call('/auth/me', { session: backup })
  assert.ok(backupMe.body.user.permissions.includes('users:manage'))
  await assert.rejects(
    () =>
      new UserRepository(() => pool).setUserActive(
        {
          userId: backup.id,
          role: backupMe.body.user.role,
          permissions: backupMe.body.user.permissions,
          slmMember: false,
          sector: 'Protocolo',
        },
        adminId,
        false,
      ),
    /não autorizada/,
  )

  const second = await createUser('segunda-admin@example.gov.br', 'administrator')
  const demotedByOther = await setAccess(second, adminId, { role: 'requester' })
  assert.equal(demotedByOther.status, 200, 'com outro administrador, a troca é permitida')

  const stillLast = await setAccess(second, second.id, { role: 'requester' })
  assert.equal(stillLast.status, 403)

  const restored = await setAccess(second, adminId, { role: 'administrator' })
  assert.equal(restored.status, 200)
  assert.equal((await call('/admin/users', { session: admin })).status, 200)
})

test('dois administradores rebaixando um ao outro ao mesmo tempo não zeram os administradores', async () => {
  const others = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM public.auth_users
      WHERE role = 'admin' AND status = 'approved' AND id <> $1`,
    [adminId],
  )
  for (const { id } of others.rows) {
    await setAccess(admin, id, { role: 'requester' })
  }

  const rival = await createUser('rival@example.gov.br', 'administrator')
  const results = await Promise.all([
    setAccess(admin, rival.id, { role: 'requester' }),
    setAccess(rival, adminId, { role: 'requester' }),
  ])

  assert.equal(results.filter((result) => result.status === 200).length, 1)
  assert.equal(results.filter((result) => result.status === 403).length, 1)

  const remaining = await pool.query(
    `SELECT id FROM public.auth_users WHERE role = 'admin' AND status = 'approved'`,
  )
  assert.equal(remaining.rowCount, 1)

  // Devolve o estado esperado pelos testes seguintes.
  if (results[1].status === 200) {
    await setAccess(rival, adminId, { role: 'administrator' })
    await setAccess(admin, rival.id, { role: 'requester' })
  }
})

test('ninguém altera o próprio acesso por requisição direta, nem com dados forjados', async () => {
  const user = await createUser('forjada@example.gov.br')

  const direct = await setAccess(user, user.id, {
    role: 'administrator',
    grantedPermissions: ['users:manage', 'flights:cpf:read'],
  })
  assert.equal(direct.status, 403)

  // Administrador também não concede o CPF a si mesmo.
  const adminSelf = await setAccess(admin, adminId, {
    role: 'administrator',
    grantedPermissions: ['flights:cpf:read'],
  })
  assert.equal(adminSelf.status, 403)

  // Campos extras enviados pelo navegador são ignorados.
  const login = await call('/auth/login', {
    method: 'POST',
    body: {
      identifier: 'forjada@example.gov.br',
      password,
      role: 'administrator',
      permissions: ['users:manage'],
      slmMember: true,
    },
  })
  assert.equal(login.body.user.role, 'requester')
  assert.equal(login.body.user.permissions.includes('users:manage'), false)
  assert.equal(login.body.user.slmMember, false)

  const session = { cookie: login.setCookie, id: login.body.user.id }
  const me = await call('/auth/me', { session })
  assert.equal(me.body.user.role, 'requester')
})

test('quem tem users:manage sem ser administrador não eleva privilégios', async () => {
  const manager = await createUser('so-gerencia@example.gov.br')
  const target = await createUser('alvo-gerencia@example.gov.br')
  await setAccess(admin, manager.id, { grantedPermissions: ['users:read', 'users:manage'] })

  // Pode o que é operacional.
  assert.equal(
    (await call(`/admin/users/${target.id}/deactivate`, { method: 'POST', session: manager })).status,
    200,
  )
  assert.equal(
    (await call(`/admin/users/${target.id}/activate`, { method: 'POST', session: manager })).status,
    200,
  )

  // Pode corrigir nome e setor, mas não o e-mail, que recebe a recuperação de senha.
  const renamed = await call(`/admin/users/${target.id}`, {
    method: 'PATCH',
    session: manager,
    body: { name: 'Nome Corrigido', email: 'alvo-gerencia@example.gov.br', sector: 'RH' },
  })
  assert.equal(renamed.status, 200)
  const takeover = await call(`/admin/users/${target.id}`, {
    method: 'PATCH',
    session: manager,
    body: { name: 'Nome Corrigido', email: 'atacante@example.gov.br', sector: 'RH' },
  })
  assert.equal(takeover.status, 403)
  const unchanged = await call(`/admin/users/${target.id}`, { session: admin })
  assert.equal(unchanged.body.user.email, 'alvo-gerencia@example.gov.br')

  // Não pode conceder acesso, nem tocar em administradores.
  for (const access of [
    { role: 'administrator' },
    { grantedPermissions: ['users:manage'] as Permission[] },
    { grantedPermissions: ['flights:cpf:read'] as Permission[] },
    { role: 'slm_operator', slmMember: true },
  ]) {
    assert.equal((await setAccess(manager, target.id, access)).status, 403)
  }
  assert.equal(
    (await call(`/admin/users/${adminId}/deactivate`, { method: 'POST', session: manager })).status,
    403,
  )
  assert.equal(
    (await call(`/admin/users/${adminId}`, {
      method: 'PATCH',
      session: manager,
      body: { name: 'Trocado', email: 'tomada@example.gov.br', sector: 'XX' },
    })).status,
    403,
  )
})

test('quem só aprova cadastros aprova solicitantes, nunca perfis superiores', async () => {
  const approver = await createUser('aprovadora@example.gov.br')
  await setAccess(admin, approver.id, { grantedPermissions: ['users:approve'] })
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')

  await call('/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Novo Cadastro',
      email: 'novo-por-aprovadora@example.gov.br',
      sector: 'RH',
      password,
      passwordConfirmation: password,
    },
  })
  const pending = await call('/admin/registrations/pending', { session: approver })
  assert.equal(pending.status, 200)
  const id = pending.body.registrations.find(
    (item: { email: string }) => item.email === 'novo-por-aprovadora@example.gov.br',
  ).id

  for (const role of ['administrator', 'slm_operator']) {
    const refused = await call(`/admin/registrations/${id}/approve`, {
      method: 'POST',
      session: approver,
      body: { role },
    })
    assert.equal(refused.status, 403, role)
  }

  const approved = await call(`/admin/registrations/${id}/approve`, {
    method: 'POST',
    session: approver,
    body: { role: 'requester' },
  })
  assert.equal(approved.status, 200)
})

test('equipe SLM: entra e sai pelo administrador, e o histórico permanece', async () => {
  const member = await createUser('integrante@example.gov.br', 'slm_operator', 'CPC')
  const body = { module: 'fleet', ownSector: 'CPC', targetSector: 'RH' }
  await setAccess(admin, member.id, {
    role: 'slm_operator',
    slmMember: true,
    grantedPermissions: ['requests:create_on_behalf'],
  })
  assert.equal((await policyRoute('/criar', body, member.cookie)).status, 200)

  const invalid = await setAccess(admin, member.id, {
    role: 'slm_operator',
    slmMember: false,
  })
  assert.equal(invalid.status, 400, 'o perfil operacional exige a equipe')

  const before = (await auditFor(member.id)).length
  const removed = await setAccess(admin, member.id, { role: 'requester', slmMember: false })
  assert.equal(removed.status, 200)
  assert.equal((await policyRoute('/criar', body, member.cookie)).status, 403)

  const after = await auditFor(member.id)
  assert.ok(after.length > before, 'nenhum registro anterior foi apagado')
  assert.ok(after.some((row) => row.action === 'user.slm_removed'))
  assert.ok(after.some((row) => row.action === 'auth.login'))

  const account = await pool.query(
    'SELECT status, sector FROM public.auth_users WHERE id = $1',
    [member.id],
  )
  assert.deepEqual(account.rows[0], { status: 'approved', sector: 'CPC' })

  const history = await call(`/admin/users/${member.id}/history`, { session: admin })
  assert.equal(history.status, 200)
  const actions = history.body.events.map((event: { action: string }) => event.action)
  assert.ok(actions.includes('user.slm_removed'))
  assert.ok(actions.includes('user.role_changed'))
  assert.equal(history.body.events[0].actorName, 'Administradora')

  // Não há limite de integrantes na equipe.
  const team = await Promise.all(
    ['a', 'b', 'c', 'd', 'e'].map((suffix) => `equipe-${suffix}@example.gov.br`),
  )
  for (const email of team) await createUser(email, 'slm_operator')
  const members = await call('/admin/users?slm=true', { session: admin })
  assert.ok(members.body.total >= 5)
})

test('histórico registra o que mudou e a concessão de CPF, sem dados pessoais', async () => {
  const user = await createUser('historico@example.gov.br', 'slm_operator')
  await setAccess(admin, user.id, {
    role: 'slm_operator',
    slmMember: true,
    grantedPermissions: ['flights:cpf:read', 'reports:read'],
  })
  await setAccess(admin, user.id, {
    role: 'slm_operator',
    slmMember: true,
    grantedPermissions: ['reports:read'],
  })

  const { body, text } = await call(`/admin/users/${user.id}/history`, { session: admin })
  const actions = body.events.map((event: { action: string }) => event.action)
  assert.ok(actions.includes('user.cpf_access_granted'))
  assert.ok(actions.includes('user.cpf_access_revoked'))

  const change = body.events.find(
    (event: { action: string; details: { grantedAdded?: string[] } }) =>
      event.action === 'user.permissions_changed' && event.details.grantedAdded?.length,
  )
  assert.deepEqual(change.details.grantedAdded, ['flights:cpf:read', 'reports:read'])
  assert.equal(text.includes('historico@example.gov.br'), false)
})

test('consulta de auditoria exige audit:read e não exibe IP', async () => {
  const user = await createUser('auditora@example.gov.br')
  assert.equal((await call('/admin/audit', { session: user })).status, 403)

  await call('/auth/login', {
    method: 'POST',
    body: { identifier: 'auditora@example.gov.br', password: 'senha-errada-de-teste' },
  })

  await setAccess(admin, user.id, { grantedPermissions: ['audit:read'] })
  const audit = await call('/admin/audit', { session: user })
  assert.equal(audit.status, 200)
  assert.ok(audit.body.events.length > 0)
  assert.doesNotMatch(audit.text, /"ip"|"identifier"/)
  assert.equal(audit.text.includes('senha-errada-de-teste'), false)
})

test('o catálogo de permissões exige users:read e não oferece CPF em perfil algum', async () => {
  const catalog = await call('/admin/permissions', { session: admin })
  assert.equal(catalog.status, 200)
  for (const profile of catalog.body.profiles) {
    assert.equal(profile.permissions.includes('flights:cpf:read'), false, profile.key)
  }
})

// --- Etapa 04: o mapa de rotas conduz os testes, para nenhuma rota ficar de fora ---

const unknownId = '00000000-0000-4000-8000-000000000000'
const protectedRoutes = routeAccessMap.flatMap((route) =>
  route.access === 'permission' ? [route] : [],
)

function bodyFor(path: string, method: string) {
  if (method === 'PATCH') {
    return { name: 'Pessoa', email: 'qualquer@example.gov.br', sector: 'RH' }
  }
  if (path.endsWith('/access')) {
    return { role: 'requester', slmMember: false, grantedPermissions: [], deniedPermissions: [] }
  }
  if (path.endsWith('/approve')) return { role: 'requester' }
  return undefined
}

function callRoute(route: { method: string; path: string }, session?: Session) {
  const path = route.path.replace(/:[A-Za-z]+/g, unknownId)
  return call(path, {
    method: route.method,
    session,
    body: bodyFor(route.path, route.method),
  })
}

/** Deixa a conta somente com as permissões indicadas, além de nenhuma outra. */
function accessExactly(permissions: readonly Permission[]) {
  // As permissões especiais só são elegíveis dentro da equipe SLM.
  const role = permissions.some(isRestrictedPermission) ? 'slm_operator' : 'requester'
  return {
    role,
    slmMember: role === 'slm_operator',
    grantedPermissions: [...permissions],
    deniedPermissions: permissionsForProfile(role).filter(
      (permission) => !permissions.includes(permission),
    ),
  }
}

test('cada rota do mapa: só com a permissão exata passa, e sem qualquer uma delas é recusada', async () => {
  const user = await createUser('matriz@example.gov.br')

  for (const route of protectedRoutes) {
    const label = `${route.method} ${route.path}`

    // Sem permissão nenhuma, direto na API.
    assert.equal(
      (await setAccess(admin, user.id, accessExactly([]))).status,
      200,
    )
    assert.equal((await callRoute(route, user)).status, 403, `${label} sem permissão`)

    // Com a permissão concedida individualmente, e só ela.
    await setAccess(admin, user.id, accessExactly(route.requires))
    const allowed = await callRoute(route, user)
    if (route.administratorOnly) {
      assert.equal(allowed.status, 403, `${label} exige administrador`)
      assert.equal((await callRoute(route, admin)).status, 404, `${label} por administrador`)
    } else {
      assert.ok(
        ![401, 403, 500, 503].includes(allowed.status),
        `${label} com a permissão respondeu ${allowed.status}`,
      )
    }

    // Faltando qualquer uma das exigidas.
    for (const missing of route.requires) {
      await setAccess(
        admin,
        user.id,
        accessExactly(route.requires.filter((permission) => permission !== missing)),
      )
      assert.equal(
        (await callRoute(route, user)).status,
        403,
        `${label} sem ${missing}`,
      )
    }
  }
})

test('cada rota do mapa: sessão de conta desativada recebe 401', async () => {
  const user = await createUser('sessao-antiga@example.gov.br', 'slm_operator')
  assert.equal((await call('/auth/me', { session: user })).status, 200)

  await call(`/admin/users/${user.id}/deactivate`, { method: 'POST', session: admin })

  assert.equal((await call('/auth/me', { session: user })).status, 401)
  for (const route of protectedRoutes) {
    assert.equal(
      (await callRoute(route, user)).status,
      401,
      `${route.method} ${route.path}`,
    )
  }
})

test('cada rota de escrita do mapa exige CSRF, mesmo para quem tem a permissão', async () => {
  for (const route of protectedRoutes.filter((item) => item.method !== 'GET')) {
    const refused = await call(route.path.replace(/:[A-Za-z]+/g, unknownId), {
      method: route.method,
      session: admin,
      csrf: false,
      body: bodyFor(route.path, route.method),
    })
    assert.equal(refused.status, 403, `${route.method} ${route.path}`)
    assert.equal(refused.body.code, 'CSRF_INVALID', `${route.method} ${route.path}`)
  }
})

test('consultar sem gerenciar: users:read lê, mas não altera nada', async () => {
  const reader = await createUser('so-consulta@example.gov.br')
  const target = await createUser('alvo-consulta@example.gov.br')
  await setAccess(admin, reader.id, { grantedPermissions: ['users:read'] })

  assert.equal((await call('/admin/users', { session: reader })).status, 200)
  assert.equal((await call(`/admin/users/${target.id}`, { session: reader })).status, 200)
  assert.equal((await call(`/admin/users/${target.id}/history`, { session: reader })).status, 200)
  assert.equal((await call('/admin/permissions', { session: reader })).status, 200)

  for (const [method, path, body] of [
    ['PATCH', `/admin/users/${target.id}`, { name: 'Alterado', email: 'alvo-consulta@example.gov.br', sector: 'XX' }],
    ['PUT', `/admin/users/${target.id}/access`, { role: 'administrator', slmMember: false, grantedPermissions: [], deniedPermissions: [] }],
    ['POST', `/admin/users/${target.id}/deactivate`],
  ] as const) {
    assert.equal(
      (await call(path, { method, session: reader, body })).status,
      403,
      `${method} ${path}`,
    )
  }

  const after = await call(`/admin/users/${target.id}`, { session: admin })
  assert.equal(after.body.user.name, 'Pessoa alvo-consulta')
  assert.equal(after.body.user.status, 'approved')
  assert.equal(after.body.user.role, 'requester')
})

test('permissão individual retirada vale mais que o perfil, inclusive o de administrador', async () => {
  const second = await createUser('admin-parcial@example.gov.br', 'administrator')
  assert.equal((await call('/admin/audit', { session: second })).status, 200)
  assert.equal((await call('/admin/registrations/pending', { session: second })).status, 200)

  await setAccess(admin, second.id, {
    role: 'administrator',
    deniedPermissions: ['reports:read', 'requests:schedule'],
  })
  const secondMe = await call('/auth/me', { session: second })
  assert.equal(secondMe.body.user.permissions.includes('reports:read'), false)
  assert.equal(
    (await policyRoute('/agendar', { module: 'maintenance' }, second.cookie)).status,
    403,
  )
  assert.equal((await call('/admin/audit', { session: second })).status, 200, 'essencial permanece')

  await setAccess(admin, second.id, { role: 'requester' })

  const owner = await createUser('dona-retirada@example.gov.br')
  const { requestId } = await createFlightRequest(owner.id)
  await setAccess(admin, owner.id, { deniedPermissions: ['flights:read'] })
  assert.equal(
    (await call(`/flights/requests/${requestId}/passengers`, { session: owner })).status,
    403,
    'nem o dono entra sem acesso ao módulo',
  )

  const operator = await createUser('operador-retirado@example.gov.br', 'slm_operator')
  assert.equal(
    (await call(`/flights/requests/${requestId}/passengers`, { session: operator })).status,
    200,
  )
  await setAccess(admin, operator.id, {
    role: 'slm_operator',
    slmMember: true,
    deniedPermissions: ['requests:read_all'],
  })
  assert.equal(
    (await call(`/flights/requests/${requestId}/passengers`, { session: operator })).status,
    404,
    'sem read_all, vale a regra das próprias solicitações',
  )
})

test('solicitante não consulta solicitação de outra pessoa, nem conhecendo os identificadores', async () => {
  const owner = await createUser('dona-etapa4@example.gov.br')
  const other = await createUser('curiosa-etapa4@example.gov.br')
  const { requestId, passengerId } = await createFlightRequest(owner.id)

  const list = await call(`/flights/requests/${requestId}/passengers`, { session: other })
  assert.equal(list.status, 404)
  assert.equal(list.text.includes('Passageira'), false)

  // Quem tem a permissão de CPF, sem read_all, também não alcança a de terceiros.
  await setAccess(admin, other.id, {
    role: 'slm_operator',
    slmMember: true,
    grantedPermissions: ['flights:cpf:read'],
    deniedPermissions: ['requests:read_all'],
  })
  const cpf = await call(`/flights/passengers/${passengerId}/cpf`, { session: other })
  assert.equal(cpf.status, 404)
  assert.equal(cpf.text.includes(fullCpf), false)
})

test('quem é do CPC e não está na SLM não executa operação exclusiva da equipe', async () => {
  const fromCpc = await createUser('cpc-fora-slm@example.gov.br', 'requester', 'CPC')
  const exclusive = () => policyRoute('/exclusiva-slm', {}, fromCpc.cookie)
  const onBehalf = { module: 'maintenance', targetSector: 'RH' }

  assert.equal((await exclusive()).status, 403)
  assert.equal((await policyRoute('/criar', onBehalf, fromCpc.cookie)).status, 403)
  assert.equal((await policyRoute('/criar', { module: 'maintenance', targetSector: 'CPC' }, fromCpc.cookie)).status, 200)

  // A equipe não depende do setor: integrante de outro setor pode.
  const fromRh = await createUser('slm-do-rh@example.gov.br', 'slm_operator', 'RH')
  await setAccess(admin, fromRh.id, {
    role: 'slm_operator',
    slmMember: true,
    grantedPermissions: ['requests:create_on_behalf'],
  })
  assert.equal((await policyRoute('/exclusiva-slm', {}, fromRh.cookie)).status, 200)
  const ownership = await policyRoute(
    '/criar',
    { module: 'maintenance', targetSector: 'Financeiro' },
    fromRh.cookie,
  )
  assert.equal(ownership.status, 200)
  assert.deepEqual(await ownership.json(), {
    requesterId: fromRh.id,
    sector: 'Financeiro',
    onBehalf: true,
  })
})

test('dados manipulados pelo navegador não mudam dono, setor nem equipe da solicitação', async () => {
  const user = await createUser('manipula@example.gov.br', 'requester', 'RH')

  // Dizer que o setor próprio é outro, ou que pertence à equipe, não adianta.
  const forged = await policyRoute(
    '/criar',
    {
      module: 'maintenance',
      targetSector: 'CPC',
      ownSector: 'CPC',
      sector: 'CPC',
      slmMember: true,
      permissions: ['requests:create_on_behalf'],
      role: 'slm_operator',
    },
    user.cookie,
  )
  assert.equal(forged.status, 403)

  // Informar outro solicitante não muda o dono.
  const owned = await policyRoute(
    '/criar',
    { module: 'maintenance', requesterId: adminId, solicitante_id: adminId, userId: adminId },
    user.cookie,
  )
  assert.equal(owned.status, 200)
  assert.deepEqual(await owned.json(), {
    requesterId: user.id,
    sector: 'RH',
    onBehalf: false,
  })
})

test('campos extras e cabeçalhos forjados não alteram acesso em nenhuma rota real', async () => {
  const user = await createUser('forja-etapa4@example.gov.br')
  const target = await createUser('alvo-forja@example.gov.br')

  const forgedHeaders: Array<Record<string, string>> = [
    { 'x-user-id': adminId, 'x-role': 'administrator', 'x-permissions': 'users:manage' },
    { 'x-http-method-override': 'GET', 'x-original-url': '/api/health', 'x-forwarded-for': '127.0.0.1' },
    { authorization: 'Bearer token-forjado' },
  ]
  for (const headers of forgedHeaders) {
    const response = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { cookie: user.cookie, ...headers },
    })
    assert.equal(response.status, 403, JSON.stringify(Object.keys(headers)))
  }

  for (const path of [
    '/api/ADMIN/USERS',
    '/api/admin/users/',
    '/api//admin/users',
    '/api/admin/users?role=administrator&permissions=users:manage',
    '/API/admin/audit',
  ]) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { cookie: user.cookie } })
    assert.notEqual(response.status, 200, path)
  }

  const head = await fetch(`${baseUrl}/api/admin/users`, {
    method: 'HEAD',
    headers: { cookie: user.cookie },
  })
  assert.equal(head.status, 403)

  // A edição de dados ignora perfil, situação e permissões enviados junto.
  const edited = await call(`/admin/users/${target.id}`, {
    method: 'PATCH',
    session: admin,
    body: {
      name: 'Nome Editado',
      email: 'alvo-forja@example.gov.br',
      sector: 'RH',
      role: 'administrator',
      status: 'blocked',
      permissions: ['users:manage'],
      slmMember: true,
      password_hash: 'forjado',
      id: adminId,
    },
  })
  assert.equal(edited.status, 200)
  const me = await call('/auth/me', { session: target })
  assert.equal(me.status, 200)
  assert.equal(me.body.user.role, 'requester')
  assert.equal(me.body.user.slmMember, false)
  assert.equal(me.body.user.permissions.includes('users:manage'), false)

  // Tipos errados são recusados, e não convertidos.
  for (const access of [
    { role: 'requester', slmMember: 'true', grantedPermissions: [], deniedPermissions: [] },
    { role: 'requester', slmMember: false, grantedPermissions: 'users:manage', deniedPermissions: [] },
    { role: ['administrator'], slmMember: false, grantedPermissions: [], deniedPermissions: [] },
    { role: 'requester', slmMember: false },
  ]) {
    assert.equal(
      (await call(`/admin/users/${target.id}/access`, { method: 'PUT', session: admin, body: access })).status,
      400,
    )
  }

  // Aprovação e cadastro ignoram permissões enviadas.
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  await call('/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Cadastro Forjado',
      email: 'cadastro-forjado@example.gov.br',
      sector: 'RH',
      password,
      passwordConfirmation: password,
      role: 'administrator',
      status: 'approved',
      permissions: ['users:manage'],
    },
  })
  const stillPending = await call('/auth/login', {
    method: 'POST',
    body: { identifier: 'cadastro-forjado@example.gov.br', password },
  })
  assert.equal(stillPending.status, 401)

  const pending = await call('/admin/registrations/pending', { session: admin })
  const id = pending.body.registrations.find(
    (item: { email: string }) => item.email === 'cadastro-forjado@example.gov.br',
  ).id
  await call(`/admin/registrations/${id}/approve`, {
    method: 'POST',
    session: admin,
    body: {
      role: 'requester',
      permissions: ['users:manage', 'flights:cpf:read'],
      grantedPermissions: ['users:manage'],
      slmMember: true,
    },
  })
  const approved = await signIn('cadastro-forjado@example.gov.br')
  const approvedMe = await call('/auth/me', { session: approved })
  assert.equal(approvedMe.body.user.role, 'requester')
  assert.equal(approvedMe.body.user.slmMember, false)
  assert.equal(approvedMe.body.user.permissions.includes('users:manage'), false)
  assert.equal(approvedMe.body.user.permissions.includes('flights:cpf:read'), false)
})

test('paginação com valores absurdos responde normalmente, sem chegar à consulta', async () => {
  for (const page of ['1e400', '-5', 'abc', '1.5', '999999999999999999999', "1;DROP TABLE x"]) {
    for (const path of ['/admin/users', '/admin/audit']) {
      const response = await call(`${path}?page=${encodeURIComponent(page)}`, { session: admin })
      assert.equal(response.status, 200, `${path} page=${page}`)
      assert.equal(response.body.page, 1, `${path} page=${page}`)
    }
  }
})

// --- Correção da migração 003: matriz de acesso definitiva ---

async function myPermissions(session: Session): Promise<string[]> {
  return (await call('/auth/me', { session })).body.user.permissions
}

async function currentAccess(userId: string) {
  const { rows } = await pool.query(
    `SELECT profile, slm_member, granted_permissions FROM public.auth_user_access WHERE user_id = $1`,
    [userId],
  )
  return rows[0]
}

test('agendar: administrador sem SLM não pode; da SLM pode; operador da SLM pelo perfil; solicitante nunca', async () => {
  const schedule = (session: Session, module: string) =>
    policyRoute('/agendar', { module }, session.cookie).then((response) => response.status)

  // P-08: o perfil Administrador, sozinho, não dá atribuições operacionais da SLM.
  const second = await createUser('admin-agenda@example.gov.br', 'administrator')
  assert.equal((await call('/auth/me', { session: second })).body.user.slmMember, false)
  assert.equal(await schedule(second, 'maintenance'), 403)
  assert.equal(await schedule(second, 'fleet'), 403)
  assert.equal(
    (await setAccess(admin, second.id, { role: 'administrator', grantedPermissions: ['requests:schedule'] })).status,
    400,
    'concessão de agendamento fora da equipe',
  )
  await setAccess(admin, second.id, { role: 'administrator', slmMember: true })
  assert.equal(await schedule(second, 'maintenance'), 200)
  assert.equal(await schedule(second, 'fleet'), 200)

  // Operador SLM aprovado na equipe agenda pelo perfil, sem concessão manual.
  const operator = await createUser('operador-agenda@example.gov.br', 'slm_operator')
  assert.equal((await call('/auth/me', { session: operator })).body.user.slmMember, true)
  assert.equal(await schedule(operator, 'maintenance'), 200, 'pelo perfil')
  assert.equal(await schedule(operator, 'fleet'), 200, 'pelo perfil')
  assert.deepEqual((await currentAccess(operator.id)).granted_permissions, [], 'sem concessão gravada')

  // A retirada individual prevalece sobre o padrão do perfil.
  await setAccess(admin, operator.id, {
    role: 'slm_operator',
    slmMember: true,
    deniedPermissions: ['requests:schedule'],
  })
  assert.equal(await schedule(operator, 'maintenance'), 403, 'retirada individual')
  assert.equal(await schedule(operator, 'fleet'), 403, 'retirada individual')

  // Cada módulo exige sua própria permissão.
  await setAccess(admin, operator.id, {
    role: 'slm_operator',
    slmMember: true,
    deniedPermissions: ['fleet:schedule'],
  })
  assert.equal(await schedule(operator, 'fleet'), 403)
  assert.equal(await schedule(operator, 'maintenance'), 200)
  await setAccess(admin, operator.id, {
    role: 'slm_operator',
    slmMember: true,
    deniedPermissions: ['maintenance:schedule'],
  })
  assert.equal(await schedule(operator, 'maintenance'), 403)
  assert.equal(await schedule(operator, 'fleet'), 200)

  // Fora da equipe, o mesmo operador passa a Solicitante e não agenda mais.
  await setAccess(admin, operator.id, { role: 'requester', slmMember: false })
  assert.equal(await schedule(operator, 'maintenance'), 403, 'fora da equipe')
  assert.equal(await schedule(operator, 'fleet'), 403, 'fora da equipe')

  const requester = await createUser('solicitante-agenda@example.gov.br')
  const refused = await setAccess(admin, requester.id, {
    grantedPermissions: ['requests:schedule', 'maintenance:schedule'],
  })
  assert.equal(refused.status, 400)
  assert.equal(await schedule(requester, 'maintenance'), 403)

  await setAccess(admin, second.id, { role: 'requester' })
})

test('conjunto operacional da SLM: aprovação, setor, equipe, perfil, API direta e auditoria', async () => {
  const operational: Permission[] = ['requests:schedule', 'warehouse:manage', 'warehouse:forecast']
  const schedule = (session: Session, module: string) =>
    policyRoute('/agendar', { module }, session.cookie).then((response) => response.status)
  const warehouseStatus = async (session: Session) => [
    (await call('/warehouse/stock', { session })).status,
    (await call('/warehouse/inventory-checks', { session })).status,
  ]

  // 1. Aprovado como Operador SLM, recebe o conjunto sem concessão, mesmo lotado fora da SLM.
  const operator = await createUser('op-conjunto@example.gov.br', 'slm_operator', 'Gabinete')
  const granted = await myPermissions(operator)
  for (const permission of operational) assert.ok(granted.includes(permission), permission)
  for (const permission of [
    'flights:cpf:read', 'requests:create_on_behalf', 'slm_central:read', 'users:read', 'users:manage',
    'users:approve', 'settings:manage', 'audit:read',
  ]) {
    assert.equal(granted.includes(permission), false, permission)
  }
  assert.deepEqual((await currentAccess(operator.id)).granted_permissions, [], 'nada gravado como concessão')
  assert.equal(await schedule(operator, 'maintenance'), 200)
  assert.equal(await schedule(operator, 'fleet'), 200)
  assert.deepEqual(await warehouseStatus(operator), [200, 200])
  // Sem administração: não gerencia usuários nem o próprio acesso.
  assert.equal((await call('/admin/users', { session: operator })).status, 403)
  assert.equal((await setAccess(operator, operator.id, { role: 'administrator', slmMember: true })).status, 403)

  const approval = await pool.query(
    `SELECT details FROM public.auth_audit_events
      WHERE target_user_id = $1 AND action = 'registration.approve'`,
    [operator.id],
  )
  assert.equal(approval.rows[0].details.slmMember, 'true')
  for (const permission of operational) {
    assert.ok(approval.rows[0].details.effectivePermissions.includes(permission), `auditoria: ${permission}`)
  }

  // 2. Lotado no setor "SLM", mas Solicitante: o setor nunca conta, nem com valor forçado no banco.
  const sectorOnly = await createUser('setor-slm@example.gov.br', 'requester', 'SLM')
  await pool.query(
    `UPDATE public.auth_user_access SET granted_permissions = $2 WHERE user_id = $1`,
    [sectorOnly.id, operational],
  )
  const sectorPermissions = await myPermissions(sectorOnly)
  for (const permission of operational) assert.equal(sectorPermissions.includes(permission), false, permission)
  assert.equal(await schedule(sectorOnly, 'maintenance'), 403)
  assert.equal(await schedule(sectorOnly, 'fleet'), 403)
  assert.deepEqual(await warehouseStatus(sectorOnly), [403, 403])

  // 3. Mesmo perfil sem a equipe SLM (conta anterior à migração 003, lida pelas colunas antigas).
  const legacy = await createUser('op-sem-equipe@example.gov.br', 'slm_operator', 'CPC')
  await pool.query(`DELETE FROM public.auth_user_access WHERE user_id = $1`, [legacy.id])
  const legacyMe = (await call('/auth/me', { session: legacy })).body.user
  assert.equal(legacyMe.role, 'slm_operator')
  assert.equal(legacyMe.slmMember, false)
  for (const permission of operational) assert.equal(legacyMe.permissions.includes(permission), false, permission)
  assert.ok(legacyMe.permissions.includes('requests:update'), 'o restante do atendimento continua')
  assert.equal(await schedule(legacy, 'maintenance'), 403)
  assert.equal(await schedule(legacy, 'fleet'), 403)
  assert.deepEqual(await warehouseStatus(legacy), [403, 403])

  // 4. Retirada da equipe: o perfil passa a Solicitante, nada sobra, e a auditoria registra o que saiu.
  const removed = await setAccess(admin, operator.id, { role: 'requester', slmMember: false })
  assert.equal(removed.status, 200, removed.text)
  const afterRemoval = await myPermissions(operator)
  for (const permission of [...operational, 'requests:read_all', 'requests:update']) {
    assert.equal(afterRemoval.includes(permission), false, permission)
  }
  assert.equal(await schedule(operator, 'maintenance'), 403)
  assert.deepEqual(await warehouseStatus(operator), [403, 403])
  const lost = await pool.query(
    `SELECT details FROM public.auth_audit_events
      WHERE target_user_id = $1 AND action = 'user.role_changed' ORDER BY id DESC LIMIT 1`,
    [operator.id],
  )
  for (const permission of operational) {
    assert.ok(lost.rows[0].details.effectiveRemoved.includes(permission), `perdida: ${permission}`)
  }
  assert.ok(
    (await pool.query(`SELECT 1 FROM public.auth_audit_events WHERE target_user_id = $1 AND action = 'user.slm_removed'`, [operator.id])).rowCount,
  )

  // 5. Reinclusão: o conjunto volta pelo perfil, com a auditoria do que foi ganho.
  await setAccess(admin, operator.id, { role: 'slm_operator', slmMember: true })
  const back = await myPermissions(operator)
  for (const permission of operational) assert.ok(back.includes(permission), permission)
  const gained = await pool.query(
    `SELECT details FROM public.auth_audit_events
      WHERE target_user_id = $1 AND action = 'user.role_changed' ORDER BY id DESC LIMIT 1`,
    [operator.id],
  )
  for (const permission of operational) {
    assert.ok(gained.rows[0].details.effectiveAdded.includes(permission), `ganha: ${permission}`)
  }

  // 6. Administrador fora da SLM: administra, mas não agenda nem registra previsão.
  const outsider = await createUser('admin-conjunto@example.gov.br', 'administrator')
  const outsiderPermissions = await myPermissions(outsider)
  assert.equal(outsiderPermissions.includes('requests:schedule'), false)
  assert.equal(outsiderPermissions.includes('warehouse:forecast'), false)
  assert.ok(outsiderPermissions.includes('users:manage'))
  assert.equal(await schedule(outsider, 'maintenance'), 403)

  await setAccess(admin, outsider.id, { role: 'requester' })
  await setAccess(admin, operator.id, { role: 'requester' })
})

test('em nome de outro setor: dentro e fora da SLM, com e sem concessão, inclusive administrador', async () => {
  const onBehalf = (session: Session) =>
    policyRoute('/criar', { module: 'maintenance', targetSector: 'Outro Setor' }, session.cookie)
      .then((response) => response.status)
  const grant: Permission[] = ['requests:create_on_behalf']

  const second = await createUser('admin-outro-setor@example.gov.br', 'administrator')
  assert.equal(await onBehalf(second), 403, 'administrador sem equipe nem concessão')

  assert.equal(
    (await setAccess(admin, second.id, { role: 'administrator', grantedPermissions: grant })).status,
    400,
    'concessão fora da equipe',
  )
  await setAccess(admin, second.id, { role: 'administrator', slmMember: true })
  assert.equal(await onBehalf(second), 403, 'na equipe, sem concessão')

  await setAccess(admin, second.id, { role: 'administrator', slmMember: true, grantedPermissions: grant })
  assert.equal(await onBehalf(second), 200, 'na equipe, com concessão')

  const operator = await createUser('operador-outro-setor@example.gov.br', 'slm_operator')
  assert.equal(await onBehalf(operator), 403, 'perfil não concede')
  await setAccess(admin, operator.id, { role: 'slm_operator', slmMember: true, grantedPermissions: grant })
  assert.equal(await onBehalf(operator), 200)

  await setAccess(admin, second.id, { role: 'requester' })
})

test('só Administrador e Operador SLM integram a equipe, na API e no banco', async () => {
  const requester = await createUser('solicitante-equipe@example.gov.br')

  const refused = await setAccess(admin, requester.id, { role: 'requester', slmMember: true })
  assert.equal(refused.status, 400)

  await assert.rejects(
    () =>
      pool.query(
        `UPDATE public.auth_user_access SET slm_member = true WHERE user_id = $1`,
        [requester.id],
      ),
    /check constraint/,
  )
})

test('CPF: com e sem concessão, e a consulta de quem tem acesso fica auditada', async () => {
  const owner = await createUser('titular-matriz@example.gov.br')
  const { passengerId } = await createFlightRequest(owner.id)
  const read = (session: Session) =>
    call(`/flights/passengers/${passengerId}/cpf`, { session }).then((result) => result.status)

  const operator = await createUser('operador-matriz@example.gov.br', 'slm_operator')
  assert.equal(await read(operator), 403, 'operador sem concessão')
  assert.equal(await read(admin), 403, 'administrador sem concessão')

  const second = await createUser('admin-cpf@example.gov.br', 'administrator')
  assert.equal(
    (await setAccess(second, adminId, { role: 'administrator', grantedPermissions: ['flights:cpf:read'] })).status,
    400,
    'administrador fora da equipe não recebe',
  )
  await setAccess(second, adminId, {
    role: 'administrator',
    slmMember: true,
    grantedPermissions: ['flights:cpf:read'],
  })
  assert.equal(await read(admin), 200, 'administrador na equipe, com concessão individual')
  await setAccess(second, adminId, { role: 'administrator', slmMember: true })
  assert.equal(await read(admin), 403, 'concessão retirada vale na mesma sessão')
  await setAccess(second, adminId, { role: 'administrator' })

  const refused = await setAccess(admin, owner.id, { grantedPermissions: ['flights:cpf:read'] })
  assert.equal(refused.status, 400, 'solicitante não é elegível, nem para os próprios passageiros')
  assert.equal(await read(owner), 403)

  await setAccess(admin, second.id, { role: 'requester' })
})

test('sair da SLM revoga no servidor, mesmo com reenvio, e voltar não devolve', async () => {
  const owner = await createUser('titular-saida@example.gov.br')
  const { passengerId } = await createFlightRequest(owner.id)
  const operator = await createUser('operador-saida@example.gov.br', 'slm_operator')
  const special: Permission[] = ['flights:cpf:read', 'requests:schedule', 'requests:create_on_behalf']

  await setAccess(admin, operator.id, {
    role: 'slm_operator',
    slmMember: true,
    grantedPermissions: [...special, 'reports:read'],
  })
  assert.equal((await call(`/flights/passengers/${passengerId}/cpf`, { session: operator })).status, 200)

  // O navegador ainda envia as concessões, como a tela faz ao salvar o formulário.
  const removed = await setAccess(admin, operator.id, {
    role: 'requester',
    slmMember: false,
    grantedPermissions: [...special, 'reports:read'],
  })
  assert.equal(removed.status, 200)
  assert.deepEqual([...removed.body.user.revokedPermissions].sort(), [...special].sort())
  assert.deepEqual(removed.body.user.grantedPermissions, ['reports:read'], 'as demais continuam')

  const stored = await currentAccess(operator.id)
  assert.deepEqual(stored.granted_permissions, ['reports:read'])
  assert.equal(stored.slm_member, false)

  const permissions = await myPermissions(operator)
  for (const permission of special) {
    assert.equal(permissions.includes(permission), false, permission)
  }
  assert.equal((await call(`/flights/passengers/${passengerId}/cpf`, { session: operator })).status, 403)

  // Auditoria calculada pelo acesso efetivo, com o motivo.
  const { rows } = await pool.query(
    `SELECT action, details FROM public.auth_audit_events
      WHERE target_user_id = $1 AND action IN ('user.cpf_access_revoked', 'user.permissions_changed')
      ORDER BY id DESC LIMIT 2`,
    [operator.id],
  )
  const revokedCpf = rows.find((row) => row.action === 'user.cpf_access_revoked')
  const changed = rows.find((row) => row.action === 'user.permissions_changed')
  assert.equal(revokedCpf.details.reason, 'slm_removed')
  assert.equal(changed.details.reason, 'slm_removed')
  assert.deepEqual([...changed.details.automaticallyRevoked].sort(), [...special].sort())

  // Voltar à equipe não devolve as concessões individuais; o agendamento volta só por ser
  // padrão do perfil Operador SLM na equipe, e não fica gravado como concessão.
  await setAccess(admin, operator.id, { role: 'slm_operator', slmMember: true, grantedPermissions: ['reports:read'] })
  const back = await myPermissions(operator)
  for (const permission of ['flights:cpf:read', 'requests:create_on_behalf'] as const) {
    assert.equal(back.includes(permission), false, permission)
  }
  assert.ok(back.includes('requests:schedule'), 'padrão do perfil')
  assert.deepEqual((await currentAccess(operator.id)).granted_permissions, ['reports:read'])
})

test('rebaixar um administrador revoga o CPF, e ele não volta ao ser promovido de novo', async () => {
  const target = await createUser('admin-rebaixado@example.gov.br', 'administrator')

  await setAccess(admin, target.id, {
    role: 'administrator',
    slmMember: true,
    grantedPermissions: ['flights:cpf:read'],
  })
  assert.ok((await myPermissions(target)).includes('flights:cpf:read'))

  const demoted = await setAccess(admin, target.id, {
    role: 'requester',
    grantedPermissions: ['flights:cpf:read'],
  })
  assert.equal(demoted.status, 200)
  assert.deepEqual(demoted.body.user.revokedPermissions, ['flights:cpf:read'])

  await setAccess(admin, target.id, { role: 'administrator' })
  assert.equal((await myPermissions(target)).includes('flights:cpf:read'), false)
  await setAccess(admin, target.id, { role: 'requester' })
})

test('administrador que sai da SLM perde o CPF, com auditoria, e voltar não devolve', async () => {
  const owner = await createUser('titular-admin-saida@example.gov.br')
  const { passengerId } = await createFlightRequest(owner.id)
  const target = await createUser('admin-saida@example.gov.br', 'administrator')
  const read = () =>
    call(`/flights/passengers/${passengerId}/cpf`, { session: target }).then((result) => result.status)

  await setAccess(admin, target.id, {
    role: 'administrator',
    slmMember: true,
    grantedPermissions: ['flights:cpf:read', 'requests:create_on_behalf', 'reports:read'],
  })
  assert.equal(await read(), 200)

  // O navegador ainda reenvia a concessão ao salvar a saída da equipe.
  const removed = await setAccess(admin, target.id, {
    role: 'administrator',
    slmMember: false,
    grantedPermissions: ['flights:cpf:read', 'requests:create_on_behalf', 'reports:read'],
  })
  assert.equal(removed.status, 200)
  assert.deepEqual(
    [...removed.body.user.revokedPermissions].sort(),
    ['flights:cpf:read', 'requests:create_on_behalf'],
  )
  assert.deepEqual((await currentAccess(target.id)).granted_permissions, ['reports:read'])
  assert.equal(await read(), 403, 'vale na mesma sessão')

  const { rows } = await pool.query(
    `SELECT details->>'reason' AS reason FROM public.auth_audit_events
      WHERE target_user_id = $1 AND action = 'user.cpf_access_revoked'
      ORDER BY id DESC LIMIT 1`,
    [target.id],
  )
  assert.equal(rows[0].reason, 'slm_removed')

  // Fora da equipe, nem nova concessão pela API nem valor forçado no banco.
  const refused = await setAccess(admin, target.id, {
    role: 'administrator',
    slmMember: false,
    grantedPermissions: ['flights:cpf:read'],
  })
  assert.equal(refused.status, 400)
  await pool.query(
    `UPDATE public.auth_user_access SET granted_permissions = '{flights:cpf:read}' WHERE user_id = $1`,
    [target.id],
  )
  assert.equal(await read(), 403)
  await pool.query(
    `UPDATE public.auth_user_access SET granted_permissions = '{}' WHERE user_id = $1`,
    [target.id],
  )

  // Voltar à equipe não devolve; só uma nova concessão individual.
  await setAccess(admin, target.id, { role: 'administrator', slmMember: true })
  assert.equal(await read(), 403)
  await setAccess(admin, target.id, {
    role: 'administrator',
    slmMember: true,
    grantedPermissions: ['flights:cpf:read'],
  })
  assert.equal(await read(), 200)

  // Desativar um administrador também revoga, e reativar não devolve.
  const deactivated = await call(`/admin/users/${target.id}/deactivate`, { method: 'POST', session: admin })
  assert.deepEqual(deactivated.body.user.revokedPermissions, ['flights:cpf:read'])
  await call(`/admin/users/${target.id}/activate`, { method: 'POST', session: admin })
  const session = await signIn('admin-saida@example.gov.br')
  assert.equal((await myPermissions(session)).includes('flights:cpf:read'), false)

  await setAccess(admin, target.id, { role: 'requester' })
})

test('ninguém concede CPF a si mesmo, nem o administrador', async () => {
  const self = await setAccess(admin, adminId, {
    role: 'administrator',
    slmMember: true,
    grantedPermissions: ['flights:cpf:read'],
  })
  assert.equal(self.status, 403)
  assert.equal((await myPermissions(admin)).includes('flights:cpf:read'), false)
})

test('desativar revoga as permissões especiais, com auditoria, e reativar não devolve', async () => {
  const operator = await createUser('operador-desativado@example.gov.br', 'slm_operator')
  const email = 'operador-desativado@example.gov.br'
  await setAccess(admin, operator.id, {
    role: 'slm_operator',
    slmMember: true,
    grantedPermissions: ['flights:cpf:read', 'requests:schedule', 'reports:read'],
  })

  const deactivated = await call(`/admin/users/${operator.id}/deactivate`, {
    method: 'POST',
    session: admin,
  })
  assert.equal(deactivated.status, 200)
  assert.deepEqual(
    [...deactivated.body.user.revokedPermissions].sort(),
    ['flights:cpf:read', 'requests:schedule'],
  )
  assert.deepEqual((await currentAccess(operator.id)).granted_permissions, ['reports:read'])

  const { rows } = await pool.query(
    `SELECT action, details->>'reason' AS reason FROM public.auth_audit_events
      WHERE target_user_id = $1 AND action IN ('user.cpf_access_revoked', 'user.permissions_changed')
      ORDER BY id DESC LIMIT 2`,
    [operator.id],
  )
  assert.deepEqual(rows.map((row) => row.reason), ['account_deactivated', 'account_deactivated'])

  await call(`/admin/users/${operator.id}/activate`, { method: 'POST', session: admin })
  const session = await signIn(email)
  const permissions = await myPermissions(session)
  assert.equal(permissions.includes('flights:cpf:read'), false)
  // O agendamento volta só como padrão do perfil Operador SLM na equipe, não como concessão.
  assert.ok(permissions.includes('requests:schedule'), 'padrão do perfil')
  assert.deepEqual((await currentAccess(operator.id)).granted_permissions, ['reports:read'])
  assert.ok(permissions.includes('reports:read'), 'as demais concessões permanecem')
})

test('nenhuma permissão essencial pode ser retirada de um administrador, e a retirada forçada é ignorada', async () => {
  const second = await createUser('admin-essencial@example.gov.br', 'administrator')
  const essentials: Permission[] = [
    'users:read', 'users:approve', 'users:manage', 'audit:read', 'settings:read', 'settings:manage',
  ]

  for (const permission of essentials) {
    const refused = await setAccess(admin, second.id, {
      role: 'administrator',
      deniedPermissions: [permission],
    })
    assert.equal(refused.status, 400, permission)
    assert.ok((await myPermissions(second)).includes(permission), permission)
  }

  await pool.query(
    `UPDATE public.auth_user_access SET denied_permissions = $2 WHERE user_id = $1`,
    [second.id, essentials],
  )
  const forced = await myPermissions(second)
  for (const permission of essentials) {
    assert.ok(forced.includes(permission), permission)
  }
  assert.equal((await call('/admin/users', { session: second })).status, 200)

  await setAccess(admin, second.id, { role: 'requester' })
})

test('as tabelas não podem divergir, e as operações legítimas continuam funcionando', async () => {
  const user = await createUser('coerencia@example.gov.br')

  await assert.rejects(
    () => pool.query(`UPDATE public.auth_users SET role = 'admin' WHERE id = $1`, [user.id]),
    /divergente/,
  )
  await assert.rejects(
    () => pool.query(`UPDATE public.auth_user_access SET profile = 'administrator' WHERE user_id = $1`, [user.id]),
    /divergente/,
  )

  const row = await pool.query(
    `SELECT u.role, a.profile FROM public.auth_users u
       JOIN public.auth_user_access a ON a.user_id = u.id WHERE u.id = $1`,
    [user.id],
  )
  assert.deepEqual(row.rows[0], { role: 'operator', profile: 'requester' })

  // Alterar as duas na mesma transação é aceito, porque a checagem é no fim dela.
  const client = await pool.connect()
  await client.query('BEGIN')
  await client.query(`UPDATE public.auth_user_access SET profile = 'administrator' WHERE user_id = $1`, [user.id])
  await client.query(`UPDATE public.auth_users SET role = 'admin' WHERE id = $1`, [user.id])
  await client.query('COMMIT')
  client.release()
  assert.equal((await call('/auth/me', { session: user })).body.user.role, 'administrator')

  // Perfil, aprovação e desativação passam pelo caminho normal.
  assert.equal((await setAccess(admin, user.id, { role: 'requester' })).status, 200)
  assert.equal(
    (await call(`/admin/users/${user.id}/deactivate`, { method: 'POST', session: admin })).status,
    200,
  )
  const approved = await createUser('coerencia-aprovada@example.gov.br', 'slm_operator')
  assert.equal((await currentAccess(approved.id)).profile, 'slm_operator')
})
