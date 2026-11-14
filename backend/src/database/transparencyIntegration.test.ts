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

// Supercomandos 06 e 07 pela API real, em um PostgreSQL descartável, com provedor de e-mail falso.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')

let pool: Pool
let server: Server
let baseUrl: string
let admin: Session
let floorId: string
let serviceTypeId: string
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
  const raw = Buffer.from(await response.arrayBuffer())
  const text = raw.toString('utf8')
  const type = response.headers.get('content-type') ?? ''
  const body = (type.includes('json') ? JSON.parse(text) : {}) as Record<string, any>
  const setCookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  if (setCookie && body.csrfToken) csrfTokens.set(setCookie, body.csrfToken)
  await settleAccountNotices(path)
  return { status: response.status, body, text, raw, type, setCookie, disposition: response.headers.get('content-disposition') ?? '' }
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


const post = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'POST', session, body })
const put = (path: string, session: Session, body: unknown) => call(path, { method: 'PUT', session, body })
const patch = (path: string, session: Session, body: unknown) => call(path, { method: 'PATCH', session, body })

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
    body: { fullName: `Pessoa ${email.split('@')[0]}`, email, sector: 'Protocolo', password, passwordConfirmation: password },
  })
  assert.equal(registered.status, 202, registered.text)
  const pending = await call('/admin/registrations/pending', { session: admin })
  const id = pending.body.registrations.find((item: { email: string }) => item.email === email).id
  assert.equal((await post(`/admin/registrations/${id}/approve`, admin, { role })).status, 200)
  return signIn(email)
}

async function staff(email: string, grants: Permission[] = ['requests:schedule']): Promise<Session> {
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

const fleetBody = (dataHora = '2031-05-10T13:00:00.000Z') => ({
  origem: 'Sede', destino: 'Fórum', dataHora, finalidade: 'Levar documentos ao fórum', veiculo: 'Van 1',
})
const maintenanceBody = (descricao = 'Trocar lâmpada queimada') => ({
  andarId: floorId, tipoServicoId: serviceTypeId, localServico: 'Sala de reuniões', descricao,
})

async function createFleet(requester: Session, dataHora?: string) {
  const created = await post('/fleet/requests', requester, fleetBody(dataHora))
  assert.equal(created.status, 201, created.text)
  return created.body as { id: string; protocol: string }
}

async function historyOf(id: string) {
  const { rows } = await pool.query<{ acao: string; comentario: string | null; detalhes: Record<string, any> }>(
    `SELECT acao, comentario, detalhes FROM public.request_history WHERE request_id = $1 ORDER BY created_at, id`,
    [id],
  )
  return rows
}

before(async () => {
  process.env.PASSENGER_DATA_KEY = randomBytes(32).toString('base64')
  process.env.EMAIL_TRANSPORT = 'simulated'

  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  for (const file of [
    '001_public_schema_snapshot.sql', '002_password_recovery.sql', '003_user_access.sql', '004_flight_passengers.sql',
    '005_operational_modules.sql', '006_integrations.sql', '007_operations_center.sql', '008_attachments.sql',
    '009_module_extensions.sql', '010_monitoring.sql', '011_delivery_forecast.sql',
  ]) {
    await pool.query(schema(file))
  }
  resetAccessSchemaCacheForTests()
  await pool.query(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'transp-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )
  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('transp-admin@example.gov.br')

  const option = async (category: string, label: string) => {
    const created = await post(`/settings/catalog/${category}`, admin, { label })
    assert.equal(created.status, 201, created.text)
    return created.body.option.id as string
  }
  floorId = await option('floors', 'Térreo')
  serviceTypeId = await option('serviceTypes', 'Elétrica')
  const unitId = await option('measurementUnits', 'Unidade')
  await option('sectors', 'Protocolo')
  materialId = (await post('/warehouse/materials', admin, { name: 'Papel A4', unitId })).body.id
})

after(async () => {
  for (const name of ['PASSENGER_DATA_KEY', 'EMAIL_TRANSPORT']) delete process.env[name]
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

// Roda primeiro: o código publicado precede a migração, e nada que já funciona pode depender dela.
test('sem a migração 012, os fluxos existentes continuam, e só o novo pede a atualização', async () => {
  const requester = await createUser('sem-012@example.gov.br')
  const operator = await staff('sem-012-op@example.gov.br')
  const { id } = await createFleet(requester)
  const path = `/fleet/requests/${id}`

  const detail = await call(path, { session: requester })
  assert.equal(detail.status, 200, detail.text)
  assert.deepEqual(detail.body.returns, [])
  assert.equal(detail.body.request.waitingSince, null)

  assert.equal((await post(`${path}/schedule`, operator, { dataAgendada: '2031-05-10T13:00:00.000Z' })).status, 200)
  assert.equal((await call('/slm/overview', { session: admin })).status, 403, 'a Central segue exigindo a permissão')
  assert.equal((await call('/forms/definitions', { session: requester })).status, 200)
  assert.equal((await call('/public/forms/registration')).body.form, null)
  assert.equal((await call('/config/email-templates', { session: admin })).status, 200)
  assert.equal((await post(`${path}/return`, operator, { tipo: 'complementacao', motivo: 'Faltam dados' })).status, 503)

  // Parâmetros continuam salvando, e o e-mail segue com o texto padrão.
  assert.equal((await put('/settings/parameters/deadlines', admin, { warningDays: 3, byModule: {}, byServiceType: {} })).status, 200)
  assert.deepEqual((await call('/settings/history', { session: admin })).body.history, [])

  // Sem registros dela, a migração é desfeita por inteiro, e pode ser aplicada de novo.
  await pool.query(schema('012_operational_transparency.sql'))
  await pool.query(schema('012_operational_transparency.rollback.sql'))
  assert.equal((await pool.query(`SELECT to_regclass('public.config_versions') AS t`)).rows[0].t, null)
  assert.equal((await call(path, { session: requester })).status, 200, 'os registros seguem legíveis')
  await pool.query(schema('012_operational_transparency.sql'))
})

test('agendamento diferente do pedido exige motivo, registra tudo e explica ao solicitante', async () => {
  const requester = await createUser('agenda-pede@example.gov.br')
  const operator = await staff('agenda-op@example.gov.br')
  const requested = '2031-06-10T13:00:00.000Z'
  const { id, protocol } = await createFleet(requester, requested)
  const path = `/fleet/requests/${id}`

  // Diferente do pedido: precisa de motivo, e motivo inventado não passa.
  const other = '2031-06-11T14:00:00.000Z'
  assert.equal((await post(`${path}/schedule`, operator, { dataAgendada: other })).status, 400)
  assert.equal((await post(`${path}/schedule`, operator, { dataAgendada: other, motivoCodigo: 'inventado' })).status, 400)
  assert.equal((await post(`${path}/schedule`, operator, { dataAgendada: other, motivoCodigo: 'outro' })).status, 400, '"outros" exige texto')
  const scheduled = await post(`${path}/schedule`, operator, {
    dataAgendada: other,
    motivoCodigo: 'veiculo_indisponivel',
    comentario: 'Van em revisão',
  })
  assert.equal(scheduled.status, 200, scheduled.text)

  let history = (await historyOf(id)).at(-1)!
  assert.equal(history.acao, 'agendada')
  assert.equal(history.comentario, 'Indisponibilidade de veículo: Van em revisão')
  assert.equal(history.detalhes.divergente, true)
  assert.equal(history.detalhes.solicitado.inicio, requested)
  assert.equal(history.detalhes.novo.inicio, other)
  assert.equal(history.detalhes.motivoCodigo, 'veiculo_indisponivel')

  // Reagendar: exige motivo e preserva o agendamento anterior.
  const third = '2031-06-12T14:00:00.000Z'
  assert.equal((await post(`${path}/schedule`, operator, { dataAgendada: third })).status, 400)
  assert.equal((await post(`${path}/schedule`, operator, { dataAgendada: third, motivoCodigo: 'conflito_agenda' })).status, 200)
  history = (await historyOf(id)).at(-1)!
  assert.equal(history.acao, 'reagendada')
  assert.equal(history.detalhes.anterior.inicio, other)
  assert.equal(history.detalhes.solicitado.inicio, requested)

  // Mesma data e outra condição: alteração, com status mantido e motivo obrigatório.
  assert.equal((await post(`${path}/schedule`, operator, { dataAgendada: third, condicoesAlteradas: 'Outro veículo' })).status, 400)
  const adjusted = await post(`${path}/schedule`, operator, {
    dataAgendada: third,
    condicoesAlteradas: 'Outro veículo',
    motivoCodigo: 'adequacao_operacional',
  })
  assert.equal(adjusted.status, 200, adjusted.text)
  assert.equal((await historyOf(id)).at(-1)!.acao, 'agendamento_alterado')

  // Clique duplo: nada mudou, nada a registrar.
  const total = (await historyOf(id)).length
  assert.equal((await post(`${path}/schedule`, operator, { dataAgendada: third })).status, 200)
  assert.equal((await historyOf(id)).length, total)

  const fake = fakeEmail()
  await processEmailQueue(fake.transport)
  const mine = fake.sent.filter((item) => item.to === 'agenda-pede@example.gov.br' && item.text.includes(protocol))
  const first = mine.find((item) => item.subject.startsWith('Atendimento agendado'))!
  assert.ok(first.text.includes('condições diferentes das solicitadas'))
  assert.ok(first.text.includes('Solicitado:'), 'mostra o que foi pedido')
  assert.ok(first.text.includes('Data e horário:'), 'mostra o que foi agendado')
  assert.ok(first.text.includes('Motivo da adequação: Indisponibilidade de veículo: Van em revisão'))
  assert.ok(mine.some((item) => item.subject.startsWith('Agendamento alterado') && item.text.includes('Outro veículo')))

  // Nota de exatamente como pedido: confirmação normal, sem motivo.
  const same = await createFleet(requester, '2031-07-10T13:00:00.000Z')
  assert.equal(
    (await post(`/fleet/requests/${same.id}/schedule`, operator, { dataAgendada: '2031-07-10T13:00:00.000Z', comentario: 'Nota interna da equipe' })).status,
    200,
  )
  const plain = fakeEmail()
  await processEmailQueue(plain.transport)
  const confirmation = plain.sent.find((item) => item.to === 'agenda-pede@example.gov.br' && item.text.includes(same.protocol) && item.subject.startsWith('Atendimento agendado'))!
  assert.ok(!confirmation.text.includes('diferentes'))
  assert.ok(!confirmation.text.includes('Nota interna'), 'comentário interno não vai ao solicitante')
})

test('editar a data pedida não apaga o pedido nem dispensa a justificativa', async () => {
  const requester = await createUser('original-pede@example.gov.br')
  const operator = await staff('original-op@example.gov.br')
  const requested = '2031-08-10T13:00:00.000Z'
  const { id } = await createFleet(requester, requested)
  const path = `/fleet/requests/${id}`
  const moved = '2031-08-20T13:00:00.000Z'
  assert.equal((await patch(path, operator, { dataHora: moved })).status, 200)
  assert.equal((await post(`${path}/schedule`, operator, { dataAgendada: moved })).status, 400, 'continua diferente do pedido original')
  const detail = await call(path, { session: requester })
  assert.equal(detail.body.request.details.solicitacaoOriginal.inicio, requested)
})

test('cancelamento: motivo obrigatório, registro completo e histórico mantido', async () => {
  const requester = await createUser('cancela-pede@example.gov.br')
  const operator = await staff('cancela-op@example.gov.br')
  const { id, protocol } = await createFleet(requester, '2031-09-10T13:00:00.000Z')
  const path = `/fleet/requests/${id}`
  await post(`${path}/schedule`, operator, { dataAgendada: '2031-09-10T13:00:00.000Z' })

  assert.equal((await post(`${path}/cancel`, operator, {})).status, 400)
  const cancelled = await post(`${path}/cancel`, operator, { motivoCodigo: 'equipe_indisponivel', motivo: 'Equipe em treinamento' })
  assert.equal(cancelled.status, 200, cancelled.text)

  const history = (await historyOf(id)).at(-1)!
  assert.equal(history.acao, 'cancelada')
  assert.equal(history.detalhes.situacaoAnterior, 'agendado')
  assert.equal(history.detalhes.agendamentoCancelado.inicio, '2031-09-10T13:00:00.000Z')
  assert.equal(history.detalhes.motivoNome, 'Indisponibilidade de equipe')

  const fake = fakeEmail()
  await processEmailQueue(fake.transport)
  const message = fake.sent.find((item) => item.to === 'cancela-pede@example.gov.br' && item.subject.startsWith('Solicitação cancelada') && item.text.includes(protocol))!
  assert.ok(message.text.includes('Motivo informado: Indisponibilidade de equipe: Equipe em treinamento'))

  // O solicitante não altera histórico nem justificativa, e o banco recusa mudanças diretas.
  await assert.rejects(pool.query(`UPDATE public.request_history SET comentario = 'x' WHERE request_id = $1`, [id]))
})

test('devolução: mesmo protocolo, só os campos indicados, dados anteriores preservados e prazo pausado', async () => {
  const requester = await createUser('devolve-pede@example.gov.br')
  const other = await createUser('devolve-outra@example.gov.br')
  const operator = await staff('devolve-op@example.gov.br')
  const created = await post('/maintenance/requests', requester, maintenanceBody('Descrição incompleta'))
  const { id, protocol } = created.body
  const path = `/maintenance/requests/${id}`

  assert.equal((await post(`${path}/return`, requester, { tipo: 'correcao', motivo: 'Tentativa', campos: ['sala'] })).status, 403)
  assert.equal((await post(`${path}/return`, operator, { tipo: 'correcao', motivo: 'Falta o local', campos: ['status'] })).status, 400)
  assert.equal((await post(`${path}/return`, operator, { tipo: 'correcao', motivo: 'x', campos: ['sala'] })).status, 400)
  const returned = await post(`${path}/return`, operator, {
    tipo: 'correcao',
    motivo: 'Descreva melhor o problema',
    campos: ['descricao', 'sala'],
  })
  assert.equal(returned.status, 201, returned.text)
  assert.equal((await post(`${path}/return`, operator, { tipo: 'correcao', motivo: 'De novo', campos: ['sala'] })).status, 409, 'uma devolução aberta por vez')
  // Operação sensível: fica na auditoria com quem fez, o resultado e o momento.
  const returnAudit = await pool.query<{ actor: string; result: string; at: Date }>(
    `SELECT actor_user_id::text AS actor, result, occurred_at AS at FROM public.auth_audit_events
      WHERE action = 'request.returned' ORDER BY occurred_at DESC LIMIT 1`,
  )
  assert.equal(returnAudit.rows[0]?.actor, operator.id)
  assert.equal(returnAudit.rows[0]?.result, 'success')
  assert.ok(returnAudit.rows[0]?.at instanceof Date)

  const seen = await call(path, { session: requester })
  assert.equal(seen.body.request.protocol, protocol, 'o protocolo é o mesmo')
  assert.equal(seen.body.actions.respondReturn, true)
  assert.equal(seen.body.actions.cancel, false)
  assert.equal(seen.body.returns[0].reason, 'Descreva melhor o problema')
  assert.deepEqual(seen.body.returns[0].fields, ['descricao', 'sala'])
  assert.equal(seen.body.returns[0].previousData, undefined, 'dados anteriores são internos')

  // Enquanto aguarda, não se agenda; e não conta como atraso interno.
  assert.equal((await post(`${path}/schedule`, operator, { dataAgendada: '2031-10-10T13:00:00.000Z' })).status, 409)
  assert.equal((await call(path, { session: operator })).body.actions.schedule, false)

  assert.equal((await post(`${path}/return/respond`, other, { resposta: 'Oi' })).status, 404, 'outra pessoa não responde')
  assert.equal((await post(`${path}/return/respond`, operator, { resposta: 'Oi' })).status, 404, 'quem atende também não')
  assert.equal((await post(`${path}/return/respond`, requester, {})).status, 400, 'sem alteração nem resposta')

  // Campo não indicado e identidade são descartados.
  const responded = await post(`${path}/return/respond`, requester, {
    resposta: 'Corrigido',
    dados: { descricao: 'Lâmpada queimada na sala 12', sala: '12', localServico: 'Outro lugar', solicitanteId: other.id, status: 'concluido' },
  })
  assert.equal(responded.status, 200, responded.text)
  const after = await call(path, { session: operator })
  assert.equal(after.body.request.description, 'Lâmpada queimada na sala 12')
  assert.equal(after.body.request.details.sala, '12')
  assert.equal(after.body.request.details.localServico, 'Sala de reuniões', 'campo não indicado não muda')
  assert.equal(after.body.request.requester.id, requester.id)
  assert.equal(after.body.request.waitingSince, null)
  assert.equal(after.body.returns[0].status, 'atendida')
  assert.equal(after.body.returns[0].previousData.descricao, 'Descrição incompleta', 'preserva os dados anteriores')
  assert.ok(after.body.history.some((item: { action: string }) => item.action === 'corrigida_pelo_solicitante'))

  // Devolução não apaga: o registro não muda nem some.
  await assert.rejects(pool.query(`UPDATE public.request_returns SET motivo = 'x' WHERE request_id = $1`, [id]))
  await assert.rejects(pool.query(`DELETE FROM public.request_returns WHERE request_id = $1`, [id]))

  // A equipe encerra uma devolução sem resposta; a espera soma e o agendamento volta a ser possível.
  assert.equal((await post(`${path}/return`, operator, { tipo: 'complementacao', motivo: 'Qual o horário?' })).status, 201)
  await pool.query(
    `UPDATE public.service_requests
        SET created_at = now() - interval '3 hours', aguardando_externo_desde = now() - interval '2 hours'
      WHERE id = $1`,
    [id],
  )
  assert.equal((await post(`${path}/return/close`, operator, { motivo: 'Informação recebida por telefone' })).status, 200)
  const closed = await call(path, { session: operator })
  assert.ok(closed.body.request.timing.requesterWaitSeconds >= 7199)
  assert.ok(closed.body.request.timing.internalSeconds < closed.body.request.timing.totalSeconds)
  assert.equal((await post(`${path}/schedule`, operator, { dataAgendada: '2031-10-10T13:00:00.000Z' })).status, 200)

  const fake = fakeEmail()
  await processEmailQueue(fake.transport)
  const message = fake.sent.find((item) => item.to === 'devolve-pede@example.gov.br' && item.subject.startsWith('Solicitação devolvida'))!
  assert.ok(message.text.includes('Motivo informado: Descreva melhor o problema'))
  assert.ok(message.text.includes('Campos a corrigir: Descrição, Sala'))
})

test('passagens: o solicitante corrige passageiros sem CPF no histórico nem nos e-mails', async () => {
  const requester = await createUser('voo-pede@example.gov.br')
  const operator = await staff('voo-op@example.gov.br', [])
  const cpf = '52998224725'
  const created = await post('/flights/requests', requester, {
    andarId: floorId,
    tipoViagem: 'somente_ida',
    ida: { origem: 'SP', destino: 'RJ', data: '2031-11-10', horario: '10:00' },
    passageiros: [{ nome: 'Passageira Fictícia', cpf }],
  })
  assert.equal(created.status, 201, created.text)
  const path = `/flights/requests/${created.body.id}`
  assert.equal((await post(`${path}/return`, operator, { tipo: 'correcao', motivo: 'CPF não confere', campos: ['passageiros'] })).status, 201)
  const passengerId = (await call(path, { session: requester })).body.passengers[0].id
  const responded = await post(`${path}/return/respond`, requester, {
    dados: { passageiros: [{ id: passengerId, nome: 'Passageira Corrigida' }] },
  })
  assert.equal(responded.status, 200, responded.text)
  assert.equal((await call(path, { session: requester })).body.passengers[0].name, 'Passageira Corrigida')

  const report = await call(`${path}/report?format=csv`, { session: operator })
  assert.equal(report.status, 200)
  assert.ok(report.text.includes('Nomes e CPF não são exportados'))
  assert.ok(!report.text.includes('Passageira'), 'o relatório não traz nomes de passageiros')
  assert.ok(!report.text.includes(cpf))
})

test('duplicidade: alerta conforme as permissões e nunca impede o registro', async () => {
  const first = await createUser('dup-primeira@example.gov.br')
  const second = await createUser('dup-segunda@example.gov.br')
  const operator = await staff('dup-op@example.gov.br')
  const created = await post('/maintenance/requests', first, maintenanceBody('Lâmpada queimada na sala de reuniões do terceiro andar'))
  assert.equal(created.status, 201)
  const probe = maintenanceBody('Lâmpada queimada, sala de reuniões, terceiro andar')

  const own = await post('/maintenance/requests/duplicates', first, probe)
  assert.equal(own.status, 200, own.text)
  assert.equal(own.body.duplicates[0].canOpen, true)
  assert.equal(own.body.duplicates[0].id, created.body.id)

  // Outra pessoa sabe que existe algo parecido, e nada além disso.
  const masked = await post('/maintenance/requests/duplicates', second, probe)
  assert.equal(masked.body.duplicates[0].canOpen, false)
  assert.equal(masked.body.duplicates[0].id, undefined)
  assert.equal(masked.body.duplicates[0].protocol, undefined)
  assert.equal(masked.body.duplicates[0].title, undefined)

  assert.equal((await post('/maintenance/requests/duplicates', operator, probe)).body.duplicates[0].canOpen, true)

  // O registro continua possível, e a decisão fica no histórico.
  const again = await post('/maintenance/requests', second, { ...probe, duplicidadeAvisada: true })
  assert.equal(again.status, 201)
  assert.equal((await historyOf(again.body.id))[0].detalhes.duplicidadeAvisada, true)

  // Outro problema, em outro local e de outra categoria, não é apontado como parecido.
  const otherType = await post('/settings/catalog/serviceTypes', admin, { label: 'Hidráulica' })
  const none = await post('/maintenance/requests/duplicates', first, {
    ...maintenanceBody('Vazamento na garagem'),
    localServico: 'Garagem',
    tipoServicoId: otherType.body.option.id,
  })
  assert.equal(none.status, 200)
  assert.deepEqual(none.body.duplicates, [])
})

test('relatório individual: PDF e CSV reais, com alcance por permissão e auditoria', async () => {
  const requester = await createUser('relat-pede@example.gov.br')
  const stranger = await createUser('relat-outra@example.gov.br')
  const operator = await staff('relat-op@example.gov.br')
  const { id, protocol } = await createFleet(requester, '2032-01-10T13:00:00.000Z')
  const path = `/fleet/requests/${id}`
  await post(`${path}/schedule`, operator, { dataAgendada: '2032-01-11T13:00:00.000Z', motivoCodigo: 'conflito_agenda' })

  const pdf = await call(`${path}/report`, { session: requester })
  assert.equal(pdf.status, 200)
  assert.match(pdf.type, /application\/pdf/)
  assert.ok(pdf.raw.subarray(0, 8).toString('latin1').startsWith('%PDF-'))
  assert.match(pdf.disposition, /attachment; filename="solicitacao-/)
  assert.ok(pdf.raw.toString('latin1').includes(protocol))

  const csv = await call(`${path}/report?format=csv`, { session: operator })
  assert.ok(csv.text.includes('Conflito de agenda'))

  assert.equal((await call(`${path}/report`, { session: stranger })).status, 404)
  assert.equal((await call(`${path}/report?format=exe`, { session: requester })).status, 400)
  assert.equal((await call(`${path}/report`)).status, 401)
  const audit = await pool.query(`SELECT 1 FROM public.auth_audit_events WHERE action = 'request.report_exported' AND target_resource_id = $1`, [id])
  assert.equal(audit.rows.length, 2)
})

test('almoxarifado: atendimento parcial com motivo, observação interna e saldo sem obrigação', async () => {
  const manager = await staff('almox-gestora@example.gov.br', ['warehouse:manage'])
  const requester = await createUser('almox-pede@example.gov.br')
  const created = await post('/warehouse/requests', requester, { items: [{ materialId, requested: 10 }] })
  assert.equal(created.status, 201, created.text)
  const path = `/warehouse/requests/${created.body.id}`

  await put(`${path}/items`, manager, { items: [{ materialId, requested: 10, fulfilled: 6 }] })
  assert.equal((await post(`${path}/status`, manager, { status: 'atendido_parcial' })).status, 400, 'exige motivo por item')
  assert.equal((await put(`${path}/items`, manager, { items: [{ materialId, requested: 10, fulfilled: 6, reasonCode: 'inventado' }] })).status, 400)
  assert.equal((await put(`${path}/items`, manager, { items: [{ materialId, requested: 10, fulfilled: 6, reasonCode: 'outro' }] })).status, 400, '"outros" exige texto')
  const saved = await put(`${path}/items`, manager, {
    items: [{ materialId, requested: 10, fulfilled: 6, reasonCode: 'quantidade_incompativel', note: 'Avaliação interna restrita' }],
  })
  assert.equal(saved.status, 200, saved.text)
  assert.equal((await post(`${path}/status`, manager, { status: 'atendido_parcial' })).status, 200)

  const internal = await call(path, { session: manager })
  assert.equal(internal.body.items[0].notProvided, 4)
  assert.equal(internal.body.items[0].note, 'Avaliação interna restrita')
  assert.equal(internal.body.itemChanges.at(-1).reason, 'Quantidade incompatível com a necessidade apresentada')
  const seen = await call(path, { session: requester })
  assert.equal(seen.body.items[0].reason, 'Quantidade incompatível com a necessidade apresentada')
  assert.ok(!seen.text.includes('Avaliação interna'), 'a observação não chega ao solicitante')
  assert.deepEqual(seen.body.itemChanges, [])

  // Físico, reservado, disponível e fornecido são números diferentes.
  const entry = await post('/warehouse/stock-movements', manager, { materialId, tipo: 'entrada', quantidade: 20, justificativa: 'Saldo inicial' })
  assert.equal(entry.status, 201, entry.text)
  assert.equal((await put(`/warehouse/stock/${materialId}/reserved`, manager, { reservada: 5 })).status, 400, 'exige justificativa')
  assert.equal((await put(`/warehouse/stock/${materialId}/reserved`, requester, { reservada: 5, justificativa: 'Tentativa' })).status, 403)
  assert.equal((await put(`/warehouse/stock/${materialId}/reserved`, manager, { reservada: 5, justificativa: 'Demanda prioritária' })).status, 200)
  await post(`${path}/deliver`, manager, { receivedBy: 'Pessoa Recebedora' })
  const stock = await call('/warehouse/stock', { session: manager })
  const item = stock.body.items.find((entry: { id: string }) => entry.id === materialId)
  // Desde 12/11/2026 a entrega dá baixa automática: 20 de entrada, 6 entregues, 14 no físico.
  assert.deepEqual([item.current, item.reserved, item.available, item.provided], [14, 5, 9, 6])
  assert.equal(
    (await pool.query(`SELECT 1 FROM public.auth_audit_events WHERE action = 'warehouse.reserve_changed'`)).rows.length,
    1,
  )

  const fake = fakeEmail()
  await processEmailQueue(fake.transport)
  assert.ok(!fake.sent.some((entry) => entry.text.includes('Avaliação interna')))
})

test('prazos: por módulo e tipo de serviço, alertas na Central e espera fora do atraso', async () => {
  const central = await staff('central-prazos@example.gov.br', ['slm_central:read', 'slm_central:manage'])
  const requester = await createUser('prazos-pede@example.gov.br')
  assert.equal((await put('/settings/parameters/deadlines', admin, { warningDays: 2, byModule: { maintenance: 30 }, byServiceType: { [serviceTypeId]: 3 } })).status, 200)
  assert.equal((await put('/settings/parameters/deadlines', admin, { warningDays: 0 })).status, 400)
  assert.equal((await put('/settings/parameters/deadlines', requester, { warningDays: 2 })).status, 403)

  const created = await post('/maintenance/requests', requester, maintenanceBody('Prazo pelo tipo de serviço'))
  const path = `/maintenance/requests/${created.body.id}`
  const days = (Date.parse((await call(path, { session: central })).body.request.deadline) - Date.now()) / 86_400_000
  assert.ok(days > 2.9 && days <= 3, 'vale o mais curto entre os definidos')

  const list = async (queue: string) => (await call(`/slm/requests?queue=${queue}&search=${created.body.protocol}`, { session: central })).body
  assert.equal((await list('awaiting_internal')).total, 1)
  assert.equal((await list('near_due')).total, 0)

  await pool.query(`UPDATE public.service_requests SET prazo_em = now() + interval '1 day' WHERE id = $1`, [created.body.id])
  const near = await list('near_due')
  assert.equal(near.total, 1)
  assert.equal(near.requests[0].nearDue, true)

  await pool.query(`UPDATE public.service_requests SET prazo_em = now() - interval '1 hour' WHERE id = $1`, [created.body.id])
  assert.equal((await list('late')).total, 1)

  // Devolvida: não é atraso interno enquanto aguarda o solicitante.
  assert.equal((await post(`${path}/return`, central, { tipo: 'complementacao', motivo: 'Qual a sala?' })).status, 201)
  assert.equal((await list('late')).total, 0)
  assert.equal((await list('stale')).total, 0)
  const waiting = await list('awaiting_requester')
  assert.equal(waiting.total, 1)
  assert.equal(waiting.requests[0].waitingRequester, true)
  const overview = await call('/slm/overview', { session: central })
  assert.ok(overview.body.counts.awaiting_requester >= 1)
  assert.equal(overview.body.warningDays, 2)
  assert.ok('requesterWaitSeconds' in overview.body.timing)

  await put('/settings/parameters/deadlines', admin, { warningDays: 2, byModule: {}, byServiceType: {} })
  const log = await call('/settings/history?section=deadlines', { session: admin })
  assert.ok(log.body.history.length >= 2)
  assert.ok(log.body.history[0].user)
  assert.deepEqual(log.body.history[0].after.byServiceType, {})
})

test('motivos: administráveis, sem perder "outros", e fora da tela só quem tem permissão', async () => {
  const requester = await createUser('motivos-pede@example.gov.br')
  const base = (await call('/settings/parameters', { session: admin })).body.settings.reasons
  assert.equal((await put('/settings/parameters/reasons', requester, base)).status, 403)
  const scheduling = [{ key: 'chuva', label: 'Condições climáticas', active: true }, { key: 'conflito_agenda', label: 'Conflito de agenda', active: false }]
  const saved = await put('/settings/parameters/reasons', admin, { ...base, scheduling })
  assert.equal(saved.status, 200, saved.text)
  assert.ok(saved.body.value.scheduling.some((item: { key: string }) => item.key === 'outro'), '"outros" nunca sai')

  const operator = await staff('motivos-op@example.gov.br')
  const { id } = await createFleet(requester, '2032-03-10T13:00:00.000Z')
  const other = '2032-03-11T13:00:00.000Z'
  assert.equal((await post(`/fleet/requests/${id}/schedule`, operator, { dataAgendada: other, motivoCodigo: 'conflito_agenda' })).status, 400, 'desativado')
  assert.equal((await post(`/fleet/requests/${id}/schedule`, operator, { dataAgendada: other, motivoCodigo: 'chuva' })).status, 200)
  const capabilities = await call('/operations/capabilities', { session: requester })
  assert.ok(capabilities.body.reasons.scheduling.every((item: { active: boolean }) => item.active))
  await put('/settings/parameters/reasons', admin, base)
})

const template = (changes: Record<string, unknown> = {}) => ({
  name: 'Confirmação personalizada',
  event: 'request_scheduled',
  active: true,
  subject: 'Atendimento confirmado para {{data_agendada}}',
  greeting: 'Olá, {{nome_solicitante}}.',
  body: 'Seu atendimento foi **confirmado**.\nSetor: {{setor}}\nResponsável: {{responsavel}}\nVariável sem dado: {{data_solicitada}}',
  closing: 'Conte conosco.',
  signature: 'Equipe SLM - JUCESP',
  facts: ['reason', 'scheduled'],
  ...changes,
})

test('modelos: permissões separadas, validação, rascunho sem efeito, publicação e restauração', async () => {
  const reader = await staff('modelo-leitor@example.gov.br', ['email_templates:read'])
  const editor = await staff('modelo-editor@example.gov.br', ['email_templates:read', 'email_templates:edit'])
  const publisher = await staff('modelo-publica@example.gov.br', ['email_templates:read', 'email_templates:edit', 'email_templates:publish'])
  const requester = await createUser('modelo-pede@example.gov.br')
  const path = '/config/email-templates/request_scheduled'

  assert.equal((await call(path, { session: requester })).status, 403)
  const list = await call('/config/email-templates', { session: reader })
  assert.equal(list.status, 200)
  const event = list.body.events.find((item: { key: string }) => item.key === 'request_scheduled')
  assert.ok(event.variables.includes('data_agendada'))
  assert.ok(list.body.events.find((item: { key: string }) => item.key === 'flight_issued').variables.every((name: string) => name !== 'descricao'))
  for (const required of ['request_received', 'flight_approval_needed', 'request_info_requested', 'request_returned', 'request_scheduled', 'request_schedule_changed', 'request_rescheduled', 'request_cancelled', 'request_completed', 'warehouse_forecast_set', 'warehouse_forecast_changed']) {
    assert.ok(list.body.events.some((item: { key: string }) => item.key === required), required)
  }
  const detail = await call(path, { session: reader })
  assert.equal(detail.body.default.event, 'request_scheduled')
  assert.ok(detail.body.default.signature.includes('JUCESP'))

  // Permissões: leitor só lê, editor não publica nem restaura.
  assert.equal((await put(`${path}/draft`, reader, { conteudo: template() })).status, 403)
  assert.equal((await post(`${path}/publish`, editor, { conteudo: template() })).status, 403)
  assert.equal((await post(`${path}/restore`, publisher, { versao: 1 })).status, 403)

  // Validação no servidor: nada de marcação, variável desconhecida ou incompatível.
  const refused = [
    template({ body: '<script>alert(1)</script>' }),
    template({ body: 'Seu CPF: {{cpf}}' }),
    template({ body: '{{quantidade_solicitada}}' }),
    template({ subject: '' }),
    template({ signature: '' }),
    template({ event: 'inventado' }),
    template({ facts: ['senha'] }),
  ]
  for (const conteudo of refused) {
    assert.equal((await put(`${path}/draft`, editor, { conteudo })).status, 400, JSON.stringify(conteudo).slice(0, 60))
  }
  assert.equal(
    (await post('/config/email-templates/warehouse_forecast_set/publish', publisher, {
      conteudo: template({ event: 'warehouse_forecast_set', subject: 'Previsão', body: 'Sem a data', facts: [] }),
    })).status,
    400,
    'a previsão precisa citar a data',
  )

  // Prévia com dados de exemplo; variável sem dado some, sem identificador técnico.
  const preview = await post(`${path}/preview`, reader, { conteudo: template() })
  assert.equal(preview.status, 200, preview.text)
  assert.equal(preview.body.simulated, true)
  assert.ok(preview.body.text.includes('Pessoa de Exemplo'))
  assert.ok(preview.body.html.includes('<strong>confirmado</strong>'))
  assert.ok(!preview.body.text.includes('**'))
  assert.ok(!/\{\{/.test(preview.body.text + preview.body.subject))

  // Rascunho não vale para os envios.
  const requesterEmail = 'modelo-pede@example.gov.br'
  const operator = await staff('modelo-op@example.gov.br')
  assert.equal((await put(`${path}/draft`, editor, { conteudo: template({ subject: 'Rascunho' }) })).status, 200)
  const first = await createFleet(requester, '2032-04-10T13:00:00.000Z')
  await post(`/fleet/requests/${first.id}/schedule`, operator, { dataAgendada: '2032-04-10T13:00:00.000Z' })
  let fake = fakeEmail()
  await processEmailQueue(fake.transport)
  assert.ok(fake.sent.some((item) => item.to === requesterEmail && item.subject.startsWith('Atendimento agendado')))

  // Publicado: vale, com dados reais do banco, e sem campo vazio.
  const published = await post(`${path}/publish`, publisher, { conteudo: template(), observacao: 'Primeira versão' })
  assert.equal(published.status, 200, published.text)
  const second = await createFleet(requester, '2032-04-11T13:00:00.000Z')
  await post(`/fleet/requests/${second.id}/schedule`, operator, { dataAgendada: '2032-04-11T14:00:00.000Z', motivoCodigo: 'conflito_agenda' })
  fake = fakeEmail()
  await processEmailQueue(fake.transport)
  const custom = fake.sent.find((item) => item.to === requesterEmail && item.subject.startsWith('Atendimento confirmado'))!
  assert.ok(custom.text.includes('Olá, Pessoa modelo-pede.'))
  assert.ok(custom.text.includes('Setor: Protocolo'))
  assert.ok(custom.text.includes('Responsável: Pessoa modelo-op'))
  assert.ok(custom.text.includes('Equipe SLM - JUCESP'))
  assert.ok(custom.text.includes('Motivo da adequação: Conflito de agenda'), 'o motivo não pode faltar')
  assert.ok(custom.text.includes('Solicitado:'), 'nem o que foi pedido, mesmo fora da lista')
  assert.ok(!/\{\{|: \n/.test(custom.text))

  // Dados obrigatórios ausentes: a mensagem não sai.
  const history = await call(path, { session: reader })
  assert.deepEqual(history.body.history.map((item: { status: string }) => item.status), ['publicada', 'rascunho'])
  assert.equal(history.body.history[0].note, 'Primeira versão')
  assert.ok(history.body.history[0].user)
  await post(`${path}/publish`, publisher, { conteudo: template({ subject: 'Segunda versão' }) })

  // Restaurar publica uma cópia; nenhuma versão se perde.
  const restorer = await staff('modelo-restaura@example.gov.br', ['email_templates:read', 'config_versions:restore'])
  const version = history.body.history[0].version
  const restored = await post(`${path}/restore`, restorer, { versao: version })
  assert.equal(restored.status, 200, restored.text)
  const finalHistory = (await call(path, { session: reader })).body
  assert.equal(finalHistory.history.length, 4)
  assert.equal(finalHistory.published.content.subject, template().subject)
  assert.match(finalHistory.published.note, /Restaurada/)
  assert.equal((await post(`${path}/restore`, restorer, { versao: 999 })).status, 404)
  await assert.rejects(pool.query(`UPDATE public.config_versions SET situacao = 'rascunho'`))
  await assert.rejects(pool.query(`DELETE FROM public.config_versions`))
  for (const action of ['config.published', 'config.restored', 'config.draft_saved']) {
    assert.ok((await pool.query(`SELECT 1 FROM public.auth_audit_events WHERE action = $1`, [action])).rows.length >= 1, action)
  }

  // Volta ao texto padrão para os próximos testes.
  await post(`${path}/publish`, publisher, { conteudo: { ...detail.body.default, active: false } })
})

test('e-mail de teste: só para a própria conta, sem fila, status ou agenda', async () => {
  const editor = await staff('teste-editor@example.gov.br', ['email_templates:read', 'email_templates:edit'])
  const before = await pool.query<{ eventos: number; entregas: number; agenda: number }>(
    `SELECT (SELECT count(*)::int FROM public.integration_events) AS eventos,
            (SELECT count(*)::int FROM public.email_deliveries) AS entregas,
            (SELECT count(*)::int FROM public.calendar_sync_items) AS agenda`,
  )
  const sent = await post('/config/email-templates/request_scheduled/test', editor, {
    conteudo: template(),
    para: 'terceiro@example.gov.br',
  })
  assert.equal(sent.status, 200, sent.text)
  assert.equal(sent.body.simulated, true)
  const now = await pool.query(
    `SELECT (SELECT count(*)::int FROM public.integration_events) AS eventos,
            (SELECT count(*)::int FROM public.email_deliveries) AS entregas,
            (SELECT count(*)::int FROM public.calendar_sync_items) AS agenda`,
  )
  assert.deepEqual(now.rows[0], before.rows[0])
  assert.equal((await pool.query(`SELECT 1 FROM public.auth_audit_events WHERE action = 'config.email_test_sent'`)).rows.length, 1)
})

test('formulários: proteção dos campos essenciais, regras, rascunho e publicação com efeito real', async () => {
  const editor = await staff('form-editor@example.gov.br', ['forms:read', 'forms:edit'])
  const publisher = await staff('form-publica@example.gov.br', ['forms:read', 'forms:edit', 'forms:publish'])
  const requester = await createUser('form-pede@example.gov.br')
  const path = '/config/forms/maintenance'
  assert.equal((await call(path, { session: requester })).status, 403)
  const base = (await call(path, { session: editor })).body.default
  assert.equal((await post(`${path}/publish`, editor, { conteudo: base })).status, 403)
  assert.equal((await call('/config/forms/inventado', { session: editor })).status, 404)

  const withFields = (...extra: Record<string, unknown>[]) => ({ ...base, fields: [...base.fields, ...extra] })
  const refused = [
    { ...base, fields: base.fields.filter((field: { id: string }) => field.id !== 'descricao') },
    withFields({ id: 'custom-a', label: 'Setor', type: 'singleSelect', options: ['A'] }),
    withFields({ id: 'custom-a', label: 'Lista', type: 'singleSelect', options: [] }),
    withFields({ id: 'custom-a', label: 'Lista', type: 'singleSelect', options: ['A', 'a'] }),
    withFields({ id: 'custom-a', label: 'Duplicado', type: 'shortText' }, { id: 'custom-b', label: 'duplicado', type: 'shortText' }),
    withFields({ id: 'custom-a', label: '<b>x</b>', type: 'shortText' }),
    withFields({ id: 'nao-custom', label: 'Inválido', type: 'shortText' }),
    withFields({ id: 'custom-a', label: 'Tipo', type: 'script' }),
    withFields({ id: 'custom-a', label: 'Regra', type: 'shortText', visibleWhen: { field: 'custom-b', equals: 'x' } }, { id: 'custom-b', label: 'Depois', type: 'shortText' }),
    withFields({ id: 'custom-a', label: 'Fora', type: 'shortText', section: 'inexistente' }),
    withFields({ id: 'custom-a', label: 'Limite', type: 'shortText', minLength: 5, maxLength: 2 }),
  ]
  for (const conteudo of refused) {
    assert.equal((await put(`${path}/draft`, editor, { conteudo })).status, 400, JSON.stringify(conteudo).slice(-80))
  }

  // Campo protegido não fica opcional nem some, mesmo pedindo; o nome pode mudar.
  const relabel = base.fields.map((field: { id: string }) => (field.id === 'descricao' ? { ...field, label: 'O que precisa ser feito', required: false, active: false } : field))
  const content = {
    sections: [...base.sections, { id: 'extra', title: 'Dados adicionais' }],
    fields: [
      ...relabel.map((field: { id: string }) => (field.id === 'sala' ? { ...field, required: true } : field)),
      { id: 'custom-ramal', label: 'Ramal', description: 'Para contato', help: 'Só números', type: 'shortText', required: true, section: 'extra', validation: 'digits', maxLength: 6 },
      { id: 'custom-modalidade', label: 'Modalidade', type: 'singleSelect', options: ['Comum', 'Especial'], required: false, section: 'extra' },
      { id: 'custom-motivo', label: 'Motivo especial', type: 'longText', required: true, section: 'extra', visibleWhen: { field: 'custom-modalidade', equals: 'Especial' } },
    ],
  }
  const validated = await post(`${path}/validate`, editor, { conteudo: content })
  assert.equal(validated.status, 200, validated.text)
  const description = validated.body.content.fields.find((field: { id: string }) => field.id === 'descricao')
  assert.deepEqual([description.label, description.required, description.active], ['O que precisa ser feito', true, true])

  // Rascunho não muda nada no formulário em uso.
  assert.equal((await put(`${path}/draft`, editor, { conteudo: content })).status, 200)
  assert.equal((await call('/forms/definitions', { session: requester })).body.definitions, null)
  const draftOnly = await post('/maintenance/requests', requester, maintenanceBody('Antes da publicação'))
  assert.equal(draftOnly.status, 201, 'o rascunho não exige os campos novos')

  const published = await post(`${path}/publish`, publisher, { conteudo: content })
  assert.equal(published.status, 200, published.text)
  const definitions = (await call('/forms/definitions', { session: requester })).body
  assert.equal(definitions.versions.maintenance, published.body.version)
  assert.ok(definitions.definitions.maintenance.some((field: { id: string }) => field.id === 'custom-ramal'))
  assert.ok(definitions.definitions.fleet.length > 0, 'os demais formulários seguem com os campos padrão')

  // O servidor aplica as regras: não é só aparência.
  const send = (body: Record<string, unknown>) => post('/maintenance/requests', requester, { ...maintenanceBody('Depois da publicação'), ...body })
  assert.equal((await send({ customFields: { 'custom-ramal': '123' } })).status, 400, 'sala ficou obrigatória')
  assert.equal((await send({ sala: '1' })).status, 400, 'ramal obrigatório')
  assert.equal((await send({ sala: '1', customFields: { 'custom-ramal': 'abc' } })).status, 400, 'só números')
  assert.equal((await send({ sala: '1', customFields: { 'custom-ramal': '1234567' } })).status, 400, 'tamanho')
  assert.equal((await send({ sala: '1', customFields: { 'custom-ramal': '123', 'custom-modalidade': 'Outra' } })).status, 400, 'opção inválida')
  assert.equal((await send({ sala: '1', customFields: { 'custom-ramal': '123', 'custom-modalidade': 'Especial' } })).status, 400, 'a regra torna o campo exigido')
  const created = await send({
    sala: '1',
    customFields: { 'custom-ramal': '123', 'custom-modalidade': 'Comum', 'custom-motivo': 'Oculto: não deve ficar', 'campo-inventado': 'x' },
  })
  assert.equal(created.status, 201, created.text)
  const saved = (await call(`/maintenance/requests/${created.body.id}`, { session: requester })).body.request
  assert.deepEqual(saved.details.customFields, { 'custom-ramal': '123', 'custom-modalidade': 'Comum' })
  assert.equal(saved.details.customFieldLabels['custom-ramal'], 'Ramal')
  assert.equal((await historyOf(created.body.id))[0].detalhes.versaoFormulario, published.body.version)
  const row = await pool.query(`SELECT formulario_versao FROM public.service_requests WHERE id = $1`, [created.body.id])
  assert.equal(row.rows[0].formulario_versao, published.body.version)

  // Desativar um campo não apaga o valor nem o nome antigos.
  const without = { ...content, fields: content.fields.map((field: { id: string }) => (field.id === 'custom-ramal' ? { ...field, active: false, label: 'Telefone interno' } : field)) }
  await post(`${path}/publish`, publisher, { conteudo: without })
  const still = (await call(`/maintenance/requests/${created.body.id}`, { session: requester })).body.request
  assert.equal(still.details.customFields['custom-ramal'], '123')
  assert.equal(still.details.customFieldLabels['custom-ramal'], 'Ramal')
  assert.equal((await send({ sala: '1' })).status, 201, 'desativado não é exigido')

  // Restaurar: exige permissão própria e passa pelas regras atuais.
  assert.equal((await post(`${path}/restore`, publisher, { versao: 1 })).status, 403)
  const restorer = await staff('form-restaura@example.gov.br', ['forms:read', 'config_versions:restore'])
  assert.equal((await post(`${path}/restore`, restorer, { versao: published.body.version })).status, 200)
  await post(`${path}/publish`, publisher, { conteudo: base })
})

test('formulário de conta: campos próprios sem afrouxar acesso, senha ou aprovação', async () => {
  const publisher = await staff('conta-publica@example.gov.br', ['forms:read', 'forms:edit', 'forms:publish'])
  const path = '/config/forms/registration'
  const base = (await call(path, { session: publisher })).body.default
  const send = (email: string, extra: Record<string, unknown> = {}) => {
    authRateLimits.registerIp.reset('127.0.0.1')
    authRateLimits.registerIp.reset('::ffff:127.0.0.1')
    return call('/auth/register', {
      method: 'POST',
      body: { fullName: 'Pessoa Conta', email, sector: 'Protocolo', password, passwordConfirmation: password, ...extra },
    })
  }

  assert.equal((await put(`${path}/draft`, publisher, { conteudo: { ...base, fields: base.fields.filter((field: { id: string }) => field.id !== 'password') } })).status, 400)

  // Tentativa de afrouxar a senha e o e-mail: o servidor mantém os limites.
  const content = {
    ...base,
    fields: [
      ...base.fields.map((field: { id: string; minLength: number | null }) =>
        field.id === 'password'
          ? { ...field, label: 'Crie sua senha', minLength: 1, required: false, active: false }
          : field.id === 'email'
            ? { ...field, validation: 'none', required: false }
            : field,
      ),
      { id: 'custom-matricula', label: 'Matrícula', type: 'shortText', required: true, section: 'principal', validation: 'digits' },
    ],
  }
  const published = await post(`${path}/publish`, publisher, { conteudo: content })
  assert.equal(published.status, 200, published.text)
  const form = (await call('/public/forms/registration')).body
  assert.equal(form.version, published.body.version)
  const passwordField = form.form.fields.find((field: { id: string }) => field.id === 'password')
  assert.deepEqual([passwordField.label, passwordField.minLength, passwordField.required, passwordField.active], ['Crie sua senha', 8, true, true])

  assert.equal((await send('conta-sem@example.gov.br')).status, 400, 'matrícula obrigatória')
  assert.equal((await send('conta-errada@example.gov.br', { customFields: { 'custom-matricula': 'abc' } })).status, 400)
  assert.equal((await send('conta-curta@example.gov.br', { password: 'curta', passwordConfirmation: 'curta', customFields: { 'custom-matricula': '1' } })).status, 400, 'a senha curta continua recusada')
  assert.equal((await send('conta-boa@example.gov.br', { customFields: { 'custom-matricula': '123' } })).status, 202)

  // Continua pendente de aprovação, e sem conseguir entrar.
  authRateLimits.loginPair.reset('127.0.0.1|conta-boa@example.gov.br')
  authRateLimits.loginPair.reset('::ffff:127.0.0.1|conta-boa@example.gov.br')
  assert.equal((await call('/auth/login', { method: 'POST', body: { identifier: 'conta-boa@example.gov.br', password } })).status, 401)
  const pending = await call('/admin/registrations/pending', { session: admin })
  const entry = pending.body.registrations.find((item: { email: string }) => item.email === 'conta-boa@example.gov.br')
  assert.deepEqual(entry.additional, [{ label: 'Matrícula', value: '123' }])
  const row = await pool.query(`SELECT status, formulario_versao FROM public.auth_users WHERE email = 'conta-boa@example.gov.br'`)
  assert.deepEqual([row.rows[0].status, row.rows[0].formulario_versao], ['pending', published.body.version])

  await post(`${path}/publish`, publisher, { conteudo: base })
})

test('controle interno do Almoxarifado: só a equipe, com justificativa de divergência e sem novo pedido', async () => {
  const manager = await staff('controle-gestora@example.gov.br', ['warehouse:manage', 'forms:read', 'forms:edit', 'forms:publish'])
  const requester = await createUser('controle-pede@example.gov.br')
  const body = { material: materialId, reference: 'GOV-7', referenceQuantity: 10, countedQuantity: 8, providedQuantity: 8 }
  const before = await pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM public.material_requests`)

  assert.equal((await post('/warehouse/control-records', requester, body)).status, 403)
  assert.equal((await call('/warehouse/control-records', { session: requester })).status, 403)
  assert.equal((await post('/warehouse/control-records', manager, { referenceQuantity: 1 })).status, 400, 'material obrigatório')
  assert.equal((await post('/warehouse/control-records', manager, body)).status, 400, 'divergência exige justificativa')
  const created = await post('/warehouse/control-records', manager, { ...body, divergenceJustification: 'Duas caixas avariadas' })
  assert.equal(created.status, 201, created.text)

  const list = await call('/warehouse/control-records', { session: manager })
  assert.equal(list.body.records[0].justification, 'Duas caixas avariadas')
  assert.equal(list.body.records[0].material, 'Papel A4')

  const after = await pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM public.material_requests`)
  assert.equal(after.rows[0].total, before.rows[0].total, 'não cria pedido de materiais')

  // Adaptável pelas Configurações: campo novo vale, e a versão fica no registro.
  const base = (await call('/warehouse/control-form', { session: manager })).body.content
  const published = await post('/config/forms/warehouseControl/publish', manager, {
    conteudo: { ...base, fields: [...base.fields, { id: 'custom-lote', label: 'Lote', type: 'shortText', required: true, section: 'registro' }] },
  })
  assert.equal(published.status, 200, published.text)
  assert.equal((await post('/warehouse/control-records', manager, { material: materialId })).status, 400)
  const versioned = await post('/warehouse/control-records', manager, { material: materialId, customFields: { 'custom-lote': 'L1' } })
  assert.equal(versioned.status, 201, versioned.text)
  const records = (await call('/warehouse/control-records', { session: manager })).body.records
  assert.equal(records[0].formVersion, published.body.version)
  assert.equal(records[0].customFields.nomes['custom-lote'], 'Lote')
})

test('a migração 012 só é desfeita sem registros', async () => {
  await assert.rejects(pool.query(schema('012_operational_transparency.rollback.sql')), /interrompida/)
})

test('P-08: administrador fora da SLM mantém o controle do Almoxarifado; previsão só com a SLM', async () => {
  // A administradora destes cenários é a conta inicial, fora da equipe SLM, como no banco real.
  const me = (await call('/auth/me', { session: admin })).body.user
  assert.equal(me.slmMember, false)
  assert.ok(me.permissions.includes('warehouse:manage'))
  assert.equal(me.permissions.includes('warehouse:forecast'), false)
  assert.equal(me.permissions.includes('requests:schedule'), false)

  const firstDate = '2031-03-10'
  const secondDate = '2031-03-20'
  const unit = await post('/settings/catalog/measurementUnits', admin, { label: 'Caixa P-08' })
  assert.equal(unit.status, 201, unit.text)
  const unitId = unit.body.option.id
  const sector = await post('/settings/catalog/sectors', admin, { label: 'Setor P-08' })
  assert.equal(sector.status, 201, sector.text)
  // Sem concessões: desde 08/11/2026, o perfil Operador SLM já traz a gestão e a previsão.
  const staff = async (email: string, denied: Permission[] = []) => {
    const user = await createUser(email, 'slm_operator')
    const result = await put(`/admin/users/${user.id}/access`, admin, { role: 'slm_operator', slmMember: true, grantedPermissions: [], deniedPermissions: denied })
    assert.equal(result.status, 200, result.text)
    return user
  }

  // 1. Materiais: cadastra e edita.
  const material = await post('/warehouse/materials', admin, { name: 'Toner P-08', unitId })
  assert.equal(material.status, 201, material.text)
  assert.equal((await patch(`/warehouse/materials/${material.body.id}`, admin, { name: 'Toner P-08 preto', unitId })).status, 200)

  // 2. Estoque: entrada com justificativa, mínimo e consulta.
  const movement = await post('/warehouse/stock-movements', admin, { materialId: material.body.id, tipo: 'entrada', quantidade: 4, justificativa: 'Saldo conferido' })
  assert.equal(movement.status, 201, movement.text)
  assert.equal((await put(`/warehouse/stock/${material.body.id}/minimum`, admin, { minimo: 1 })).status, 200)
  assert.equal((await call('/warehouse/stock', { session: admin })).status, 200)
  assert.equal((await call('/warehouse/stock-movements', { session: admin })).status, 200)
  assert.equal((await call('/warehouse/control-form', { session: admin })).status, 200)
  assert.equal((await call('/warehouse/control-records', { session: admin })).status, 200)

  // 3. Inventário: nova conferência, contagem, fechamento e histórico.
  const check = await post('/warehouse/inventory-checks', admin, {
    title: 'Conferência P-08', referenceDate: '2027-02-01', items: [{ materialId: material.body.id, governmentQuantity: 4 }],
  })
  assert.equal(check.status, 201, check.text)
  const counted = await put(`/warehouse/inventory-checks/${check.body.id}/items/${material.body.id}`, admin, { governmentQuantity: 4, countedQuantity: 4 })
  assert.equal(counted.status, 200, counted.text)
  const closed = await post(`/warehouse/inventory-checks/${check.body.id}/close`, admin, { outcome: 'concluida' })
  assert.equal(closed.status, 200, closed.text)
  assert.equal((await call('/warehouse/inventory-checks', { session: admin })).status, 200)
  assert.ok((await call('/search?q=Conferência P-08', { session: admin })).body.results.inventoryChecks.total >= 1, 'pesquisa global de conferências')

  // Pedido: externo, itens, situação, edição local e entrega.
  const created = await post('/warehouse/external-requests', admin, {
    externalReference: 'GOV-P08', externalRequester: 'Pessoa Externa', externalRequesterEmail: 'pedido-p08@example.gov.br',
    sectorId: sector.body.option.id, note: 'Nota interna', items: [{ materialId: material.body.id, requested: 2, fulfilled: 0 }],
  })
  assert.equal(created.status, 201, created.text)
  const path = `/warehouse/requests/${created.body.id}`
  assert.equal((await patch(path, admin, { note: 'Registro local editado' })).status, 200)
  assert.equal((await put(`${path}/items`, admin, { items: [{ materialId: material.body.id, requested: 2, fulfilled: 2 }] })).status, 200)
  assert.equal((await post(`${path}/status`, admin, { status: 'atendido' })).status, 200)
  assert.equal((await post(`${path}/deliver`, admin, { receivedBy: 'Pessoa Recebedora' })).status, 200)

  // 4. Indicadores e relatórios.
  assert.equal((await call('/reports/summary', { session: admin })).status, 200)
  const report = await call('/reports/operational', { session: admin })
  assert.equal(report.status, 200)
  assert.ok(report.body.inventory, 'indicadores de inventário para quem administra')

  // 6. Previsão: recusada ao administrador, pela API, com auditoria (9).
  const asker = await createUser('pede-p08@example.gov.br')
  const internal = await post('/warehouse/requests', asker, { items: [{ materialId: material.body.id, requested: 1 }] })
  assert.equal(internal.status, 201, internal.text)
  const open = internal.body.id as string
  const refused = await put(`/warehouse/requests/${open}/delivery-forecast`, admin, { date: firstDate })
  assert.equal(refused.status, 403)
  const audit = await pool.query(
    `SELECT result FROM public.auth_audit_events WHERE action = 'access.denied' AND actor_user_id = $1 AND target_resource_id = $2`,
    [admin.id, open],
  )
  assert.deepEqual(audit.rows.map((row) => row.result), ['denied'])
  const unchanged = await call(`/warehouse/requests/${open}`, { session: admin })
  assert.equal(unchanged.body.request.deliveryForecast, null, 'a recusa não grava nada')

  // 7. Operador SLM da equipe executa a ação restrita pelo perfil, sem concessão manual.
  const slm = await staff('slm-p08@example.gov.br')
  const allowed = await put(`/warehouse/requests/${open}/delivery-forecast`, slm, { date: firstDate })
  assert.equal(allowed.status, 200, allowed.text)
  // Operador da SLM com a previsão retirada individualmente é recusado.
  const withoutForecast = await staff('slm-sem-previsao-p08@example.gov.br', ['warehouse:forecast'])
  assert.equal((await put(`/warehouse/requests/${open}/delivery-forecast`, withoutForecast, { date: secondDate, justification: 'Tentativa com a previsão retirada' })).status, 403)

  // 8. Usuário comum: nada administrativo, nem por concessão da previsão.
  const requester = await createUser('comum-p08@example.gov.br')
  const requesterPermissions = (await call('/auth/me', { session: requester })).body.user.permissions as string[]
  assert.equal(requesterPermissions.includes('warehouse:manage'), false)
  assert.equal(requesterPermissions.includes('warehouse:forecast'), false)
  assert.equal((await post('/warehouse/materials', requester, { name: 'Indevido', unitId })).status, 403)
  assert.equal((await call('/warehouse/stock', { session: requester })).status, 403)
  assert.equal((await put(`/warehouse/requests/${open}/delivery-forecast`, requester, { date: secondDate, justification: 'Indevido' })).status, 403)
  assert.equal(
    (await put(`/admin/users/${requester.id}/access`, admin, { role: 'requester', slmMember: false, grantedPermissions: ['warehouse:forecast'], deniedPermissions: [] })).status,
    400,
  )

  // 10. A tela recebe do servidor o mesmo catálogo que ele aplica: a previsão é restrita e só elegível na SLM.
  const catalog = (await call('/admin/permissions', { session: admin })).body
  assert.ok(catalog.restricted.includes('warehouse:forecast'))
  // Supercomando 17: a administração do Almoxarifado é restrita (fora de Solicitante e Motorista),
  // mas continua elegível ao administrador fora da SLM.
  assert.ok(catalog.restricted.includes('warehouse:manage'))
  const eligible = (role: string, slmMember: boolean) =>
    catalog.eligibility.find((entry: { role: string; slmMember: boolean }) => entry.role === role && entry.slmMember === slmMember).eligible as string[]
  assert.equal(eligible('administrator', false).includes('warehouse:forecast'), false)
  assert.equal(eligible('administrator', true).includes('warehouse:forecast'), true)
  assert.ok(eligible('administrator', false).includes('warehouse:manage'))
  assert.equal(eligible('requester', false).includes('warehouse:manage'), false)
})


test('setor: o solicitante consulta as solicitações do próprio setor, sem alterar; outro setor não vê', async () => {
  const author = await createUser('setor-autora@example.gov.br')
  const colleagueWithout = await createUser('setor-colega@example.gov.br')
  // Desligada por padrão: ligada só para esta pessoa, no cadastro.
  const granted = await call(`/admin/users/${colleagueWithout.id}/access`, {
    method: 'PUT',
    session: admin,
    body: { role: 'requester', slmMember: false, grantedPermissions: ['requests:read_sector'], deniedPermissions: [] },
  })
  assert.equal(granted.status, 200, granted.text)
  const colleague = await signIn('setor-colega@example.gov.br')
  const sameSectorWithout = await createUser('setor-sem-permissao@example.gov.br')
  const outsider = await createUser('setor-fora@example.gov.br')
  // Lotação sem setor na lista: não compartilha com ninguém.
  await pool.query(`UPDATE public.auth_users SET sector = 'Setor sem lista' WHERE id = $1`, [outsider.id])
  const outsiderAgain = await signIn('setor-fora@example.gov.br')

  const created = await post('/maintenance/requests', author, maintenanceBody('Tomada solta na copa do setor'))
  assert.equal(created.status, 201, created.text)
  const path = `/maintenance/requests/${created.body.id}`

  const seen = await call('/maintenance/requests?search=Tomada%20solta', { session: colleague })
  assert.equal(seen.status, 200)
  assert.ok(seen.body.requests.some((item: { id: string }) => item.id === created.body.id), 'colega vê na lista')
  assert.equal((await call(path, { session: colleague })).status, 200, 'colega abre')
  assert.notEqual((await post(`${path}/cancel`, colleague, { motivo: 'Tentativa de quem só consulta' })).status, 200, 'não cancela')
  assert.equal((await call(path, { session: sameSectorWithout })).status, 404, 'sem a permissão, nem do mesmo setor')

  const hidden = await call('/maintenance/requests?search=Tomada%20solta', { session: outsiderAgain })
  assert.ok(!hidden.body.requests.some((item: { id: string }) => item.id === created.body.id), 'outro setor não vê')
  assert.equal((await call(path, { session: outsiderAgain })).status, 404)
})
