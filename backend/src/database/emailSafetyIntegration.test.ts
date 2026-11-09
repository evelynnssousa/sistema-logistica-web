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
import { processPasswordRecoveryRequest } from '../auth/passwordRecoveryService.js'
import type { AuthAuditEvent } from './authAuditRepository.js'
import { reserveEmailQuota } from '../integrations/emailQuota.js'
import type { EmailTransport, OutgoingEmail } from '../integrations/transports.js'
import { processEmailQueue, processManualEmailQueue } from '../integrations/worker.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { IntegrationRepository } from './integrationRepository.js'
import { setDatabasePoolForTests } from './pool.js'

// Correções de segurança da fila de e-mails (A1, M1 e B1 da auditoria de 08/11/2026), pela API real,
// em PostgreSQL descartável, com todas as migrações até a 019. O provedor é sempre falso.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')
const quotaVariables = [
  'EMAIL_DAILY_LIMIT', 'EMAIL_RECOVERY_DAILY_RESERVE', 'EMAIL_ADMIN_GROUP_MINUTES', 'PASSWORD_RESET_PEPPER',
  'EMAIL_RECIPIENT_ALLOWLIST', 'EMAIL_RECIPIENT_RESTRICTION',
] as const
const savedEnvironment: Record<string, string | undefined> = Object.fromEntries(
  ['EMAIL_TRANSPORT', 'APP_PUBLIC_URL', ...quotaVariables].map((key) => [key, process.env[key]]),
)

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
  return { status: response.status, body, text, setCookie }
}

const post = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'POST', session, body })
const put = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'PUT', session, body })
const patch = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'PATCH', session, body })

async function signIn(email: string): Promise<Session> {
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1']) authRateLimits.loginPair.reset(`${ip}|${email}`)
  authRateLimits.loginAccount.reset(email)
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

async function createUser(email: string, role = 'requester'): Promise<Session> {
  const id = await register(email)
  const approved = await post(`/admin/registrations/${id}/approve`, admin, { role })
  assert.equal(approved.status, 200, approved.text)
  return signIn(email)
}

type Delivery = { id: string; template_key: string; recipient: string; status: string; last_error_code: string | null; attempts: number; grouped_count: number; next_attempt_at: Date }

async function deliveries(templateKey: string, recipient?: string) {
  const { rows } = await pool.query<Delivery>(
    `SELECT d.id::text AS id, d.template_key, d.recipient, d.status, d.last_error_code, d.attempts,
            COALESCE((to_jsonb(d)->>'grouped_count')::int, 1) AS grouped_count, d.next_attempt_at
       FROM public.email_deliveries d
      WHERE d.template_key = $1 AND ($2::text IS NULL OR d.recipient = $2)
      ORDER BY d.created_at`,
    [templateKey, recipient ?? null],
  )
  return rows
}

/** Tira da frente tudo o que já existe, para cada teste olhar só as próprias mensagens. */
async function settleQueue() {
  await pool.query(
    `UPDATE public.email_deliveries
        SET status = 'sent', sent_at = now() - interval '1 day', created_at = created_at - interval '1 day'
      WHERE status IN ('pending', 'sending', 'not_configured')`,
  )
  // O que já saiu também fica para trás, para não cair na janela de agrupamento do teste seguinte.
  await pool.query(
    `UPDATE public.email_deliveries
        SET sent_at = sent_at - interval '1 day', created_at = created_at - interval '1 day'
      WHERE status <> 'pending' AND sent_at > now() - interval '1 day'`,
  )
  await pool.query(`DELETE FROM public.email_daily_usage`)
}

async function failureAlerts() {
  const { rows } = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM public.integration_events WHERE event_type = 'integration_failure'`,
  )
  return rows[0].total
}

function fakeTransport(provider = 'falso'): EmailTransport & { sent: OutgoingEmail[] } {
  const sent: OutgoingEmail[] = []
  return {
    provider,
    simulated: true,
    sent,
    async send(message) {
      sent.push(message)
      return { messageId: `msg-${sent.length}-${randomBytes(4).toString('hex')}` }
    },
  }
}

let admin: Session
const adminEmail = 'seguranca-admin@example.gov.br'

before(async () => {
  process.env.EMAIL_TRANSPORT = 'simulated'
  process.env.APP_PUBLIC_URL = 'https://slm.exemplo.gov.br'
  for (const key of quotaVariables) delete process.env[key]
  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  for (const file of [
    '001_public_schema_snapshot.sql', '002_password_recovery.sql', '003_user_access.sql', '004_flight_passengers.sql',
    '005_operational_modules.sql', '006_integrations.sql', '007_operations_center.sql', '008_attachments.sql',
    '009_module_extensions.sql', '010_monitoring.sql', '011_delivery_forecast.sql', '012_operational_transparency.sql',
    '013_communications.sql', '014_demands.sql', '015_organizational_structure.sql', '016_driver_portal.sql',
    '017_driver_portal_settings.sql', '018_public_api_privileges.sql', '019_email_quota.sql',
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

beforeEach(() => {
  for (const key of quotaVariables) delete process.env[key]
})

after(async () => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

// ---------------------------------------------------------------------------
// A1: cota diária e reserva da recuperação de senha
// ---------------------------------------------------------------------------
test('migração 019: o contador fica fora da API pública e com RLS', async () => {
  const { rows } = await pool.query<{ rls: boolean }>(
    `SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'public.email_daily_usage'::regclass`,
  )
  assert.equal(rows[0].rls, true)
  const grants = await pool.query(
    `SELECT 1 FROM information_schema.role_table_grants
      WHERE table_name = 'email_daily_usage' AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')`,
  )
  assert.equal(grants.rows.length, 0)
})

test('cota: as notificações param no limite menos a reserva, e a recuperação de senha usa a reserva', async () => {
  await settleQueue()
  process.env.EMAIL_DAILY_LIMIT = '5'
  process.env.EMAIL_RECOVERY_DAILY_RESERVE = '2'
  process.env.PASSWORD_RESET_PEPPER = randomBytes(32).toString('hex')
  const reserve = (channel: 'notification' | 'recovery') =>
    reserveEmailQuota(pool, channel, 1, { enforced: true }).then((result) => result.allowed)
  assert.deepEqual([await reserve('notification'), await reserve('notification'), await reserve('notification')], [true, true, true])
  assert.equal(await reserve('notification'), false, 'a fila não toca na reserva')

  // A recuperação de senha, pelo serviço real, com o provedor falso: usa a reserva e para no total.
  const sent: string[] = []
  const audit: AuthAuditEvent[] = []
  const invalidated: string[] = []
  const recover = () =>
    processPasswordRecoveryRequest('pessoa@example.gov.br', {
      isConfigured: () => true,
      createCode: async () => ({ id: '00000000-0000-4000-8000-000000000001', email: 'pessoa@example.gov.br' }),
      invalidateCodes: async (userId) => { invalidated.push(userId) },
      send: async (recipient) => { sent.push(recipient); return { attempts: 1 } },
      record: async (event) => { audit.push(event) },
      reserveQuota: async () => (await reserveEmailQuota(pool, 'recovery', 1, { enforced: true })).allowed,
    })
  await recover()
  await recover()
  assert.equal(sent.length, 2, 'a reserva garante duas recuperações mesmo com a fila esgotada')
  await recover()
  assert.equal(sent.length, 2, 'no total do dia, nada mais sai')
  const failure = audit.find((event) => event.eventType === 'password_recovery_email_failed')
  assert.equal(failure?.details?.code, 'DAILY_LIMIT_REACHED')
  assert.equal(invalidated.length, 1, 'o código não enviado é invalidado')

  const usage = await pool.query(`SELECT notifications_used, recovery_used FROM public.email_daily_usage`)
  assert.deepEqual(usage.rows[0], { notifications_used: 3, recovery_used: 2 })
})

test('cota: reservas simultâneas nunca passam do limite', async () => {
  await settleQueue()
  process.env.EMAIL_DAILY_LIMIT = '10'
  process.env.EMAIL_RECOVERY_DAILY_RESERVE = '3'
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      reserveEmailQuota(pool, index % 4 === 0 ? 'recovery' : 'notification', 1, { enforced: true }),
    ),
  )
  const usage = await pool.query<{ notifications_used: number; recovery_used: number }>(
    `SELECT notifications_used, recovery_used FROM public.email_daily_usage`,
  )
  assert.equal(results.filter((result) => result.allowed).length, 10)
  assert.ok(usage.rows[0].notifications_used <= 7)
  assert.equal(usage.rows[0].notifications_used + usage.rows[0].recovery_used, 10)
})

test('cota: dois workers ao mesmo tempo enviam só o que cabe; o resto volta à fila sem gastar tentativa', async () => {
  await settleQueue()
  process.env.EMAIL_ADMIN_GROUP_MINUTES = '0'
  for (let index = 0; index < 6; index += 1) await register(`cota-${index}@example.gov.br`)
  const queued = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM public.email_deliveries WHERE status = 'pending'`,
  )
  assert.equal(queued.rows[0].total, 12, 'confirmação a cada pessoa e aviso à administradora')

  process.env.EMAIL_DAILY_LIMIT = '4'
  process.env.EMAIL_RECOVERY_DAILY_RESERVE = '1'
  const first = fakeTransport()
  const second = fakeTransport()
  const results = await Promise.all([processEmailQueue(first), processEmailQueue(second)])
  assert.equal(first.sent.length + second.sent.length, 3, 'limite 4, reserva 1: três notificações')
  assert.equal(results.reduce((sum, result) => sum + result.sent, 0), 3)

  const deferred = await pool.query<{ total: number; attempts: number }>(
    `SELECT count(*)::int AS total, max(attempts)::int AS attempts FROM public.email_deliveries
      WHERE status = 'pending' AND last_error_code = 'DAILY_LIMIT_REACHED'`,
  )
  assert.equal(deferred.rows[0].total, 9)
  assert.equal(deferred.rows[0].attempts, 0, 'adiar não conta tentativa')
  const nextDay = await pool.query<{ ok: boolean }>(
    `SELECT bool_and(next_attempt_at >= ((now() AT TIME ZONE 'UTC')::date + 1) AT TIME ZONE 'UTC') AS ok
       FROM public.email_deliveries WHERE last_error_code = 'DAILY_LIMIT_REACHED'`,
  )
  assert.equal(nextDay.rows[0].ok, true, 'voltam no dia seguinte (UTC)')
})

test('cota: reiniciar o worker não zera o consumo; só o dia seguinte libera', async () => {
  // Como se o Render tivesse reiniciado: novo repositório, nova chamada, o mesmo banco.
  await pool.query(`UPDATE public.email_deliveries SET next_attempt_at = now() WHERE last_error_code = 'DAILY_LIMIT_REACHED'`)
  process.env.EMAIL_DAILY_LIMIT = '4'
  process.env.EMAIL_RECOVERY_DAILY_RESERVE = '1'
  const afterRestart = fakeTransport()
  await processEmailQueue(afterRestart, new IntegrationRepository())
  assert.equal(afterRestart.sent.length, 0, 'o consumo do dia continua no banco')

  // Virada do dia: a linha de hoje passa a ser de ontem.
  await pool.query(`UPDATE public.email_daily_usage SET day = day - 1`)
  await pool.query(`UPDATE public.email_deliveries SET next_attempt_at = now() WHERE last_error_code = 'DAILY_LIMIT_REACHED'`)
  const nextDay = fakeTransport()
  await processEmailQueue(nextDay, new IntegrationRepository())
  assert.equal(nextDay.sent.length, 3)
})

test('cota: provedor real sem EMAIL_DAILY_LIMIT não envia nada pela fila', async () => {
  await settleQueue()
  // O destinatário está na lista de testes: o que segura a mensagem é a falta do limite diário.
  process.env.EMAIL_RECIPIENT_ALLOWLIST = 'cota-sem-limite@example.gov.br'
  process.env.EMAIL_ADMIN_GROUP_MINUTES = '0'
  await register('cota-sem-limite@example.gov.br')
  const resendLike = fakeTransport('resend')
  const result = await processEmailQueue(resendLike)
  assert.equal(resendLike.sent.length, 0)
  assert.ok((result.deferred ?? 0) >= 1)
  const [item] = await deliveries('account_registration_received', 'cota-sem-limite@example.gov.br')
  assert.deepEqual([item.status, item.last_error_code, item.attempts], ['pending', 'QUOTA_NOT_CONFIGURED', 0])
})

// ---------------------------------------------------------------------------
// A1: agrupamento dos avisos administrativos
// ---------------------------------------------------------------------------
test('agrupamento: cadastros em sequência viram um único aviso à administração, com a contagem', async () => {
  await settleQueue()
  process.env.EMAIL_ADMIN_GROUP_MINUTES = '30'
  for (const name of ['grupo-a', 'grupo-b', 'grupo-c']) await register(`${name}@example.gov.br`)
  const grouped = (await deliveries('account_registration_pending', adminEmail)).filter((item) => item.status === 'pending')
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0].grouped_count, 3)

  const transport = fakeTransport()
  await processEmailQueue(transport)
  const message = transport.sent.find((item) => item.to === adminEmail)
  assert.ok(message)
  assert.match(message.text, /Foram recebidos 3 novos pedidos de cadastro/)
  assert.doesNotMatch(message.text, /grupo-a|grupo-b|grupo-c/, 'nenhuma conta identificada')

  // Logo depois do envio, o próximo espera o fim da janela, e reúne o que vier até lá.
  await register('grupo-d@example.gov.br')
  await register('grupo-e@example.gov.br')
  const waiting = (await deliveries('account_registration_pending', adminEmail)).filter((item) => item.status === 'pending')
  assert.equal(waiting.length, 1)
  assert.equal(waiting[0].grouped_count, 2)
  assert.ok(waiting[0].next_attempt_at.getTime() > Date.now() + 25 * 60_000, 'aguarda a janela')
  const early = fakeTransport()
  await processEmailQueue(early)
  assert.equal(early.sent.filter((item) => item.to === adminEmail).length, 0)
})

// ---------------------------------------------------------------------------
// M1: revalidação no envio, segundo cada evento
// ---------------------------------------------------------------------------
test('revalidação: confirmação vale para cadastro pendente; aprovação antiga de conta desativada não sai', async () => {
  await settleQueue()
  process.env.EMAIL_ADMIN_GROUP_MINUTES = '0'
  const alertsBefore = await failureAlerts()
  const pendingEmail = 'reval-pendente@example.gov.br'
  await register(pendingEmail)

  const email = 'reval-desativada@example.gov.br'
  const user = await createUser(email)
  assert.equal((await post(`/admin/users/${user.id}/deactivate`, admin)).status, 200)

  const transport = fakeTransport()
  await processEmailQueue(transport)
  const to = (address: string) => transport.sent.filter((item) => item.to === address).map((item) => item.subject)
  assert.deepEqual(to(pendingEmail), ['Cadastro recebido - Conta de acesso - JUCESP'], 'pendente recebe a confirmação')
  assert.deepEqual(to(email), ['Conta desativada - Conta de acesso - JUCESP'], 'só o aviso que ainda vale')

  const [received] = await deliveries('account_registration_received', email)
  const [approved] = await deliveries('account_approved', email)
  assert.deepEqual([received.status, received.last_error_code], ['failed', 'NOTICE_OBSOLETE'])
  assert.deepEqual([approved.status, approved.last_error_code], ['failed', 'NOTICE_OBSOLETE'])
  assert.equal(await failureAlerts(), alertsBefore, 'aviso obsoleto não vira alerta de falha')

  // B2: o nome da pessoa entra só nos avisos à própria conta, lido no envio.
  const pendingId = (await pool.query(`SELECT id::text AS id FROM public.auth_users WHERE email = $1`, [pendingEmail])).rows[0].id
  const repository = new IntegrationRepository()
  const own = await repository.noticeRecipientCheck({
    templateKey: 'account_registration_received', recipient: pendingEmail, resourceId: pendingId, module: 'system',
  })
  assert.deepEqual(own, { allowed: true, accountName: 'Pessoa reval-pendente' })
  const toAdministration = await repository.noticeRecipientCheck({
    templateKey: 'account_registration_pending', recipient: adminEmail, resourceId: pendingId, module: 'system',
  })
  assert.deepEqual(toAdministration, { allowed: true }, 'o aviso à administração não leva nome')
})

test('revalidação: endereço trocado e alerta a quem perdeu a permissão administrativa não saem', async () => {
  await settleQueue()
  process.env.EMAIL_ADMIN_GROUP_MINUTES = '0'
  const original = 'reval-endereco@example.gov.br'
  const user = await createUser(original)
  const changed = await patch(`/admin/users/${user.id}`, admin, { name: 'Pessoa reval-endereco', email: 'reval-novo@example.gov.br', sector: 'Administração' })
  assert.equal(changed.status, 200, changed.text)

  const second = await createUser('reval-admin2@example.gov.br', 'administrator')
  await register('reval-novo-cadastro@example.gov.br')
  const demoted = await put(`/admin/users/${second.id}/access`, admin, {
    role: 'requester', slmMember: false, grantedPermissions: [], deniedPermissions: [],
  })
  assert.equal(demoted.status, 200, demoted.text)

  const transport = fakeTransport()
  await processEmailQueue(transport)
  assert.equal(transport.sent.filter((item) => item.to === original).length, 0, 'o endereço antigo não recebe')
  const [approved] = await deliveries('account_approved', original)
  assert.equal(approved.last_error_code, 'RECIPIENT_ADDRESS_CHANGED')

  const notices = await deliveries('account_registration_pending')
  const toSecond = notices.filter((item) => item.recipient === 'reval-admin2@example.gov.br').at(-1)
  const toFirst = notices.filter((item) => item.recipient === adminEmail).at(-1)
  assert.deepEqual([toSecond?.status, toSecond?.last_error_code], ['failed', 'RECIPIENT_ACCESS_REVOKED'])
  assert.equal(toFirst?.status, 'sent')
})

test('revalidação: responsável alterado antes do envio recebe só a retirada', async () => {
  await settleQueue()
  const ids: Record<string, string> = {}
  for (const [category, label] of [['floors', '1º andar'], ['serviceTypes', 'Elétrica']] as const) {
    const created = await post(`/settings/catalog/${category}`, admin, { label })
    assert.equal(created.status, 201, created.text)
    ids[category] = created.body.option.id
  }
  const floorId = ids.floors
  const typeId = ids.serviceTypes

  const requester = await createUser('resp-solicitante@example.gov.br')
  const scheduler = await createUser('resp-agenda@example.gov.br', 'slm_operator')
  const first = await createUser('resp-primeiro@example.gov.br', 'slm_operator')
  const secondPerson = await createUser('resp-segundo@example.gov.br', 'slm_operator')
  const created = await post('/maintenance/requests', requester, {
    andarId: floorId, tipoServicoId: typeId, localServico: 'Sala 1', descricao: 'Troca de lâmpada', avisoPrivacidade: 'manutencao-2026-11',
  })
  assert.equal(created.status, 201, created.text)
  const path = `/maintenance/requests/${created.body.id}/schedule`
  assert.equal((await post(path, scheduler, { dataAgendada: '2031-02-10T13:00:00.000Z', responsavelId: first.id })).status, 200)
  const moved = await post(path, scheduler, {
    dataAgendada: '2031-02-11T13:00:00.000Z', responsavelId: secondPerson.id, motivoCodigo: 'outro', comentario: 'Troca de responsável',
  })
  assert.equal(moved.status, 200, moved.text)

  const transport = fakeTransport()
  await processEmailQueue(transport)
  const subjects = (address: string) =>
    transport.sent
      .filter((item) => item.to === address && item.subject.startsWith('Solicitação'))
      .map((item) => item.subject.split(' - ')[0])
  assert.deepEqual(subjects('resp-primeiro@example.gov.br'), ['Solicitação retirada da sua responsabilidade'])
  assert.deepEqual(subjects('resp-segundo@example.gov.br'), ['Solicitação atribuída'])
  const [stale] = await deliveries('request_assigned', 'resp-primeiro@example.gov.br')
  assert.equal(stale.last_error_code, 'NOTICE_OBSOLETE')
})

// ---------------------------------------------------------------------------
// M1: validade dos itens antigos
// ---------------------------------------------------------------------------
test('expiração: "não configurado" antigo vira expirado, fica no histórico e não pode ser reprocessado', async () => {
  await settleQueue()
  delete process.env.EMAIL_TRANSPORT
  try {
    await register('expira-antigo@example.gov.br')
  } finally {
    process.env.EMAIL_TRANSPORT = 'simulated'
  }
  const [item] = await deliveries('account_registration_received', 'expira-antigo@example.gov.br')
  assert.equal(item.status, 'not_configured')

  const before = await call('/integrations/status', { session: admin })
  assert.ok(before.body.status.queue.notConfigured >= 1, 'identificável antes de qualquer ativação')

  await pool.query(`UPDATE public.email_deliveries SET created_at = now() - interval '8 days' WHERE id = $1`, [item.id])
  const expired = await new IntegrationRepository().expireStaleEmails()
  assert.ok(expired >= 1)
  const [after] = await deliveries('account_registration_received', 'expira-antigo@example.gov.br')
  assert.deepEqual([after.status, after.last_error_code], ['failed', 'EXPIRED'])
  const attempts = await pool.query(`SELECT outcome, error_code FROM public.integration_attempts WHERE item_id = $1`, [item.id])
  assert.deepEqual(attempts.rows, [{ outcome: 'failure', error_code: 'EXPIRED' }])

  const retry = await post(`/integrations/emails/${item.id}/retry`, admin)
  assert.equal(retry.status, 409)
  assert.match(retry.body.message, /validade/)
  const status = await call('/integrations/status', { session: admin })
  assert.ok(status.body.status.queue.expired >= 1)
  assert.equal(status.body.status.queue.quota.dailyLimit, null)
})

test('expiração: aviso de segurança pendente que passou de 24 horas não sai, e não vira alerta', async () => {
  await settleQueue()
  const alertsBefore = await failureAlerts()
  const email = 'expira-seguranca@example.gov.br'
  const user = await createUser(email)
  await signIn(email)
  assert.equal((await post(`/admin/users/${user.id}/sessions/revoke`, admin)).status, 200)
  const [item] = await deliveries('security_sessions_revoked', email)
  await pool.query(`UPDATE public.email_deliveries SET created_at = now() - interval '25 hours' WHERE id = $1`, [item.id])

  const transport = fakeTransport()
  await processEmailQueue(transport)
  assert.equal(transport.sent.filter((message) => message.subject.startsWith('Sessões encerradas')).length, 0)
  const [after] = await deliveries('security_sessions_revoked', email)
  assert.deepEqual([after.status, after.last_error_code], ['failed', 'EXPIRED'])
  assert.equal(await failureAlerts(), alertsBefore)
})

// ---------------------------------------------------------------------------
// B1 e B2
// ---------------------------------------------------------------------------
test('bloqueio: o aviso diz se foi a conta ou um endereço, e o nome só vai à própria pessoa', async () => {
  await settleQueue()
  process.env.EMAIL_ADMIN_GROUP_MINUTES = '0'
  const email = 'bloqueio-escopo@example.gov.br'
  await createUser(email)
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1']) authRateLimits.loginPair.reset(`${ip}|${email}`)
  authRateLimits.loginAccount.reset(email)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wrong = await call('/auth/login', { method: 'POST', body: { identifier: email, password: 'senha-errada' } })
    assert.equal(wrong.status, 401)
  }
  for (let attempt = 0; attempt < 40 && (await deliveries('security_login_blocked', email)).length === 0; attempt += 1) {
    await new Promise((done) => setTimeout(done, 50))
  }
  const transport = fakeTransport()
  await processEmailQueue(transport)
  const notice = transport.sent.find((item) => item.to === email && item.subject.startsWith('Acesso bloqueado'))
  assert.ok(notice)
  assert.match(notice.text, /a partir de um mesmo endereço de rede|novas tentativas foram bloqueadas/)
  const toAdmin = transport.sent.find((item) => item.to === adminEmail && item.subject.startsWith('Conta com acesso bloqueado'))
  assert.ok(toAdmin)
  assert.doesNotMatch(toAdmin.text, /bloqueio-escopo/, 'a conta não é identificada à administração')
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1']) authRateLimits.loginPair.reset(`${ip}|${email}`)
  authRateLimits.loginAccount.reset(email)
})

// ---------------------------------------------------------------------------
// Lista de destinatários permitidos (testes reais restritos na homologação)
// ---------------------------------------------------------------------------
async function usage() {
  const { rows } = await pool.query<{ notifications_used: number; recovery_used: number }>(
    `SELECT notifications_used, recovery_used FROM public.email_daily_usage`,
  )
  return rows[0] ?? { notifications_used: 0, recovery_used: 0 }
}

async function blockedAudits() {
  const { rows } = await pool.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM public.auth_audit_events WHERE action = 'email.recipient_blocked' ORDER BY id`,
  )
  return rows.map((row) => row.details)
}

test('lista de testes: autorizado sai; fora da lista, CC fora ou destinatários mistos bloqueiam a mensagem inteira, sem cota', async () => {
  await settleQueue()
  process.env.EMAIL_ADMIN_GROUP_MINUTES = '0'
  process.env.EMAIL_DAILY_LIMIT = '50'
  process.env.EMAIL_RECOVERY_DAILY_RESERVE = '5'
  process.env.EMAIL_RECIPIENT_ALLOWLIST = 'lista-autorizada@example.gov.br, @x.test, *@x.test'
  const auditsBefore = (await blockedAudits()).length
  await register('lista-autorizada@example.gov.br')
  await register('lista-fora@example.gov.br')
  // Mistos: o destinatário está na lista, mas uma cópia não.
  const [mixed] = await deliveries('account_registration_received', 'lista-autorizada@example.gov.br')
  await pool.query(`UPDATE public.email_deliveries SET cc = ARRAY['copia-fora@x.test'] WHERE id = $1`, [mixed.id])
  await register('lista-autorizada-2@example.gov.br')
  process.env.EMAIL_RECIPIENT_ALLOWLIST += ', lista-autorizada-2@example.gov.br'

  const transport = fakeTransport('resend')
  await processEmailQueue(transport)
  const to = (address: string) => transport.sent.filter((message) => message.to === address)
  assert.equal(to('lista-autorizada-2@example.gov.br').length, 1, 'autorizado recebe')
  assert.equal(to('lista-fora@example.gov.br').length, 0, 'fora da lista não recebe')
  assert.equal(to('lista-autorizada@example.gov.br').length, 0, 'cópia fora da lista bloqueia a mensagem inteira')
  assert.equal(transport.sent.some((message) => message.cc.includes('copia-fora@x.test')), false)

  for (const address of ['lista-fora@example.gov.br', 'lista-autorizada@example.gov.br']) {
    const [item] = await deliveries('account_registration_received', address)
    assert.deepEqual([item.status, item.last_error_code], ['failed', 'RECIPIENT_OUTSIDE_TEST_LIST'], address)
  }
  // Só a mensagem que saiu consumiu cota; o aviso à administração (fora da lista) também ficou bloqueado.
  assert.equal((await usage()).notifications_used, 1)

  // Auditoria: canal, modelo e domínio. Nunca o endereço completo.
  const audits = (await blockedAudits()).slice(auditsBefore)
  assert.ok(audits.length >= 3)
  const text = JSON.stringify(audits)
  assert.doesNotMatch(text, /lista-fora@|lista-autorizada@|copia-fora@|seguranca-admin@/)
  assert.match(text, /example\.gov\.br/)
  assert.ok(audits.every((details) => details.channel === 'fila'))

  // Bloqueio definitivo: nem com a lista removida o item volta.
  const [outside] = await deliveries('account_registration_received', 'lista-fora@example.gov.br')
  delete process.env.EMAIL_RECIPIENT_ALLOWLIST
  process.env.EMAIL_RECIPIENT_RESTRICTION = 'off'
  const retry = await post(`/integrations/emails/${outside.id}/retry`, admin)
  assert.equal(retry.status, 409)
})

test('lista de testes: sem a lista, nenhum envio real sai; só EMAIL_RECIPIENT_RESTRICTION=off libera', async () => {
  await settleQueue()
  process.env.EMAIL_ADMIN_GROUP_MINUTES = '0'
  process.env.EMAIL_DAILY_LIMIT = '50'
  await register('sem-lista@example.gov.br')
  const blocked = fakeTransport('resend')
  await processEmailQueue(blocked)
  assert.equal(blocked.sent.length, 0)
  const [item] = await deliveries('account_registration_received', 'sem-lista@example.gov.br')
  assert.equal(item.last_error_code, 'RECIPIENT_OUTSIDE_TEST_LIST')
  assert.equal((await usage()).notifications_used, 0, 'bloqueio não consome cota')

  // Valor desconhecido mantém a restrição; "off" desliga.
  process.env.EMAIL_RECIPIENT_RESTRICTION = 'talvez'
  await register('sem-lista-2@example.gov.br')
  const stillBlocked = fakeTransport('resend')
  await processEmailQueue(stillBlocked)
  assert.equal(stillBlocked.sent.length, 0)
  process.env.EMAIL_RECIPIENT_RESTRICTION = 'off'
  await register('sem-lista-3@example.gov.br')
  const released = fakeTransport('resend')
  await processEmailQueue(released)
  assert.ok(released.sent.some((message) => message.to === 'sem-lista-3@example.gov.br'))

})

test('lista de testes: recuperação de senha bloqueada não envia, não usa a reserva e registra só o domínio', async () => {
  await settleQueue()
  process.env.EMAIL_DAILY_LIMIT = '10'
  process.env.EMAIL_RECOVERY_DAILY_RESERVE = '5'
  process.env.PASSWORD_RESET_PEPPER = randomBytes(32).toString('hex')
  process.env.EMAIL_RECIPIENT_ALLOWLIST = 'recupera-ok@example.gov.br'
  const { restrictionEnforcedFor, recipientsOutsideList } = await import('../integrations/recipientAllowlist.js')
  const sent: string[] = []
  const audit: AuthAuditEvent[] = []
  const recover = (email: string) =>
    processPasswordRecoveryRequest(email, {
      isConfigured: () => true,
      createCode: async () => ({ id: '00000000-0000-4000-8000-000000000002', email }),
      invalidateCodes: async () => undefined,
      send: async (recipient) => { sent.push(recipient); return { attempts: 1 } },
      record: async (event) => { audit.push(event) },
      reserveQuota: async () => (await reserveEmailQuota(pool, 'recovery', 1, { enforced: true })).allowed,
      recipientAllowed: (address) => !restrictionEnforcedFor('resend') || recipientsOutsideList([address]).length === 0,
    })
  await recover('recupera-fora@x.test')
  await recover('recupera-ok@example.gov.br')
  assert.deepEqual(sent, ['recupera-ok@example.gov.br'])
  assert.equal((await usage()).recovery_used, 1, 'o bloqueio não consumiu a reserva')
  const blocked = audit.find((event) => event.eventType === 'email_recipient_blocked')
  assert.deepEqual(blocked?.details, { channel: 'recuperacao_senha', template: 'codigo', domains: ['x.test'] })
  const failure = audit.find((event) => event.eventType === 'password_recovery_email_failed')
  assert.equal(failure?.details?.code, 'RECIPIENT_OUTSIDE_TEST_LIST')
  assert.doesNotMatch(JSON.stringify(audit), /recupera-fora@/)

})

test('lista de testes: mensagem manual e teste de modelo bloqueados, sem cota', async () => {
  await settleQueue()
  process.env.EMAIL_DAILY_LIMIT = '10'
  process.env.EMAIL_RECIPIENT_ALLOWLIST = 'manual-ok@example.gov.br'
  const request = (await pool.query<{ id: string }>(`SELECT id::text AS id FROM public.service_requests LIMIT 1`)).rows[0]
  assert.ok(request, 'há uma solicitação de Manutenção dos testes anteriores')
  const insertManual = async (to: string[], cc: string[]) =>
    (await pool.query<{ id: string }>(
      `INSERT INTO public.manual_emails
        (request_id, modulo, protocolo, destinatarios, copias, assunto, corpo_texto, corpo_html, chave_idempotencia, enviado_por, status)
       VALUES ($1, 'maintenance', 'MAN-TESTE', $2, $3, 'Assunto', 'Texto', '<p>Texto</p>', gen_random_uuid(), $4, 'pending')
       RETURNING id::text AS id`,
      [request.id, to, cc, admin.id],
    )).rows[0].id
  const blockedId = await insertManual(['manual-ok@example.gov.br'], ['manual-fora@example.gov.br'])
  const okId = await insertManual(['manual-ok@example.gov.br'], [])
  const transport = fakeTransport('resend')
  await processManualEmailQueue(transport, undefined, null)
  assert.equal(transport.sent.length, 1)
  const rows = await pool.query<{ id: string; status: string; codigo_erro: string | null }>(
    `SELECT id::text AS id, status, codigo_erro FROM public.manual_emails WHERE id = ANY($1::uuid[])`,
    [[blockedId, okId]],
  )
  const byId = new Map(rows.rows.map((row) => [row.id, row]))
  assert.deepEqual([byId.get(blockedId)?.status, byId.get(blockedId)?.codigo_erro], ['failed', 'RECIPIENT_OUTSIDE_TEST_LIST'])
  assert.equal(byId.get(okId)?.status, 'sent')
  assert.equal((await usage()).notifications_used, 1, 'só a autorizada consumiu cota')
  assert.ok((await blockedAudits()).some((details) => details.channel === 'mensagem_manual'))

  // Teste de modelo: o e-mail da administradora não está na lista.
  const { setEmailTransportForTests } = await import('../integrations/transports.js')
  setEmailTransportForTests(fakeTransport('resend'))
  try {
    const result = await post('/config/email-templates/account_approved/test', admin, {
      conteudo: { name: 'Cadastro aprovado', event: 'account_approved', subject: 'Cadastro aprovado', body: 'Aprovado.', signature: 'Equipe' },
    })
    assert.equal(result.status, 422, result.text)
    assert.equal(result.body.code, 'RECIPIENT_OUTSIDE_TEST_LIST')
  } finally {
    setEmailTransportForTests(undefined)
  }
  assert.equal((await usage()).notifications_used, 1, 'o teste bloqueado não consumiu cota')
  const testAudit = (await blockedAudits()).find((details) => details.channel === 'teste_modelo')
  assert.deepEqual(testAudit?.domains, ['example.gov.br'])
})

test('lista de testes: dois workers com destinatários mistos não passam da cota nem enviam aos de fora', async () => {
  await settleQueue()
  process.env.EMAIL_ADMIN_GROUP_MINUTES = '0'
  process.env.EMAIL_DAILY_LIMIT = '4'
  process.env.EMAIL_RECOVERY_DAILY_RESERVE = '1'
  const allowed = Array.from({ length: 5 }, (_, index) => `misto-ok-${index}@example.gov.br`)
  process.env.EMAIL_RECIPIENT_ALLOWLIST = allowed.join(',')
  for (const address of allowed) await register(address)
  for (let index = 0; index < 4; index += 1) await register(`misto-fora-${index}@example.gov.br`)
  const first = fakeTransport('resend')
  const second = fakeTransport('resend')
  await Promise.all([processEmailQueue(first), processEmailQueue(second)])
  const sent = [...first.sent, ...second.sent]
  assert.equal(sent.length, 3, 'limite 4, reserva 1')
  assert.ok(sent.every((message) => allowed.includes(message.to)))
  assert.equal((await usage()).notifications_used, 3)
  // Os de fora nunca saem: ficam bloqueados ou, se a cota acabou antes de chegar neles, adiados.
  const outside = await pool.query<{ status: string; last_error_code: string }>(
    `SELECT status, last_error_code FROM public.email_deliveries WHERE recipient LIKE 'misto-fora-%'`,
  )
  assert.equal(outside.rows.length, 4)
  assert.ok(outside.rows.every((row) => row.status !== 'sent'))
  assert.ok(outside.rows.some((row) => row.last_error_code === 'RECIPIENT_OUTSIDE_TEST_LIST'))
  assert.ok(outside.rows.every((row) => ['RECIPIENT_OUTSIDE_TEST_LIST', 'DAILY_LIMIT_REACHED'].includes(row.last_error_code)))
})

test('cota: a data é calculada uma vez por reserva, e a virada da meia-noite UTC separa os dias', async () => {
  await settleQueue()
  process.env.EMAIL_DAILY_LIMIT = '2'
  process.env.EMAIL_RECOVERY_DAILY_RESERVE = '1'
  const beforeMidnight = new Date('2031-05-10T23:59:59.999Z')
  const afterMidnight = new Date('2031-05-11T00:00:00.000Z')
  const reserve = (channel: 'notification' | 'recovery', now: Date) =>
    reserveEmailQuota(pool, channel, 1, { enforced: true, now }).then((result) => result.allowed)
  assert.equal(await reserve('notification', beforeMidnight), true)
  assert.equal(await reserve('notification', beforeMidnight), false, 'a parte das notificações acabou no dia 10')
  assert.equal(await reserve('recovery', beforeMidnight), true, 'a reserva continua no mesmo dia')
  assert.equal(await reserve('recovery', afterMidnight), true, 'o dia 11 começa do zero')
  const { rows } = await pool.query<{ day: string; notifications_used: number; recovery_used: number }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, notifications_used, recovery_used FROM public.email_daily_usage ORDER BY day`,
  )
  assert.deepEqual(rows, [
    { day: '2031-05-10', notifications_used: 1, recovery_used: 1 },
    { day: '2031-05-11', notifications_used: 0, recovery_used: 1 },
  ])
})

test('migração 019: sela a fila anterior à proteção, preserva os registros e nada a libera depois', async () => {
  await settleQueue()
  const alertsBefore = await failureAlerts()
  // O banco volta ao estado anterior à 019, com mensagens "não configuradas" de antes.
  await pool.query(schema('019_email_quota.rollback.sql'))
  delete process.env.EMAIL_TRANSPORT
  try {
    await register('antiga-1@example.gov.br')
  } finally {
    process.env.EMAIL_TRANSPORT = 'simulated'
  }
  const [legacy] = await deliveries('account_registration_received', 'antiga-1@example.gov.br')
  assert.equal(legacy.status, 'not_configured')
  const totalBefore = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.email_deliveries`)).rows[0].n

  await pool.query(schema('019_email_quota.sql'))
  const [sealed] = await deliveries('account_registration_received', 'antiga-1@example.gov.br')
  assert.deepEqual([sealed.status, sealed.last_error_code], ['failed', 'BLOCKED_BEFORE_ACTIVATION'])
  const attempts = await pool.query(`SELECT outcome, error_code FROM public.integration_attempts WHERE item_id = $1`, [sealed.id])
  assert.deepEqual(attempts.rows, [{ outcome: 'failure', error_code: 'BLOCKED_BEFORE_ACTIVATION' }])
  const totalAfter = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.email_deliveries`)).rows[0].n
  assert.equal(totalAfter, totalBefore, 'nada foi apagado')
  const index = await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_email_deliveries_grouping'`)
  assert.equal(index.rows.length, 1)

  // Nem reprocessamento, nem a remoção da lista de testes, nem o worker liberam a mensagem selada.
  process.env.EMAIL_RECIPIENT_RESTRICTION = 'off'
  assert.equal((await post(`/integrations/emails/${sealed.id}/retry`, admin)).status, 409)
  const transport = fakeTransport('resend')
  await processEmailQueue(transport)
  assert.equal(transport.sent.filter((message) => message.to === 'antiga-1@example.gov.br').length, 0)
  assert.equal(await failureAlerts(), alertsBefore)
  const status = await call('/integrations/status', { session: admin })
  assert.ok(status.body.status.queue.blockedBeforeActivation >= 1)
})

test('integrações: a tela recebe o modo restrito e a contagem de autorizados, nunca os endereços', async () => {
  process.env.EMAIL_RECIPIENT_ALLOWLIST = 'tela-a@example.gov.br,tela-b@example.gov.br,@x.test'
  const status = await call('/integrations/status', { session: admin })
  assert.equal(status.status, 200)
  assert.deepEqual(status.body.status.email.restriction, { mode: 'test', allowedRecipients: 2, rejectedEntries: 1 })
  assert.doesNotMatch(status.text, /tela-a@|tela-b@/)
  assert.equal(typeof status.body.status.queue.blockedByTestList, 'number')
})
