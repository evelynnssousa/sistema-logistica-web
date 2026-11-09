import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { Pool } from 'pg'
import app from '../app.js'
import { hashPassword } from '../auth/password.js'
import type { Permission } from '../auth/permissions.js'
import { processEmailQueue, publishOverdueAlerts } from '../integrations/worker.js'
import { readBackupStatus, recordAvailability } from '../monitoring/healthChecks.js'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'

// Supercomando 04, pela API real, em um PostgreSQL descartável.

const password = randomBytes(24).toString('hex')
const schema = (file: string) =>
  readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')

const fictionalCpf = '00000000191'

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
  const result = await call('/auth/login', { method: 'POST', body: { identifier: email, password } })
  assert.equal(result.status, 200, `login de ${email}`)
  return { cookie: result.setCookie, id: result.body.user.id }
}

let admin: Session
let central: Session
let requester: Session
const options: Record<string, string> = {}

async function createUser(
  email: string,
  role: 'requester' | 'slm_operator' | 'administrator' = 'requester',
  sector = 'Protocolo',
): Promise<Session> {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { fullName: `Pessoa ${email.split('@')[0]}`, email, sector, password, passwordConfirmation: password },
  })
  assert.equal(registered.status, 202)
  const pending = await call('/admin/registrations/pending', { session: admin })
  const id = pending.body.registrations.find(
    (registration: { email: string }) => registration.email === email,
  ).id
  assert.equal((await post(`/admin/registrations/${id}/approve`, admin, { role })).status, 200)
  return signIn(email)
}

function setAccess(
  userId: string,
  access: { role: string; slmMember?: boolean; grantedPermissions?: Permission[]; deniedPermissions?: Permission[] },
) {
  return put(`/admin/users/${userId}/access`, admin, {
    slmMember: false,
    grantedPermissions: [],
    deniedPermissions: [],
    ...access,
  })
}

async function staff(email: string, grants: Permission[] = [], denied: Permission[] = []): Promise<Session> {
  const user = await createUser(email, 'slm_operator', 'CPC')
  const result = await setAccess(user.id, { role: 'slm_operator', slmMember: true, grantedPermissions: grants, deniedPermissions: denied })
  assert.equal(result.status, 200, result.text)
  return user
}

async function option(category: string, label: string) {
  const created = await post(`/settings/catalog/${category}`, admin, { label })
  assert.equal(created.status, 201, created.text)
  options[label] = created.body.option.id
}

const maintenanceBody = (extra: Record<string, unknown> = {}) => ({
  andarId: options['1º andar'],
  tipoServicoId: options['Elétrica'],
  localServico: 'Sala de arquivo',
  descricao: 'Lâmpada queimada',
  ...extra,
})

const newRequest = async (session: Session = requester, extra: Record<string, unknown> = {}) => {
  const created = await post('/maintenance/requests', session, maintenanceBody(extra))
  assert.equal(created.status, 201, created.text)
  return created.body as { id: string; protocol: string }
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
    '006_integrations.sql',
  ]) {
    await setup.query(schema(file))
  }
  setup.release(true)
  resetAccessSchemaCacheForTests()

  await pool.query(
    `INSERT INTO public.auth_users
      (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'central-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )

  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('central-admin@example.gov.br')

  await option('floors', '1º andar')
  await option('serviceTypes', 'Elétrica')
  await option('measurementUnits', 'Unidade')
  await option('sectors', 'Protocolo')
  await option('sectors', 'CPC')

  requester = await createUser('central-solicitante@example.gov.br')
})

after(async () => {
  delete process.env.PASSENGER_DATA_KEY
  delete process.env.PASSWORD_RESET_PEPPER
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

// ---------------------------------------------------------------------------
// Protocolo
// ---------------------------------------------------------------------------

test('sem a 007: a solicitação segue funcionando com o número antigo, e a Central responde 503', async () => {
  const created = await newRequest()
  assert.match(created.protocol, /^\d+$/)

  const detail = await call(`/maintenance/requests/${created.id}`, { session: requester })
  assert.equal(detail.status, 200)
  assert.deepEqual(detail.body.notes, [])

  const operator = await staff('central-pre@example.gov.br', ['slm_central:read'])
  const overview = await call('/slm/overview', { session: operator })
  assert.equal(overview.status, 503)
  assert.equal(overview.body.code, 'MODULES_MIGRATION_REQUIRED')
})

test('migração 007 em banco com dados: dá código aos registros, sem mexer em nenhum outro campo', async () => {
  const existing = await newRequest()
  await pool.query(
    `INSERT INTO public.material_requests (origem, status, solicitante_id, registrado_por)
     VALUES ('interna', 'pendente', $1, $1)`,
    [requester.id],
  )
  const before = await pool.query(
    `SELECT id, protocolo, status, titulo, updated_at FROM public.service_requests ORDER BY id`,
  )

  await pool.query(schema('007_operations_center.sql'))

  const after = await pool.query(
    `SELECT id, protocolo, status, titulo, updated_at, protocolo_codigo FROM public.service_requests ORDER BY id`,
  )
  assert.equal(after.rows.length, before.rows.length)
  after.rows.forEach((row, index) => {
    const { protocolo_codigo: code, ...rest } = row
    assert.deepEqual(rest, before.rows[index])
    assert.match(code, /^MAN-\d{4}-\d{5}$/)
  })

  const detail = await call(`/maintenance/requests/${existing.id}`, { session: requester })
  assert.match(detail.body.request.protocol, /^MAN-\d{4}-\d{5}$/)
  // O número antigo continua pesquisável.
  const oldNumber = after.rows.find((row) => row.id === existing.id).protocolo
  const list = await call(`/maintenance/requests?search=${oldNumber}`, { session: requester })
  assert.equal(list.body.requests.some((item: { id: string }) => item.id === existing.id), true)

  const warehouse = await pool.query(`SELECT protocolo_codigo FROM public.material_requests`)
  assert.match(warehouse.rows[0].protocolo_codigo, /^ALM-\d{4}-00001$/)
})

test('protocolo: simultâneo sem duplicar, por módulo, e permanente', async () => {
  const year = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getFullYear()
  const created = await Promise.all(Array.from({ length: 20 }, () => newRequest()))
  const codes = created.map((item) => item.protocol)
  assert.equal(new Set(codes).size, 20)
  for (const code of codes) assert.match(code, new RegExp(`^MAN-${year}-\\d{5}$`))

  const fleet = await post('/fleet/requests', requester, {
    origem: 'Sede',
    destino: 'Fórum',
    dataHora: '2027-03-10T13:00:00.000Z',
    finalidade: 'Entrega de documentos',
    passageiros: [{ nome: 'Pessoa Fictícia' }],
  })
  assert.equal(fleet.status, 201, fleet.text)
  assert.equal(fleet.body.protocol, `FRO-${year}-00001`)

  const flight = await post('/flights/requests', requester, {
    andarId: options['1º andar'],
    tipoViagem: 'somente_ida',
    ida: { origem: 'GRU', destino: 'BSB', data: '2027-04-01', horario: '08:00' },
    bagagem: 'Bagagem de mão',
    passageiros: [{ nome: 'Passageira Fictícia', cpf: fictionalCpf }],
  })
  assert.equal(flight.status, 201, flight.text)
  assert.equal(flight.body.protocol, `PAS-${year}-00001`)

  // O código não muda, nem por comando direto.
  await assert.rejects(
    pool.query(`UPDATE public.service_requests SET protocolo_codigo = 'MAN-2000-00001' WHERE id = $1`, [created[0].id]),
    /permanente/,
  )

  // Valor enviado é ignorado, e excluir um registro não libera o número.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const inserted = await client.query(
      `INSERT INTO public.service_requests (tipo, solicitante_id, titulo, protocolo_codigo)
       VALUES ('manutencao', $1, 'Teste', 'MAN-1999-00001') RETURNING id, protocolo_codigo`,
      [requester.id],
    )
    assert.doesNotMatch(inserted.rows[0].protocolo_codigo, /1999/)
    await client.query('ROLLBACK')
  } finally {
    client.release()
  }

  const last = await newRequest()
  await pool.query(`DELETE FROM public.request_history WHERE false`)
  const counter = await pool.query(
    `SELECT ultimo FROM public.protocol_counters WHERE prefixo = 'MAN' AND ano = $1`,
    [year],
  )
  const lastNumber = Number(last.protocol.split('-')[2])
  assert.equal(counter.rows[0].ultimo, lastNumber)
})

test('protocolo: Almoxarifado usa ALM em pedidos e conferências; e-mail e notificação usam o código', async () => {
  const material = await post('/warehouse/materials', admin, {
    name: 'Papel A4',
    unitId: options.Unidade,
  })
  assert.equal(material.status, 201, material.text)
  const check = await post('/warehouse/inventory-checks', admin, {
    title: 'Conferência mensal',
    referenceDate: '2027-01-15',
    items: [{ materialId: material.body.id, governmentQuantity: 10 }],
  })
  assert.equal(check.status, 201, check.text)
  const loaded = await call(`/warehouse/inventory-checks/${check.body.id}`, { session: admin })
  assert.match(loaded.body.check.protocol, /^ALM-\d{4}-\d{5}$/)

  const created = await newRequest()
  const emails = await pool.query(
    `SELECT d.subject FROM public.email_deliveries d
       JOIN public.integration_events e ON e.id = d.event_id WHERE e.resource_id = $1`,
    [created.id],
  )
  assert.ok(emails.rows.length > 0)
  assert.ok(emails.rows[0].subject.includes(created.protocol))
  assert.ok(!emails.rows[0].subject.includes('#'))
})

// ---------------------------------------------------------------------------
// Central de Operações
// ---------------------------------------------------------------------------

test('Central: só com concessão individual a integrante da SLM; administrador não entra pelo perfil', async () => {
  // Administrador do sistema, sem estar na equipe.
  assert.equal((await call('/slm/overview', { session: admin })).status, 403)
  assert.equal((await call('/slm/overview', { session: requester })).status, 403)

  // Operador da SLM sem a concessão.
  const noGrant = await staff('central-sem@example.gov.br')
  assert.equal((await call('/slm/overview', { session: noGrant })).status, 403)

  // Concessão fora da equipe é recusada.
  const outsider = await createUser('central-fora@example.gov.br')
  const refused = await setAccess(outsider.id, { role: 'requester', grantedPermissions: ['slm_central:read'] })
  assert.equal(refused.status, 400)

  central = await staff('central-operadora@example.gov.br', ['slm_central:read', 'slm_central:manage'])
  assert.equal((await call('/slm/overview', { session: central })).status, 200)

  // Só leitura: consulta, mas não altera.
  const reader = await staff('central-leitura@example.gov.br', ['slm_central:read'])
  const target = await newRequest()
  assert.equal((await call('/slm/requests', { session: reader })).status, 200)
  assert.equal(
    (await post(`/slm/requests/${target.id}/assign`, reader, { responsavelId: reader.id })).status,
    403,
  )
})

test('Central: indicadores coincidem com as listas, e os filtros combinam', async () => {
  const unassigned = await newRequest()
  const overview = await call('/slm/overview', { session: central })
  assert.equal(overview.status, 200)
  assert.ok(overview.body.counts.unassigned > 0)
  assert.ok(overview.body.byModule.length > 0)
  assert.ok(overview.body.communications.emailsNotConfigured >= 0)

  for (const queue of Object.keys(overview.body.counts)) {
    const list = await call(`/slm/requests?queue=${queue}`, { session: central })
    assert.equal(list.status, 200, `${queue}: ${list.text}`)
    assert.equal(list.body.total, overview.body.counts[queue], queue)
  }

  const byProtocol = await call(`/slm/requests?search=${unassigned.protocol}`, { session: central })
  assert.equal(byProtocol.body.total, 1)
  assert.equal(byProtocol.body.requests[0].id, unassigned.id)

  const filtered = await call(`/slm/requests?module=fleet&search=${unassigned.protocol}`, { session: central })
  assert.equal(filtered.body.total, 0)

  // Sem leitura de Passagens, o módulo some da Central.
  const noFlights = await staff('central-sem-passagens@example.gov.br', ['slm_central:read'])
  await setAccess(noFlights.id, {
    role: 'slm_operator',
    slmMember: true,
    grantedPermissions: ['slm_central:read'],
    deniedPermissions: ['flights:read'],
  })
  const list = await call('/slm/requests?module=flights', { session: noFlights })
  assert.equal(list.body.total, 0)
})

test('Central: atribuição, transferência com justificativa, prioridade, prazo e histórico de→para', async () => {
  const other = await staff('central-colega@example.gov.br')
  const created = await newRequest()
  const base = `/slm/requests/${created.id}`

  assert.equal((await post(`${base}/assign`, central, { responsavelId: requester.id })).status, 400)

  // Primeira atribuição é rotina.
  assert.equal((await post(`${base}/assign`, central, { responsavelId: central.id })).status, 200)

  // Transferir exige motivo.
  assert.equal((await post(`${base}/assign`, central, { responsavelId: other.id })).status, 400)
  assert.equal(
    (await post(`${base}/assign`, central, { responsavelId: other.id, justificativa: 'Férias da titular' })).status,
    200,
  )

  // Prioridade sem justificativa, não.
  assert.equal((await post(`${base}/priority`, central, { prioridade: 'urgente' })).status, 400)
  assert.equal((await post(`${base}/priority`, central, { prioridade: 'qualquer', justificativa: 'abc' })).status, 400)
  assert.equal(
    (await post(`${base}/priority`, central, { prioridade: 'urgente', justificativa: 'Risco elétrico' })).status,
    200,
  )

  assert.equal((await post(`${base}/deadline`, central, { prazo: '2030-01-10T15:00:00.000Z' })).status, 200)
  assert.equal((await post(`${base}/deadline`, central, { prazo: '2030-01-11T15:00:00.000Z' })).status, 400)
  assert.equal((await post(`${base}/complexity`, central, { complexidade: 'complexa' })).status, 200)

  assert.equal((await post(`${base}/notes`, central, { texto: `CPF ${fictionalCpf} citado` })).status, 201)

  const staffView = await call(`/maintenance/requests/${created.id}`, { session: central })
  assert.equal(staffView.body.request.priority, 'urgente')
  assert.equal(staffView.body.request.complexity, 'complexa')
  assert.equal(staffView.body.request.responsible, 'Pessoa central-colega')
  assert.ok(!staffView.text.includes(fictionalCpf), 'o CPF não pode ficar em observações')
  assert.equal(staffView.body.notes.length, 1)

  const transfer = staffView.body.history.filter((entry: any) => entry.action === 'responsavel_alterado')[1]
  assert.deepEqual(transfer.details.alteracoes[0], {
    campo: 'Responsável',
    de: 'Pessoa central-operadora',
    para: 'Pessoa central-colega',
  })
  assert.equal(transfer.comment, 'Férias da titular')

  // Solicitante acompanha o fato, sem o contexto interno.
  const own = await call(`/maintenance/requests/${created.id}`, { session: requester })
  assert.deepEqual(own.body.notes, [])
  assert.deepEqual(own.body.communications, [])
  const actions = own.body.history.map((entry: any) => entry.action)
  for (const hidden of ['nota_interna', 'prioridade_alterada', 'prazo_alterado', 'complexidade_alterada']) {
    assert.ok(!actions.includes(hidden), hidden)
  }
  assert.ok(!own.text.includes('Férias da titular'))
  assert.ok(!own.text.includes('Risco elétrico'))

  // A nota é registro permanente.
  await assert.rejects(pool.query(`DELETE FROM public.request_internal_notes`), /não podem ser alterados/)

  // Auditoria e notificação à pessoa atribuída, sem repetir.
  const audited = await pool.query(
    `SELECT action FROM public.auth_audit_events WHERE target_resource_id = $1 ORDER BY id`,
    [created.id],
  )
  const auditedActions = audited.rows.map((row) => row.action)
  for (const action of ['request.assigned', 'request.priority_changed', 'request.deadline_changed', 'request.note_added']) {
    assert.ok(auditedActions.includes(action), action)
  }
  const notifications = await call('/notifications?pending=true', { session: other })
  const received = notifications.body.notifications.filter(
    (item: any) => item.category === 'atribuicao' && item.link === `/manutencao/${created.id}`,
  )
  assert.equal(received.length, 1)
  assert.equal(received[0].requiresAction, true)
  assert.ok(received[0].title.includes(created.protocol))

  // Repetir a mesma atribuição não gera outro registro.
  const count = staffView.body.history.length
  assert.equal(
    (await post(`${base}/assign`, central, { responsavelId: other.id, justificativa: 'Sem mudança' })).status,
    200,
  )
  const again = await call(`/maintenance/requests/${created.id}`, { session: central })
  assert.equal(again.body.history.length, count)

  const team = await call('/slm/team', { session: central })
  const member = team.body.team.find((item: any) => item.id === other.id)
  assert.ok(member.open >= 1)
  assert.ok(member.urgent >= 1)
  assert.ok(member.complexity.complex >= 1)
  assert.equal('score' in member, false)
})

test('Central: encerrada não é redistribuída, e atraso e parada são identificados', async () => {
  const created = await newRequest()
  await pool.query(
    `UPDATE public.service_requests SET prazo_em = now() - interval '1 day' WHERE id = $1`,
    [created.id],
  )
  // Move updated_at para o passado sem o gatilho, como se estivesse parada.
  await pool.query(`ALTER TABLE public.service_requests DISABLE TRIGGER trg_sr_updated_at`)
  await pool.query(
    `UPDATE public.service_requests SET updated_at = now() - interval '30 days' WHERE id = $1`,
    [created.id],
  )
  await pool.query(`ALTER TABLE public.service_requests ENABLE TRIGGER trg_sr_updated_at`)

  const late = await call(`/slm/requests?queue=late&search=${created.protocol}`, { session: central })
  assert.equal(late.body.total, 1)
  assert.equal(late.body.requests[0].late, true)
  const stale = await call(`/slm/requests?queue=stale&search=${created.protocol}`, { session: central })
  assert.equal(stale.body.total, 1)

  // Aviso de prazo vencido, uma única vez.
  await post(`/slm/requests/${created.id}/assign`, central, { responsavelId: central.id })
  await publishOverdueAlerts()
  await publishOverdueAlerts()
  const notified = await pool.query(
    `SELECT n.id FROM public.user_notifications n
       JOIN public.integration_events e ON e.id = n.event_id
      WHERE e.resource_id = $1 AND e.event_type = 'request_overdue'`,
    [created.id],
  )
  // Quem atribuiu é o próprio responsável: o aviso de atribuição não vai a si mesmo, o de prazo vai.
  assert.equal(notified.rows.length, 1)

  const cancelled = await post(`/maintenance/requests/${created.id}/cancel`, central, { motivo: 'Duplicada' })
  assert.equal(cancelled.status, 200, cancelled.text)
  assert.equal(
    (await post(`/slm/requests/${created.id}/assign`, central, { responsavelId: null, justificativa: 'Teste' })).status,
    409,
  )
})

// ---------------------------------------------------------------------------
// Linha do tempo e justificativas
// ---------------------------------------------------------------------------

test('linha do tempo: edição guarda de→para, e dado relevante exige justificativa', async () => {
  const created = await newRequest()
  const path = `/maintenance/requests/${created.id}`

  // Antes de agendar, editar o local é rotina.
  assert.equal((await patch(path, central, { localServico: 'Sala 2' })).status, 200)

  // Prioridade exige justificativa em qualquer etapa.
  assert.equal((await patch(path, central, { prioridade: 'alta' })).status, 400)

  const scheduler = await staff('central-agenda@example.gov.br', ['requests:schedule'])
  const scheduled = await post(`${path}/schedule`, scheduler, { dataAgendada: '2031-05-05T13:00:00.000Z' })
  assert.equal(scheduled.status, 200, scheduled.text)

  // Depois de agendado, mudar o local também exige.
  assert.equal((await patch(path, central, { localServico: 'Sala 3' })).status, 400)
  assert.equal(
    (await patch(path, central, { localServico: 'Sala 3', justificativa: 'Mudou o local do defeito' })).status,
    200,
  )
  // Observação não é dado relevante.
  assert.equal((await patch(path, central, { observacoes: 'Levar escada' })).status, 200)

  const detail = await call(path, { session: central })
  const edits = detail.body.history.filter((entry: any) => entry.action === 'editada')
  assert.equal(edits.length, 3)
  const change = edits[1].details.alteracoes.find((item: any) => item.campo === 'Local')
  assert.deepEqual(change, { campo: 'Local', de: 'Sala 2', para: 'Sala 3' })
  assert.equal(edits[1].comment, 'Mudou o local do defeito')

  // Histórico continua protegido, inclusive contra o próprio banco.
  await assert.rejects(pool.query(`UPDATE public.request_history SET comentario = 'x'`), /não podem ser alterados/)

  // Comunicações aparecem só como situação, sem destinatário.
  assert.ok(detail.body.communications.length > 0)
  assert.equal('recipient' in detail.body.communications[0], false)
  assert.ok(!JSON.stringify(detail.body.communications).includes('@'))
})

// ---------------------------------------------------------------------------
// Notificações e parâmetros
// ---------------------------------------------------------------------------

test('parâmetros: só quem administra altera; categoria desativada some do perfil e volta ao reativar', async () => {
  assert.equal((await call('/settings/parameters', { session: requester })).status, 403)
  assert.equal((await put('/settings/parameters/notifications', central, {})).status, 403)

  const current = await call('/settings/parameters', { session: admin })
  assert.equal(current.status, 200)
  assert.equal(current.body.settings.operations.staleDays, 5)

  assert.equal((await put('/settings/parameters/inexistente', admin, {})).status, 404)
  assert.equal((await put('/settings/parameters/operations', admin, { staleDays: 0 })).status, 400)

  await newRequest(requester)
  const before = await call('/notifications', { session: central })
  const newOnes = before.body.notifications.filter((item: any) => item.category === 'nova_solicitacao')
  assert.ok(newOnes.length > 0)

  assert.equal(
    (await put('/settings/parameters/notifications', admin, {
      disabled: { slm_operator: ['nova_solicitacao', 'categoria-inventada'] },
    })).status,
    200,
  )
  const hidden = await call('/notifications', { session: central })
  assert.equal(hidden.body.notifications.some((item: any) => item.category === 'nova_solicitacao'), false)
  const saved = await call('/settings/parameters', { session: admin })
  assert.deepEqual(saved.body.settings.notifications.disabled.slm_operator, ['nova_solicitacao'])

  assert.equal((await put('/settings/parameters/notifications', admin, { disabled: {} })).status, 200)
  const back = await call('/notifications', { session: central })
  assert.equal(back.body.notifications.some((item: any) => item.category === 'nova_solicitacao'), true)

  // Prazo padrão por prioridade.
  assert.equal(
    (await put('/settings/parameters/operations', admin, {
      staleDays: 7,
      deadlineDays: { normal: 3 },
    })).status,
    200,
  )
  const withDeadline = await newRequest(requester)
  const detail = await call(`/maintenance/requests/${withDeadline.id}`, { session: central })
  const days = (new Date(detail.body.request.deadline).getTime() - Date.now()) / 86_400_000
  assert.ok(days > 2.9 && days <= 3)
  await put('/settings/parameters/operations', admin, { staleDays: 5, deadlineDays: {} })
})

// ---------------------------------------------------------------------------
// Anexos
// ---------------------------------------------------------------------------

const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const pdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')

async function upload(
  session: Session,
  path: string,
  content: Buffer,
  name: string,
  query = '',
) {
  const cookie = session.cookie
  const response = await fetch(`${baseUrl}/api${path}${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      cookie,
      'x-csrf-token': csrfTokens.get(cookie) as string,
      'x-file-name': encodeURIComponent(name),
    },
    body: new Uint8Array(content),
  })
  const text = await response.text()
  return { status: response.status, body: JSON.parse(text) as Record<string, any>, text }
}

function download(session: Session, id: string, query = '') {
  return fetch(`${baseUrl}/api/attachments/files/${id}/content${query}`, {
    headers: { cookie: session.cookie },
  })
}

test('anexos: sem armazenamento configurado responde 503 e nada é gravado', async () => {
  await pool.query(schema('008_attachments.sql'))
  const created = await newRequest()
  const path = `/attachments/resources/service_request/${created.id}`

  const listed = await call(path, { session: requester })
  assert.equal(listed.status, 200)
  assert.equal(listed.body.storageConfigured, false)

  const refused = await upload(requester, path, pngBytes, 'foto.png')
  assert.equal(refused.status, 503, refused.text)
  const rows = await pool.query(`SELECT count(*)::int AS total FROM public.request_attachments`)
  assert.equal(rows.rows[0].total, 0)
})

test('anexos: validação real, acesso por solicitação, restrição, remoção lógica e auditoria', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'slm-anexos-'))
  process.env.ATTACHMENTS_DIR = directory
  try {
    const created = await newRequest()
    const path = `/attachments/resources/service_request/${created.id}`
    const stranger = await createUser('anexo-estranho@example.gov.br')

    // Estranho: como se não existisse, ao listar, enviar ou baixar.
    assert.equal((await call(path, { session: stranger })).status, 404)
    assert.equal((await upload(stranger, path, pngBytes, 'foto.png')).status, 404)

    // Conteúdo manda, não o nome.
    assert.equal((await upload(requester, path, Buffer.from('MZ\x90\x00binario'), 'relatorio.pdf')).status, 400)
    assert.equal((await upload(requester, path, pngBytes, 'foto.pdf')).status, 400)
    assert.equal((await upload(requester, path, pdfBytes, 'virus.exe.pdf')).status, 400)
    assert.equal(
      (await upload(requester, path, Buffer.from('%PDF-1.7\n<< /JavaScript (x) >>\n'), 'a.pdf')).status,
      400,
    )
    assert.equal((await upload(requester, path, Buffer.from('<html><script>1</script></html>'), 'a.txt')).status, 400)
    assert.equal((await upload(requester, path, pngBytes, 'a.png', '?categoria=inventada')).status, 400)
    assert.equal(readdirSync(directory).length, 0, 'nada recusado chega ao disco')

    const sent = await upload(requester, path, pngBytes, '../../etc/foto antes.png', '?categoria=fotografia_antes')
    assert.equal(sent.status, 201, sent.text)

    const staffFile = await upload(central, path, pdfBytes, 'orcamento.pdf', '?categoria=orcamento&restrito=true')
    assert.equal(staffFile.status, 201, staffFile.text)

    // O arquivo fica fora de qualquer pasta pública, com permissão só do processo.
    const folder = readdirSync(directory)[0]
    const stored = readdirSync(join(directory, folder))[0]
    assert.equal(statSync(join(directory, folder, stored)).mode & 0o077, 0)
    assert.ok(!stored.includes('foto'))

    // Solicitante não vê o restrito.
    const ownList = await call(path, { session: requester })
    assert.equal(ownList.body.attachments.length, 1)
    assert.equal(ownList.body.attachments[0].name, 'foto antes.png')
    assert.ok(!ownList.text.includes('storage'.concat('_key')))
    assert.equal((await download(requester, staffFile.body.id)).status, 404)
    assert.equal((await call(path, { session: central })).body.attachments.length, 2)

    // Download: só com sessão, com o conteúdo original e sem execução no navegador.
    assert.equal((await fetch(`${baseUrl}/api/attachments/files/${sent.body.id}/content`)).status, 401)
    assert.equal((await download(stranger, sent.body.id)).status, 404)
    const file = await download(requester, sent.body.id)
    assert.equal(file.status, 200)
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), pngBytes)
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff')
    assert.match(file.headers.get('content-disposition') as string, /^attachment/)
    assert.match(file.headers.get('content-security-policy') as string, /sandbox/)
    assert.match((await download(requester, sent.body.id, '?inline=1')).headers.get('content-disposition') as string, /^inline/)

    // Remover exige quem atende e justificativa, e o registro permanece.
    const removePath = `/attachments/files/${sent.body.id}/remove`
    assert.equal((await post(removePath, requester, { justificativa: 'Não quero' })).status, 403)
    assert.equal((await post(removePath, central, {})).status, 400)
    assert.equal((await post(removePath, central, { justificativa: 'Foto de outra sala' })).status, 200)
    assert.equal((await post(removePath, central, { justificativa: 'De novo' })).status, 409)
    assert.equal((await download(requester, sent.body.id)).status, 404)
    const after = await call(path, { session: central })
    const removed = after.body.attachments.find((item: any) => item.id === sent.body.id)
    assert.equal(removed.removalReason, 'Foto de outra sala')

    const detail = await call(`/maintenance/requests/${created.id}`, { session: central })
    const actions = detail.body.history.map((entry: any) => entry.action)
    assert.ok(actions.includes('anexo_incluido'))
    assert.ok(actions.includes('anexo_removido'))
    assert.ok(!detail.text.includes('foto antes'), 'o nome do arquivo não entra no histórico')

    const audit = await pool.query(
      `SELECT action FROM public.auth_audit_events WHERE target_resource_id = $1`,
      [created.id],
    )
    const audited = audit.rows.map((row) => row.action)
    for (const action of ['attachment.uploaded', 'attachment.downloaded', 'attachment.removed']) {
      assert.ok(audited.includes(action), action)
    }

    await assert.rejects(pool.query(`DELETE FROM public.request_attachments`), /não podem ser alterados/)
    await assert.rejects(
      pool.query(`UPDATE public.request_attachments SET nome_original = 'outro'`),
      /não podem ser alterados/,
    )

    // Limites configuráveis pela tela.
    assert.equal(
      (await put('/settings/parameters/attachments', admin, {
        maxFileMb: 1,
        maxTotalMb: 1,
        allowedKinds: ['png'],
      })).status,
      200,
    )
    assert.equal((await upload(central, path, pdfBytes, 'outro.pdf')).status, 400)
    assert.equal((await upload(central, path, Buffer.concat([pngBytes, Buffer.alloc(2 * 1024 * 1024)]), 'grande.png')).status, 400)
    await put('/settings/parameters/attachments', admin, {
      maxFileMb: 10,
      maxTotalMb: 2048,
      allowedKinds: ['pdf', 'png', 'jpeg', 'webp', 'docx', 'xlsx', 'txt'],
    })

    // Passagens: restrito por padrão, por conter dados pessoais.
    const flight = await post('/flights/requests', requester, {
      andarId: options['1º andar'],
      tipoViagem: 'somente_ida',
      ida: { origem: 'GRU', destino: 'BSB', data: '2027-04-01', horario: '08:00' },
      bagagem: 'Bagagem de mão',
      passageiros: [{ nome: 'Passageira Fictícia', cpf: fictionalCpf }],
    })
    const flightPath = `/attachments/resources/service_request/${flight.body.id}`
    const ticket = await upload(central, flightPath, pdfBytes, 'bilhete.pdf', '?categoria=bilhete')
    assert.equal(ticket.status, 201, ticket.text)
    assert.equal((await call(flightPath, { session: requester })).body.attachments.length, 0)
    assert.equal((await download(requester, ticket.body.id)).status, 404)

    const capacity = await call('/attachments/capacity', { session: admin })
    assert.ok(capacity.body.usedBytes > 0)
    assert.equal(capacity.body.configured, true)
    assert.equal((await call('/attachments/capacity', { session: requester })).status, 403)
  } finally {
    delete process.env.ATTACHMENTS_DIR
    rmSync(directory, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Pesquisa global
// ---------------------------------------------------------------------------

test('pesquisa: encontra por protocolo e palavra, por categoria, e respeita as permissões', async () => {
  const unique = `Vazamento${randomBytes(4).toString('hex')}`
  const own = await newRequest(requester, { descricao: `Defeito ${unique}` })
  const other = await createUser('pesquisa-outro@example.gov.br')
  const foreign = await newRequest(other, { descricao: `Defeito ${unique}` })

  assert.equal((await call('/search?q=a', { session: requester })).status, 400)
  assert.equal((await fetch(`${baseUrl}/api/search?q=abc`)).status, 401)

  // Quem atende vê as duas; solicitante, só a própria.
  const staffResult = await call(`/search?q=${unique}`, { session: central })
  assert.equal(staffResult.body.results.requests.total, 2)
  const ownResult = await call(`/search?q=${unique}`, { session: requester })
  assert.equal(ownResult.body.results.requests.total, 1)
  assert.equal(ownResult.body.results.requests.hits[0].id, own.id)
  assert.ok(!ownResult.text.includes(foreign.id))

  // Protocolo completo e parcial.
  const full = await call(`/search?q=${own.protocol}`, { session: requester })
  assert.equal(full.body.results.requests.hits[0].protocol, own.protocol)
  const partial = await call(`/search?q=${own.protocol.slice(-9)}`, { session: requester })
  assert.ok(partial.body.results.requests.total >= 1)
  assert.equal(partial.body.results.requests.hits[0].link, `/manutencao/${partial.body.results.requests.hits[0].id}`)

  // Filtros e paginação por categoria.
  assert.equal((await call(`/search?q=${unique}&module=fleet`, { session: central })).body.results.requests, undefined)
  const scoped = await call(`/search?q=${unique}&status=aguardando_agendamento&category=requests&page=1`, { session: central })
  assert.equal(scoped.body.results.requests.pageSize, 25)
  assert.equal(
    (await call(`/search?q=${unique}&status=concluido`, { session: central })).body.results.requests,
    undefined,
  )

  // Curinga é texto literal.
  assert.equal((await call('/search?q=%25%25', { session: requester })).body.results.requests, undefined)

  // Nada de passageiros, CPF ou nomes guardados nos dados da solicitação.
  const flight = await post('/flights/requests', requester, {
    andarId: options['1º andar'],
    tipoViagem: 'somente_ida',
    ida: { origem: 'CGH', destino: 'SDU', data: '2027-04-01', horario: '08:00' },
    bagagem: 'Bagagem de mão',
    passageiros: [{ nome: 'Passageira Sigilosa', cpf: fictionalCpf }],
  })
  assert.equal(flight.status, 201, flight.text)
  await post('/fleet/requests', requester, {
    origem: 'Sede',
    destino: 'Fórum',
    dataHora: '2027-03-10T13:00:00.000Z',
    finalidade: 'Entrega',
    passageiros: [{ nome: 'Passageira Sigilosa' }],
  })
  for (const term of ['Sigilosa', fictionalCpf, '000.000.001-91']) {
    const result = await call(`/search?q=${encodeURIComponent(term)}`, { session: central })
    assert.deepEqual(result.body.results, {}, term)
  }

  // Materiais só para quem tem o Almoxarifado; inventário, só para quem o administra.
  const noWarehouse = await createUser('pesquisa-sem-almox@example.gov.br')
  await setAccess(noWarehouse.id, { role: 'requester', deniedPermissions: ['warehouse:read'] })
  const papel = await call('/search?q=Papel', { session: noWarehouse })
  assert.equal(papel.body.results.materials, undefined)
  assert.equal((await call('/search?q=Papel', { session: requester })).body.results.materials.total, 1)
  const inventory = await call('/search?q=mensal', { session: requester })
  assert.equal(inventory.body.results.inventoryChecks, undefined)
  assert.equal((await call('/search?q=mensal', { session: admin })).body.results.inventoryChecks.total, 1)
})

test('pesquisa: histórico só para quem acompanha todos, e nunca o contexto interno', async () => {
  const created = await newRequest()
  const unique = `Justifica${randomBytes(4).toString('hex')}`
  await post(`/maintenance/requests/${created.id}/cancel`, central, { motivo: `Duplicada ${unique}` })
  const other = await newRequest()
  await post(`/slm/requests/${other.id}/priority`, central, { prioridade: 'alta', justificativa: `Interno ${unique}` })

  const found = await call(`/search?q=${unique}`, { session: central })
  assert.equal(found.body.results.history.total, 1)
  assert.equal(found.body.results.history.hits[0].link, `/manutencao/${created.id}`)
  assert.equal((await call(`/search?q=${unique}`, { session: requester })).body.results.history, undefined)
})

// ---------------------------------------------------------------------------
// Ampliações dos módulos
// ---------------------------------------------------------------------------

test('frota: cadastro de veículos, registros, quilometragem e alertas de revisão', async () => {
  await pool.query(schema('009_module_extensions.sql'))
  const operator = await staff('veiculo-operadora@example.gov.br')

  assert.equal((await call('/fleet/vehicles', { session: requester })).status, 403)
  // Operação registra uso; cadastrar é de quem administra o módulo.
  const body = { placa: 'abc1d23', modelo: 'Sedan', kmAtual: 1000, proximaRevisaoKm: 1400 }
  assert.equal((await post('/fleet/vehicles', operator, body)).status, 403)
  assert.equal((await post('/fleet/vehicles', admin, { ...body, placa: 'x' })).status, 400)
  const created = await post('/fleet/vehicles', admin, body)
  assert.equal(created.status, 201, created.text)
  assert.equal((await post('/fleet/vehicles', admin, body)).status, 409)

  const id = created.body.id
  const list = await call('/fleet/vehicles', { session: operator })
  assert.equal(list.body.vehicles[0].plate, 'ABC1D23')
  assert.equal(list.body.vehicles[0].reviewAlert, 'proxima')

  const trip = await post('/fleet/requests', requester, {
    origem: 'Sede',
    destino: 'Fórum',
    dataHora: '2027-03-10T13:00:00.000Z',
    finalidade: 'Entrega',
    passageiros: [{ nome: 'Pessoa Fictícia' }],
  })
  const logs = `/fleet/vehicles/${id}/logs`
  const usage = { tipo: 'utilizacao', data: '2027-03-10T13:00:00.000Z', descricao: 'Ida ao fórum' }
  assert.equal((await post(logs, requester, usage)).status, 403)
  assert.equal((await post(logs, operator, usage)).status, 400)
  assert.equal((await post(logs, operator, { ...usage, kmInicial: 1100, kmFinal: 1000 })).status, 400)
  assert.equal(
    (await post(logs, operator, { ...usage, kmInicial: 1000, kmFinal: 1500, protocolo: 'FRO-1999-99999' })).status,
    400,
  )
  assert.equal(
    (await post(logs, operator, { ...usage, kmInicial: 1000, kmFinal: 1500, protocolo: trip.body.protocol })).status,
    201,
  )
  assert.equal(
    (await post(logs, operator, { tipo: 'abastecimento', data: '2027-03-11T13:00:00.000Z', litros: '40,5', valor: 250, descricao: 'Posto' })).status,
    201,
  )
  // Lançar viagem antiga não faz a quilometragem recuar.
  assert.equal(
    (await post(logs, operator, { ...usage, kmInicial: 10, kmFinal: 20 })).status,
    201,
  )

  const detail = await call(`/fleet/vehicles/${id}`, { session: operator })
  assert.equal(detail.body.vehicle.currentKm, 1500)
  assert.equal(detail.body.vehicle.reviewAlert, 'vencida')
  assert.equal(detail.body.summary.kmDriven, 510)
  assert.equal(detail.body.summary.liters, 40.5)
  assert.equal(detail.body.logs.find((log: any) => log.requestId === trip.body.id).protocol, trip.body.protocol)

  assert.equal((await patch(`/fleet/vehicles/${id}`, admin, { ...body, situacao: 'em_manutencao', proximaRevisaoKm: 9000, kmAtual: 1500 })).status, 200)
  await assert.rejects(pool.query(`DELETE FROM public.vehicle_logs`), /não podem ser alterados/)

  // A pesquisa encontra o veículo, só para quem atende.
  assert.equal((await call('/search?q=ABC1D', { session: operator })).body.results.vehicles.total, 1)
  assert.equal((await call('/search?q=ABC1D', { session: requester })).body.results.vehicles, undefined)
})

test('manutenção: equipamento é opcional, e a execução fica no histórico da solicitação', async () => {
  const operator = await staff('equip-operadora@example.gov.br')
  const created = await newRequest()
  const executions = `/maintenance/requests/${created.id}/executions`
  const body = { executadoPor: 'Técnico Fictício', executadoEm: '2027-05-05T15:00:00.000Z', servico: 'Troca de lâmpada' }

  assert.equal((await post(executions, requester, body)).status, 403)
  assert.equal((await post(executions, operator, { ...body, servico: '' })).status, 400)
  // Sem equipamento: o cadastro não é obrigatório.
  assert.equal((await post(executions, operator, { ...body, pendencias: 'Faltou reator' })).status, 201)

  assert.equal((await post('/maintenance/equipments', operator, { nome: 'Ar-condicionado' })).status, 403)
  const equipment = await post('/maintenance/equipments', admin, { nome: 'Ar-condicionado', local: 'Sala 2' })
  assert.equal(equipment.status, 201, equipment.text)
  assert.equal((await post(executions, operator, { ...body, equipamentoId: equipment.body.id })).status, 201)

  const history = await call(`/maintenance/equipments/${equipment.body.id}/history`, { session: operator })
  assert.equal(history.body.executions.length, 1)
  assert.equal(history.body.executions[0].protocol, created.protocol)

  // Solicitante acompanha o que foi feito no próprio pedido; outra pessoa, não.
  const own = await call(executions, { session: requester })
  assert.equal(own.body.executions.length, 2)
  const stranger = await createUser('equip-estranho@example.gov.br')
  assert.equal((await call(executions, { session: stranger })).status, 404)

  // Desativado sai das novas execuções, sem perder o histórico.
  await patch(`/maintenance/equipments/${equipment.body.id}`, admin, { nome: 'Ar-condicionado', local: 'Sala 2', ativo: false })
  assert.equal((await post(executions, operator, { ...body, equipamentoId: equipment.body.id })).status, 400)
  assert.equal(
    (await call(`/maintenance/equipments/${equipment.body.id}/history`, { session: operator })).body.executions.length,
    1,
  )
  await assert.rejects(pool.query(`DELETE FROM public.maintenance_executions`), /não podem ser alterados/)

  const detail = await call(`/maintenance/requests/${created.id}`, { session: requester })
  assert.equal(detail.body.history.filter((entry: any) => entry.action === 'execucao_registrada').length, 2)
})

test('passagens: cotações comparáveis, escolha única com justificativa e fora do alcance de quem solicita', async () => {
  const operator = await staff('cotacao-operadora@example.gov.br')
  const flight = await post('/flights/requests', requester, {
    andarId: options['1º andar'],
    tipoViagem: 'somente_ida',
    ida: { origem: 'GRU', destino: 'BSB', data: '2027-04-01', horario: '08:00' },
    bagagem: 'Bagagem de mão',
    passageiros: [{ nome: 'Passageira Fictícia', cpf: fictionalCpf }],
  })
  const base = `/flights/requests/${flight.body.id}/quotes`
  const quote = { companhia: 'Companhia A', voos: 'AA100', valor: '1200,50', condicoes: 'Sem remarcação' }

  assert.equal((await post(base, requester, quote)).status, 403)
  assert.equal((await call(base, { session: requester })).status, 403)
  assert.equal((await post(base, operator, { ...quote, valor: 'caro' })).status, 400)

  const first = await post(base, operator, quote)
  assert.equal(first.status, 201, first.text)
  const second = await post(base, operator, { ...quote, companhia: 'Companhia B', valor: 900 })

  const listed = await call(base, { session: operator })
  assert.deepEqual(listed.body.quotes.map((item: any) => item.value), [900, 1200.5])

  assert.equal((await post(`${base}/${first.body.id}/select`, operator, {})).status, 400)
  assert.equal((await post(`${base}/${first.body.id}/select`, operator, { justificativa: 'Melhor horário' })).status, 200)
  assert.equal((await post(`${base}/${second.body.id}/select`, operator, { justificativa: 'Mudou o orçamento' })).status, 200)
  const chosen = (await call(base, { session: operator })).body.quotes.filter((item: any) => item.selected)
  assert.deepEqual(chosen.map((item: any) => item.id), [second.body.id])

  // Registrada, a cotação não muda.
  await assert.rejects(pool.query(`UPDATE public.flight_quotes SET valor = 1`), /não podem ser alteradas/)
  await assert.rejects(pool.query(`DELETE FROM public.flight_quotes`), /não podem ser alteradas/)

  const staffView = await call(`/flights/requests/${flight.body.id}`, { session: operator })
  assert.ok(staffView.body.history.some((entry: any) => entry.action === 'cotacao_selecionada'))
  const own = await call(`/flights/requests/${flight.body.id}`, { session: requester })
  assert.ok(!own.body.history.some((entry: any) => entry.action.startsWith('cotacao')))
  assert.ok(!own.text.includes('Mudou o orçamento'))
})

test('estoque interno: entradas, saídas com justificativa, mínimo e histórico', async () => {
  const material = await post('/warehouse/materials', admin, { name: 'Toner', unitId: options.Unidade })
  const id = material.body.id

  assert.equal((await call('/warehouse/stock', { session: requester })).status, 403)
  const movement = { materialId: id, tipo: 'entrada', quantidade: 5, justificativa: 'Saldo inicial conferido' }
  assert.equal((await post('/warehouse/stock-movements', requester, movement)).status, 403)
  assert.equal((await post('/warehouse/stock-movements', admin, { ...movement, justificativa: '' })).status, 400)
  assert.equal((await post('/warehouse/stock-movements', admin, movement)).status, 201)

  // Não fica negativo.
  const exit = { materialId: id, tipo: 'saida', quantidade: 9, justificativa: 'Retirada' }
  assert.equal((await post('/warehouse/stock-movements', admin, exit)).status, 409)
  assert.equal((await post('/warehouse/stock-movements', admin, { ...exit, quantidade: 3 })).status, 201)

  assert.equal((await put(`/warehouse/stock/${id}/minimum`, admin, { minimo: 4 })).status, 200)
  const below = await call('/warehouse/stock?belowMinimum=true&search=Toner', { session: admin })
  assert.equal(below.body.items[0].current, 2)
  assert.equal(below.body.items[0].belowMinimum, true)

  const history = await call(`/warehouse/stock-movements?materialId=${id}`, { session: admin })
  assert.equal(history.body.total, 2)
  assert.equal(history.body.movements[0].reason, 'Retirada')
  await assert.rejects(pool.query(`DELETE FROM public.stock_movements`), /não podem ser alterados/)
})

test('indicadores: dados reais, tempos separados, cumprimento de prazo e produtividade restrita', async () => {
  const operator = await staff('indicador-operadora@example.gov.br', ['requests:schedule', 'slm_central:read', 'slm_central:manage'])
  const created = await newRequest()
  const path = `/maintenance/requests/${created.id}`

  await pool.query(`ALTER TABLE public.service_requests DISABLE TRIGGER trg_sr_updated_at`)
  await pool.query(
    `UPDATE public.service_requests SET created_at = now() - interval '2 days', prazo_em = now() + interval '1 day' WHERE id = $1`,
    [created.id],
  )
  await pool.query(`ALTER TABLE public.service_requests ENABLE TRIGGER trg_sr_updated_at`)

  assert.equal((await post(`${path}/schedule`, operator, { dataAgendada: '2031-06-01T13:00:00.000Z', responsavelId: operator.id })).status, 200)
  assert.equal((await post(`/slm/requests/${created.id}/complexity`, operator, { complexidade: 'complexa' })).status, 200)
  assert.equal((await post(`${path}/start`, operator, { inicioReal: new Date(Date.now() - 3_600_000).toISOString() })).status, 200)
  assert.equal((await post(`${path}/complete`, operator, { fimReal: new Date().toISOString() })).status, 200)

  const report = await call(`/reports/performance?responsibleId=${operator.id}`, { session: operator })
  assert.equal(report.status, 200, report.text)
  assert.ok(report.body.received >= 1)
  assert.ok(report.body.concluded >= 1)
  assert.equal(report.body.deadlines.onTime, 1)
  assert.equal(report.body.deadlines.percent, 100)
  assert.ok(report.body.times.effectiveService.minutes >= 59 && report.body.times.effectiveService.minutes <= 61)
  assert.ok(report.body.times.waitUntilStart.minutes >= 2800)
  assert.ok(report.body.times.totalResolution.minutes >= 2880)
  assert.equal(report.body.times.effectiveService.basedOn, 1)
  const own = report.body.productivity.find((row: any) => row.responsible === 'Pessoa indicador-operadora')
  assert.equal(own.concluded, 1)
  assert.equal(own.complexity.complex, 1)
  assert.equal('score' in own, false)

  // Sem a Central, os indicadores gerais continuam, sem o desempenho das pessoas nem o filtro.
  const reporter = await staff('indicador-relatorio@example.gov.br')
  const general = await call(`/reports/performance?responsibleId=${operator.id}`, { session: reporter })
  assert.equal(general.body.productivity, null)
  assert.ok(general.body.received > report.body.received)

  // Quem só solicita não tem relatórios, e o alcance continua no SQL.
  assert.equal((await call('/reports/performance', { session: requester })).status, 403)
})

// ---------------------------------------------------------------------------
// Monitoramento, revisão de acessos e sessões
// ---------------------------------------------------------------------------

test('monitoramento: serviços, disponibilidade, períodos sem verificação e registros sem dados sensíveis', async () => {
  await pool.query(schema('010_monitoring.sql'))
  assert.equal((await call('/monitoring/status', { session: requester })).status, 403)
  assert.equal((await call('/monitoring/status', { session: central })).status, 403)

  // O endpoint público não mudou.
  const health = await call('/health')
  assert.deepEqual(Object.keys(health.body).sort(), ['environment', 'message', 'success'])

  const status = await call('/monitoring/status', { session: admin })
  assert.equal(status.status, 200, status.text)
  const byService = Object.fromEntries(status.body.checks.map((check: any) => [check.service, check.status]))
  assert.equal(byService.api, 'up')
  assert.equal(byService.database, 'up')
  assert.equal(byService.email, 'not_configured')
  assert.equal(byService.storage, 'not_configured')
  assert.equal(status.body.monitoringActive, false)

  await recordAvailability(
    [
      { service: 'database', status: 'up', detail: null, responseMs: 1 },
      { service: 'email', status: 'not_configured', detail: null, responseMs: null },
    ],
    60_000,
  )
  await recordAvailability([{ service: 'database', status: 'up', detail: null, responseMs: 1 }], 60_000)
  const rows = await pool.query(`SELECT service, status FROM public.availability_periods`)
  assert.equal(rows.rows.length, 1, 'mesma situação não cria outro período, e não configurado não conta')

  // Intervalo sem verificação vira "unknown", e não disponibilidade.
  await pool.query(
    `UPDATE public.availability_periods
        SET started_at = now() - interval '2 hours', last_seen_at = now() - interval '1 hour'`,
  )
  await recordAvailability([{ service: 'database', status: 'down', detail: 'ECONNREFUSED', responseMs: null }], 60_000)
  const after = await pool.query(`SELECT status FROM public.availability_periods ORDER BY started_at, id`)
  assert.deepEqual(after.rows.map((row) => row.status), ['up', 'unknown', 'down'])

  const report = await call('/monitoring/status', { session: admin })
  const database = report.body.availability.find((item: any) => item.service === 'database')
  assert.ok(database.availabilityPercent >= 49 && database.availabilityPercent <= 51, String(database.availabilityPercent))
  assert.ok(database.unknownMinutes >= 59)
  assert.equal(report.body.incidents.some((item: any) => item.status === 'unknown'), true)

  recordTechnicalEvent('email', 'envio_falhou', Object.assign(new Error('CPF 123.456.789-09 senha=abc'), { code: 'SMTP_500' }))
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = await pool.query(`SELECT 1 FROM public.technical_events WHERE event = 'envio_falhou'`)
    if (found.rows.length > 0) break
    await new Promise((done) => setTimeout(done, 20))
  }
  const events = await call('/monitoring/events?service=email', { session: admin })
  const entry = events.body.events.find((item: any) => item.event === 'envio_falhou')
  assert.equal(entry.errorCode, 'SMTP_500')
  assert.ok(!events.text.includes('123.456'))
  assert.ok(!events.text.includes('senha'))
})

test('registro de backup: lê a última cópia e o último teste de restauração', () => {
  assert.deepEqual(readBackupStatus({}), { configured: false })
  const directory = mkdtempSync(join(tmpdir(), 'slm-backup-log-'))
  try {
    const path = join(directory, 'registro.jsonl')
    assert.deepEqual(readBackupStatus({ BACKUP_LOG_PATH: path }), { configured: true, last: null, lastVerified: null })
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'backup', at: '2027-01-01T00:00:00.000Z', ok: true, sizeBytes: 10 }),
        JSON.stringify({ type: 'restore_test', at: '2027-01-02T00:00:00.000Z', ok: true }),
        JSON.stringify({ type: 'backup', at: '2027-01-03T00:00:00.000Z', ok: false }),
      ].join('\n'),
    )
    const status = readBackupStatus({ BACKUP_LOG_PATH: path })
    assert.equal(status.last?.ok, false)
    assert.equal(status.lastVerified?.ok, true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('revisão de acessos: lista quem precisa, registra na auditoria e identifica sessões', async () => {
  assert.equal((await call('/admin/access-review', { session: requester })).status, 403)

  const review = await call('/admin/access-review', { session: admin })
  assert.equal(review.status, 200, review.text)
  const self = review.body.users.find((user: any) => user.id === admin.id)
  assert.equal(self.administrator, true)
  assert.ok(self.lastAccess)
  assert.ok(self.reasons.includes('Acesso sensível sem revisão recente'))
  const operator = review.body.users.find((user: any) => user.id === central.id)
  assert.ok(operator.restrictedPermissions.includes('slm_central:read'))

  assert.equal((await post(`/admin/access-review/${central.id}`, requester, { resultado: 'mantido' })).status, 403)
  assert.equal((await post(`/admin/access-review/${central.id}`, admin, { resultado: 'qualquer' })).status, 400)
  assert.equal(
    (await post(`/admin/access-review/${central.id}`, admin, { resultado: 'mantido', observacao: 'Conferido com a chefia' })).status,
    201,
  )
  const after = await call('/admin/access-review', { session: admin })
  const reviewed = after.body.users.find((user: any) => user.id === central.id)
  assert.ok(reviewed.lastReview)
  assert.equal(reviewed.lastReviewResult, 'mantido')
  assert.ok(!reviewed.reasons.includes('Acesso sensível sem revisão recente'))
  const audit = await pool.query(
    `SELECT 1 FROM public.auth_audit_events WHERE action = 'user.access_reviewed' AND target_user_id = $1`,
    [central.id],
  )
  assert.equal(audit.rows.length, 1)

  // Sessões: identifica sem expor token, e encerra só a própria, uma a uma.
  const second = await signIn('central-solicitante@example.gov.br')
  const own = await call('/auth/sessions', { session: requester })
  const other = own.body.sessions.find((session: any) => !session.current)
  assert.ok(other)
  const adminView = await call(`/admin/users/${requester.id}/sessions`, { session: admin })
  assert.equal(adminView.body.sessions.length, own.body.sessions.length)
  assert.ok(!adminView.text.includes('hash'))
  assert.equal((await call(`/admin/users/${requester.id}/sessions`, { session: requester })).status, 403)

  const current = own.body.sessions.find((session: any) => session.current)
  assert.equal((await post(`/auth/sessions/${current.id}/revoke`, requester)).status, 404)
  assert.equal((await post(`/auth/sessions/${other.id}/revoke`, central)).status, 404)
  assert.equal((await post(`/auth/sessions/nao-e-uuid/revoke`, requester)).status, 404)
  assert.equal((await post(`/auth/sessions/${other.id}/revoke`, requester)).status, 200)
  void second
})

test('modelos de e-mail: texto próprio, com protocolo preservado e sem marcação', async () => {
  assert.equal(
    (await put('/settings/parameters/emailTemplates', admin, { overrides: { request_received: { intro: '<script>' } } })).status,
    400,
  )
  assert.equal(
    (await put('/settings/parameters/emailTemplates', admin, {
      overrides: { request_received: { subject: 'Recebemos seu pedido', intro: 'Agradecemos o contato.' } },
    })).status,
    200,
  )
  const created = await newRequest()
  const sent: { subject: string; text: string }[] = []
  await pool.query(`UPDATE public.email_deliveries SET status = 'pending' WHERE status = 'not_configured' AND event_id IN (
    SELECT id FROM public.integration_events WHERE resource_id = $1)`, [created.id])
  await processEmailQueue({
    provider: 'teste',
    simulated: true,
    send: async (message) => {
      sent.push({ subject: message.subject, text: message.text })
      return { messageId: null }
    },
  })
  const mine = sent.find((message) => message.subject.includes(created.protocol))
  assert.ok(mine, 'o e-mail da solicitação precisa sair com o protocolo')
  assert.ok(mine.subject.startsWith('Recebemos seu pedido'))
  assert.ok(mine.text.includes('Agradecemos o contato.'))
  await put('/settings/parameters/emailTemplates', admin, { overrides: {} })
})

test('formulários personalizados: valem para todos, com permissão e campo obrigatório no servidor', async () => {
  const requester = await createUser('forms-pede@example.gov.br')
  assert.equal((await call('/forms/definitions')).status, 401)
  assert.equal((await call('/forms/definitions', { session: requester })).body.definitions, null)

  const custom = { id: 'custom-ramal', label: 'Ramal', description: '', type: 'shortText', required: true, active: true, protected: false, options: [] }
  const definitions = { maintenance: [custom], fleet: [custom], airTravel: [custom] }
  assert.equal((await put('/settings/parameters/forms', requester, { definitions })).status, 403)
  assert.equal((await put('/settings/parameters/forms', admin, { definitions: { fleet: [] } })).status, 400)
  assert.equal((await put('/settings/parameters/forms', admin, { definitions })).status, 200)

  const seen = await call('/forms/definitions', { session: requester })
  assert.equal(seen.body.definitions.fleet[0].label, 'Ramal')

  const body = {
    origem: 'Sede',
    destino: 'Fórum',
    dataHora: '2031-05-10T13:00:00.000Z',
    finalidade: 'Entrega de documentos',
  }
  const refused = await post('/fleet/requests', requester, body)
  assert.equal(refused.status, 400)
  assert.match(refused.body.message, /Ramal/)
  const accepted = await post('/fleet/requests', requester, { ...body, customFields: { 'custom-ramal': '123' } })
  assert.equal(accepted.status, 201, accepted.text)

  // Voltar ao padrão retira a exigência.
  assert.equal((await put('/settings/parameters/forms', admin, { definitions: null })).status, 200)
  assert.equal((await post('/fleet/requests', requester, body)).status, 201)
})

test('passagens: o filtro por tipo de viagem vem da API e ignora valor desconhecido', async () => {
  const requester = await createUser('tipo-viagem@example.gov.br')
  const segment = { origem: 'São Paulo', destino: 'Brasília', data: '2031-08-10', horario: '08:00' }
  const passengers = [{ nome: 'Pessoa Passageira', cpf: '00000000191' }]
  const flight = (extra: Record<string, unknown>) =>
    post('/flights/requests', requester, { andarId: options['1º andar'], passageiros: passengers, ...extra })
  assert.equal((await flight({ tipoViagem: 'somente_ida', ida: segment })).status, 201)
  assert.equal((await flight({ tipoViagem: 'somente_volta', volta: segment })).status, 201)

  const types = async (query: string) =>
    (await call(`/flights/requests${query}`, { session: requester })).body.requests.map(
      (item: { details: { tipoViagem: string } }) => item.details.tipoViagem,
    )
  assert.deepEqual(await types('?tripType=somente_ida'), ['somente_ida'])
  assert.equal((await types('?tripType=inventado')).length, 2)
})

test('relatórios: quilometragem e consumo só para quem acessa essas áreas, sem presumir dados', async () => {
  // Operador SLM com a gestão do Almoxarifado retirada individualmente.
  const reader = await staff('rel-frota@example.gov.br', ['reports:read'], ['warehouse:manage'])
  const vehicle = await post('/fleet/vehicles', admin, { placa: 'REL-1234', modelo: 'Sedan', situacao: 'disponivel' })
  assert.equal(vehicle.status, 201, vehicle.text)
  const log = (extra: Record<string, unknown>) =>
    post(`/fleet/vehicles/${vehicle.body.id}/logs`, admin, {
      tipo: 'utilizacao',
      data: '2031-02-10T13:00:00.000Z',
      descricao: 'Registro de teste',
      ...extra,
    })
  assert.equal((await log({ kmInicial: 100, kmFinal: 150 })).status, 201)
  assert.equal((await log({ kmInicial: 150, kmFinal: 170 })).status, 201)
  assert.equal((await log({ tipo: 'abastecimento', litros: 20, valor: 100 })).status, 201)

  const period = '?from=2031-02-01T00:00:00.000Z&to=2031-03-01T00:00:00.000Z'
  const report = await call(`/reports/operational${period}`, { session: admin })
  assert.equal(report.status, 200, report.text)
  assert.deepEqual(report.body.fleetUsage, [
    {
      vehicle: 'REL-1234',
      uses: 2,
      occurrences: 0,
      fuelings: 1,
      maintenances: 0,
      kilometers: 70,
      liters: 20,
      cost: 100,
    },
  ])
  const outside = await call('/reports/operational?from=2030-01-01T00:00:00.000Z&to=2030-02-01T00:00:00.000Z', { session: admin })
  assert.deepEqual(outside.body.fleetUsage, [])

  // Só relatórios, sem acesso de gestão ao estoque: a seção de consumo não aparece.
  const limited = await call(`/reports/operational${period}`, { session: reader })
  assert.equal(limited.status, 200, limited.text)
  assert.equal(limited.body.stockFlow, null)
  assert.ok(Array.isArray(report.body.stockFlow))
})

test('reversões: 009 e 008 recusam com registros, e 010 desfaz por completo', async () => {
  await assert.rejects(pool.query(schema('009_module_extensions.rollback.sql')), /interrompida/)
  await assert.rejects(pool.query(schema('008_attachments.rollback.sql')), /interrompida/)
  await pool.query(schema('010_monitoring.rollback.sql'))
  // Sem a 010, erros continuam só no log e a API segue respondendo.
  assert.equal((await call('/health')).status, 200)
  assert.equal((await call('/monitoring/events', { session: admin })).status, 503)
  await pool.query(schema('010_monitoring.sql'))
})

test('reversão da 007: recusa com observações registradas', async () => {
  await assert.rejects(pool.query(schema('007_operations_center.rollback.sql')), /interrompida/)
  const audit = await pool.query(`SELECT count(*)::int AS total FROM public.request_internal_notes`)
  assert.ok(audit.rows[0].total > 0)
})
