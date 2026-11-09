import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { Pool } from 'pg'
import app from '../app.js'
import { hashPassword } from '../auth/password.js'
import type { Permission } from '../auth/permissions.js'
import {
  processCalendarQueue,
  processEmailQueue,
  publishPendingReminders,
  refreshDeliveryStatuses,
} from '../integrations/worker.js'
import { IntegrationError } from '../integrations/transports.js'
import type { CalendarEventInput, CalendarTransport, EmailTransport, OutgoingEmail } from '../integrations/transports.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'

// Rotinas institucionais pela API real, em um PostgreSQL descartável. Os provedores são falsos:
// nada sai da máquina, e a trava de rede dos testes continua valendo.

const password = randomBytes(24).toString('hex')
const schema = (file: string) =>
  readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')

const fictionalCpf = '00000000191'

let pool: Pool
let server: Server
let baseUrl: string
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
  const setCookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  const body = JSON.parse(text) as Record<string, any>
  if (setCookie && body.csrfToken) csrfTokens.set(setCookie, body.csrfToken)
  await settleAccountNotices(path)
  return { status: response.status, body, text, setCookie }
}
/**
 * Avisos da conta de acesso (cadastro, aprovação, perfil) entram na mesma fila desde 07/11/2026 e têm
 * testes próprios (emailNotificationsIntegration.test.ts). Aqui, saem da fila antes de serem tentados,
 * para estes testes continuarem conferindo só as mensagens das solicitações.
 */
async function settleAccountNotices(path: string) {
  if (!path.startsWith('/auth/register') && !path.startsWith('/admin/')) return
  await pool
    .query(
      `DELETE FROM public.email_deliveries
        WHERE attempts = 0 AND status IN ('pending', 'not_configured')
          AND (template_key LIKE 'account\\_%' OR template_key LIKE 'security\\_%')`,
    )
    .catch((error: { code?: string }) => {
      // Único caso previsto: antes da migração 006 a fila não existe (42P01). Qualquer outro erro aparece.
      if (error?.code !== '42P01') throw error
    })
}


const post = (path: string, session: Session, body: unknown = {}) =>
  call(path, { method: 'POST', session, body })

async function signIn(email: string): Promise<Session> {
  authRateLimits.loginPair.reset(`127.0.0.1|${email}`)
  authRateLimits.loginPair.reset(`::ffff:127.0.0.1|${email}`)
  authRateLimits.loginAccount.reset(email)
  const result = await call('/auth/login', { method: 'POST', body: { identifier: email, password } })
  assert.equal(result.status, 200, `login de ${email}`)
  return { cookie: result.setCookie, id: result.body.user.id }
}

let admin: Session

async function createUser(
  email: string,
  role: 'requester' | 'slm_operator' = 'requester',
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
  const id = pending.body.registrations.find((item: { email: string }) => item.email === email).id
  assert.equal((await post(`/admin/registrations/${id}/approve`, admin, { role })).status, 200)
  return signIn(email)
}

function setAccess(userId: string, grants: Permission[], denied: Permission[] = []) {
  return call(`/admin/users/${userId}/access`, {
    method: 'PUT',
    session: admin,
    body: { role: 'slm_operator', slmMember: true, grantedPermissions: grants, deniedPermissions: denied },
  })
}

async function staff(email: string, grants: Permission[] = ['requests:schedule'], denied: Permission[] = []): Promise<Session> {
  const user = await createUser(email, 'slm_operator', 'CPC')
  const result = await setAccess(user.id, grants, denied)
  assert.equal(result.status, 200, result.text)
  return user
}

const options: Record<string, string> = {}

async function option(category: string, label: string) {
  const created = await post(`/settings/catalog/${category}`, admin, { label })
  assert.equal(created.status, 201, created.text)
  options[label] = created.body.option.id
}

function maintenanceBody() {
  return {
    andarId: options['1º andar'],
    tipoServicoId: options['Elétrica'],
    localServico: 'Sala de arquivo',
    descricao: 'Descrição interna do pedido',
    avisoPrivacidade: 'manutencao-2026-11',
  }
}

function fleetBody(extra: Record<string, unknown> = {}) {
  return {
    origem: 'Sede',
    destino: 'Fórum',
    dataHora: '2031-03-10T13:00:00.000Z',
    finalidade: 'Entrega de documentos',
    passageiros: [{ nome: 'Pessoa Passageira' }],
    ...extra,
  }
}

function flightBody() {
  return {
    andarId: options['1º andar'],
    tipoViagem: 'somente_ida',
    ida: { origem: 'GRU', destino: 'BSB', data: '2031-04-01', horario: '08:00' },
    passageiros: [{ nome: 'Passageira Fictícia', cpf: fictionalCpf }],
    avisoPrivacidade: 'passagens-2026-11',
  }
}

/** Provedor falso, com falhas programadas. Não há nenhuma comunicação de rede. */
function fakeEmail(failures: (IntegrationError | null)[] = []) {
  const sent: OutgoingEmail[] = []
  const transport: EmailTransport = {
    provider: 'falso',
    simulated: true,
    async send(message) {
      const failure = failures.shift()
      if (failure) throw failure
      sent.push(message)
      return { messageId: `msg-${sent.length}` }
    },
    deliveryStatus: async () => 'delivered',
  }
  return { sent, transport }
}

function fakeCalendar(failures: (IntegrationError | null)[] = []) {
  const operations: { kind: 'upsert' | 'remove'; event?: CalendarEventInput; eventId: string }[] = []
  const transport: CalendarTransport = {
    provider: 'falso',
    simulated: true,
    async upsert(event) {
      const failure = failures.shift()
      if (failure) throw failure
      operations.push({ kind: 'upsert', event, eventId: event.eventId })
    },
    async remove(_module, eventId) {
      const failure = failures.shift()
      if (failure) throw failure
      operations.push({ kind: 'remove', eventId })
    },
  }
  return { operations, transport }
}

async function drain() {
  await pool.query(`UPDATE public.email_deliveries SET status = 'sent' WHERE status IN ('pending', 'sending')`)
  await pool.query(`UPDATE public.calendar_sync_items SET status = 'synced' WHERE status IN ('pending', 'syncing')`)
}

async function dueNow() {
  await pool.query(`UPDATE public.email_deliveries SET next_attempt_at = now() WHERE status = 'pending'`)
  await pool.query(`UPDATE public.calendar_sync_items SET next_attempt_at = now() WHERE status = 'pending'`)
}

async function deliveriesOf(resourceId: string) {
  const { rows } = await pool.query<{
    id: string
    template_key: string
    audience: string
    recipient: string
    cc: string[]
    subject: string
    status: string
    attempts: number
    last_error_code: string | null
  }>(
    `SELECT d.id::text AS id, d.template_key, d.audience, d.recipient, d.cc, d.subject, d.status,
            d.attempts, d.last_error_code
       FROM public.email_deliveries d
       JOIN public.integration_events e ON e.id = d.event_id
      WHERE e.resource_id = $1
      ORDER BY d.created_at, d.id`,
    [resourceId],
  )
  return rows
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
     VALUES ('Administradora', 'rotinas-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )

  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('rotinas-admin@example.gov.br')

  await option('floors', '1º andar')
  await option('serviceTypes', 'Elétrica')
  await option('measurementUnits', 'Unidade')
  await option('sectors', 'Protocolo')
  await option('sectors', 'CPC')
})

after(async () => {
  for (const name of ['PASSENGER_DATA_KEY', 'PASSWORD_RESET_PEPPER', 'EMAIL_TRANSPORT', 'GOOGLE_CALENDAR_TRANSPORT']) {
    delete process.env[name]
  }
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

beforeEach(() => {
  process.env.EMAIL_TRANSPORT = 'simulated'
  process.env.GOOGLE_CALENDAR_TRANSPORT = 'simulated'
})

// Este teste precisa ser o primeiro: roda antes de a migração 006 ser aplicada.
test('sem a migração 006, as solicitações continuam sendo registradas', async (context) => {
  const warnings = context.mock.method(console, 'warn', () => {})
  const requester = await createUser('sem-006@example.gov.br')
  const operator = await staff('sem-006-op@example.gov.br')

  const created = await post('/maintenance/requests', requester, maintenanceBody())
  assert.equal(created.status, 201, created.text)
  const scheduled = await post(`/maintenance/requests/${created.body.id}/schedule`, operator, {
    dataAgendada: '2031-01-10T13:00:00.000Z',
  })
  assert.equal(scheduled.status, 200, scheduled.text)

  const logged = warnings.mock.calls.map((item) => String(item.arguments[0]))
  assert.ok(logged.some((line) => line.includes('integration_publish_failed')))

  // As telas que dependem da migração avisam, sem erro genérico.
  const list = await call('/notifications', { session: requester })
  assert.equal(list.status, 503)
  assert.equal(list.body.code, 'MODULES_MIGRATION_REQUIRED')

  await pool.query(schema('006_integrations.sql'))
})

test('recebimento: uma falha no provedor não impede o registro, e o envio é único', async () => {
  const requester = await createUser('recebe@example.gov.br')
  const created = await post('/maintenance/requests', requester, maintenanceBody())
  assert.equal(created.status, 201, created.text)

  const [delivery] = await deliveriesOf(created.body.id)
  assert.equal(delivery.template_key, 'request_received')
  assert.equal(delivery.audience, 'requester')
  assert.equal(delivery.recipient, 'recebe@example.gov.br')
  assert.equal(delivery.status, 'pending')

  // Provedor fora do ar: a solicitação continua registrada, e a tentativa é repetida depois.
  const offline = fakeEmail([new IntegrationError('NETWORK', true)])
  assert.deepEqual(await processEmailQueue(offline.transport), { sent: 0, failed: 1 })
  const afterFailure = (await deliveriesOf(created.body.id))[0]
  assert.equal(afterFailure.status, 'pending')
  assert.equal(afterFailure.attempts, 1)
  assert.equal(afterFailure.last_error_code, 'NETWORK')

  // A espera ainda não passou: nada é reenviado.
  const working = fakeEmail()
  assert.deepEqual(await processEmailQueue(working.transport), { sent: 0, failed: 0 })
  await dueNow()
  const result = await processEmailQueue(working.transport)
  assert.equal(result.failed, 0)
  assert.ok(working.sent.some((message) => message.to === 'recebe@example.gov.br'))
  const before = working.sent.length

  // Repetir o processamento não envia de novo.
  assert.deepEqual(await processEmailQueue(working.transport), { sent: 0, failed: 0 })
  assert.equal(working.sent.length, before)

  const finished = (await deliveriesOf(created.body.id))[0]
  assert.equal(finished.status, 'sent')
  assert.equal(finished.attempts, 2)

  // A mesma chave acompanha o item, para o provedor reconhecer uma repetição.
  const message = working.sent.find((item) => item.to === 'recebe@example.gov.br')!
  assert.equal(message.idempotencyKey, `slm-${finished.id}`)
  assert.ok(message.subject.includes(`#${created.body.protocol}`))
  assert.ok(message.text.includes('Manutenção'))
  assert.ok(!message.text.includes('Descrição interna'))

  const attempts = await call(`/integrations/emails/${finished.id}/attempts`, { session: admin })
  assert.deepEqual(
    attempts.body.attempts.map((item: { outcome: string }) => item.outcome),
    ['retry', 'success'],
  )
  await drain()
})

test('dois processos ao mesmo tempo não enviam o mesmo e-mail', async () => {
  const requester = await createUser('concorre@example.gov.br')
  for (let index = 0; index < 6; index += 1) {
    assert.equal((await post('/maintenance/requests', requester, maintenanceBody())).status, 201)
  }
  const first = fakeEmail()
  const second = fakeEmail()
  await Promise.all([processEmailQueue(first.transport), processEmailQueue(second.transport)])

  const keys = [...first.sent, ...second.sent].map((message) => message.idempotencyKey)
  assert.equal(new Set(keys).size, keys.length)
  assert.ok(keys.length >= 6)
  await drain()
})

test('item preso por queda do processo volta à fila depois do prazo, com a mesma chave', async () => {
  const requester = await createUser('preso@example.gov.br')
  const created = await post('/maintenance/requests', requester, maintenanceBody())
  await pool.query(
    `UPDATE public.email_deliveries SET status = 'sending', locked_until = now() + interval '1 hour'
      WHERE event_id IN (SELECT id FROM public.integration_events WHERE resource_id = $1)`,
    [created.body.id],
  )
  const fake = fakeEmail()
  await processEmailQueue(fake.transport)
  assert.ok(!fake.sent.some((message) => message.to === 'preso@example.gov.br'))

  await pool.query(
    `UPDATE public.email_deliveries SET locked_until = now() - interval '1 second'
      WHERE event_id IN (SELECT id FROM public.integration_events WHERE resource_id = $1)`,
    [created.body.id],
  )
  await processEmailQueue(fake.transport)
  assert.equal(fake.sent.filter((message) => message.to === 'preso@example.gov.br').length, 1)
  await drain()
})

test('falha definitiva: fila de falhas, aviso à administração e reprocessamento autorizado', async () => {
  const requester = await createUser('falha@example.gov.br')
  const created = await post('/maintenance/requests', requester, maintenanceBody())
  const [delivery] = await deliveriesOf(created.body.id)

  const rejecting = fakeEmail([new IntegrationError('RESEND_422', false)])
  await processEmailQueue(rejecting.transport)
  const failed = (await deliveriesOf(created.body.id))[0]
  assert.equal(failed.status, 'failed')
  assert.equal(failed.last_error_code, 'RESEND_422')

  // Aviso aos administradores, sem o endereço de quem deveria receber.
  const notices = await call('/notifications?unread=true', { session: admin })
  const notice = notices.body.notifications.find((item: { category: string }) => item.category === 'falha_operacional')
  assert.ok(notice, 'sem aviso de falha')
  assert.ok(notice.message.includes(created.body.protocol))
  assert.ok(!JSON.stringify(notice).includes('falha@example.gov.br'))
  assert.equal(notice.link, '/integracoes')

  // Quem só consulta não reprocessa.
  const reader = await staff('falha-leitora@example.gov.br', ['integrations:read'])
  assert.equal((await post(`/integrations/emails/${delivery.id}/retry`, reader)).status, 403)
  assert.equal((await post(`/integrations/emails/${delivery.id}/retry`, requester)).status, 403)

  // Sem serviço ativo, reprocessar é recusado.
  delete process.env.EMAIL_TRANSPORT
  assert.equal((await post(`/integrations/emails/${delivery.id}/retry`, admin)).status, 409)
  process.env.EMAIL_TRANSPORT = 'simulated'

  assert.equal((await post(`/integrations/emails/${delivery.id}/retry`, admin)).status, 200)
  const { rows } = await pool.query(
    `SELECT action, actor_user_id::text AS actor FROM public.auth_audit_events WHERE target_resource_id = $1`,
    [delivery.id],
  )
  assert.deepEqual(rows, [{ action: 'integrations.retry', actor: admin.id }])

  const fake = fakeEmail()
  await processEmailQueue(fake.transport)
  assert.ok(fake.sent.some((message) => message.to === 'falha@example.gov.br'))

  // Item enviado não pode ser reprocessado.
  assert.equal((await post(`/integrations/emails/${delivery.id}/retry`, admin)).status, 409)
  await drain()
})

test('a falha de um e-mail não gera outro e-mail, mesmo com destinatário de sistema', async () => {
  process.env.EMAIL_INTERNAL_TO_SYSTEM = 'sistema@example.gov.br'
  try {
    const requester = await createUser('sem-ciclo@example.gov.br')
    const created = await post('/maintenance/requests', requester, maintenanceBody())
    await processEmailQueue(fakeEmail(Array(50).fill(new IntegrationError('RESEND_422', false))).transport)

    const events = await pool.query(
      `SELECT count(*)::int AS total FROM public.integration_events
        WHERE event_type = 'integration_failure' AND protocol = $1`,
      [created.body.protocol],
    )
    assert.equal(events.rows[0].total, 1)
    const emails = await pool.query(
      `SELECT count(*)::int AS total FROM public.email_deliveries WHERE recipient = 'sistema@example.gov.br'`,
    )
    assert.equal(emails.rows[0].total, 0)
  } finally {
    delete process.env.EMAIL_INTERNAL_TO_SYSTEM
    await drain()
  }
})

test('as tentativas têm limite', async () => {
  const requester = await createUser('limite@example.gov.br')
  const created = await post('/maintenance/requests', requester, maintenanceBody())
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await dueNow()
    await processEmailQueue(fakeEmail(Array(50).fill(new IntegrationError('RESEND_500', true))).transport)
  }
  const [delivery] = await deliveriesOf(created.body.id)
  assert.equal(delivery.status, 'failed')
  assert.equal(delivery.attempts, 5)
  await dueNow()
  const fake = fakeEmail()
  await processEmailQueue(fake.transport)
  assert.ok(!fake.sent.some((message) => message.to === 'limite@example.gov.br'))
  await drain()
})

test('sem serviço ativo, a comunicação fica registrada, e ligar o serviço não dispara o acúmulo', async () => {
  delete process.env.EMAIL_TRANSPORT
  const requester = await createUser('desligado@example.gov.br')
  const created = await post('/maintenance/requests', requester, maintenanceBody())
  assert.equal(created.status, 201)

  const [delivery] = await deliveriesOf(created.body.id)
  assert.equal(delivery.status, 'not_configured')
  assert.equal(delivery.last_error_code, 'EMAIL_NOT_CONFIGURED')

  const fake = fakeEmail()
  await processEmailQueue(fake.transport)
  assert.ok(!fake.sent.some((message) => message.to === 'desligado@example.gov.br'))

  process.env.EMAIL_TRANSPORT = 'simulated'
  assert.equal((await post(`/integrations/emails/${delivery.id}/retry`, admin)).status, 200)
  await processEmailQueue(fake.transport)
  assert.ok(fake.sent.some((message) => message.to === 'desligado@example.gov.br'))
  await drain()
})

test('destinatários internos e cópias vêm só da configuração', async () => {
  process.env.EMAIL_INTERNAL_TO_MAINTENANCE = 'equipe@example.gov.br'
  process.env.EMAIL_CC_MAINTENANCE = 'copia@example.gov.br'
  try {
    const requester = await createUser('copias@example.gov.br')
    const created = await post('/maintenance/requests', requester, maintenanceBody())
    const rows = await deliveriesOf(created.body.id)
    assert.deepEqual(
      rows.map((row) => [row.audience, row.recipient, row.cc]).sort(),
      [
        ['internal', 'equipe@example.gov.br', []],
        ['requester', 'copias@example.gov.br', ['copia@example.gov.br']],
      ],
    )
  } finally {
    delete process.env.EMAIL_INTERNAL_TO_MAINTENANCE
    delete process.env.EMAIL_CC_MAINTENANCE
    await drain()
  }
})

test('manutenção: comunicações, notificações e agenda acompanham cada etapa', async () => {
  const requester = await createUser('ciclo@example.gov.br')
  const operator = await staff('ciclo-op@example.gov.br')
  const responsible = await staff('ciclo-resp@example.gov.br')

  const created = await post('/maintenance/requests', requester, maintenanceBody())
  const id = created.body.id
  const base = `/maintenance/requests/${id}`

  assert.equal((await post(`${base}/schedule`, operator, {
    dataAgendada: '2031-02-10T13:00:00.000Z',
    responsavelId: responsible.id,
  })).status, 200)

  // Reagendar para a mesma data não gera nova mensagem; para outra, sim.
  assert.equal((await post(`${base}/schedule`, operator, {
    dataAgendada: '2031-02-10T13:00:00.000Z',
    responsavelId: responsible.id,
    comentario: 'Repetição',
  })).status, 200)
  assert.equal((await post(`${base}/schedule`, operator, {
    dataAgendada: '2031-02-11T13:00:00.000Z',
    responsavelId: responsible.id,
    comentario: `Equipe indisponível, contato ${fictionalCpf}`,
  })).status, 200)
  assert.equal((await post(`${base}/start`, operator)).status, 200)
  assert.equal((await post(`${base}/complete`, operator)).status, 200)

  const rows = await deliveriesOf(id)
  assert.deepEqual(
    rows.filter((row) => row.audience === 'requester').map((row) => row.template_key),
    ['request_received', 'request_scheduled', 'request_rescheduled', 'request_started', 'request_completed'],
  )

  // CPF digitado em um comentário não chega ao histórico nem ao e-mail.
  const detail = await call(base, { session: operator })
  assert.ok(!detail.text.includes(fictionalCpf))
  const fake = fakeEmail()
  await processEmailQueue(fake.transport)
  const rescheduled = fake.sent.find((message) => message.subject.includes('reagendado'))!
  assert.ok(!rescheduled.text.includes(fictionalCpf))
  assert.ok(rescheduled.text.includes('Equipe indisponível'))
  assert.ok(rescheduled.text.includes('Data anterior'))

  // O solicitante vê o andamento; a pessoa responsável, o que lhe diz respeito.
  const seen = await call('/notifications', { session: requester })
  assert.equal(seen.body.notifications.length, 4)
  assert.ok(seen.body.notifications.every((item: { link: string }) => item.link === `/manutencao/${id}`))
  const forResponsible = await call('/notifications', { session: responsible })
  assert.ok(forResponsible.body.notifications.some((item: { link: string; message: string }) =>
    item.link === `/manutencao/${id}` && item.message.startsWith('Agendamento')))

  // Quem agiu não recebe aviso da própria ação.
  const forOperator = await call('/notifications', { session: operator })
  assert.ok(!forOperator.body.notifications.some((item: { link: string; category: string }) =>
    item.link === `/manutencao/${id}` && item.category === 'agendamento'))
  await drain()
})

test('notificações: permissões, leitura, outra pessoa e dados restritos', async () => {
  const requester = await createUser('avisos@example.gov.br')
  const other = await createUser('avisos-outra@example.gov.br')
  const team = await staff('avisos-equipe@example.gov.br')
  const created = await post('/flights/requests', requester, flightBody())
  assert.equal(created.status, 201, created.text)

  const teamList = await call('/notifications?unread=true', { session: team })
  const notice = teamList.body.notifications.find((item: { link: string }) =>
    item.link === `/passagens-aereas/${created.body.id}`)
  assert.ok(notice, 'equipe sem aviso da nova solicitação')

  // Nem o texto da notificação nem a resposta trazem dados pessoais.
  for (const secret of [fictionalCpf, 'Passageira', 'GRU']) {
    assert.ok(!teamList.text.includes(secret), `notificação expôs ${secret}`)
  }

  // Quem não atende não é avisado.
  const otherList = await call('/notifications', { session: other })
  assert.equal(otherList.body.notifications.length, 0)
  assert.equal((await post(`/notifications/${notice.id}/read`, other)).status, 404)

  const before = (await call('/notifications/unread-count', { session: team })).body.unread
  assert.ok(before >= 1)
  assert.equal((await post(`/notifications/${notice.id}/read`, team)).status, 200)
  assert.equal((await call('/notifications/unread-count', { session: team })).body.unread, before - 1)
  assert.equal((await post(`/notifications/${notice.id}/read`, team)).status, 200)

  // Quem perde a permissão deixa de ver a notificação, que fica no banco.
  const access = await setAccess(team.id, ['requests:schedule'], ['flights:update'])
  assert.equal(access.status, 200, access.text)
  const reloaded = await signIn('avisos-equipe@example.gov.br')
  const hidden = await call('/notifications', { session: reloaded })
  assert.ok(!hidden.body.notifications.some((item: { id: string }) => item.id === notice.id))

  assert.equal((await post('/notifications/read-all', reloaded)).status, 200)
  assert.equal((await call('/notifications/unread-count', { session: reloaded })).body.unread, 0)
  await drain()
})

test('passagens: fluxo, sem CPF, nomes ou trechos nos e-mails e nos eventos', async () => {
  const requester = await createUser('voo@example.gov.br')
  const operator = await staff('voo-op@example.gov.br')
  const created = await post('/flights/requests', requester, flightBody())
  const id = created.body.id

  for (const status of ['aguardando_aprovacao', 'em_emissao', 'emitida']) {
    assert.equal((await post(`/flights/requests/${id}/advance`, operator, { status })).status, 200)
  }

  const rows = await deliveriesOf(id)
  assert.deepEqual(
    rows.filter((row) => row.audience === 'requester').map((row) => row.template_key),
    ['request_received', 'flight_approval_needed', 'flight_approved', 'flight_issued'],
  )

  const fake = fakeEmail()
  await processEmailQueue(fake.transport)
  const events = await pool.query(
    `SELECT payload::text AS payload FROM public.integration_events WHERE resource_id = $1`,
    [id],
  )
  const everything = [
    ...fake.sent.flatMap((message) => [message.subject, message.text, message.html]),
    ...rows.map((row) => row.subject),
    ...events.rows.map((row) => row.payload),
  ].join('\n')
  for (const secret of [fictionalCpf, '000.000.001-91', 'Passageira', 'GRU', 'BSB']) {
    assert.ok(!everything.includes(secret), `comunicação expôs ${secret}`)
  }

  // Sem pedido de consentimento: a versão do aviso exibido fica no histórico.
  const stored = await pool.query(
    `SELECT lgpd_aceite, lgpd_aceite_em FROM public.service_requests WHERE id = $1`,
    [id],
  )
  assert.deepEqual(stored.rows[0], { lgpd_aceite: false, lgpd_aceite_em: null })
  const detail = await call(`/flights/requests/${id}`, { session: requester })
  assert.equal(detail.body.history[0].details.avisoPrivacidade, 'passagens-2026-11')
  await drain()
})

test('cancelamento: motivo por e-mail, sem repetir na notificação', async () => {
  const requester = await createUser('cancela@example.gov.br')
  const operator = await staff('cancela-op@example.gov.br')
  const created = await post('/flights/requests', requester, flightBody())
  const id = created.body.id
  assert.equal((await post(`/flights/requests/${id}/cancel`, operator, { motivo: 'Viagem desmarcada' })).status, 200)

  const fake = fakeEmail()
  await processEmailQueue(fake.transport)
  const email = fake.sent.find((message) => message.to === 'cancela@example.gov.br' && message.subject.includes('cancelada'))!
  assert.ok(email.text.includes('Viagem desmarcada'))

  const notices = await call('/notifications', { session: requester })
  assert.ok(notices.body.notifications.length >= 1)
  assert.ok(!notices.text.includes('Viagem desmarcada'))
  await drain()
})

test('almoxarifado: fluxo interno avisa; pedido externo não tem a quem avisar', async () => {
  const requester = await createUser('material@example.gov.br')
  const manager = await staff('material-gestora@example.gov.br', ['warehouse:manage'])
  const material = await post('/warehouse/materials', manager, { name: 'Papel A4', unitId: options['Unidade'] })
  assert.equal(material.status, 201, material.text)

  const internal = await post('/warehouse/requests', requester, {
    items: [{ materialId: material.body.id, requested: 10 }],
    avisoPrivacidade: 'almoxarifado-2026-11',
  })
  assert.equal(internal.status, 201, internal.text)
  const id = internal.body.id

  const items = (fulfilled: number) => ({ items: [{ materialId: material.body.id, requested: 10, fulfilled }] })
  assert.equal((await post(`/warehouse/requests/${id}/status`, manager, { status: 'em_analise' })).status, 200)
  assert.equal((await call(`/warehouse/requests/${id}/items`, { method: 'PUT', session: manager, body: items(4) })).status, 200)
  assert.equal((await post(`/warehouse/requests/${id}/status`, manager, { status: 'atendido_parcial' })).status, 200)
  assert.equal((await call(`/warehouse/requests/${id}/items`, { method: 'PUT', session: manager, body: items(10) })).status, 200)
  assert.equal((await post(`/warehouse/requests/${id}/status`, manager, { status: 'atendido' })).status, 200)
  assert.equal((await post(`/warehouse/requests/${id}/deliver`, manager, { receivedBy: 'Pessoa Recebedora' })).status, 200)

  const rows = await deliveriesOf(id)
  assert.deepEqual(
    rows.filter((row) => row.audience === 'requester').map((row) => row.template_key),
    ['warehouse_received', 'warehouse_in_review', 'warehouse_partial', 'warehouse_ready', 'warehouse_delivered'],
  )

  const fake = fakeEmail()
  await processEmailQueue(fake.transport)
  assert.ok(!fake.sent.some((message) => message.text.includes('Pessoa Recebedora')))

  const seen = await call('/notifications', { session: requester })
  assert.ok(seen.body.notifications.every((item: { link: string }) => item.link === `/almoxarifado/pedidos/${id}`))
  const stored = await pool.query(`SELECT lgpd_aceite FROM public.material_requests WHERE id = $1`, [id])
  assert.equal(stored.rows[0].lgpd_aceite, false)
  const detail = await call(`/warehouse/requests/${id}`, { session: requester })
  assert.equal(detail.body.history[0].details.avisoPrivacidade, 'almoxarifado-2026-11')

  const external = await post('/warehouse/external-requests', manager, {
    sectorId: options['CPC'],
    externalRequester: 'Pessoa Externa',
    items: [{ materialId: material.body.id, requested: 1 }],
  })
  assert.equal(external.status, 201, external.text)
  await post(`/warehouse/requests/${external.body.id}/status`, manager, { status: 'em_analise' })
  assert.deepEqual(await deliveriesOf(external.body.id), [])
  await drain()
})

test('google simulado: cria, reagenda e cancela sem duplicar; a agenda segue sem o provedor', async () => {
  const requester = await createUser('agenda@example.gov.br')
  const operator = await staff('agenda-op@example.gov.br')
  const created = await post('/fleet/requests', requester, fleetBody())
  const id = created.body.id
  const base = `/fleet/requests/${id}`

  const offline = fakeCalendar([new IntegrationError('GOOGLE_500', true)])
  assert.equal((await post(`${base}/schedule`, operator, { dataAgendada: '2031-05-10T13:00:00.000Z', motivoCodigo: 'conflito_agenda' })).status, 200)

  // O provedor fora do ar não atrapalha a agenda interna.
  assert.deepEqual(await processCalendarQueue(offline.transport), { synced: 0, failed: 1 })
  const events = await call(
    '/calendar/events?from=2031-05-01T00:00:00.000Z&to=2031-06-01T00:00:00.000Z',
    { session: operator },
  )
  assert.ok(events.body.events.some((event: { id: string }) => event.id === id))

  const item = async () =>
    (await pool.query(
      `SELECT id::text AS id, status, attempts, revision, synced_revision, last_error_code, external_event_id
         FROM public.calendar_sync_items WHERE request_id = $1`,
      [id],
    )).rows[0]
  assert.equal((await item()).status, 'pending')
  assert.equal((await item()).last_error_code, 'GOOGLE_500')

  await dueNow()
  const calendar = fakeCalendar()
  assert.deepEqual(await processCalendarQueue(calendar.transport), { synced: 1, failed: 0 })
  const expectedId = `slm${id.replace(/-/g, '')}`
  assert.equal(calendar.operations[0].eventId, expectedId)
  assert.equal((await item()).status, 'synced')
  assert.equal((await item()).external_event_id, expectedId)

  // Sem nada novo, nada é enviado.
  assert.deepEqual(await processCalendarQueue(calendar.transport), { synced: 0, failed: 0 })

  // O evento só leva o necessário.
  const sentEvent = calendar.operations[0].event!
  const eventText = JSON.stringify(sentEvent)
  for (const secret of ['agenda@example.gov.br', 'Pessoa agenda', 'Pessoa Passageira', 'Entrega de documentos']) {
    assert.ok(!eventText.includes(secret), `evento expôs ${secret}`)
  }

  assert.equal((await post(`${base}/schedule`, operator, {
    dataAgendada: '2031-05-12T13:00:00.000Z',
    comentario: 'Mudança',
  })).status, 200)
  assert.equal((await item()).revision, 2)
  await processCalendarQueue(calendar.transport)
  assert.equal(calendar.operations[1].kind, 'upsert')
  assert.equal(calendar.operations[1].eventId, expectedId)
  assert.equal(calendar.operations[1].event!.start.toISOString(), '2031-05-12T13:00:00.000Z')

  assert.equal((await post(`${base}/cancel`, operator, { motivo: 'Desmarcado' })).status, 200)
  await processCalendarQueue(calendar.transport)
  assert.deepEqual(
    calendar.operations.slice(2).map((operation) => [operation.kind, operation.eventId]),
    [['remove', expectedId]],
  )
  assert.equal((await item()).status, 'synced')
  await drain()
})

test('mudança durante a sincronização não se perde', async () => {
  const requester = await createUser('corrida@example.gov.br')
  const operator = await staff('corrida-op@example.gov.br')
  const created = await post('/fleet/requests', requester, fleetBody())
  const id = created.body.id
  await post(`/fleet/requests/${id}/schedule`, operator, { motivoCodigo: 'conflito_agenda', dataAgendada: '2031-06-10T13:00:00.000Z' })

  // Durante o envio, chega um reagendamento.
  const transport: CalendarTransport = {
    provider: 'falso',
    simulated: true,
    upsert: async () => {
      await post(`/fleet/requests/${id}/schedule`, operator, {
        motivoCodigo: 'conflito_agenda',
        dataAgendada: '2031-06-11T13:00:00.000Z',
        comentario: 'Mudou durante o envio',
      })
    },
    remove: async () => {},
  }
  await processCalendarQueue(transport)

  const { rows } = await pool.query(
    `SELECT status, revision, synced_revision FROM public.calendar_sync_items WHERE request_id = $1`,
    [id],
  )
  assert.deepEqual(rows[0], { status: 'pending', revision: 2, synced_revision: 1 })

  const calendar = fakeCalendar()
  await processCalendarQueue(calendar.transport)
  assert.equal(calendar.operations[0].event!.start.toISOString(), '2031-06-11T13:00:00.000Z')
  await drain()
})

test('calendário: falha definitiva vai para reprocessamento autorizado', async () => {
  const requester = await createUser('cal-falha@example.gov.br')
  const operator = await staff('cal-falha-op@example.gov.br')
  const created = await post('/maintenance/requests', requester, maintenanceBody())
  await post(`/maintenance/requests/${created.body.id}/schedule`, operator, { dataAgendada: '2031-07-10T13:00:00.000Z' })

  await processCalendarQueue(fakeCalendar([new IntegrationError('GOOGLE_401', false)]).transport)
  const list = await call('/integrations/calendar?status=failed', { session: admin })
  const failed = list.body.items.find((item: { requestId: string }) => item.requestId === created.body.id)
  assert.equal(failed.errorCode, 'GOOGLE_401')
  assert.equal(failed.protocol, created.body.protocol)

  assert.equal((await post(`/integrations/calendar/${failed.id}/retry`, operator)).status, 403)
  assert.equal((await post(`/integrations/calendar/${failed.id}/retry`, admin)).status, 200)
  const calendar = fakeCalendar()
  await processCalendarQueue(calendar.transport)
  assert.equal(calendar.operations.length, 1)

  const attempts = await call(`/integrations/calendar/${failed.id}/attempts`, { session: admin })
  assert.deepEqual(attempts.body.attempts.map((item: { outcome: string }) => item.outcome), ['failure', 'success'])
  await drain()
})

test('calendário sem configuração: fica registrado e nunca é enviado', async () => {
  delete process.env.GOOGLE_CALENDAR_TRANSPORT
  const requester = await createUser('cal-sem@example.gov.br')
  const operator = await staff('cal-sem-op@example.gov.br')
  const created = await post('/maintenance/requests', requester, maintenanceBody())
  const scheduled = await post(`/maintenance/requests/${created.body.id}/schedule`, operator, {
    dataAgendada: '2031-07-20T13:00:00.000Z',
  })
  assert.equal(scheduled.status, 200)

  const { rows } = await pool.query(
    `SELECT id::text AS id, status FROM public.calendar_sync_items WHERE request_id = $1`,
    [created.body.id],
  )
  assert.equal(rows[0].status, 'not_configured')
  const calendar = fakeCalendar()
  assert.deepEqual(await processCalendarQueue(calendar.transport), { synced: 0, failed: 0 })
  assert.equal((await post(`/integrations/calendar/${rows[0].id}/retry`, admin)).status, 409)
  assert.deepEqual(await processCalendarQueue(null), { synced: 0, failed: 0 })
  await drain()
})

test('conflitos: mesmo responsável ou veículo pedem confirmação, e a escolha fica registrada', async () => {
  const requester = await createUser('conflito@example.gov.br')
  const operator = await staff('conflito-op@example.gov.br')
  const secondOperator = await staff('conflito-op2@example.gov.br')

  const first = await post('/maintenance/requests', requester, maintenanceBody())
  const second = await post('/fleet/requests', requester, fleetBody())
  const third = await post('/fleet/requests', requester, fleetBody({ veiculo: 'Van 01' }))
  const fourth = await post('/fleet/requests', requester, fleetBody({ veiculo: ' VAN 01 ' }))

  const start = '2031-08-10T13:00:00.000Z'
  const end = '2031-08-10T15:00:00.000Z'
  assert.equal((await post(`/maintenance/requests/${first.body.id}/schedule`, operator, { dataAgendada: start, dataFim: end })).status, 200)

  // Mesmo responsável, entre módulos, com horário sobreposto.
  const overlapping = await post(`/fleet/requests/${second.body.id}/schedule`, operator, {
    motivoCodigo: 'conflito_agenda',
    dataAgendada: '2031-08-10T14:00:00.000Z',
  })
  assert.equal(overlapping.status, 409)
  assert.equal(overlapping.body.code, 'SCHEDULE_CONFLICT')
  assert.equal(overlapping.body.conflicts[0].protocol, first.body.protocol)
  assert.equal(overlapping.body.conflicts[0].reason, 'responsible')
  assert.ok(!overlapping.text.includes('conflito@example.gov.br'))

  // Nada mudou com a recusa.
  const unchanged = await call(`/fleet/requests/${second.body.id}`, { session: operator })
  assert.equal(unchanged.body.request.status, 'aguardando_agendamento')

  // Terminar exatamente quando o outro começa não é conflito.
  assert.equal((await post(`/fleet/requests/${second.body.id}/schedule`, operator, {
    motivoCodigo: 'conflito_agenda',
    dataAgendada: end,
  })).status, 200)

  // Outro responsável, no mesmo horário: sem regra de equipe, é permitido.
  assert.equal((await post(`/fleet/requests/${third.body.id}/schedule`, secondOperator, { motivoCodigo: 'conflito_agenda', dataAgendada: start, dataFim: end })).status, 200)

  // Mesmo veículo, com escrita diferente. Quem agenda é da SLM, com a concessão (P-08).
  const vehicleScheduler = await staff('conflito-veiculo@example.gov.br')
  const vehicle = await post(`/fleet/requests/${fourth.body.id}/schedule`, vehicleScheduler, {
    motivoCodigo: 'conflito_agenda',
    dataAgendada: '2031-08-10T14:00:00.000Z',
  })
  assert.equal(vehicle.status, 409)
  assert.equal(vehicle.body.conflicts[0].protocol, third.body.protocol)
  assert.equal(vehicle.body.conflicts[0].reason, 'vehicle')

  // Quem agenda decide: a confirmação é aceita e fica no histórico.
  const confirmed = await post(`/fleet/requests/${fourth.body.id}/schedule`, vehicleScheduler, {
    motivoCodigo: 'conflito_agenda',
    dataAgendada: '2031-08-10T14:00:00.000Z',
    confirmarConflito: true,
  })
  assert.equal(confirmed.status, 200, confirmed.text)
  const history = await call(`/fleet/requests/${fourth.body.id}`, { session: admin })
  const scheduled = history.body.history.find((entry: { action: string }) => entry.action === 'agendada')
  assert.deepEqual(scheduled.details.conflitosConfirmados, [third.body.protocol])

  // Compromisso cancelado libera o horário.
  await post(`/fleet/requests/${third.body.id}/cancel`, secondOperator, { motivo: 'Desmarcado' })
  await post(`/fleet/requests/${fourth.body.id}/cancel`, admin, { motivo: 'Desmarcado' })
  const again = await post('/fleet/requests', requester, fleetBody({ veiculo: 'Van 01' }))
  assert.equal((await post(`/fleet/requests/${again.body.id}/schedule`, vehicleScheduler, {
    motivoCodigo: 'conflito_agenda',
    dataAgendada: start,
  })).status, 200)
  await drain()
})

test('alteração simultânea: quem viu uma versão antiga é avisado, e dois agendamentos não escapam', async () => {
  const requester = await createUser('simultaneo@example.gov.br')
  const operator = await staff('simultaneo-op@example.gov.br')
  const created = await post('/maintenance/requests', requester, maintenanceBody())
  const base = `/maintenance/requests/${created.body.id}`

  const seen = (await call(base, { session: operator })).body.request.updatedAt
  assert.equal((await post(`${base}/schedule`, operator, {
    dataAgendada: '2031-09-10T13:00:00.000Z',
    versao: seen,
  })).status, 200)

  const stale = await post(`${base}/schedule`, operator, {
    dataAgendada: '2031-09-12T13:00:00.000Z',
    comentario: 'Com a tela desatualizada',
    versao: seen,
  })
  assert.equal(stale.status, 409)
  assert.ok(stale.body.message.includes('outra pessoa'))

  const current = await call(base, { session: operator })
  assert.equal(current.body.request.scheduledAt, '2031-09-10T13:00:00.000Z')

  // Dois agendamentos simultâneos do mesmo responsável: um só passa sem confirmação.
  const a = await post('/maintenance/requests', requester, maintenanceBody())
  const b = await post('/maintenance/requests', requester, maintenanceBody())
  const results = await Promise.all(
    [a, b].map((item) =>
      post(`/maintenance/requests/${item.body.id}/schedule`, operator, {
        dataAgendada: '2031-09-20T13:00:00.000Z',
      }),
    ),
  )
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
  await drain()
})

test('agenda: filtros por status e responsável, e compromisso que atravessa o período', async () => {
  const requester = await createUser('filtros@example.gov.br')
  const operator = await staff('filtros-op@example.gov.br')
  const other = await staff('filtros-op2@example.gov.br')

  const scheduled = await post('/maintenance/requests', requester, maintenanceBody())
  await post(`/maintenance/requests/${scheduled.body.id}/schedule`, operator, {
    dataAgendada: '2032-01-30T13:00:00.000Z',
    dataFim: '2032-02-02T13:00:00.000Z',
  })
  const cancelled = await post('/fleet/requests', requester, fleetBody())
  await post(`/fleet/requests/${cancelled.body.id}/schedule`, other, { motivoCodigo: 'conflito_agenda', dataAgendada: '2032-02-01T13:00:00.000Z' })
  await post(`/fleet/requests/${cancelled.body.id}/cancel`, other, { motivo: 'Desmarcado' })

  const query = (extra: string) =>
    call(`/calendar/events?from=2032-02-01T00:00:00.000Z&to=2032-03-01T00:00:00.000Z${extra}`, { session: operator })
  const ids = (response: { body: Record<string, any> }) => response.body.events.map((event: { id: string }) => event.id)

  // Começou antes do período e continua dentro dele.
  assert.ok(ids(await query('')).includes(scheduled.body.id))
  assert.ok(ids(await query('')).includes(cancelled.body.id))

  assert.deepEqual(ids(await query('&statuses=cancelado')), [cancelled.body.id])
  assert.deepEqual(ids(await query('&statuses=agendado')), [scheduled.body.id])
  assert.deepEqual(ids(await query(`&responsibleId=${other.id}`)), [cancelled.body.id])
  assert.deepEqual(ids(await query('&modules=fleet')), [cancelled.body.id])

  // O solicitante vê só os próprios, com os mesmos filtros.
  const stranger = await createUser('filtros-outro@example.gov.br')
  const denied = await call('/calendar/events?from=2032-02-01T00:00:00.000Z&to=2032-03-01T00:00:00.000Z', { session: stranger })
  assert.equal(denied.status, 403)
  await drain()
})

test('relatórios: indicadores reais, com a limitação informada e no alcance de quem consulta', async () => {
  const requester = await createUser('rel@example.gov.br')
  // Sem a gestão do Almoxarifado (retirada individual), para conferir o alcance do relatório.
  const operator = await staff('rel-op@example.gov.br', ['requests:schedule'], ['warehouse:manage'])
  const period = 'from=2020-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z'

  const before = (await call(`/reports/operational?${period}&module=maintenance`, { session: operator })).body

  const done = await post('/maintenance/requests', requester, maintenanceBody())
  await post(`/maintenance/requests/${done.body.id}/schedule`, operator, { dataAgendada: '2033-01-10T13:00:00.000Z' })
  await post(`/maintenance/requests/${done.body.id}/schedule`, operator, { dataAgendada: '2033-01-11T13:00:00.000Z', comentario: 'Mudança' })
  await post(`/maintenance/requests/${done.body.id}/start`, operator, { inicioReal: '2026-01-01T10:00:00.000Z' })
  await post(`/maintenance/requests/${done.body.id}/complete`, operator, { fimReal: '2026-01-01T11:30:00.000Z' })

  // Registro concluído sem horários de execução, como os anteriores ao sistema.
  const legacy = await post('/maintenance/requests', requester, maintenanceBody())
  await pool.query(`UPDATE public.service_requests SET status = 'concluida' WHERE id = $1`, [legacy.body.id])

  const report = (await call(`/reports/operational?${period}&module=maintenance`, { session: operator })).body
  assert.equal(report.scheduling.scheduled, before.scheduling.scheduled + 1)
  assert.equal(report.scheduling.rescheduled, before.scheduling.rescheduled + 1)
  const time = report.serviceTime.find((row: { module: string }) => row.module === 'maintenance')
  // A média usa só os registros com dados, e a diferença fica visível.
  assert.ok(time.concluded > time.withData)
  assert.ok(time.averageMinutes > 0)
  assert.equal(report.warehouse, null)
  assert.equal(report.inventory, null)
  assert.equal(report.fleet, null)

  // Sem permissão, não há relatório.
  assert.equal((await call(`/reports/operational?${period}`, { session: requester })).status, 403)

  // A conferência de inventário só aparece para quem administra o Almoxarifado.
  const operatorAll = (await call(`/reports/operational?${period}`, { session: operator })).body
  assert.equal(operatorAll.inventory, null)
  const manager = await staff('rel-gestora@example.gov.br', ['warehouse:manage'])
  const material = await post('/warehouse/materials', manager, { name: 'Caneta rel', unitId: options['Unidade'] })
  const check = await post('/warehouse/inventory-checks', manager, {
    title: 'Conferência rel',
    referenceDate: '2026-01-01',
    items: [{ materialId: material.body.id, governmentQuantity: 5 }],
  })
  assert.equal(check.status, 201, check.text)
  const counted = await call(`/warehouse/inventory-checks/${check.body.id}/items/${material.body.id}`, {
    method: 'PUT',
    session: manager,
    body: { governmentQuantity: 5, countedQuantity: 4 },
  })
  assert.equal(counted.status, 200, counted.text)
  const managerAll = (await call(`/reports/operational?${period}`, { session: manager })).body
  assert.equal(managerAll.inventory.items, 1)
  assert.equal(managerAll.inventory.counted, 1)
  assert.equal(managerAll.inventory.divergent, 1)
  await drain()
})

test('administração: permissões, e-mails mascarados e nenhuma credencial', async () => {
  const requester = await createUser('adm-int@example.gov.br')
  const created = await post('/maintenance/requests', requester, maintenanceBody())

  for (const path of ['/integrations/status', '/integrations/templates', '/integrations/emails', '/integrations/calendar']) {
    assert.equal((await call(path, { session: requester })).status, 403, path)
    assert.equal((await call(path)).status, 401, path)
  }

  process.env.RESEND_API_KEY = 'valor-secreto-de-teste'
  try {
    const status = await call('/integrations/status', { session: admin })
    assert.equal(status.status, 200)
    assert.ok(!status.text.includes('valor-secreto-de-teste'))
    assert.equal(status.body.status.email.mode, 'simulated')
  } finally {
    delete process.env.RESEND_API_KEY
  }

  const list = await call(`/integrations/emails?search=${created.body.protocol}`, { session: admin })
  assert.ok(list.body.total >= 1)
  assert.ok(!list.text.includes('adm-int@example.gov.br'))
  assert.equal(list.body.emails[0].recipient, 'ad***@example.gov.br')
  assert.ok(!list.text.includes('Descrição interna'))

  const filtered = await call('/integrations/emails?status=failed&module=flights', { session: admin })
  assert.ok(filtered.body.emails.every((row: { status: string; module: string }) => row.status === 'failed' && row.module === 'flights'))

  const templates = await call('/integrations/templates', { session: admin })
  assert.ok(templates.body.templates.some((row: { key: string }) => row.key === 'request_rescheduled'))
  await drain()
})

test('situação de entrega: consultada só quando o provedor informa', async () => {
  const requester = await createUser('entrega@example.gov.br')
  const created = await post('/maintenance/requests', requester, maintenanceBody())
  const fake = fakeEmail()
  fake.transport = { ...fake.transport, simulated: false }
  await processEmailQueue(fake.transport)
  assert.ok((await refreshDeliveryStatuses(fake.transport)) >= 1)

  const { rows } = await pool.query(
    `SELECT d.delivery_status FROM public.email_deliveries d
       JOIN public.integration_events e ON e.id = d.event_id
      WHERE e.resource_id = $1`,
    [created.body.id],
  )
  assert.equal(rows[0].delivery_status, 'delivered')
  assert.equal(await refreshDeliveryStatuses(null), 0)
  await pool.query(`UPDATE public.email_deliveries SET simulated = true WHERE provider = 'falso'`)
})

test('lembrete de pendências: só com prazo definido, por módulo, uma vez ao dia', async () => {
  const requester = await createUser('lembrete@example.gov.br')
  const team = await staff('lembrete-equipe@example.gov.br')
  const created = await post('/maintenance/requests', requester, maintenanceBody())

  assert.equal(await publishPendingReminders(null), 0)

  await pool.query(`ALTER TABLE public.service_requests DISABLE TRIGGER trg_sr_updated_at`)
  await pool.query(`UPDATE public.service_requests SET updated_at = now() - interval '10 days' WHERE id = $1`, [created.body.id])
  await pool.query(`ALTER TABLE public.service_requests ENABLE TRIGGER trg_sr_updated_at`)

  const today = new Date('2033-05-05T12:00:00.000Z')
  assert.ok((await publishPendingReminders(5, undefined, today)) >= 1)
  await publishPendingReminders(5, undefined, today)

  const notices = await call('/notifications', { session: team })
  const reminders = notices.body.notifications.filter((item: { category: string; link: string }) =>
    item.category === 'pendencia' && item.link === '/manutencao')
  assert.equal(reminders.length, 1)
  assert.ok(reminders[0].message.includes('5 dias'))

  // Quem só solicita não é avisado.
  const forRequester = await call('/notifications', { session: requester })
  assert.ok(!forRequester.body.notifications.some((item: { category: string }) => item.category === 'pendencia'))
  await drain()
})

test('registros históricos: eventos, tentativas e histórico não mudam nem somem', async () => {
  const requester = await createUser('imutavel@example.gov.br')
  const created = await post('/maintenance/requests', requester, maintenanceBody())
  const fake = fakeEmail()
  await processEmailQueue(fake.transport)

  for (const statement of [
    `UPDATE public.integration_events SET event_type = 'x' WHERE resource_id = '${created.body.id}'`,
    `DELETE FROM public.integration_events WHERE resource_id = '${created.body.id}'`,
    `UPDATE public.integration_attempts SET outcome = 'failure'`,
    `DELETE FROM public.integration_attempts`,
  ]) {
    await assert.rejects(pool.query(statement), /Registros de integração não podem ser alterados/, statement)
  }
  // O histórico das solicitações segue protegido pelo gatilho da migração 005.
  for (const statement of [
    `UPDATE public.request_history SET acao = 'x' WHERE request_id = '${created.body.id}'`,
    `DELETE FROM public.request_history WHERE request_id = '${created.body.id}'`,
  ]) {
    await assert.rejects(pool.query(statement), statement)
  }
  const kept = await pool.query(
    `SELECT acao FROM public.request_history WHERE request_id = $1`,
    [created.body.id],
  )
  assert.deepEqual(kept.rows, [{ acao: 'criada' }])
  await drain()
})

test('a migração 006 pode ser desfeita sem tocar nas solicitações', async () => {
  const before = await pool.query(`SELECT count(*)::int AS total FROM public.service_requests`)
  await pool.query(schema('006_integrations.rollback.sql'))

  const remaining = await pool.query(
    `SELECT count(*)::int AS total FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('integration_events', 'email_deliveries', 'user_notifications',
                           'calendar_sync_items', 'integration_attempts')`,
  )
  assert.equal(remaining.rows[0].total, 0)
  const after = await pool.query(`SELECT count(*)::int AS total FROM public.service_requests`)
  assert.equal(after.rows[0].total, before.rows[0].total)

  await pool.query(schema('006_integrations.sql'))
})
