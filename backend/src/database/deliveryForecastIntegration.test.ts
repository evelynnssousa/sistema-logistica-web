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
import type { Permission } from '../auth/permissions.js'
import { processEmailQueue } from '../integrations/worker.js'
import type { EmailTransport, OutgoingEmail } from '../integrations/transports.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'

// Previsão e entrega de materiais pela API real, em um PostgreSQL descartável. O provedor de
// e-mail é falso, e a trava de rede dos testes continua valendo.

const password = randomBytes(24).toString('hex')
const schema = (file: string) =>
  readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')

const firstDate = '2031-03-10'
const secondDate = '2031-03-20'

let pool: Pool
let server: Server
let baseUrl: string
let admin: Session
let unitId: string
let sectorId: string
let materialId: string
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

const post = (path: string, session: Session, body: unknown = {}) =>
  call(path, { method: 'POST', session, body })
const put = (path: string, session: Session, body: unknown) =>
  call(path, { method: 'PUT', session, body })
const patch = (path: string, session: Session, body: unknown) =>
  call(path, { method: 'PATCH', session, body })

async function signIn(email: string): Promise<Session> {
  authRateLimits.loginPair.reset(`127.0.0.1|${email}`)
  authRateLimits.loginPair.reset(`::ffff:127.0.0.1|${email}`)
  authRateLimits.loginAccount.reset(email)
  const result = await call('/auth/login', { method: 'POST', body: { identifier: email, password } })
  assert.equal(result.status, 200, `login de ${email}`)
  return { cookie: result.setCookie, id: result.body.user.id }
}

async function createUser(email: string, role: 'requester' | 'slm_operator' = 'requester'): Promise<Session> {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const registered = await call('/auth/register', {
    method: 'POST',
    body: {
      fullName: `Pessoa ${email.split('@')[0]}`,
      email,
      sector: 'Protocolo',
      password,
      passwordConfirmation: password,
    },
  })
  assert.equal(registered.status, 202)
  const pending = await call('/admin/registrations/pending', { session: admin })
  const id = pending.body.registrations.find((item: { email: string }) => item.email === email).id
  assert.equal((await post(`/admin/registrations/${id}/approve`, admin, { role })).status, 200)
  return signIn(email)
}

async function staff(email: string, grants: Permission[] = ['warehouse:manage']): Promise<Session> {
  const user = await createUser(email, 'slm_operator')
  const result = await call(`/admin/users/${user.id}/access`, {
    method: 'PUT',
    session: admin,
    body: { role: 'slm_operator', slmMember: true, grantedPermissions: grants, deniedPermissions: [] },
  })
  assert.equal(result.status, 200, result.text)
  return user
}

function fakeEmail() {
  const sent: OutgoingEmail[] = []
  const transport: EmailTransport = {
    provider: 'falso',
    simulated: true,
    async send(message) {
      sent.push(message)
      return { messageId: `msg-${sent.length}` }
    },
  }
  return { sent, transport }
}

async function deliveriesOf(resourceId: string) {
  const { rows } = await pool.query<{ template_key: string; audience: string; recipient: string; subject: string }>(
    `SELECT d.template_key, d.audience, d.recipient, d.subject
       FROM public.email_deliveries d
       JOIN public.integration_events e ON e.id = d.event_id
      WHERE e.resource_id = $1 AND d.template_key LIKE 'warehouse_forecast%'
      ORDER BY d.created_at, d.id`,
    [resourceId],
  )
  return rows
}

async function internalRequest(requester: Session) {
  const created = await post('/warehouse/requests', requester, { items: [{ materialId, requested: 2 }] })
  assert.equal(created.status, 201, created.text)
  return created.body as { id: string; protocol: string }
}

async function externalRequest(manager: Session, email?: string) {
  const created = await post('/warehouse/external-requests', manager, {
    externalReference: 'GOV-1',
    externalRequester: 'Pessoa Externa',
    externalRequesterEmail: email,
    sectorId,
    note: 'Nota interna da equipe',
    items: [{ materialId, requested: 2, fulfilled: 2 }],
  })
  assert.equal(created.status, 201, created.text)
  return created.body as { id: string; protocol: string }
}

async function markReady(manager: Session, id: string) {
  assert.equal(
    (await put(`/warehouse/requests/${id}/items`, manager, { items: [{ materialId, requested: 2, fulfilled: 2 }] })).status,
    200,
  )
  assert.equal((await post(`/warehouse/requests/${id}/status`, manager, { status: 'atendido' })).status, 200)
}

before(async () => {
  process.env.PASSENGER_DATA_KEY = randomBytes(32).toString('base64')
  process.env.PASSWORD_RESET_PEPPER = randomBytes(16).toString('hex')
  // Aceita o provedor falso e deixa os e-mails na fila.
  process.env.EMAIL_TRANSPORT = 'simulated'

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
     VALUES ('Administradora', 'entrega-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )

  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('entrega-admin@example.gov.br')

  const unit = await post('/settings/catalog/measurementUnits', admin, { label: 'Unidade' })
  assert.equal(unit.status, 201, unit.text)
  unitId = unit.body.option.id
  const sector = await post('/settings/catalog/sectors', admin, { label: 'Protocolo' })
  assert.equal(sector.status, 201, sector.text)
  sectorId = sector.body.option.id
  const material = await post('/warehouse/materials', admin, { name: 'Papel A4', unitId })
  assert.equal(material.status, 201, material.text)
  materialId = material.body.id
})

after(async () => {
  for (const name of ['PASSENGER_DATA_KEY', 'PASSWORD_RESET_PEPPER', 'EMAIL_TRANSPORT']) {
    delete process.env[name]
  }
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

// Roda primeiro: a API publicada precede a migração, e nada que já funciona pode depender dela.
test('sem a migração 011, os pedidos seguem funcionando e só a previsão pede a atualização', async () => {
  const manager = await staff('sem-011@example.gov.br')
  const requester = await createUser('sem-011-pede@example.gov.br')
  const { id } = await internalRequest(requester)
  const path = `/warehouse/requests/${id}`

  const detail = await call(path, { session: manager })
  assert.equal(detail.status, 200, detail.text)
  assert.equal(detail.body.request.deliveryForecast, null)
  assert.equal(detail.body.request.deliveryStatus, 'aguardando_entrega')
  assert.deepEqual(detail.body.deliveryHistory, [])
  assert.equal((await call('/warehouse/requests', { session: requester })).status, 200)
  assert.equal((await patch(path, manager, { note: 'Sem a 011' })).status, 200)
  assert.equal((await externalRequest(manager)).id.length, 36)

  const forecast = await put(`${path}/delivery-forecast`, manager, { date: firstDate })
  assert.equal(forecast.status, 503)
  assert.equal(forecast.body.code, 'MODULES_MIGRATION_REQUIRED')

  await markReady(manager, id)
  assert.equal((await post(`${path}/deliver`, manager, { deliveryNote: 'Nota', receivedBy: 'Pessoa' })).status, 503)
  assert.equal((await post(`${path}/deliver`, manager, { receivedBy: 'Pessoa' })).status, 200)
  assert.equal((await call(path, { session: requester })).body.request.deliveryStatus, 'entregue')

  await pool.query(schema('011_delivery_forecast.sql'))
})

test('previsão: permissões, validações, histórico interno e comunicação única', async () => {
  const manager = await staff('previsao-gestora@example.gov.br')
  const operator = await staff('previsao-operadora@example.gov.br', ['requests:schedule'])
  const requester = await createUser('previsao-pede@example.gov.br')
  const other = await createUser('previsao-outra@example.gov.br')
  const { id, protocol } = await internalRequest(requester)
  const path = `/warehouse/requests/${id}`
  const forecastPath = `${path}/delivery-forecast`

  // Só quem administra o Almoxarifado altera, e a validação é do servidor.
  assert.equal((await put(forecastPath, requester, { date: firstDate })).status, 403)
  assert.equal((await put(forecastPath, operator, { date: firstDate })).status, 403)
  assert.equal((await put(forecastPath, manager, { date: '2020-01-01' })).status, 400)
  assert.equal((await put(forecastPath, manager, { date: '31/12/2031' })).status, 400)
  assert.equal(
    (await put('/warehouse/requests/00000000-0000-4000-8000-000000000000/delivery-forecast', manager, { date: firstDate })).status,
    404,
  )

  const first = await put(forecastPath, manager, { date: firstDate })
  assert.equal(first.status, 200, first.text)
  assert.deepEqual([first.body.changed, first.body.requesterNotified], [true, true])

  // Uma previsão não é uma entrega.
  const waiting = await call(path, { session: requester })
  assert.equal(waiting.body.request.deliveryForecast, firstDate)
  assert.equal(waiting.body.request.deliveryStatus, 'aguardando_entrega')
  assert.equal(waiting.body.request.status, 'pendente')
  assert.equal(waiting.body.request.deliveredAt, null)

  // A mesma data, por clique duplo ou reprocessamento, não gera nada.
  const repeated = await put(forecastPath, manager, { date: firstDate })
  assert.deepEqual([repeated.status, repeated.body.changed], [200, false])
  assert.equal((await deliveriesOf(id)).length, 1)

  // Dois envios simultâneos da mesma alteração: a trava do registro deixa passar só um.
  assert.equal((await put(forecastPath, manager, { date: secondDate })).status, 400, 'sem justificativa')
  assert.equal((await put(forecastPath, manager, { date: secondDate, justification: 'a' })).status, 400, 'curta demais')
  const simultaneous = await Promise.all([
    put(forecastPath, manager, { date: secondDate, justification: 'Fornecedor atrasou a remessa' }),
    put(forecastPath, manager, { date: secondDate, justification: 'Fornecedor atrasou a remessa' }),
  ])
  assert.deepEqual(simultaneous.map((item) => item.body.changed).sort(), [false, true])

  const deliveries = await deliveriesOf(id)
  assert.deepEqual(
    deliveries.map((item) => [item.template_key, item.audience, item.recipient]),
    [
      ['warehouse_forecast_set', 'requester', 'previsao-pede@example.gov.br'],
      ['warehouse_forecast_changed', 'requester', 'previsao-pede@example.gov.br'],
    ],
  )
  // Este banco não tem a migração 007: o protocolo ainda é o número antigo, com "#".
  assert.equal(deliveries[0].subject, `Previsão de entrega de materiais — #${protocol}`)

  // A volta à data anterior é outra alteração real e gera outra comunicação.
  await put(forecastPath, manager, { date: firstDate, justification: 'Remessa normalizada' })
  await put(forecastPath, manager, { date: secondDate, justification: 'Novo atraso na remessa' })
  assert.equal((await deliveriesOf(id)).length, 4)

  const staffView = await call(path, { session: manager })
  assert.equal(staffView.body.request.deliveryStatus, 'entrega_reagendada')
  assert.deepEqual(
    staffView.body.deliveryHistory.slice(0, 2).map((item: Record<string, unknown>) => [
      item.action,
      item.previousForecast,
      item.newForecast,
      item.comment,
      item.user,
    ]),
    [
      ['previsao_informada', null, firstDate, null, 'Pessoa previsao-gestora'],
      ['previsao_alterada', firstDate, secondDate, 'Fornecedor atrasou a remessa', 'Pessoa previsao-gestora'],
    ],
  )
  assert.ok(staffView.body.deliveryHistory.every((item: { at: string }) => item.at))

  // O solicitante vê a data, nunca a justificativa, nem por outro caminho.
  const requesterView = await call(path, { session: requester })
  assert.deepEqual(requesterView.body.deliveryHistory, [])
  assert.ok(!requesterView.text.includes('Fornecedor atrasou'))
  assert.equal(requesterView.body.request.deliveryForecast, secondDate)
  const list = await call('/warehouse/requests', { session: requester })
  assert.ok(!list.text.includes('Fornecedor atrasou'))

  // Outra pessoa não vê o pedido.
  assert.equal((await call(path, { session: other })).status, 404)

  // A notificação interna chega ao solicitante, com o destino certo e sem a justificativa.
  const notices = await call('/notifications', { session: requester })
  assert.ok(notices.body.notifications.some((item: { message: string; link: string }) =>
    item.message === 'Previsão de entrega alterada para 20/03/2031.' && item.link === `/almoxarifado/pedidos/${id}`,
  ))
  assert.ok(!notices.text.includes('Fornecedor atrasou'))

  // O texto enviado segue o modelo e não leva a justificativa.
  const fake = fakeEmail()
  await processEmailQueue(fake.transport)
  const message = fake.sent.find((item) => item.to === 'previsao-pede@example.gov.br' && item.subject.startsWith('Previsão'))
  assert.ok(message)
  assert.ok(message.text.includes('previsão de entrega para 10/03/2031'))
  assert.ok(message.text.includes(`Protocolo: ${protocol}`))
  assert.ok(!fake.sent.some((item) => item.text.includes('Fornecedor atrasou')))

  // A auditoria guarda as datas, e não o motivo.
  const audit = await pool.query<{ action: string; details: string }>(
    `SELECT action, details::text AS details FROM public.auth_audit_events
      WHERE target_resource_id = $1 AND action LIKE 'warehouse.forecast%' ORDER BY occurred_at`,
    [id],
  )
  assert.deepEqual(audit.rows.map((row) => row.action).slice(0, 2), ['warehouse.forecast_set', 'warehouse.forecast_changed'])
  assert.ok(audit.rows.every((row) => !row.details.includes('Fornecedor')))

  // O histórico de previsões não muda nem some.
  await assert.rejects(pool.query(`UPDATE public.material_delivery_history SET comentario = 'x'`))
  await assert.rejects(pool.query(`DELETE FROM public.material_delivery_history`))
})

test('entrega efetiva: separada da previsão, com observação interna e sem previsão depois', async () => {
  const manager = await staff('entrega-gestora@example.gov.br')
  const requester = await createUser('entrega-pede@example.gov.br')
  const { id } = await internalRequest(requester)
  const path = `/warehouse/requests/${id}`
  await put(`${path}/delivery-forecast`, manager, { date: firstDate })
  await markReady(manager, id)

  const future = await post(`${path}/deliver`, manager, { receivedBy: 'Pessoa', deliveredDate: '2099-01-01' })
  assert.equal(future.status, 400)
  const done = await post(`${path}/deliver`, manager, {
    receivedBy: 'Pessoa Recebedora',
    deliveredDate: '2026-01-15',
    deliveryNote: 'Caixa avariada na recepção',
  })
  assert.equal(done.status, 200, done.text)

  const seen = await call(path, { session: requester })
  assert.equal(seen.body.request.deliveryStatus, 'entregue')
  assert.equal(seen.body.request.deliveryForecast, firstDate)
  assert.equal(seen.body.request.deliveredAt, '2026-01-15T15:00:00.000Z')
  assert.ok(!seen.text.includes('Caixa avariada'))

  const internal = await call(path, { session: manager })
  const registered = internal.body.deliveryHistory.at(-1)
  assert.equal(registered.action, 'entrega_registrada')
  assert.equal(registered.effectiveDate, '2026-01-15')
  assert.equal(registered.previousForecast, firstDate)
  assert.equal(registered.comment, 'Caixa avariada na recepção')

  // Pedido encerrado não recebe nova previsão.
  assert.equal((await put(`${path}/delivery-forecast`, manager, { date: secondDate, justification: 'Tarde demais' })).status, 409)
  assert.equal((await deliveriesOf(id)).length, 1)

  // Cancelado não aguarda entrega.
  const cancelled = await internalRequest(requester)
  await post(`/warehouse/requests/${cancelled.id}/status`, manager, { status: 'cancelado', comment: 'Sem verba' })
  const closed = await call(`/warehouse/requests/${cancelled.id}`, { session: requester })
  assert.equal(closed.body.request.deliveryStatus, null)
})

test('pedido digitado: o e-mail informado avisa e dá só o acompanhamento à pessoa', async () => {
  const manager = await staff('externo-gestora@example.gov.br')
  const person = await createUser('externo-pessoa@example.gov.br')
  const other = await createUser('externo-outra@example.gov.br')

  assert.equal(
    (await post('/warehouse/external-requests', manager, {
      sectorId,
      externalRequesterEmail: 'sem-arroba',
      items: [{ materialId, requested: 1 }],
    })).status,
    400,
  )

  // Quem digita o pedido não vira destinatário por isso.
  const withoutEmail = await externalRequest(manager)
  const silent = await put(`/warehouse/requests/${withoutEmail.id}/delivery-forecast`, manager, { date: firstDate })
  assert.deepEqual([silent.status, silent.body.requesterNotified], [200, false])
  assert.deepEqual(await deliveriesOf(withoutEmail.id), [])

  // Informar o e-mail depois avisa uma vez; repetir o salvamento não avisa de novo.
  const body = { externalReference: 'GOV-1', externalRequester: 'Pessoa Externa', note: 'Nota interna da equipe' }
  const lateEmail = 'externo-pessoa@example.gov.br'
  assert.equal((await patch(`/warehouse/requests/${withoutEmail.id}`, manager, { ...body, externalRequesterEmail: lateEmail })).status, 200)
  assert.equal((await patch(`/warehouse/requests/${withoutEmail.id}`, manager, { ...body, externalRequesterEmail: lateEmail })).status, 200)
  // Editar sem enviar o campo mantém o e-mail.
  assert.equal((await patch(`/warehouse/requests/${withoutEmail.id}`, manager, body)).status, 200)
  assert.deepEqual((await deliveriesOf(withoutEmail.id)).map((item) => item.recipient), [lateEmail])

  // Com conta: e-mail e notificação; só o acompanhamento, sem dados internos.
  const { id } = await externalRequest(manager, 'Externo-Pessoa@example.gov.br')
  const path = `/warehouse/requests/${id}`
  const set = await put(`${path}/delivery-forecast`, manager, { date: firstDate })
  assert.equal(set.body.requesterNotified, true)
  assert.equal((await put(`${path}/delivery-forecast`, manager, { date: secondDate, justification: 'Justificativa restrita' })).status, 200)
  assert.deepEqual((await deliveriesOf(id)).map((item) => item.recipient), [lateEmail, lateEmail])

  const view = await call(path, { session: person })
  assert.equal(view.status, 200, view.text)
  assert.equal(view.body.request.limitedView, true)
  assert.equal(view.body.request.deliveryForecast, secondDate)
  assert.equal(view.body.request.deliveryStatus, 'entrega_reagendada')
  assert.equal(view.body.items[0].material, 'Papel A4')
  assert.deepEqual(view.body.history, [])
  assert.deepEqual(view.body.deliveryHistory, [])
  for (const hidden of ['Nota interna', 'Justificativa restrita', 'externo-gestora', 'Pessoa externo-gestora', lateEmail]) {
    assert.ok(!view.text.toLowerCase().includes(hidden.toLowerCase()), hidden)
  }

  const list = await call('/warehouse/requests', { session: person })
  assert.ok(list.body.requests.some((item: { id: string; limitedView: boolean }) => item.id === id && item.limitedView))
  assert.ok(!list.text.includes('Nota interna'))
  const notices = await call('/notifications', { session: person })
  assert.ok(notices.body.notifications.some((item: { link: string }) => item.link === `/almoxarifado/pedidos/${id}`))

  // Quem não é a pessoa indicada segue sem acesso, e sem poder alterar.
  assert.equal((await call(path, { session: other })).status, 404)
  assert.equal((await call('/warehouse/requests', { session: other })).body.requests.length, 0)
  assert.equal((await put(`${path}/delivery-forecast`, person, { date: firstDate, justification: 'Tentativa' })).status, 403)
  assert.notEqual((await call(`/attachments/resources/material_request/${id}`, { session: person })).status, 200)

  // Sem conta: o e-mail sai mesmo assim, e nenhuma notificação interna é criada.
  const noAccount = await externalRequest(manager, 'sem-conta@example.gov.br')
  const notified = await put(`/warehouse/requests/${noAccount.id}/delivery-forecast`, manager, { date: firstDate })
  assert.equal(notified.body.requesterNotified, true)
  assert.deepEqual((await deliveriesOf(noAccount.id)).map((item) => item.recipient), ['sem-conta@example.gov.br'])
  const noNotice = await pool.query(
    `SELECT 1 FROM public.user_notifications n
       JOIN public.integration_events e ON e.id = n.event_id
      WHERE e.resource_id = $1 AND e.event_type LIKE 'warehouse_forecast%'`,
    [noAccount.id],
  )
  assert.equal(noNotice.rows.length, 0)
})

test('a migração 011 só é desfeita sem registros, e sem afetar os pedidos', async () => {
  await assert.rejects(pool.query(schema('011_delivery_forecast.rollback.sql')), /interrompida/)

  const fresh = await pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM public.material_requests`)
  await pool.query(`ALTER TABLE public.material_delivery_history DISABLE TRIGGER material_delivery_history_immutable`)
  await pool.query(`DELETE FROM public.material_delivery_history`)
  await pool.query(`UPDATE public.material_requests SET previsao_entrega = NULL, solicitante_email = NULL`)
  await pool.query(schema('011_delivery_forecast.rollback.sql'))

  const kept = await pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM public.material_requests`)
  assert.equal(kept.rows[0].total, fresh.rows[0].total)
  const manager = await signIn('entrega-gestora@example.gov.br')
  assert.equal((await call('/warehouse/requests', { session: manager })).status, 200)

  await pool.query(schema('011_delivery_forecast.sql'))
})
