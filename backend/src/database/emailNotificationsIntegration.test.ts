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
import { demandEmailRecipients } from '../demands/demandNotifications.js'
import { addDays } from '../demands/recurrence.js'
import { IntegrationError, setEmailTransportForTests } from '../integrations/transports.js'
import type { EmailTransport, OutgoingEmail } from '../integrations/transports.js'
import { processEmailQueue } from '../integrations/worker.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { todayInSaoPaulo } from './demandSeriesRepository.js'
import { PasswordRecoveryRepository } from './passwordRecoveryRepository.js'
import { setDatabasePoolForTests } from './pool.js'

// E-mails de conta, segurança e Demandas pela API real, em um PostgreSQL descartável. O provedor é
// falso e a trava de rede dos testes continua valendo: nenhuma mensagem sai da máquina.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')
const today = todayInSaoPaulo()

let pool: Pool
let server: Server
let baseUrl: string
const csrfTokens = new Map<string, string>()
const savedEnvironment = { EMAIL_TRANSPORT: process.env.EMAIL_TRANSPORT, APP_PUBLIC_URL: process.env.APP_PUBLIC_URL }

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
  return { status: response.status, body, text, setCookie }
}

const post = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'POST', session, body })
const put = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'PUT', session, body })

function resetLoginLimits(email: string) {
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1']) authRateLimits.loginPair.reset(`${ip}|${email}`)
  authRateLimits.loginAccount.reset(email)
}

async function signIn(email: string): Promise<Session> {
  resetLoginLimits(email)
  const result = await call('/auth/login', { method: 'POST', body: { identifier: email, password } })
  assert.equal(result.status, 200, `login de ${email}`)
  return { cookie: result.setCookie, id: result.body.user.id }
}

async function register(email: string) {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { fullName: `Pessoa ${email.split('@')[0]}`, email, sector: 'Administração', password, passwordConfirmation: password },
  })
  assert.equal(registered.status, 202, registered.text)
  const pending = await call('/admin/registrations/pending', { session: admin })
  return pending.body.registrations.find((item: { email: string }) => item.email === email).id as string
}

async function createUser(email: string): Promise<Session> {
  const id = await register(email)
  assert.equal((await post(`/admin/registrations/${id}/approve`, admin, { role: 'requester' })).status, 200)
  return signIn(email)
}

type Delivery = { id: string; template_key: string; recipient: string; status: string; audience: string; subject: string; payload: Record<string, unknown> }

async function deliveries(templateKey: string, recipient?: string) {
  const { rows } = await pool.query<Delivery>(
    `SELECT d.id::text AS id, d.template_key, d.recipient, d.status, d.audience, d.subject, e.payload
       FROM public.email_deliveries d JOIN public.integration_events e ON e.id = d.event_id
      WHERE d.template_key = $1 AND ($2::text IS NULL OR d.recipient = $2)
      ORDER BY d.created_at`,
    [templateKey, recipient ?? null],
  )
  return rows
}

async function waitFor<T>(read: () => Promise<T[]>, minimum = 1) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await read()
    if (rows.length >= minimum) return rows
    await new Promise((done) => setTimeout(done, 50))
  }
  return read()
}

/** Provedor falso: guarda cada mensagem, ou responde com a falha pedida. */
function fakeTransport(failure?: () => never): EmailTransport & { sent: OutgoingEmail[] } {
  const sent: OutgoingEmail[] = []
  return {
    provider: 'falso',
    simulated: true,
    sent,
    async send(message) {
      if (failure) failure()
      sent.push(message)
      return { messageId: `msg-${sent.length}` }
    },
  }
}

let admin: Session
const adminEmail = 'emails-admin@example.gov.br'

before(async () => {
  process.env.EMAIL_TRANSPORT = 'simulated'
  process.env.APP_PUBLIC_URL = 'https://slm.exemplo.gov.br'
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
     VALUES ('Administradora', $2, 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password), adminEmail],
  )
  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn(adminEmail)
})

after(async () => {
  setEmailTransportForTests(undefined)
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

// ---------------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------------
test('cadastro: confirmação a quem pediu e aviso a quem aprova; o duplicado não gera nada', async () => {
  await register('emails-novo@example.gov.br')
  const received = await deliveries('account_registration_received', 'emails-novo@example.gov.br')
  assert.equal(received.length, 1)
  assert.equal(received[0].status, 'pending')
  assert.equal(received[0].audience, 'requester')
  assert.equal(received[0].subject, 'Cadastro recebido - Conta de acesso - JUCESP')
  const pending = await deliveries('account_registration_pending')
  assert.deepEqual(pending.map((item) => item.recipient), [adminEmail])
  // Nem o nome nem o e-mail de quem pediu entram no conteúdo do evento.
  assert.ok(!JSON.stringify(pending[0].payload).includes('emails-novo'))

  const again = await call('/auth/register', {
    method: 'POST',
    body: { fullName: 'Outra Pessoa', email: 'emails-novo@example.gov.br', sector: 'TI', password, passwordConfirmation: password },
  })
  assert.equal(again.status, 202)
  assert.equal((await deliveries('account_registration_received', 'emails-novo@example.gov.br')).length, 1)
  assert.equal((await deliveries('account_registration_pending')).length, 1)
})

test('decisão: aprovado com o perfil; rejeitado no endereço do pedido, sem motivo interno', async () => {
  const approvedId = await register('emails-aprovado@example.gov.br')
  assert.equal((await post(`/admin/registrations/${approvedId}/approve`, admin, { role: 'requester' })).status, 200)
  const approved = await deliveries('account_approved', 'emails-aprovado@example.gov.br')
  assert.equal(approved.length, 1)
  assert.equal(approved[0].payload.profileLabel, 'Solicitante')

  const rejectedId = await register('emails-rejeitado@example.gov.br')
  assert.equal((await post(`/admin/registrations/${rejectedId}/reject`, admin)).status, 200)
  const rejected = await deliveries('account_rejected', 'emails-rejeitado@example.gov.br')
  assert.equal(rejected.length, 1)
  assert.deepEqual(Object.keys(rejected[0].payload).sort(), ['module', 'protocol'])
})

test('conta: desativação, ativação, mudança de perfil e encerramento de sessões avisam a pessoa', async () => {
  const user = await createUser('emails-conta@example.gov.br')
  assert.equal((await post(`/admin/users/${user.id}/deactivate`, admin)).status, 200)
  assert.equal((await deliveries('account_deactivated', 'emails-conta@example.gov.br')).length, 1)
  assert.equal((await post(`/admin/users/${user.id}/activate`, admin)).status, 200)
  assert.equal((await deliveries('account_activated', 'emails-conta@example.gov.br')).length, 1)

  const changed = await put(`/admin/users/${user.id}/access`, admin, {
    role: 'slm_operator', slmMember: true, grantedPermissions: [], deniedPermissions: [],
  })
  assert.equal(changed.status, 200, changed.text)
  const access = await deliveries('account_access_changed', 'emails-conta@example.gov.br')
  assert.equal(access.length, 1)
  assert.equal(access[0].payload.profileLabel, 'Operador SLM')
  // Nenhuma lista de permissões vai no aviso: só o nome do perfil.
  assert.deepEqual(Object.keys(access[0].payload).sort(), ['module', 'profileLabel', 'protocol'])

  await signIn('emails-conta@example.gov.br')
  assert.equal((await post(`/admin/users/${user.id}/sessions/revoke`, admin)).status, 200)
  assert.equal((await deliveries('security_sessions_revoked', 'emails-conta@example.gov.br')).length, 1)
})

test('senha alterada pela recuperação: aviso ao titular, sem código, token nem senha', async () => {
  await createUser('emails-senha@example.gov.br')
  const repository = new PasswordRecoveryRepository(() => pool)
  const tokenHash = 'a'.repeat(64)
  assert.ok(await repository.createCode('emails-senha@example.gov.br', tokenHash))
  assert.equal(await repository.resetPasswordByToken({ tokenHash, passwordHash: await hashPassword(password) }), 'emails-senha@example.gov.br')
  const changed = await deliveries('account_password_changed', 'emails-senha@example.gov.br')
  assert.equal(changed.length, 1)
  assert.ok(!JSON.stringify(changed[0].payload).includes(tokenHash))
  assert.deepEqual(Object.keys(changed[0].payload).sort(), ['module', 'occurredAt', 'protocol'])
})

// ---------------------------------------------------------------------------
// Segurança
// ---------------------------------------------------------------------------
test('bloqueio por tentativas: aviso à pessoa e aos administradores, uma vez por janela', async () => {
  const email = 'emails-bloqueio@example.gov.br'
  await createUser(email)
  resetLoginLimits(email)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wrong = await call('/auth/login', { method: 'POST', body: { identifier: email, password: 'senha-errada' } })
    assert.equal(wrong.status, 401)
  }
  const blocked = await waitFor(() => deliveries('security_login_blocked', email))
  assert.equal(blocked.length, 1)
  const alert = await waitFor(() => deliveries('security_login_blocked_admin'))
  assert.deepEqual(alert.map((item) => item.recipient), [adminEmail])
  // A conta não é identificada no aviso aos administradores.
  assert.ok(!JSON.stringify(alert[0].payload).includes('bloqueio'))
  resetLoginLimits(email)
})

test('novo acesso: desligado por padrão; ligado em Parâmetros, avisa a cada login', async () => {
  const email = 'emails-acesso@example.gov.br'
  await createUser(email)
  assert.equal((await deliveries('security_new_login', email)).length, 0)

  const disabled = { administrator: [], slm_operator: [], requester: [] }
  const on = await put('/settings/parameters/notifications', admin, { disabled, securityEmails: { newLogin: true } })
  assert.equal(on.status, 200, on.text)
  await signIn(email)
  assert.equal((await deliveries('security_new_login', email)).length, 1)
  assert.equal((await put('/settings/parameters/notifications', admin, { disabled })).status, 200)
  await signIn(email)
  assert.equal((await deliveries('security_new_login', email)).length, 1)
})

// ---------------------------------------------------------------------------
// Worker: envio, falhas, reprocessamento e "não configurado"
// ---------------------------------------------------------------------------
test('worker: mensagens da conta saem em texto e HTML; rejeição sem link, aprovação com link', async () => {
  const transport = fakeTransport()
  await processEmailQueue(transport)
  const rejected = transport.sent.find((item) => item.to === 'emails-rejeitado@example.gov.br' && item.subject.startsWith('Cadastro não aprovado'))
  const approved = transport.sent.find((item) => item.to === 'emails-aprovado@example.gov.br' && item.subject.startsWith('Cadastro aprovado'))
  assert.ok(rejected && approved)
  assert.equal(rejected.subject, 'Cadastro não aprovado - Conta de acesso - JUCESP')
  assert.doesNotMatch(rejected.text, /Acompanhe pelo sistema/)
  assert.match(approved.text, /Acompanhe pelo sistema: https:\/\/slm\.exemplo\.gov\.br\//)
  assert.match(approved.html, /Perfil de acesso: Solicitante/)
  assert.ok(approved.idempotencyKey.startsWith('slm-'))
  const sent = await deliveries('account_approved', 'emails-aprovado@example.gov.br')
  assert.equal(sent[0].status, 'sent')
})

test('falha do provedor: temporária volta à fila; definitiva vira falha e só sai por reprocessamento', async () => {
  const user = await createUser('emails-falha@example.gov.br')
  await pool.query(`UPDATE public.email_deliveries SET status = 'sent' WHERE status = 'pending'`)
  assert.equal((await post(`/admin/users/${user.id}/deactivate`, admin)).status, 200)
  const [item] = await deliveries('account_deactivated', 'emails-falha@example.gov.br')

  await processEmailQueue(fakeTransport(() => { throw new IntegrationError('RESEND_503', true) }))
  const temporary = await pool.query(`SELECT status, attempts, last_error_code FROM public.email_deliveries WHERE id = $1`, [item.id])
  assert.deepEqual(temporary.rows[0], { status: 'pending', attempts: 1, last_error_code: 'RESEND_503' })

  await pool.query(`UPDATE public.email_deliveries SET next_attempt_at = now() WHERE id = $1`, [item.id])
  await processEmailQueue(fakeTransport(() => { throw new IntegrationError('RESEND_422', false) }))
  const final = await pool.query(`SELECT status, last_error_code FROM public.email_deliveries WHERE id = $1`, [item.id])
  assert.deepEqual(final.rows[0], { status: 'failed', last_error_code: 'RESEND_422' })
  const attempts = await pool.query(`SELECT count(*)::int AS total FROM public.integration_attempts WHERE item_id = $1`, [item.id])
  assert.equal(attempts.rows[0].total, 2)

  assert.equal((await post(`/integrations/emails/${item.id}/retry`, admin)).status, 200)
  const transport = fakeTransport()
  await processEmailQueue(transport)
  assert.equal(transport.sent.filter((message) => message.to === 'emails-falha@example.gov.br').length, 1)
  const audit = await pool.query(`SELECT count(*)::int AS total FROM public.auth_audit_events WHERE action = 'integrations.retry'`)
  assert.equal(audit.rows[0].total, 1)
})

test('sem serviço ativo: fica "não configurado" e o worker não reprocessa sozinho', async () => {
  delete process.env.EMAIL_TRANSPORT
  try {
    await register('emails-sem-servico@example.gov.br')
  } finally {
    process.env.EMAIL_TRANSPORT = 'simulated'
  }
  const [item] = await deliveries('account_registration_received', 'emails-sem-servico@example.gov.br')
  assert.equal(item.status, 'not_configured')
  const transport = fakeTransport()
  await processEmailQueue(transport)
  assert.equal(transport.sent.filter((message) => message.to === 'emails-sem-servico@example.gov.br').length, 0)
  assert.equal((await deliveries('account_registration_received', 'emails-sem-servico@example.gov.br'))[0].status, 'not_configured')
})

test('teste de modelo: falha do provedor responde 502 e fica na auditoria, só com o código', async () => {
  setEmailTransportForTests(fakeTransport(() => { throw new IntegrationError('RESEND_500', true) }))
  try {
    const result = await post('/config/email-templates/account_approved/test', admin, {
      conteudo: {
        name: 'Cadastro aprovado',
        event: 'account_approved',
        subject: 'Cadastro aprovado',
        body: 'O seu cadastro foi aprovado, {{nome_usuario}}.',
        signature: 'Equipe SLM',
      },
    })
    assert.equal(result.status, 502, result.text)
    assert.match(result.body.message, /RESEND_500/)
  } finally {
    setEmailTransportForTests(undefined)
  }
  const audit = await pool.query<{ result: string; details: Record<string, string> }>(
    `SELECT result, details FROM public.auth_audit_events WHERE action = 'config.email_test_failed'`,
  )
  assert.equal(audit.rows.length, 1)
  assert.equal(audit.rows[0].result, 'failure')
  assert.deepEqual(audit.rows[0].details, { event: 'account_approved', code: 'RESEND_500', actorKind: 'user' })
})

// ---------------------------------------------------------------------------
// Controle de Demandas
// ---------------------------------------------------------------------------
let sectorId: string
let categoryId: string
let lead: Session
let member: Session
let other: Session
let outsider: Session

async function preferences(user: Session, email: boolean, muted: string[] = []) {
  const result = await put('/demands/preferences', user, { reminderDays: 3, muted, email })
  assert.equal(result.status, 200, result.text)
}

async function createDemand(extra: Record<string, unknown>) {
  const created = await post('/demands', lead, {
    title: 'Contrato sigiloso de exemplo',
    description: 'Conteúdo que não pode sair por e-mail.',
    categoryId,
    originSectorId: sectorId,
    responsibleSectorId: sectorId,
    responsibleId: member.id,
    dueDate: addDays(today, 10),
    priority: 'alta',
    ...extra,
  })
  assert.equal(created.status, 201, created.text)
  return created.body as { id: string; number: string }
}

test('demandas: preparação de setor, integrantes e preferências', async () => {
  const created = await post('/demands/settings/sectors', admin, { name: 'Setor de E-mails' })
  assert.equal(created.status, 201, created.text)
  sectorId = created.body.id
  categoryId = (await call('/demands/settings/categories', { session: admin })).body.categories[0].id
  lead = await createUser('emails-chefe@example.gov.br')
  member = await createUser('emails-membro@example.gov.br')
  other = await createUser('emails-outro@example.gov.br')
  outsider = await createUser('emails-fora@example.gov.br')
  for (const [user, role] of [[lead, 'responsavel'], [member, 'colaborador'], [other, 'colaborador']] as const) {
    const result = await put(`/demands/settings/sectors/${sectorId}/members/${user.id}`, admin, { role })
    assert.equal(result.status, 200, result.text)
  }
  for (const user of [lead, member, other]) await preferences(user, true)
})

test('demandas: restrita só alcança chefe e envolvidos; preferência e silêncio são respeitados', async () => {
  const restricted = await createDemand({ restricted: true })
  const candidates = [lead.id, member.id, other.id, outsider.id]
  const reached = async () =>
    (await demandEmailRecipients(pool, restricted.id, candidates, 'comentario')).map((item) => item.id).sort()
  assert.deepEqual(await reached(), [lead.id, member.id].sort(), 'o integrante não envolvido e quem é de fora não recebem')

  await preferences(member, true, ['comentario'])
  assert.deepEqual(await reached(), [lead.id], 'tipo silenciado não recebe')
  await preferences(member, true)
  await preferences(lead, false)
  assert.deepEqual(await reached(), [member.id], 'sem a preferência de e-mail, só o aviso no sino')
  await preferences(lead, true)

  // A atribuição da demanda restrita foi para a fila sem o título.
  const [assigned] = await deliveries('demand_atribuicao', 'emails-membro@example.gov.br')
  assert.ok(assigned)
  assert.deepEqual(assigned.payload, { restricted: true })
  assert.doesNotMatch(assigned.subject, /Contrato sigiloso/)
})

test('demandas: o worker confere de novo restrição, acesso e preferência no envio', async () => {
  await pool.query(`UPDATE public.email_deliveries SET status = 'sent' WHERE status = 'pending'`)
  const failuresBefore = await pool.query(`SELECT count(*)::int AS total FROM public.integration_events WHERE event_type = 'integration_failure'`)
  const common = await createDemand({ restricted: false, title: 'Levantamento comum' })
  let transport = fakeTransport()
  await processEmailQueue(transport)
  const commonMessage = transport.sent.find((message) => message.text.includes(common.number))
  assert.ok(commonMessage)
  assert.match(commonMessage.text, /Levantamento comum/)
  assert.match(commonMessage.text, /Acompanhe pelo sistema: https:\/\/slm\.exemplo\.gov\.br\/demandas\//)

  const secret = await createDemand({ restricted: true })
  transport = fakeTransport()
  await processEmailQueue(transport)
  const secretMessage = transport.sent.find((message) => message.text.includes(secret.number))
  assert.ok(secretMessage)
  assert.doesNotMatch(secretMessage.text + secretMessage.html + secretMessage.subject, /Contrato sigiloso|não pode sair/)

  // Ficou restrita depois de entrar na fila: sai sem o título.
  const later = await createDemand({ restricted: false, title: 'Ficará restrita' })
  await pool.query(`UPDATE public.demands SET restrita = true WHERE id = $1`, [later.id])
  transport = fakeTransport()
  await processEmailQueue(transport)
  const laterMessage = transport.sent.find((message) => message.text.includes(later.number))
  assert.ok(laterMessage)
  assert.doesNotMatch(laterMessage.text, /Ficará restrita/)

  // Desligou o e-mail depois de entrar na fila: não recebe, e não vira alerta de falha.
  const muted = await createDemand({ restricted: false, title: 'Depois de desligar' })
  await preferences(member, false)
  transport = fakeTransport()
  await processEmailQueue(transport)
  assert.equal(transport.sent.filter((message) => message.text.includes(muted.number)).length, 0)
  const skipped = await pool.query<{ status: string; last_error_code: string }>(
    `SELECT d.status, d.last_error_code FROM public.email_deliveries d
       JOIN public.integration_events e ON e.id = d.event_id
      WHERE e.resource_id = $1 AND d.recipient = 'emails-membro@example.gov.br'`,
    [muted.id],
  )
  assert.deepEqual(skipped.rows[0], { status: 'failed', last_error_code: 'RECIPIENT_PREFERENCE_DISABLED' })
  const failureNotices = await pool.query(`SELECT count(*)::int AS total FROM public.integration_events WHERE event_type = 'integration_failure'`)
  assert.equal(failureNotices.rows[0].total, failuresBefore.rows[0].total, 'nenhum novo alerta de falha')
})

// ---------------------------------------------------------------------------
// Demandas: diretor, consulta administrativa, mudanças depois da fila e isolamento do e-mail (M2, M4)
// ---------------------------------------------------------------------------
async function demandDeliveries(demandId: string) {
  const { rows } = await pool.query<{ id: string; recipient: string; status: string; last_error_code: string | null }>(
    `SELECT d.id::text AS id, d.recipient, d.status, d.last_error_code
       FROM public.email_deliveries d JOIN public.integration_events e ON e.id = d.event_id
      WHERE e.resource_id = $1 ORDER BY d.created_at`,
    [demandId],
  )
  return rows
}

test('demandas: o diretor recebe, inclusive em restrita; o administrador só de consulta não', async () => {
  const director = await createUser('emails-diretor@example.gov.br')
  await pool.query(
    `INSERT INTO public.user_directorate_links (user_id, ativo, papel_demandas) VALUES ($1, true, 'diretor')`,
    [director.id],
  )
  await preferences(director, true)
  await preferences(admin, true)
  const restricted = await createDemand({ restricted: true })
  const reached = await demandEmailRecipients(pool, restricted.id, [director.id, admin.id], 'comentario')
  assert.deepEqual(reached.map((item) => item.id), [director.id], 'o administrador não recebe por ser administrador')

  // A mesma regra vale na conferência do envio.
  const { IntegrationRepository } = await import('./integrationRepository.js')
  const repository = new IntegrationRepository()
  assert.equal((await repository.demandEmailCheck(restricted.id, 'emails-diretor@example.gov.br', 'demand_comentario')).allowed, true)
  assert.equal((await repository.demandEmailCheck(restricted.id, adminEmail, 'demand_comentario')).allowed, false)
})

test('demandas: excluída ou com o integrante retirado do setor depois da fila, o e-mail não sai', async () => {
  await preferences(member, true)
  await pool.query(`UPDATE public.email_deliveries SET status = 'sent' WHERE status = 'pending'`)
  const deleted = await createDemand({ restricted: false, title: 'Será excluída' })
  const toOther = await createDemand({ restricted: false, title: 'Do integrante retirado', responsibleId: other.id })
  assert.ok((await demandDeliveries(deleted.id)).some((item) => item.recipient === 'emails-membro@example.gov.br'))
  assert.ok((await demandDeliveries(toOther.id)).some((item) => item.recipient === 'emails-outro@example.gov.br'))

  // Só rascunho pode ser excluído (demands_deletion_only_draft): o caso é o de um rascunho já avisado.
  await pool.query(`UPDATE public.demands SET rascunho = true, excluida_em = now() WHERE id = $1`, [deleted.id])
  const removed = await post(`/demands/settings/sectors/${sectorId}/members/${other.id}/remove`, admin)
  assert.equal(removed.status, 200, removed.text)

  const transport = fakeTransport()
  await processEmailQueue(transport)
  assert.equal(transport.sent.filter((message) => message.text.includes(deleted.number)).length, 0)
  assert.equal(transport.sent.filter((message) => message.text.includes(toOther.number)).length, 0)
  // Demanda excluída: o aviso perdeu o objeto. Integrante retirado: perdeu o acesso.
  for (const item of await demandDeliveries(deleted.id)) {
    assert.deepEqual([item.status, item.last_error_code], ['failed', 'NOTICE_OBSOLETE'], item.recipient)
  }
  for (const item of await demandDeliveries(toOther.id)) {
    assert.deepEqual([item.status, item.last_error_code], ['failed', 'RECIPIENT_ACCESS_REVOKED'], item.recipient)
  }
})

test('demandas: se o e-mail falhar, o aviso no sino e a demanda permanecem, sem duplicidade', async () => {
  await pool.query(`ALTER TABLE public.email_deliveries RENAME TO email_deliveries_fora`)
  let demand: { id: string; number: string }
  try {
    demand = await createDemand({ restricted: false, title: 'Aviso sem e-mail' })
  } finally {
    await pool.query(`ALTER TABLE public.email_deliveries_fora RENAME TO email_deliveries`)
  }
  const bell = await pool.query<{ user_id: string }>(
    `SELECT user_id::text AS user_id FROM public.user_notifications WHERE link = $1`,
    [`/demandas/${demand.id}`],
  )
  assert.deepEqual(bell.rows.map((row) => row.user_id), [member.id], 'o aviso no sino ficou')
  assert.equal((await demandDeliveries(demand.id)).length, 0, 'a fila deste aviso foi desfeita sozinha')
  const stored = await pool.query(`SELECT 1 FROM public.demands WHERE id = $1 AND excluida_em IS NULL`, [demand.id])
  assert.equal(stored.rows.length, 1, 'a demanda foi gravada')

  // Com a fila de volta, um novo acontecimento segue normal, e cada pessoa recebe uma vez.
  const next = await createDemand({ restricted: false, title: 'Aviso com e-mail' })
  const queued = (await demandDeliveries(next.id)).filter((item) => item.recipient === 'emails-membro@example.gov.br')
  assert.equal(queued.length, 1)
})
