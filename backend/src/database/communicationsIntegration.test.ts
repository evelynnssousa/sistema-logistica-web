import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
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
import { IntegrationError } from '../integrations/transports.js'
import type { EmailTransport, OutgoingEmail } from '../integrations/transports.js'
import { processManualEmailQueue } from '../integrations/worker.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { CommunicationRepository } from './communicationRepository.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'

// Central de comunicação pela API real, em um PostgreSQL descartável, com provedor falso.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
const cpf = '52998224725'

let pool: Pool
let server: Server
let baseUrl: string
let admin: Session
let floorId: string
let serviceTypeId: string
let directory: string
const csrfTokens = new Map<string, string>()

type Session = { cookie: string; id: string }

async function call(path: string, options: { method?: string; body?: unknown; session?: Session; raw?: Buffer; headers?: Record<string, string> } = {}) {
  const method = options.method ?? 'GET'
  const cookie = options.session?.cookie
  const token = cookie && method !== 'GET' ? csrfTokens.get(cookie) : undefined
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      'content-type': options.raw ? 'application/octet-stream' : 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(token ? { 'x-csrf-token': token } : {}),
      ...options.headers,
    },
    body: options.raw ? new Uint8Array(options.raw) : options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  const body = JSON.parse(text) as Record<string, any>
  const setCookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  if (setCookie && body.csrfToken) csrfTokens.set(setCookie, body.csrfToken)
  return { status: response.status, body, text, setCookie }
}

const post = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'POST', session, body })

async function signIn(email: string): Promise<Session> {
  authRateLimits.loginPair.reset(`127.0.0.1|${email}`)
  authRateLimits.loginPair.reset(`::ffff:127.0.0.1|${email}`)
  authRateLimits.loginAccount.reset(email)
  const result = await call('/auth/login', { method: 'POST', body: { identifier: email, password } })
  assert.equal(result.status, 200)
  return { cookie: result.setCookie, id: result.body.user.id }
}

async function createUser(email: string, role: 'requester' | 'slm_operator' = 'requester', grants: Permission[] = [], denied: Permission[] = []) {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  await call('/auth/register', {
    method: 'POST',
    body: { fullName: `Pessoa ${email.split('@')[0]}`, email, sector: 'Protocolo', password, passwordConfirmation: password },
  })
  const pending = await call('/admin/registrations/pending', { session: admin })
  const id = pending.body.registrations.find((item: { email: string }) => item.email === email).id
  assert.equal((await post(`/admin/registrations/${id}/approve`, admin, { role })).status, 200)
  const user = await signIn(email)
  if (role === 'slm_operator') {
    const result = await call(`/admin/users/${user.id}/access`, {
      method: 'PUT',
      session: admin,
      body: { role, slmMember: true, grantedPermissions: grants, deniedPermissions: denied },
    })
    assert.equal(result.status, 200, result.text)
  }
  return user
}

function fakeEmail(failure?: Error) {
  const sent: OutgoingEmail[] = []
  const transport: EmailTransport = {
    provider: 'falso',
    simulated: false,
    async send(message) {
      if (failure) throw failure
      sent.push(message)
      return { messageId: `msg-${sent.length}` }
    },
  }
  return { sent, transport }
}

async function upload(session: Session, type: string, id: string, category = 'outro', name = 'documento.pdf', content = pdf) {
  const result = await call(`/attachments/resources/${type}/${id}?categoria=${category}`, {
    method: 'POST',
    session,
    raw: content,
    headers: { 'x-file-name': encodeURIComponent(name) },
  })
  return result
}

const message = (extra: Record<string, unknown> = {}) => ({
  confirmado: true,
  chave: randomUUID(),
  destinatarios: ['destino@example.gov.br'],
  assunto: 'Orçamento do serviço',
  mensagem: 'Segue o orçamento.\n**Confira** os valores.',
  ...extra,
})

async function maintenance(requester: Session) {
  const created = await post('/maintenance/requests', requester, {
    andarId: floorId, tipoServicoId: serviceTypeId, localServico: `Local ${randomUUID()}`, descricao: `Serviço ${randomUUID()}`,
  })
  assert.equal(created.status, 201, created.text)
  return created.body as { id: string; protocol: string }
}

async function flight(requester: Session) {
  const created = await post('/flights/requests', requester, {
    andarId: floorId,
    tipoViagem: 'ida_volta',
    ida: { origem: 'SP', destino: 'RJ', data: '2032-05-10', horario: '10:00' },
    volta: { origem: 'RJ', destino: 'SP', data: '2032-05-12', horario: '18:00' },
    passageiros: [{ nome: 'Passageira Fictícia', cpf }],
  })
  assert.equal(created.status, 201, created.text)
  return created.body as { id: string; protocol: string }
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'slm-comunicacao-'))
  process.env.ATTACHMENTS_DIR = directory
  process.env.PASSENGER_DATA_KEY = randomBytes(32).toString('base64')
  process.env.EMAIL_TRANSPORT = 'simulated'
  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  for (const file of [
    '001_public_schema_snapshot.sql', '002_password_recovery.sql', '003_user_access.sql', '004_flight_passengers.sql',
    '005_operational_modules.sql', '006_integrations.sql', '007_operations_center.sql', '008_attachments.sql',
    '009_module_extensions.sql', '010_monitoring.sql', '011_delivery_forecast.sql', '012_operational_transparency.sql',
  ]) {
    await pool.query(schema(file))
  }
  resetAccessSchemaCacheForTests()
  await pool.query(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'comunica-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )
  // P-08: Almoxarifado e agendamento são atribuições da SLM. A administradora destes cenários
  // integra a equipe; o administrador de fora dela tem testes próprios, que esperam recusa.
  await pool.query(
    `INSERT INTO public.auth_user_access (user_id, profile, slm_member)
      SELECT id, 'administrator', true FROM public.auth_users WHERE email = 'comunica-admin@example.gov.br'
      ON CONFLICT (user_id) DO UPDATE SET slm_member = true`,
  )
  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('comunica-admin@example.gov.br')
  floorId = (await post('/settings/catalog/floors', admin, { label: 'Térreo' })).body.option.id
  serviceTypeId = (await post('/settings/catalog/serviceTypes', admin, { label: 'Elétrica' })).body.option.id
})

after(async () => {
  for (const name of ['ATTACHMENTS_DIR', 'PASSENGER_DATA_KEY', 'EMAIL_TRANSPORT']) delete process.env[name]
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
  rmSync(directory, { recursive: true, force: true })
})

test('sem a migração 013, só o envio manual pede a atualização, e o histórico fica vazio', async () => {
  const requester = await createUser('sem-013@example.gov.br')
  const operator = await createUser('sem-013-op@example.gov.br', 'slm_operator')
  const { id } = await maintenance(requester)
  const base = `/communications/service_request/${id}`
  const overview = await call(base, { session: operator })
  assert.equal(overview.status, 200, overview.text)
  assert.deepEqual(overview.body.history, [])
  assert.equal((await post(`${base}/send`, operator, message())).status, 503)
  assert.equal((await call(`/maintenance/requests/${id}`, { session: operator })).status, 200)

  await pool.query(schema('013_communications.sql'))
  await pool.query(schema('013_communications.rollback.sql'))
  await pool.query(schema('013_communications.sql'))
})

test('envio: permissão, confirmação, validações, registro completo e "enviado" só com o serviço', async () => {
  const requester = await createUser('envio-pede@example.gov.br')
  const stranger = await createUser('envio-outra@example.gov.br')
  const operator = await createUser('envio-op@example.gov.br', 'slm_operator')
  const blocked = await createUser('envio-bloqueado@example.gov.br', 'slm_operator', [], ['communications:send'])
  const { id, protocol } = await maintenance(requester)
  const base = `/communications/service_request/${id}`

  // Quem não atende não vê que existe; sem permissão, responde 403.
  assert.equal((await call(base, { session: requester })).status, 403)
  assert.equal((await post(`${base}/send`, stranger, message())).status, 403)
  assert.equal((await post(`${base}/send`, blocked, message())).status, 403)
  assert.equal((await call(base)).status, 401)
  assert.equal((await call('/communications/service_request/00000000-0000-4000-8000-000000000000', { session: operator })).status, 404)
  assert.equal((await call('/communications/inventado/00000000-0000-4000-8000-000000000000', { session: operator })).status, 404)

  // Validações do servidor.
  assert.equal((await post(`${base}/send`, operator, message({ confirmado: false }))).status, 400, 'exige confirmação')
  assert.equal((await post(`${base}/send`, operator, message({ destinatarios: [] }))).status, 400)
  assert.equal((await post(`${base}/send`, operator, message({ destinatarios: ['sem-arroba'] }))).status, 400)
  assert.equal((await post(`${base}/send`, operator, message({ assunto: '' }))).status, 400)
  assert.equal((await post(`${base}/send`, operator, message({ mensagem: 'Faltou {{protocolo}}' }))).status, 400, 'campo sem preencher')
  assert.equal((await post(`${base}/send`, operator, message({ anexos: ['00000000-0000-4000-8000-000000000000'] }))).status, 400)
  assert.equal((await post(`${base}/send`, operator, message({ destinatarios: Array.from({ length: 11 }, (_, i) => `d${i}@example.gov.br`) }))).status, 400, 'limite')

  // Anexo perigoso é recusado pela validação existente, mesmo com nome de PDF.
  assert.equal((await upload(operator, 'service_request', id, 'orcamento', 'virus.pdf', Buffer.from('MZ executável'))).status, 400)
  const file = await upload(operator, 'service_request', id, 'orcamento', 'orcamento.pdf')
  assert.equal(file.status, 201, file.text)

  const preview = await post(`${base}/preview`, operator, { assunto: 'Assunto', mensagem: `Seu CPF ${cpf}\n<script>alert(1)</script>\n**Negrito**` })
  assert.equal(preview.status, 200, preview.text)
  assert.ok(!preview.text.includes(cpf), 'CPF mascarado')
  assert.ok(!preview.body.html.includes('<script>'))
  assert.ok(preview.body.html.includes('<strong>Negrito</strong>'))
  assert.ok(preview.body.html.includes(protocol))

  // Clique duplo: mesma chave, uma só mensagem.
  const chave = randomUUID()
  const body = message({ chave, anexos: [file.body.id], copias: ['copia@example.gov.br'], modelo: 'manual_message' })
  const first = await post(`${base}/send`, operator, body)
  assert.equal(first.status, 201, first.text)
  assert.equal(first.body.status, 'pending', 'só registrada: nada foi enviado ainda')
  const again = await post(`${base}/send`, operator, body)
  assert.deepEqual([again.status, again.body.id, again.body.repeated], [200, first.body.id, true])
  const pending = (await call(base, { session: operator })).body.history
  assert.equal(pending.length, 1)
  assert.equal(pending[0].status, 'pending')
  assert.equal(pending[0].sentAt, null)

  const fake = fakeEmail()
  assert.deepEqual(await processManualEmailQueue(fake.transport), { sent: 1, failed: 0 })
  assert.equal(fake.sent[0].to, 'destino@example.gov.br')
  assert.deepEqual([...fake.sent[0].cc], ['copia@example.gov.br'])
  assert.equal(fake.sent[0].attachments?.[0].filename, 'orcamento.pdf')
  assert.ok(fake.sent[0].attachments?.[0].content.equals(pdf))
  assert.equal(fake.sent[0].idempotencyKey, `slm-manual-${first.body.id}`)

  const saved = (await call(base, { session: operator })).body.history[0]
  assert.equal(saved.status, 'sent')
  assert.equal(saved.providerMessageId, 'msg-1')
  assert.equal(saved.operator, 'Pessoa envio-op')
  assert.equal(saved.template, 'manual_message')
  assert.equal(saved.attachments[0].name, 'orcamento.pdf')
  assert.ok(saved.text.includes('Segue o orçamento.'))
  assert.ok(saved.sentAt)

  // Não muda o status, e o solicitante vê só o fato na linha do tempo interna, sem conteúdo.
  const seen = await call(`/maintenance/requests/${id}`, { session: requester })
  assert.equal(seen.body.request.status, 'aguardando_agendamento')
  assert.ok(!seen.text.includes('destino@example.gov.br'))
  assert.ok(!seen.body.history.some((item: { action: string }) => item.action === 'email_registrado'))
  const internal = await call(`/maintenance/requests/${id}`, { session: operator })
  assert.ok(internal.body.history.some((item: { action: string }) => item.action === 'email_registrado'))
  assert.ok(internal.body.communications.some((item: { template: string; status: string }) => item.template === 'manual_message' && item.status === 'sent'))

  // Reenviar cria outra mensagem e mantém a anterior.
  assert.equal((await post(`/communications/emails/${first.body.id}/resend`, operator, { chave: randomUUID() })).status, 400, 'exige confirmação')
  assert.equal((await post(`/communications/emails/${first.body.id}/resend`, stranger, { confirmado: true, chave: randomUUID() })).status, 403)
  const resent = await post(`/communications/emails/${first.body.id}/resend`, operator, { confirmado: true, chave: randomUUID() })
  assert.equal(resent.status, 201, resent.text)
  await processManualEmailQueue(fake.transport)
  assert.equal(fake.sent.length, 2)
  const history = (await call(base, { session: operator })).body.history
  assert.equal(history.length, 2)
  assert.equal(history[0].resentFrom, first.body.id)
  assert.equal(history[1].id, first.body.id)

  // O registro não muda nem some.
  await assert.rejects(pool.query(`UPDATE public.manual_emails SET assunto = 'x'`))
  await assert.rejects(pool.query(`DELETE FROM public.manual_emails`))
  await assert.rejects(pool.query(`DELETE FROM public.manual_email_attachments`))
  assert.ok((await pool.query(`SELECT 1 FROM public.auth_audit_events WHERE action = 'communication.email_resent' AND target_resource_id = $1`, [id])).rows.length === 1)
  const audit = await pool.query<{ details: string }>(`SELECT details::text AS details FROM public.auth_audit_events WHERE action = 'communication.email_queued' AND target_resource_id = $1`, [id])
  assert.ok(!audit.rows[0].details.includes('destino@'), 'a auditoria não repete endereços')
})

test('falhas: temporária repete com a mesma chave, definitiva fica como falha e nada aparece como enviado', async () => {
  const requester = await createUser('falha-pede@example.gov.br')
  const operator = await createUser('falha-op@example.gov.br', 'slm_operator')
  const { id } = await maintenance(requester)
  const base = `/communications/service_request/${id}`

  const temporary = await post(`${base}/send`, operator, message())
  await processManualEmailQueue(fakeEmail(new IntegrationError('RESEND_500', true)).transport)
  let item = (await call(base, { session: operator })).body.history[0]
  assert.deepEqual([item.status, item.errorCode, item.sentAt], ['pending', 'RESEND_500', null])

  await pool.query(`ALTER TABLE public.manual_emails DISABLE TRIGGER manual_emails_protected`)
  await pool.query(`UPDATE public.manual_emails SET proxima_tentativa = now() WHERE id = $1`, [temporary.body.id])
  await pool.query(`ALTER TABLE public.manual_emails ENABLE TRIGGER manual_emails_protected`)
  const fine = fakeEmail()
  await processManualEmailQueue(fine.transport)
  assert.equal(fine.sent[0].idempotencyKey, `slm-manual-${temporary.body.id}`)

  await post(`${base}/send`, operator, message())
  await processManualEmailQueue(fakeEmail(new IntegrationError('RESEND_422', false)).transport)
  item = (await call(base, { session: operator })).body.history[0]
  assert.deepEqual([item.status, item.errorCode, item.sentAt], ['failed', 'RESEND_422', null])

  // Sem serviço ativo: fica registrada como não enviada, e a fila não a pega.
  const previous = process.env.EMAIL_TRANSPORT
  delete process.env.EMAIL_TRANSPORT
  const notConfigured = await post(`${base}/send`, operator, message())
  process.env.EMAIL_TRANSPORT = previous
  assert.equal(notConfigured.body.status, 'not_configured')
  const idle = fakeEmail()
  await processManualEmailQueue(idle.transport)
  assert.equal(idle.sent.length, 0)
  assert.equal((await call(base, { session: operator })).body.service, 'simulado')
})

test('anexos: removido ou alterado depois do registro não sai, e o limite total vale', async () => {
  const requester = await createUser('anexo-pede@example.gov.br')
  const operator = await createUser('anexo-op@example.gov.br', 'slm_operator')
  const { id } = await maintenance(requester)
  const base = `/communications/service_request/${id}`
  const first = await upload(operator, 'service_request', id, 'outro', 'um.pdf')
  const second = await upload(operator, 'service_request', id, 'outro', 'dois.pdf')

  const queued = await post(`${base}/send`, operator, message({ anexos: [first.body.id] }))
  assert.equal((await post(`/attachments/files/${first.body.id}/remove`, operator, { justificativa: 'Arquivo errado' })).status, 200)
  await processManualEmailQueue(fakeEmail().transport)
  const failed = (await call(base, { session: operator })).body.history.find((item: { id: string }) => item.id === queued.body.id)
  assert.deepEqual([failed.status, failed.errorCode], ['failed', 'ATTACHMENT_REMOVED'])
  assert.equal((await post(`${base}/send`, operator, message({ anexos: [first.body.id] }))).status, 400, 'removido não entra')

  // Anexo de outra solicitação não entra.
  const other = await maintenance(requester)
  assert.equal((await post(`/communications/service_request/${other.id}/send`, operator, message({ anexos: [second.body.id] }))).status, 400)

  // Limite total configurável, e só a administração muda.
  assert.equal((await call('/settings/parameters/communications', { method: 'PUT', session: operator, body: { maxEmailMb: 1, maxRecipients: 1 } })).status, 403)
  assert.equal((await call('/settings/parameters/communications', { method: 'PUT', session: admin, body: { maxEmailMb: 99, maxRecipients: 1 } })).status, 400)
  assert.equal((await call('/settings/parameters/communications', { method: 'PUT', session: admin, body: { maxEmailMb: 1, maxRecipients: 1 } })).status, 200)
  assert.equal((await post(`${base}/send`, operator, message({ copias: ['a@example.gov.br'] }))).status, 400)
  // Dois arquivos que, juntos, passam de 1 MB: cada um é aceito, e a mensagem não.
  const big = Buffer.concat([pdf, Buffer.alloc(700 * 1024, 32)])
  const largeOne = await upload(operator, 'service_request', id, 'outro', 'grande-1.pdf', big)
  const largeTwo = await upload(operator, 'service_request', id, 'outro', 'grande-2.pdf', big)
  assert.equal(largeOne.status, 201, largeOne.text)
  const tooLarge = await post(`${base}/send`, operator, message({ anexos: [largeOne.body.id, largeTwo.body.id] }))
  assert.equal(tooLarge.status, 400, tooLarge.text)
  assert.match(tooLarge.body.message, /limite de 1 MB/)
  assert.equal((await post(`${base}/send`, operator, message({ anexos: [largeOne.body.id] }))).status, 201)
  await call('/settings/parameters/communications', { method: 'PUT', session: admin, body: { maxEmailMb: 25, maxRecipients: 10 } })
})

test('passagem: dados automáticos, bilhete obrigatório, indicador, sem CPF, e o status não muda', async () => {
  const requester = await createUser('bilhete-pede@example.gov.br')
  const operator = await createUser('bilhete-op@example.gov.br', 'slm_operator')
  const { id, protocol } = await flight(requester)
  const base = `/communications/service_request/${id}`
  const list = async (session: Session) => (await call('/flights/requests', { session })).body.requests.find((item: { id: string }) => item.id === id)

  let overview = await call(base, { session: operator })
  assert.equal(overview.body.ticketStatus, 'nao_enviado')
  assert.equal((await list(operator)).ticketStatus, 'nao_enviado')
  assert.equal((await list(requester)).ticketStatus, undefined, 'o solicitante não vê o indicador')
  assert.ok(!overview.text.includes(cpf), 'o CPF completo não aparece')
  const passengerId = overview.body.passengers[0].id

  await post(`/flights/requests/${id}/quotes`, operator, { companhia: 'Aérea Fictícia', voos: 'AF100 e AF200', valor: 900 })
  const quotes = await call(`/flights/requests/${id}/quotes`, { session: operator })
  await post(`/flights/requests/${id}/quotes/${quotes.body.quotes[0].id}/select`, operator, { justificativa: 'Menor valor' })

  const composed = await post(`${base}/compose`, operator, { modelo: 'flight_ticket_delivery', passageiroId: passengerId, localizador: 'XYZ123' })
  assert.equal(composed.status, 200, composed.text)
  for (const expected of ['Passageira Fictícia', protocol, 'Aérea Fictícia', 'AF100 e AF200', 'SP → RJ, 10/05/2032 às 10:00', 'RJ → SP, 12/05/2032 às 18:00', 'XYZ123', 'JUCESP']) {
    assert.ok(composed.body.mensagem.includes(expected), expected)
  }
  assert.ok(!composed.text.includes(cpf))
  assert.ok(!/\{\{/.test(composed.body.mensagem + composed.body.assunto))
  const noLocator = await post(`${base}/compose`, operator, { modelo: 'flight_ticket_delivery', passageiroId: passengerId })
  assert.ok(!noLocator.body.mensagem.includes('Localizador'), 'sem dado, a linha some')
  assert.equal((await post(`${base}/compose`, operator, { modelo: 'inventado' })).status, 400)

  const ticket = message({ tipo: 'passagem', passageiroId: passengerId, destinatarios: ['passageira@x.test'], modelo: 'flight_ticket_delivery', mensagem: composed.body.mensagem })
  assert.equal((await post(`${base}/send`, operator, ticket)).status, 400, 'bilhete obrigatório')
  assert.equal((await post(`${base}/send`, operator, { ...ticket, passageiroId: null })).status, 400, 'passageiro obrigatório')
  const file = await upload(operator, 'service_request', id, 'bilhete', 'bilhete.pdf')
  assert.equal(file.status, 201, file.text)

  const sent = await post(`${base}/send`, operator, { ...ticket, chave: randomUUID(), anexos: [file.body.id] })
  assert.equal(sent.status, 201, sent.text)
  assert.equal((await call(base, { session: operator })).body.ticketStatus, 'pendente')
  assert.equal((await list(operator)).ticketStatus, 'pendente')
  const failing = fakeEmail(new IntegrationError('RESEND_422', false))
  await processManualEmailQueue(failing.transport)
  assert.equal((await list(operator)).ticketStatus, 'falha')

  const resent = await post(`/communications/emails/${sent.body.id}/resend`, operator, { confirmado: true, chave: randomUUID() })
  assert.equal(resent.status, 201, resent.text)
  const fake = fakeEmail()
  await processManualEmailQueue(fake.transport)
  overview = await call(base, { session: operator })
  assert.equal(overview.body.ticketStatus, 'enviado')
  assert.equal((await list(operator)).ticketStatus, 'enviado')
  assert.equal(overview.body.history.length, 2, 'a falha continua no histórico')
  assert.equal(fake.sent[0].to, 'passageira@x.test')
  assert.ok(!fake.sent[0].text.includes(cpf))
  assert.equal((await call(`/flights/requests/${id}`, { session: operator })).body.request.status, 'em_cotacao', 'o status não muda sozinho')

  // Endereço já usado é sugerido no próximo encaminhamento.
  const suggested = await post(`${base}/compose`, operator, { modelo: 'flight_ticket_delivery', passageiroId: passengerId })
  assert.equal(suggested.body.destinatarioSugerido, 'passageira@x.test')

  // Passagem só existe em Passagens.
  const other = await maintenance(requester)
  assert.equal((await post(`/communications/service_request/${other.id}/send`, operator, message({ tipo: 'passagem' }))).status, 404)
})

test('almoxarifado: só quem administra envia, com o e-mail informado no pedido digitado', async () => {
  const manager = await createUser('almox-mensagem@example.gov.br', 'slm_operator', ['warehouse:manage'])
  const operator = await createUser('almox-sem@example.gov.br', 'slm_operator')
  const unit = await post('/settings/catalog/measurementUnits', admin, { label: `Unidade ${randomUUID().slice(0, 6)}` })
  const material = await post('/warehouse/materials', admin, { name: `Papel ${randomUUID().slice(0, 6)}`, unitId: unit.body.option.id })
  const sector = await post('/settings/catalog/sectors', admin, { label: `Setor ${randomUUID().slice(0, 6)}` })
  const created = await post('/warehouse/external-requests', manager, {
    sectorId: sector.body.option.id,
    externalRequester: 'Pessoa Externa',
    externalRequesterEmail: 'pessoa-externa@example.gov.br',
    items: [{ materialId: material.body.id, requested: 2 }],
  })
  assert.equal(created.status, 201, created.text)
  const base = `/communications/material_request/${created.body.id}`

  assert.equal((await call(base, { session: operator })).status, 404, 'atender outros módulos não basta')
  const overview = await call(base, { session: manager })
  assert.deepEqual(overview.body.recipients.map((item: { email: string }) => item.email), ['pessoa-externa@example.gov.br'])
  assert.equal(overview.body.ticketStatus, undefined)
  const file = await upload(manager, 'material_request', created.body.id, 'comprovante', 'guia.pdf')
  assert.equal(file.status, 201, file.text)
  const sent = await post(`${base}/send`, manager, message({ destinatarios: ['pessoa-externa@example.gov.br'], anexos: [file.body.id] }))
  assert.equal(sent.status, 201, sent.text)
  const fake = fakeEmail()
  await processManualEmailQueue(fake.transport)
  assert.equal(fake.sent.at(-1)?.attachments?.[0].filename, 'guia.pdf')
})

test('modelos: a administração cria modelos próprios, que aparecem no envio só depois de publicados', async () => {
  const operator = await createUser('modelo-envio@example.gov.br', 'slm_operator')
  const requester = await createUser('modelo-envio-pede@example.gov.br')
  const { id } = await flight(requester)
  const base = `/communications/service_request/${id}`
  const content = {
    name: 'Bilhete internacional', event: 'flight_ticket_delivery', active: true, subject: 'Sua viagem {{protocolo}}',
    greeting: '', body: 'Olá, {{nome_passageiro}}.', closing: '', signature: 'Equipe SLM - JUCESP', facts: [],
  }
  assert.equal((await call('/config/email-templates/custom-bilhete-intl/draft', { method: 'PUT', session: admin, body: { conteudo: content } })).status, 200)
  const names = async () => (await call(base, { session: operator })).body.templates.map((item: { key: string }) => item.key)
  assert.ok(!(await names()).includes('custom-bilhete-intl'), 'rascunho não aparece')
  assert.equal((await post('/config/email-templates/custom-bilhete-intl/publish', admin, { conteudo: content })).status, 200)
  assert.ok((await names()).includes('custom-bilhete-intl'))
  const library = await call('/config/email-templates', { session: admin })
  assert.equal(library.body.custom[0].name, 'Bilhete internacional')
  assert.ok(library.body.events.find((item: { key: string }) => item.key === 'flight_ticket_delivery').variables.includes('localizador'))
  assert.ok(!library.body.events.find((item: { key: string }) => item.key === 'request_received').variables.includes('localizador'))
})

test('repositório: o indicador nunca afirma envio sem confirmação', async () => {
  const { ticketStatusOf } = await import('./communicationRepository.js')
  assert.equal(ticketStatusOf(undefined), 'nao_enviado')
  assert.equal(ticketStatusOf('not_configured'), 'nao_enviado')
  assert.equal(ticketStatusOf('sending'), 'pendente')
  assert.equal(ticketStatusOf('sent'), 'enviado')
  assert.ok(new CommunicationRepository())
})

test('a migração 013 só é desfeita sem mensagens', async () => {
  await assert.rejects(pool.query(schema('013_communications.rollback.sql')), /interrompida/)
})
