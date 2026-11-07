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
import { detectKind } from '../attachments/fileValidation.js'
import { addDays } from '../demands/recurrence.js'
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { publishDeadlineAlerts } from './demandInsightsRepository.js'
import { generateDueOccurrences, todayInSaoPaulo } from './demandSeriesRepository.js'
import { setDatabasePoolForTests } from './pool.js'

// Controle de Demandas pela API real, em um PostgreSQL descartável. Nada sai da máquina.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')
const today = todayInSaoPaulo()
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')

let pool: Pool
let server: Server
let baseUrl: string
let directory: string
const csrfTokens = new Map<string, string>()

type Session = { cookie: string; id: string }

async function call(path: string, options: { method?: string; body?: unknown; session?: Session; raw?: Buffer; fileName?: string } = {}) {
  const method = options.method ?? 'GET'
  const cookie = options.session?.cookie
  const token = cookie && method !== 'GET' ? csrfTokens.get(cookie) : undefined
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      'content-type': options.raw ? 'application/octet-stream' : 'application/json',
      ...(options.fileName ? { 'x-file-name': encodeURIComponent(options.fileName) } : {}),
      ...(cookie ? { cookie } : {}),
      ...(token ? { 'x-csrf-token': token } : {}),
    },
    body: options.raw ? new Uint8Array(options.raw) : options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const buffer = Buffer.from(await response.arrayBuffer())
  const text = buffer.toString('utf8')
  const setCookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  let body: Record<string, any> = {} // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    body = JSON.parse(text)
  } catch {
    // Conteúdo de arquivo.
  }
  if (setCookie && body.csrfToken) csrfTokens.set(setCookie, body.csrfToken)
  return { status: response.status, body, text, buffer, setCookie, headers: response.headers }
}

const post = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'POST', session, body })
const patch = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'PATCH', session, body })
const put = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'PUT', session, body })
const get = (path: string, session: Session) => call(path, { session })

async function signIn(email: string): Promise<Session> {
  authRateLimits.loginPair.reset(`127.0.0.1|${email}`)
  authRateLimits.loginPair.reset(`::ffff:127.0.0.1|${email}`)
  authRateLimits.loginAccount.reset(email)
  const result = await call('/auth/login', { method: 'POST', body: { identifier: email, password } })
  assert.equal(result.status, 200, `login de ${email}`)
  return { cookie: result.setCookie, id: result.body.user.id }
}

let admin: Session

async function createUser(email: string): Promise<Session> {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { fullName: `Pessoa ${email.split('@')[0]}`, email, sector: 'Administração', password, passwordConfirmation: password },
  })
  assert.equal(registered.status, 202, registered.text)
  const pending = await get('/admin/registrations/pending', admin)
  const id = pending.body.registrations.find((item: { email: string }) => item.email === email).id
  assert.equal((await post(`/admin/registrations/${id}/approve`, admin, { role: 'requester' })).status, 200)
  return signIn(email)
}

async function grant(user: Session, grants: Permission[]) {
  const result = await put(`/admin/users/${user.id}/access`, admin, {
    role: 'requester',
    slmMember: false,
    grantedPermissions: grants,
    deniedPermissions: [],
  })
  assert.equal(result.status, 200, result.text)
}

let sectorA: string
let sectorB: string
let sectorC: string
let categoryId: string
let leadA: Session
let memberA: Session
let otherA: Session
let leadB: Session
let memberB: Session
let manager: Session
let outsider: Session

async function member(sectorId: string, user: Session, role: 'colaborador' | 'responsavel', extra: Record<string, unknown> = {}) {
  const result = await put(`/demands/settings/sectors/${sectorId}/members/${user.id}`, admin, { role, ...extra })
  assert.equal(result.status, 200, result.text)
}

function demandBody(extra: Record<string, unknown> = {}) {
  return {
    title: 'Levantamento de contratos',
    description: 'Levantar os contratos vigentes.',
    categoryId,
    originSectorId: sectorA,
    responsibleSectorId: sectorA,
    responsibleId: memberA.id,
    dueDate: addDays(today, 10),
    priority: 'alta',
    ...extra,
  }
}

async function createDemand(session: Session = leadA, extra: Record<string, unknown> = {}) {
  const created = await post('/demands', session, demandBody(extra))
  assert.equal(created.status, 201, created.text)
  return created.body as { id: string; number: string; firstDate: string | null }
}

const detail = async (id: string, session: Session = leadA) => {
  const result = await get(`/demands/${id}`, session)
  assert.equal(result.status, 200, result.text)
  return result.body
}

const seriesOccurrences = async (seriesId: string) =>
  (
    await pool.query<{ numero: string; data: string; status: string; responsavel: string | null }>(
      `SELECT numero, data_ocorrencia::text AS data, status, responsavel_id::text AS responsavel
         FROM public.demands WHERE series_id = $1 ORDER BY data_ocorrencia`,
      [seriesId],
    )
  ).rows

/** Antecipa a próxima execução, como se a data tivesse chegado. */
async function runUntil(date: string) {
  return generateDueOccurrences(date)
}

const notificationsOf = async (session: Session) => (await get('/notifications', session)).body.notifications as { message: string; title: string; link: string }[]

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'slm-demandas-'))
  process.env.ATTACHMENTS_DIR = directory
  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  for (const file of [
    '001_public_schema_snapshot.sql', '002_password_recovery.sql', '003_user_access.sql', '004_flight_passengers.sql',
    '005_operational_modules.sql', '006_integrations.sql', '007_operations_center.sql', '008_attachments.sql',
    '009_module_extensions.sql', '010_monitoring.sql', '011_delivery_forecast.sql', '012_operational_transparency.sql',
    '013_communications.sql',
  ]) {
    await pool.query(schema(file))
  }
  resetAccessSchemaCacheForTests()
  await pool.query(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'demandas-admin@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )
  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('demandas-admin@example.gov.br')
})

after(async () => {
  delete process.env.ATTACHMENTS_DIR
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
  rmSync(directory, { recursive: true, force: true })
})

test('sem a migração, o módulo fica oculto, sem erro, e a migração se desfaz enquanto vazia', async () => {
  const context = await get('/demands/context', admin)
  assert.equal(context.status, 200, context.text)
  assert.equal(context.body.migrated, false)
  assert.equal(context.body.hasAccess, false)
  assert.equal((await get('/demands', admin)).status, 503)

  await pool.query(schema('014_demands.sql'))
  // Só com a 014, o módulo ainda fica oculto: a 015 é necessária.
  assert.equal((await get('/demands/context', admin)).body.migrated, false)
  await pool.query(schema('015_organizational_structure.sql'))
  await pool.query(schema('015_organizational_structure.rollback.sql'))
  await pool.query(schema('014_demands.rollback.sql'))
  await pool.query(schema('014_demands.sql'))
  await pool.query(schema('015_organizational_structure.sql'))
  const seeded = await pool.query(`SELECT count(*)::int AS total FROM public.demand_categories`)
  assert.equal(seeded.rows[0].total, 10)
  const sectors = await pool.query(`SELECT count(*)::int AS total FROM public.demand_sectors`)
  assert.equal(sectors.rows[0].total, 0, 'nenhum setor fictício')
})

test('configuração: só quem tem a permissão cadastra setores, integrantes e categorias', async () => {
  outsider = await createUser('demandas-fora@example.gov.br')
  assert.equal((await post('/demands/settings/sectors', outsider, { name: 'Invadido' })).status, 403)
  assert.equal((await get('/demands/settings/categories', outsider)).status, 403)

  const create = async (name: string) => {
    const created = await post('/demands/settings/sectors', admin, { name })
    assert.equal(created.status, 201, created.text)
    return created.body.id as string
  }
  sectorA = await create('Setor Alfa')
  sectorB = await create('Setor Beta')
  sectorC = await create('Setor Gama')
  assert.equal((await post('/demands/settings/sectors', admin, { name: 'setor alfa' })).status, 409)

  leadA = await createUser('demandas-lider-a@example.gov.br')
  memberA = await createUser('demandas-membro-a@example.gov.br')
  otherA = await createUser('demandas-outro-a@example.gov.br')
  leadB = await createUser('demandas-lider-b@example.gov.br')
  memberB = await createUser('demandas-membro-b@example.gov.br')
  manager = await createUser('demandas-gestor@example.gov.br')

  await member(sectorA, leadA, 'responsavel')
  await member(sectorA, memberA, 'colaborador')
  await member(sectorA, otherA, 'colaborador')
  await member(sectorB, leadB, 'responsavel')
  await member(sectorB, memberB, 'colaborador')
  await grant(manager, ['demands:directorate'])

  const categories = await get('/demands/settings/categories', admin)
  categoryId = categories.body.categories[0].id

  const contextMember = await get('/demands/context', memberA)
  assert.equal(contextMember.body.hasAccess, true)
  assert.equal(contextMember.body.canSeeReports, false)
  assert.equal((await get('/demands/context', leadA)).body.canSeeReports, true)
  assert.equal((await get('/demands/context', manager)).body.directorate, true)
  assert.equal((await get('/demands/context', outsider)).body.hasAccess, false)
})

test('quem não tem nenhum vínculo não entra em nenhuma rota do módulo', async () => {
  const { id } = await createDemand()
  for (const path of ['/demands', '/demands/options', '/demands/dashboard', '/demands/preferences', `/demands/${id}`]) {
    assert.equal((await get(path, outsider)).status, 403, path)
  }
  assert.equal((await post('/demands', outsider, demandBody())).status, 403)
  assert.equal((await post(`/demands/${id}/comments`, outsider, { text: 'Oi' })).status, 403)
  assert.equal((await call('/demands')).status, 401)
})

test('cadastro individual e compartilhado, com número único, histórico e notificação', async () => {
  const first = await createDemand()
  const second = await createDemand()
  assert.match(first.number, /^DEM-\d{4}-\d{5}$/)
  assert.notEqual(first.number, second.number)

  const individual = await detail(first.id)
  assert.equal(individual.demand.status, 'nao_iniciada')
  assert.equal(individual.demand.requesterId, leadA.id, 'o solicitante vem da sessão')
  assert.equal(individual.demand.shared, false)
  assert.deepEqual(individual.history.map((item: { action: string }) => item.action), ['criada'])
  assert.ok((await notificationsOf(memberA)).some((item) => item.link === `/demandas/${first.id}`))

  const shared = await createDemand(leadA, {
    collaboratorSectorIds: [sectorB],
    collaborators: [{ userId: memberB.id, activity: 'Enviar dados contábeis', dueDate: addDays(today, 5) }],
  })
  const sharedDetail = await detail(shared.id)
  assert.equal(sharedDetail.demand.shared, true)
  assert.equal(sharedDetail.demand.responsibleId, memberA.id, 'a responsabilidade principal é preservada')
  assert.equal(sharedDetail.participants[0].activity, 'Enviar dados contábeis')
  assert.equal(sharedDetail.collaboratorSectors[0].name, 'Setor Beta')
  assert.equal((await get(`/demands/${shared.id}`, leadB)).status, 200)
  assert.equal((await get(`/demands/${first.id}`, leadB)).status, 404, 'outro setor não vê')

  const listed = await get('/demands?scope=shared', leadB)
  assert.ok(listed.body.demands.some((item: { id: string }) => item.id === shared.id))
})

test('validações do cadastro e origem restrita aos setores da pessoa', async () => {
  assert.equal((await post('/demands', leadA, { title: 'Só título' })).status, 400)
  assert.equal((await post('/demands', leadA, demandBody({ priority: 'maxima' }))).status, 400)
  assert.equal((await post('/demands', leadA, demandBody({ status: 'concluida' }))).status, 400)
  assert.equal((await post('/demands', leadA, demandBody({ status: 'suspensa' }))).status, 400)
  assert.equal((await post('/demands', leadA, demandBody({ status: 'aguardando_terceiros' }))).status, 400)
  assert.equal((await post('/demands', leadA, demandBody({ responsibleId: memberB.id }))).status, 400, 'responsável de outro setor')
  assert.equal((await post('/demands', leadA, demandBody({ originSectorId: sectorB }))).status, 403)
  assert.equal((await post('/demands', leadA, demandBody({ responsibleSectorId: sectorB, responsibleId: null }))).status, 403, 'para outro setor')
  assert.equal((await post('/demands', memberA, demandBody({ originSectorId: sectorB }))).status, 403)
  assert.equal((await post('/demands', memberA, demandBody({ responsibleSectorId: sectorB, responsibleId: null }))).status, 403)
  assert.equal((await post('/demands', otherA, demandBody())).status, 201, 'todo servidor cadastra para o próprio setor')
  assert.equal((await post('/demands', leadA, demandBody({ collaborators: [{ userId: memberB.id }] }))).status, 400, 'colaborador de setor fora da demanda')
  assert.equal((await post('/demands', leadA, demandBody({ collaborators: [{ userId: outsider.id }] }))).status, 400)
  const waiting = await createDemand(leadA, { status: 'aguardando_terceiros', waitingFor: 'Prefeitura' })
  assert.equal((await detail(waiting.id)).demand.waitingFor, 'Prefeitura')
})

test('rascunho: só quem criou vê; publicar exige os dados; descartar é lógico', async () => {
  const draft = await post('/demands', memberA, { title: 'Ideia inicial', draft: true })
  assert.equal(draft.status, 201, draft.text)
  const { id } = draft.body
  assert.equal((await get(`/demands/${id}`, leadA)).status, 404)
  assert.equal((await post(`/demands/${id}/publish`, memberA)).status, 400)

  // No rascunho, valem os mesmos setores do cadastro, também por chamada direta.
  assert.equal((await patch(`/demands/${id}`, memberA, { responsibleSectorId: sectorB })).status, 403)
  assert.equal((await patch(`/demands/${id}`, memberA, { originSectorId: sectorB })).status, 403)

  assert.equal(
    (await patch(`/demands/${id}`, memberA, {
      description: 'Agora completo',
      categoryId,
      originSectorId: sectorA,
      responsibleSectorId: sectorA,
      responsibleId: memberA.id,
    })).status,
    200,
  )
  assert.equal((await post(`/demands/${id}/publish`, memberA)).status, 200)
  assert.equal((await get(`/demands/${id}`, leadA)).status, 200)
  assert.equal((await post(`/demands/${id}/discard`, memberA)).status, 409, 'publicada não se descarta')

  const other = await post('/demands', memberA, { title: 'Descartável', draft: true })
  assert.equal((await post(`/demands/${other.body.id}/discard`, memberA, { reason: 'Não precisa' })).status, 200)
  assert.equal((await get(`/demands/${other.body.id}`, memberA)).status, 404)
  const stored = await pool.query(`SELECT excluida_em FROM public.demands WHERE id = $1`, [other.body.id])
  assert.ok(stored.rows[0].excluida_em, 'o registro continua no banco')
  await assert.rejects(pool.query(`DELETE FROM public.demands WHERE id = $1`, [other.body.id]))
})

test('rascunho com repetição cria a série só ao publicar', async () => {
  const draft = await post('/demands', memberA, demandBody({
    draft: true,
    dueDate: undefined,
    recurrence: { frequency: 'mensal', startDate: today, monthDays: [5, 20] },
  }))
  assert.equal(draft.status, 201, draft.text)
  assert.equal((await pool.query(`SELECT series_id FROM public.demands WHERE id = $1`, [draft.body.id])).rows[0].series_id, null)
  assert.equal((await post(`/demands/${draft.body.id}/publish`, memberA)).status, 200)
  const published = await detail(draft.body.id, memberA)
  assert.equal(published.demand.recurring, true)
  assert.ok(published.series)
})

test('servidor edita e distribui as demandas do próprio setor; outro setor nem as alcança', async () => {
  const { id } = await createDemand()
  assert.equal((await get(`/demands/${id}`, otherA)).status, 200, 'todo servidor vê o próprio setor')

  const peer = await detail(id, otherA)
  assert.equal(peer.access.edit, true, 'mesmo sem ser o responsável')
  assert.equal(peer.access.readOnly, false)
  assert.equal(peer.access.transfer, false)
  assert.equal((await patch(`/demands/${id}`, otherA, { dueDate: addDays(today, 20), title: 'Atualizada pelo servidor' })).status, 200)
  assert.equal((await post(`/demands/${id}/status`, otherA, { status: 'em_andamento' })).status, 200)
  assert.equal((await post(`/demands/${id}/assign`, otherA, { responsibleId: otherA.id, reason: 'Redistribuição' })).status, 200)
  assert.equal((await patch(`/demands/${id}`, otherA, { responsibleSectorId: sectorB })).status, 403, 'só o Diretor transfere')

  const updated = await detail(id)
  assert.equal(updated.demand.responsibleId, otherA.id)
  assert.ok(updated.history.some((item: { action: string; details: { de: string } }) => item.action === 'responsavel_alterado' && item.details.de.includes('membro-a')))

  assert.equal((await post(`/demands/${id}/assign`, leadA, { responsibleId: memberB.id })).status, 400)
  for (const session of [leadB, memberB]) {
    assert.equal((await patch(`/demands/${id}`, session, { title: 'Invasão' })).status, 404)
    assert.equal((await post(`/demands/${id}/assign`, session, { responsibleId: null })).status, 404)
  }

  // Setor colaborador também edita, sem poder transferir a demanda.
  const shared = await createDemand(leadA, { collaboratorSectorIds: [sectorB] })
  assert.equal((await detail(shared.id, memberB)).access.edit, true)
  assert.equal((await detail(shared.id, memberB)).access.transfer, false)
  assert.equal((await patch(`/demands/${shared.id}`, memberB, { title: 'Ajustada pelo setor colaborador' })).status, 200)
  assert.equal((await patch(`/demands/${shared.id}`, memberB, { responsibleSectorId: sectorB })).status, 403)
})

test('status, suspensão, terceiros, conclusão com etapas e reabertura', async () => {
  const { id } = await createDemand()
  assert.equal((await post(`/demands/${id}/status`, leadA, { status: 'suspensa' })).status, 400)
  assert.equal(
    (await post(`/demands/${id}/status`, leadA, { status: 'suspensa', suspensionReason: 'Aguardando orçamento', resumeDate: addDays(today, 20) })).status,
    200,
  )
  assert.equal((await detail(id)).demand.resumeDate, addDays(today, 20))
  assert.equal((await post(`/demands/${id}/status`, leadA, { status: 'aguardando_terceiros', waitingFor: 'Fornecedor X' })).status, 200)
  const waiting = await detail(id)
  assert.equal(waiting.demand.waitingFor, 'Fornecedor X')
  assert.equal(waiting.demand.suspensionReason, null)
  assert.equal((await post(`/demands/${id}/status`, leadA, { status: 'concluida' })).status, 400, 'concluir tem rota própria')
  assert.equal((await post(`/demands/${id}/status`, leadA, { status: 'em_andamento' })).status, 200)

  const subtask = await post(`/demands/${id}/subtasks`, leadA, {
    title: 'Coletar dados', responsibleId: memberA.id, dueDate: addDays(today, 2), description: 'Planilhas', notes: 'Rápido',
  })
  assert.equal(subtask.status, 201, subtask.text)
  const second = await post(`/demands/${id}/subtasks`, leadA, { title: 'Consolidar', responsibleId: otherA.id })

  assert.equal((await post(`/demands/${id}/complete`, leadA, { done: 'Tudo feito' })).status, 409, 'etapas em aberto')

  assert.equal((await patch(`/demands/${id}/subtasks/${second.body.id}`, otherA, { status: 'concluida', notes: 'Pronto' })).status, 200)
  assert.equal((await patch(`/demands/${id}/subtasks/${subtask.body.id}`, leadA, { status: 'em_andamento' })).status, 200)

  const halfway = await detail(id)
  assert.equal(halfway.demand.progress, 50)
  assert.equal(halfway.demand.status, 'em_andamento')
  assert.equal((await patch(`/demands/${id}/subtasks/${subtask.body.id}`, leadA, { status: 'concluida' })).status, 200)
  const allDone = await detail(id)
  assert.equal(allDone.demand.progress, 100)
  assert.equal(allDone.demand.status, 'em_andamento', 'concluir as etapas não encerra a demanda')

  assert.equal((await post(`/demands/${id}/complete`, leadA, {})).status, 400, 'exige o que foi realizado')
  assert.equal(
    (await post(`/demands/${id}/complete`, leadA, { done: 'Levantamento entregue', result: 'Relatório aprovado', notes: 'Sem pendências' })).status,
    200,
  )
  const done = await detail(id)
  assert.equal(done.demand.status, 'concluida')
  assert.equal(done.demand.completion.done, 'Levantamento entregue')
  assert.ok(done.demand.completion.by.includes('lider-a'))
  assert.equal((await post(`/demands/${id}/status`, leadA, { status: 'em_andamento' })).status, 409)
  assert.equal((await patch(`/demands/${id}`, leadA, { title: 'Novo título' })).status, 409)

  assert.equal((await post(`/demands/${id}/reopen`, leadA, {})).status, 400, 'exige justificativa')
  assert.equal((await post(`/demands/${id}/reopen`, leadA, { reason: 'Faltou um anexo' })).status, 200)
  const reopened = await detail(id)
  assert.equal(reopened.demand.status, 'em_andamento')
  assert.equal(reopened.demand.reopenings, 1)
  assert.equal(reopened.demand.completion, null)
  const entry = reopened.history.find((item: { action: string }) => item.action === 'reaberta')
  assert.equal(entry.comment, 'Faltou um anexo')
  assert.equal(entry.details.conclusaoAnterior.realizado, 'Levantamento entregue')
  assert.ok(reopened.history.some((item: { action: string }) => item.action === 'concluida'), 'a conclusão anterior continua no histórico')

  assert.equal((await post(`/demands/${id}/cancel`, leadA, {})).status, 400)
  assert.equal((await post(`/demands/${id}/cancel`, leadA, { reason: 'Não será mais necessária' })).status, 200)
  assert.equal((await detail(id)).demand.status, 'cancelada')
  assert.equal((await post(`/demands/${id}/reopen`, leadA, { reason: 'Quero reabrir' })).status, 409)
  assert.equal((await get(`/demands/${id}`, manager)).status, 200, 'cancelada segue disponível à consulta')
})

test('histórico registra cada alteração e não pode ser alterado', async () => {
  const { id } = await createDemand()
  const current = await detail(id)
  assert.equal(
    (await patch(`/demands/${id}`, leadA, {
      version: current.demand.version,
      description: 'Descrição nova',
      dueDate: addDays(today, 30),
      priority: 'urgente',
    })).status,
    200,
  )
  const actions = (await detail(id)).history.map((item: { action: string }) => item.action)
  for (const action of ['criada', 'descricao_alterada', 'prazo_alterado', 'prioridade_alterada']) {
    assert.ok(actions.includes(action), action)
  }
  const history = (await detail(id)).history
  assert.ok(history.every((item: { at: string }) => item.at))
  assert.ok(history.some((item: { user: string }) => item.user?.includes('lider-a')))

  await assert.rejects(pool.query(`UPDATE public.demand_history SET acao = 'x' WHERE demand_id = $1`, [id]))
  await assert.rejects(pool.query(`DELETE FROM public.demand_history WHERE demand_id = $1`, [id]))
})

type HistoryItem = { id: string; action: string; details: Record<string, any>; user: string | null; at: string } // eslint-disable-line @typescript-eslint/no-explicit-any

test('histórico detalha campo, valor anterior, novo valor e autor, sem registros falsos', async () => {
  const { id } = await createDemand()
  const history = async () => (await detail(id)).history as HistoryItem[]
  const newSince = async (count: number) => (await history()).slice(count)
  const version = async () => (await detail(id)).demand.version as number

  // 1. Prazo: anterior e novo.
  let seen = (await history()).length
  assert.equal((await patch(`/demands/${id}`, leadA, { version: await version(), dueDate: addDays(today, 12) })).status, 200)
  let added = await newSince(seen)
  assert.equal(added.length, 1)
  assert.equal(added[0].action, 'prazo_alterado')
  assert.equal(added[0].details.campo, 'prazo')
  assert.equal(added[0].details.de, addDays(today, 10))
  assert.equal(added[0].details.para, addDays(today, 12))
  assert.ok(added[0].user?.includes('lider-a'), 'autor do registro')
  assert.ok(added[0].at)

  // 2. Responsável: quem saiu e quem entrou, com o autor correto.
  seen = (await history()).length
  assert.equal((await post(`/demands/${id}/assign`, otherA, { responsibleId: otherA.id, reason: 'Redistribuição' })).status, 200)
  added = await newSince(seen)
  assert.equal(added.length, 1)
  assert.equal(added[0].action, 'responsavel_alterado')
  assert.ok(added[0].details.de.includes('membro-a'))
  assert.ok(added[0].details.para.includes('outro-a'))
  assert.ok(added[0].user?.includes('outro-a'), 'quem redistribuiu')

  // 3. Status: os dois valores.
  seen = (await history()).length
  assert.equal((await post(`/demands/${id}/status`, leadA, { status: 'em_andamento' })).status, 200)
  added = await newSince(seen)
  assert.equal(added.length, 1)
  assert.equal(added[0].action, 'status_alterado')
  assert.equal(added[0].details.de, 'nao_iniciada')
  assert.equal(added[0].details.para, 'em_andamento')

  // 6. Vários campos de uma vez: um registro por campo, cada um com os dois valores.
  const categories = (await get('/demands/settings/categories', admin)).body.categories as { id: string; name: string }[]
  const otherCategory = categories.find((item) => item.id !== categoryId) as { id: string; name: string }
  seen = (await history()).length
  assert.equal(
    (await patch(`/demands/${id}`, leadA, {
      version: await version(),
      title: 'Levantamento revisado',
      description: 'Levantar os contratos vigentes e vencidos.',
      priority: 'urgente',
      startDate: addDays(today, 1),
      reminderDays: 5,
      notes: 'Conferir com o jurídico',
      categoryId: otherCategory.id,
    })).status,
    200,
  )
  added = await newSince(seen)
  const byField = new Map(added.map((item) => [item.details.campo as string, item]))
  assert.equal(added.length, 7, added.map((item) => item.details.campo).join(', '))
  assert.equal(byField.get('titulo')?.action, 'campo_alterado')
  assert.equal(byField.get('titulo')?.details.de, 'Levantamento de contratos')
  assert.equal(byField.get('titulo')?.details.para, 'Levantamento revisado')
  assert.equal(byField.get('descricao')?.action, 'descricao_alterada')
  assert.equal(byField.get('descricao')?.details.de, 'Levantar os contratos vigentes.')
  assert.equal(byField.get('prioridade')?.details.de, 'alta')
  assert.equal(byField.get('prioridade')?.details.para, 'urgente')
  assert.equal(byField.get('inicioPrevisto')?.details.de, null)
  assert.equal(byField.get('inicioPrevisto')?.details.para, addDays(today, 1))
  assert.equal(byField.get('lembreteDias')?.details.para, 5)
  assert.equal(byField.get('observacoes')?.details.para, 'Conferir com o jurídico')
  assert.equal(byField.get('categoria')?.details.para, otherCategory.name, 'categoria pelo nome')
  assert.equal(byField.get('categoria')?.details.paraId, otherCategory.id)
  assert.ok(added.every((item) => item.user?.includes('lider-a')))
  assert.equal(added.some((item) => item.action === 'dados_alterados'), false, 'nada de "N campo(s)"')

  // A auditoria geral registra qual campo mudou, sem copiar texto livre.
  const audit = await pool.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM public.auth_audit_events WHERE action = 'demand.changed' AND target_resource_id = $1`,
    [id],
  )
  const titleAudit = audit.rows.find((item) => Array.isArray(item.details.campos) && item.details.campos.includes('titulo'))
  assert.ok(titleAudit, 'o campo alterado chega à auditoria geral')
  assert.ok(!JSON.stringify(titleAudit).includes('Levantamento revisado'), 'sem o texto do título')

  // 7. Reenviar os mesmos valores não cria registro.
  seen = (await history()).length
  assert.equal(
    (await patch(`/demands/${id}`, leadA, {
      version: await version(),
      title: 'Levantamento revisado',
      priority: 'urgente',
      dueDate: addDays(today, 12),
      reminderDays: 5,
      categoryId: otherCategory.id,
    })).status,
    200,
  )
  assert.equal((await history()).length, seen, 'sem evento falso')
  assert.equal((await post(`/demands/${id}/status`, leadA, { status: 'em_andamento' })).status, 200)
  assert.equal((await history()).length, seen, 'mesmo status também não registra')

  // 4 e 5. Colaboradores e setores, um registro por pessoa ou setor.
  const collaboration = (body: Record<string, unknown>) => put(`/demands/${id}/collaboration`, leadA, body)
  seen = (await history()).length
  assert.equal(
    (await collaboration({ collaborators: [{ userId: memberA.id, activity: 'Revisar', dueDate: null }], collaboratorSectorIds: [sectorB] })).status,
    200,
  )
  added = await newSince(seen)
  assert.deepEqual(added.map((item) => item.action).sort(), ['colaborador_adicionado', 'setor_colaborador_adicionado'])
  const addedPerson = added.find((item) => item.action === 'colaborador_adicionado') as HistoryItem
  assert.ok(addedPerson.details.pessoa.includes('membro-a'))
  assert.equal(addedPerson.details.pessoaId, memberA.id)
  assert.equal(addedPerson.details.atividade, 'Revisar')
  assert.equal(added.find((item) => item.action === 'setor_colaborador_adicionado')?.details.setor, 'Setor Beta')

  seen = (await history()).length
  assert.equal(
    (await collaboration({
      collaborators: [{ userId: memberA.id, activity: 'Revisar e enviar', dueDate: null }, { userId: memberB.id, activity: null, dueDate: null }],
      collaboratorSectorIds: [sectorB, sectorC],
    })).status,
    200,
  )
  added = await newSince(seen)
  assert.deepEqual(added.map((item) => item.action).sort(), ['colaborador_adicionado', 'colaborador_alterado', 'setor_colaborador_adicionado'])
  const changedPerson = added.find((item) => item.action === 'colaborador_alterado') as HistoryItem
  assert.deepEqual(changedPerson.details.alteracoes, [{ campo: 'atividade', de: 'Revisar', para: 'Revisar e enviar' }])
  assert.ok(added.find((item) => item.action === 'colaborador_adicionado')?.details.pessoa.includes('membro-b'))
  assert.equal(added.find((item) => item.action === 'setor_colaborador_adicionado')?.details.setor, 'Setor Gama')

  seen = (await history()).length
  const final = { collaborators: [{ userId: memberB.id, activity: null, dueDate: null }], collaboratorSectorIds: [sectorB] }
  assert.equal((await collaboration(final)).status, 200)
  added = await newSince(seen)
  assert.deepEqual(added.map((item) => item.action).sort(), ['colaborador_removido', 'setor_colaborador_removido'])
  assert.ok(added.find((item) => item.action === 'colaborador_removido')?.details.pessoa.includes('membro-a'))
  assert.equal(added.find((item) => item.action === 'setor_colaborador_removido')?.details.setor, 'Setor Gama')
  assert.ok(added.every((item) => item.user?.includes('lider-a')))

  seen = (await history()).length
  assert.equal((await collaboration(final)).status, 200)
  assert.equal((await history()).length, seen, 'mesma colaboração não registra')
  assert.equal((await history()).some((item) => item.action === 'colaboracao_alterada'), false)

  // 8 e 9. Os registros anteriores continuam iguais; ninguém os altera pela API nem pelo banco.
  const before = await history()
  const entry = before[1]
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    for (const session of [leadA, admin]) {
      const attempt = await call(`/demands/${id}/history/${entry.id}`, { method, session, body: { action: 'x' } })
      assert.ok([403, 404, 405].includes(attempt.status), `${method} no histórico: ${attempt.status}`)
    }
  }
  await assert.rejects(pool.query(`UPDATE public.demand_history SET detalhes = '{}' WHERE id = $1`, [entry.id]))
  await assert.rejects(pool.query(`DELETE FROM public.demand_history WHERE id = $1`, [entry.id]))
  assert.deepEqual(await history(), before, 'nenhum registro mudou ou sumiu')
  assert.equal(before[0].action, 'criada')
})

test('alteração simultânea: a versão antiga é recusada', async () => {
  const { id } = await createDemand()
  const version = (await detail(id)).demand.version
  assert.equal((await patch(`/demands/${id}`, leadA, { version, title: 'Edição de quem chegou primeiro' })).status, 200)
  assert.equal((await patch(`/demands/${id}`, manager, { version, title: 'Edição atrasada' })).status, 409)
  assert.equal((await post(`/demands/${id}/status`, manager, { status: 'em_andamento', version })).status, 409)

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) => post(`/demands/${id}/comments`, leadA, { text: `Comentário ${index}` })),
  )
  assert.ok(results.every((item) => item.status === 201))
  assert.equal((await detail(id)).comments.length, 5)
})

test('comentários, menções e aviso único para uma conversa em andamento', async () => {
  const { id } = await createDemand()
  // A lista de avisos tem teto: conta só os desta demanda, os mais recentes.
  const noticesHere = async () => (await notificationsOf(memberA)).filter((item) => item.link === `/demandas/${id}`).length
  const before = await noticesHere()
  assert.equal((await post(`/demands/${id}/comments`, leadA, { text: 'Primeiro', kind: 'providencia' })).status, 201)
  assert.equal((await post(`/demands/${id}/comments`, leadA, { text: 'Segundo', kind: 'andamento' })).status, 201)
  assert.equal(await noticesHere(), before + 1, 'dois comentários seguidos geram um aviso')

  assert.equal((await post(`/demands/${id}/comments`, leadA, { text: 'Oi', mentions: [outsider.id] })).status, 400)
  assert.equal((await post(`/demands/${id}/comments`, leadA, { text: 'De fora', mentions: [memberB.id] })).status, 400, 'outro setor não é mencionado')
  const mention = await post(`/demands/${id}/comments`, leadA, { text: 'Veja isto', mentions: [otherA.id] })
  assert.equal(mention.status, 201, mention.text)
  assert.ok((await notificationsOf(otherA)).some((item) => item.message.includes('mencionado')))
  const comments = (await detail(id)).comments
  assert.deepEqual(comments.map((item: { kind: string }) => item.kind), ['providencia', 'andamento', 'comentario'])
  assert.equal(comments[2].mentions.length, 1)
  await assert.rejects(pool.query(`UPDATE public.demand_comments SET texto = 'x' WHERE demand_id = $1`, [id]))

  // Quem silencia um tipo de aviso deixa de recebê-lo.
  assert.equal((await put('/demands/preferences', memberA, { reminderDays: 5, muted: ['status'], email: true })).status, 200)
  assert.deepEqual((await get('/demands/preferences', memberA)).body.preferences, { reminderDays: 5, muted: ['status'], email: true })
  const silent = await noticesHere()
  await post(`/demands/${id}/status`, leadA, { status: 'em_andamento' })
  assert.equal(await noticesHere(), silent)
  await put('/demands/preferences', memberA, { reminderDays: 3, muted: [], email: false })
})

test('demanda restrita não aparece em lista, pesquisa, painel, relatório, agenda nem pela API', async () => {
  const secret = 'Sindicância confidencial'
  const { id, number } = await createDemand(leadA, {
    title: secret,
    restricted: true,
    responsibleId: leadA.id,
    authorizedUserIds: [otherA.id],
    dueDate: today,
  })

  // Servidor do setor sem envolvimento nominal e pessoas de outros setores não a alcançam.
  for (const session of [memberA, leadB, memberB]) {
    assert.equal((await get(`/demands/${id}`, session)).status, 404)
    assert.equal((await post(`/demands/${id}/comments`, session, { text: 'Intruso' })).status, 404)
    assert.equal((await post(`/demands/${id}/status`, session, { status: 'em_andamento' })).status, 404)
    assert.equal((await post(`/demands/${id}/complete`, session, { done: 'Encerrando' })).status, 404)

    for (const path of [
      `/demands?q=${encodeURIComponent(secret)}`,
      `/demands?q=${number}`,
      '/demands?pageSize=200',
      '/demands/dashboard',
      `/demands/agenda?from=${today}&to=${today}`,
      '/notifications',
    ]) {
      const response = await get(path, session)
      assert.equal(response.status, 200, `${path}: ${response.text}`)
      assert.ok(!response.text.includes(secret), `${path} vazou o título`)
      assert.ok(!response.text.includes(number), `${path} vazou o número`)
    }
  }
  assert.equal((await get(`/demands/${id}`, manager)).status, 200, 'o Diretor vê todas')
  const managerReport = await get(`/demands/reports/export?format=xlsx`, manager)
  assert.equal(managerReport.status, 200)
  assert.equal(detectKind(managerReport.buffer), 'xlsx')

  const authorized = await get(`/demands/${id}`, otherA)
  assert.equal(authorized.status, 200, 'autorizada do setor lê')
  assert.equal(authorized.body.demand.title, secret)
  assert.ok((await get('/demands?pageSize=200', otherA)).text.includes(secret))
  assert.ok((await get('/demands?pageSize=200', leadA)).text.includes(secret))

  // A notificação de demanda restrita não traz o título.
  const notes = await pool.query(
    `SELECT n.message FROM public.user_notifications n
       JOIN public.integration_events e ON e.id = n.event_id WHERE e.resource_id = $1`,
    [id],
  )
  assert.ok(notes.rows.every((row) => !row.message.includes(secret)))

  // Restringir depois: quem só acompanhava perde o acesso; quem restringiu continua.
  const open = await createDemand()
  await post(`/demands/${open.id}/comments`, leadA, { text: 'Acompanhe', mentions: [otherA.id] })
  assert.equal((await get(`/demands/${open.id}`, otherA)).status, 200)
  assert.equal((await patch(`/demands/${open.id}`, leadA, { restricted: true })).status, 200)
  assert.equal((await get(`/demands/${open.id}`, otherA)).status, 404)
  assert.equal((await get(`/demands/${open.id}`, manager)).status, 200)
  assert.equal((await get(`/demands/${open.id}`, leadA)).status, 200)
  const audit = await pool.query(`SELECT 1 FROM public.auth_audit_events WHERE action = 'demand.restriction_changed' AND target_resource_id = $1`, [open.id])
  assert.equal(audit.rowCount, 1)
})

test('a permissão de diretor dá o mesmo que o papel; o colaborador não abre relatórios', async () => {
  const { id } = await createDemand()
  const seen = await detail(id, manager)
  assert.equal(seen.access.edit, true)
  assert.equal((await post(`/demands/${id}/status`, manager, { status: 'em_andamento' })).status, 200)
  assert.equal((await post('/demands', manager, demandBody())).status, 201)
  assert.equal((await get('/demands/reports', manager)).status, 200)
  assert.equal((await get('/demands/reports', memberA)).status, 403, 'colaborador não abre relatórios')
  assert.equal((await get('/demands/reports', leadA)).status, 200)
})

test('recorrência mensal com duas datas gera demandas independentes, e reprocessar não duplica', async () => {
  const first = addDays(today, 1)
  const created = await createDemand(leadA, {
    title: 'Pagamento quinzenal do RH',
    dueDate: undefined,
    recurrence: {
      frequency: 'personalizada',
      unit: 'mes',
      interval: 1,
      monthDays: [5, 20],
      startDate: first,
      end: { type: 'quantidade', count: 4 },
    },
  })
  assert.ok(created.firstDate)
  const opened = await detail(created.id)
  assert.equal(opened.demand.dueDate, created.firstDate)
  assert.equal(opened.series.counted, 1)
  assert.equal(opened.series.upcoming.length, 3)
  const seriesId = opened.series.id

  const farAhead = addDays(today, 120)
  await Promise.all([runUntil(farAhead), runUntil(farAhead), runUntil(farAhead)])
  await runUntil(farAhead)
  const all = await seriesOccurrences(seriesId)
  assert.equal(all.length, 4, 'exatamente a quantidade pedida')
  assert.equal(new Set(all.map((item) => item.numero)).size, 4)
  assert.equal(new Set(all.map((item) => item.data)).size, 4)
  for (const item of all) assert.ok(['05', '20'].includes(item.data.slice(8, 10)) || item.data.slice(8, 10) === '20')

  const series = await pool.query(`SELECT status, proxima_execucao, ocorrencias_contadas FROM public.demand_series WHERE id = $1`, [seriesId])
  assert.equal(series.rows[0].status, 'encerrada')
  assert.equal(series.rows[0].proxima_execucao, null)
  assert.equal(series.rows[0].ocorrencias_contadas, 4)

  // Cada ocorrência vive sozinha: concluir uma não mexe nas outras.
  const ids = await pool.query<{ id: string }>(`SELECT id::text AS id FROM public.demands WHERE series_id = $1 ORDER BY data_ocorrencia`, [seriesId])
  assert.equal((await post(`/demands/${ids.rows[0].id}/complete`, leadA, { done: 'Pagamento realizado' })).status, 200)
  const after = await seriesOccurrences(seriesId)
  assert.equal(after[0].status, 'concluida')
  assert.ok(after.slice(1).every((item) => item.status === 'nao_iniciada'))
  const second = await detail(ids.rows[1].id)
  assert.equal(second.demand.number, all[1].numero)
  assert.ok(second.history.some((item: { action: string }) => item.action === 'ocorrencia_gerada'))
  assert.equal(second.history.some((item: { action: string }) => item.action === 'concluida'), false)

  await assert.rejects(
    pool.query(`UPDATE public.demands SET data_ocorrencia = $2 WHERE id = $1`, [ids.rows[1].id, all[0].data]),
    'a chave única impede duas demandas na mesma data',
  )
})

test('frequências semanal e quinzenal, encerramento por data, e nada antes da hora', async () => {
  const weekly = await createDemand(leadA, {
    title: 'Conferência semanal',
    dueDate: undefined,
    recurrence: { frequency: 'semanal', startDate: today, end: { type: 'data', date: addDays(today, 15) } },
  })
  const weeklySeries = (await detail(weekly.id)).series
  assert.equal(weeklySeries.nextExecution, addDays(today, 7))
  assert.equal(await generatedFor(weeklySeries.id, today), 1, 'a próxima data ainda não chegou')
  await runUntil(addDays(today, 30))
  const weeklyDates = (await seriesOccurrences(weeklySeries.id)).map((item) => item.data)
  assert.deepEqual(weeklyDates, [today, addDays(today, 7), addDays(today, 14)])
  assert.equal(
    (await pool.query(`SELECT status FROM public.demand_series WHERE id = $1`, [weeklySeries.id])).rows[0].status,
    'encerrada',
  )

  const fortnight = await createDemand(leadA, {
    title: 'Conferência quinzenal',
    dueDate: undefined,
    recurrence: { frequency: 'quinzenal', startDate: today, leadDays: 2, end: { type: 'quantidade', count: 3 } },
  })
  const fortnightSeries = (await detail(fortnight.id)).series
  assert.equal(fortnightSeries.nextExecution, addDays(today, 15))
  // Com dois dias de antecedência, a ocorrência do dia 15 nasce no dia 13.
  await runUntil(addDays(today, 12))
  assert.equal((await seriesOccurrences(fortnightSeries.id)).length, 1)
  await runUntil(addDays(today, 13))
  assert.equal((await seriesOccurrences(fortnightSeries.id)).length, 2)
  await runUntil(addDays(today, 90))
  assert.deepEqual((await seriesOccurrences(fortnightSeries.id)).map((item) => item.data), [today, addDays(today, 15), addDays(today, 30)])
})

async function generatedFor(seriesId: string, date: string) {
  await runUntil(date)
  return (await seriesOccurrences(seriesId)).length
}

test('suspender, retomar, pular, cancelar e editar uma ou as futuras ocorrências', async () => {
  const created = await createDemand(leadA, {
    title: 'Rotina diária',
    dueDate: undefined,
    recurrence: { frequency: 'diaria', startDate: today },
  })
  const seriesId = (await detail(created.id)).series.id

  // Suspensa, não gera.
  assert.equal((await post(`/demands/${created.id}/series/suspend`, memberB, { reason: 'Sem acesso' })).status, 404)
  assert.equal((await post(`/demands/${created.id}/series/suspend`, leadA, {})).status, 400)
  assert.equal((await post(`/demands/${created.id}/series/suspend`, leadA, { reason: 'Férias do setor' })).status, 200)
  await runUntil(addDays(today, 5))
  assert.equal((await seriesOccurrences(seriesId)).length, 1)

  // Retomada: o período suspenso não é gerado depois.
  assert.equal((await post(`/demands/${created.id}/series/resume`, leadA)).status, 200)
  await runUntil(addDays(today, 2))
  const afterResume = await seriesOccurrences(seriesId)
  assert.deepEqual(afterResume.map((item) => item.data), [today, addDays(today, 1), addDays(today, 2)])
  const secondId = (await pool.query(`SELECT id::text AS id FROM public.demands WHERE series_id = $1 AND data_ocorrencia = $2`, [seriesId, addDays(today, 1)])).rows[0].id
  const thirdId = (await pool.query(`SELECT id::text AS id FROM public.demands WHERE series_id = $1 AND data_ocorrencia = $2`, [seriesId, addDays(today, 2)])).rows[0].id

  // Pular uma data futura, que nunca vira demanda.
  const skippedDate = addDays(today, 3)
  assert.equal((await post(`/demands/${created.id}/series/skip`, leadA, { date: skippedDate, reason: 'Feriado' })).status, 200)
  assert.equal((await post(`/demands/${created.id}/series/skip`, leadA, { date: skippedDate, reason: 'De novo' })).status, 409)
  await runUntil(addDays(today, 4))
  const dates = (await seriesOccurrences(seriesId)).map((item) => item.data)
  assert.ok(!dates.includes(skippedDate))
  assert.ok(dates.includes(addDays(today, 4)))

  // Pular uma ocorrência já gerada mantém o registro, cancelado.
  assert.equal((await post(`/demands/${secondId}/series/skip`, leadA, { reason: 'Não haverá expediente' })).status, 200)
  const skipped = await detail(secondId)
  assert.equal(skipped.demand.status, 'cancelada')
  assert.ok(skipped.demand.cancellation.reason.includes('pulada'))

  // Só esta: as demais continuam iguais.
  const fourthId = (await pool.query(`SELECT id::text AS id FROM public.demands WHERE series_id = $1 AND data_ocorrencia = $2`, [seriesId, addDays(today, 4)])).rows[0].id
  assert.equal((await patch(`/demands/${thirdId}`, leadA, { title: 'Rotina especial', priority: 'urgente', scope: 'this' })).status, 200)
  assert.equal((await detail(thirdId)).demand.customOccurrence, true)
  assert.equal((await detail(fourthId)).demand.title, 'Rotina diária')

  // Esta e as futuras: também as próximas, mas sem mudar os prazos individuais nem o passado.
  const fourthDue = (await detail(fourthId)).demand.dueDate
  assert.equal(
    (await patch(`/demands/${thirdId}`, leadA, { title: 'Rotina revisada', priority: 'baixa', dueDate: addDays(today, 40), scope: 'future' })).status,
    200,
  )
  const fourth = await detail(fourthId)
  assert.equal(fourth.demand.title, 'Rotina revisada')
  assert.equal(fourth.demand.priority, 'baixa')
  assert.equal(fourth.demand.dueDate, fourthDue)
  assert.ok(fourth.history.some((item: { action: string }) => item.action === 'alterada_em_serie'))
  assert.equal((await detail(created.id)).demand.title, 'Rotina diária', 'a anterior não muda')
  assert.equal((await detail(thirdId)).demand.dueDate, addDays(today, 40))

  await runUntil(addDays(today, 5))
  const newest = (await pool.query(`SELECT titulo, prioridade FROM public.demands WHERE series_id = $1 AND data_ocorrencia = $2`, [seriesId, addDays(today, 5)])).rows[0]
  assert.deepEqual(newest, { titulo: 'Rotina revisada', prioridade: 'baixa' }, 'novas ocorrências seguem o modelo atualizado')

  // Trocar o responsável das futuras.
  assert.equal((await post(`/demands/${fourthId}/assign`, leadA, { responsibleId: otherA.id, scope: 'future' })).status, 200)
  await runUntil(addDays(today, 6))
  const reassigned = await seriesOccurrences(seriesId)
  assert.equal(reassigned[reassigned.length - 1].responsavel, otherA.id)

  // Mudar a regra daqui em diante.
  assert.equal(
    (await post(`/demands/${fourthId}/series/rule`, leadA, { frequency: 'semanal', startDate: addDays(today, 10), leadDays: 0 })).status,
    200,
  )
  const ruled = (await detail(fourthId)).series
  assert.equal(ruled.nextExecution, addDays(today, 10))
  assert.equal(ruled.frequency, 'semanal')
  assert.ok((await detail(fourthId)).history.some((item: { action: string }) => item.action === 'recorrencia_alterada'))

  // Cancelar a série não apaga nada do que existe.
  const before = await seriesOccurrences(seriesId)
  assert.equal((await post(`/demands/${fourthId}/series/cancel`, leadA, { reason: 'Rotina extinta' })).status, 200)
  await runUntil(addDays(today, 60))
  const afterCancel = await seriesOccurrences(seriesId)
  assert.equal(afterCancel.length, before.length)
  assert.deepEqual(afterCancel, before)
  assert.ok((await detail(created.id)).history.some((item: { action: string }) => item.action === 'recorrencia_criada'))
  assert.equal((await post(`/demands/${fourthId}/series/resume`, leadA)).status, 409)
})

test('a previsão mostra só o que ainda vai acontecer, e retomar não volta para uma data já gerada', async () => {
  const start = addDays(today, 1)
  const created = await createDemand(leadA, {
    title: 'Previsão sem repetição',
    dueDate: undefined,
    recurrence: { frequency: 'semanal', startDate: start },
  })
  const opened = await detail(created.id)
  const [next, afterNext] = opened.series.upcoming as string[]
  const projected = async () =>
    ((await get(`/demands/agenda?from=${today}&to=${addDays(today, 40)}`, leadA)).body.items as { kind: string; title: string; date: string }[])
      .filter((item) => item.title === 'Previsão sem repetição')

  // A data já gerada aparece uma vez, como prazo, e nunca também como previsão.
  const first = (await projected()).filter((item) => item.date === start)
  assert.deepEqual(first.map((item) => item.kind), ['prazo'])

  // Retomar antes da data da primeira ocorrência não volta o controle para ela.
  await post(`/demands/${created.id}/series/suspend`, leadA, { reason: 'Pausa curta' })
  await post(`/demands/${created.id}/series/resume`, leadA)
  assert.equal((await detail(created.id)).series.nextExecution, next)

  // A data pulada some da previsão e deixa de ser a próxima execução.
  assert.equal((await post(`/demands/${created.id}/series/skip`, leadA, { date: next, reason: 'Feriado' })).status, 200)
  assert.equal((await detail(created.id)).series.nextExecution, afterNext)
  assert.ok(!(await projected()).some((item) => item.date === next))
  assert.ok((await projected()).some((item) => item.date === afterNext && item.kind === 'recorrencia'))

  await runUntil(next)
  assert.deepEqual((await seriesOccurrences(opened.series.id)).map((item) => item.data), [start])
})

test('pular a última data de uma quantidade encerra a série', async () => {
  const created = await createDemand(leadA, {
    title: 'Série curta',
    dueDate: undefined,
    recurrence: { frequency: 'semanal', startDate: today, end: { type: 'quantidade', count: 2 } },
  })
  const { series } = await detail(created.id)
  assert.equal((await post(`/demands/${created.id}/series/skip`, leadA, { date: series.upcoming[0], reason: 'Sem necessidade' })).status, 200)
  const after = await detail(created.id)
  assert.equal(after.series.status, 'encerrada')
  assert.equal(after.series.nextExecution, null)
})

test('cancelar a série pode encerrar também as futuras não iniciadas', async () => {
  const created = await createDemand(leadA, {
    title: 'Série com antecedência',
    dueDate: undefined,
    recurrence: { frequency: 'semanal', startDate: today, leadDays: 30 },
  })
  const seriesId = (await detail(created.id)).series.id
  await runUntil(today)
  const generated = await seriesOccurrences(seriesId)
  assert.ok(generated.length >= 4, 'a antecedência gera as próximas datas')
  assert.equal((await post(`/demands/${created.id}/series/cancel`, leadA, { reason: 'Fim', cancelFuture: true })).status, 200)
  const final = await seriesOccurrences(seriesId)
  assert.equal(final[0].status, 'nao_iniciada', 'a de hoje continua')
  assert.ok(final.slice(1).every((item) => item.status === 'cancelada'))
})

test('quem saiu do setor não recebe novas ocorrências, e a demanda fica sem responsável', async () => {
  const temporary = await createUser('demandas-temporario@example.gov.br')
  await member(sectorC, temporary, 'colaborador')
  await member(sectorC, leadA, 'responsavel')
  const created = await post('/demands', leadA, demandBody({
    title: 'Série do setor Gama',
    originSectorId: sectorC,
    responsibleSectorId: sectorC,
    responsibleId: temporary.id,
    dueDate: undefined,
    recurrence: { frequency: 'semanal', startDate: today },
  }))
  assert.equal(created.status, 201, created.text)
  assert.equal((await post(`/demands/settings/sectors/${sectorC}/members/${temporary.id}/remove`, admin)).status, 200)
  assert.equal((await get('/demands', temporary)).status, 403, 'sem setor, sem acesso')
  const seriesId = (await detail(created.body.id)).series.id
  await runUntil(addDays(today, 7))
  const items = await seriesOccurrences(seriesId)
  assert.equal(items[1].responsavel, null)
  const list = await get('/demands?unassigned=true', leadA)
  assert.ok(list.body.demands.some((item: { title: string }) => item.title === 'Série do setor Gama'))
})

test('anexos: validação, acesso, download e remoção lógica registrados', async () => {
  const { id } = await createDemand()
  const upload = (session: Session, file = pdf, name = 'relatorio.pdf') =>
    call(`/demands/${id}/attachments?categoria=comprovante`, { method: 'POST', session, raw: file, fileName: name })

  const sent = await upload(leadA)
  assert.equal(sent.status, 201, sent.text)
  assert.equal((await upload(leadA, Buffer.from('MZ\u0000\u0001 binário'), 'virus.exe')).status, 400)
  assert.equal((await upload(leadA, pdf, 'relatorio.docx')).status, 400, 'extensão diferente do conteúdo')
  assert.equal((await upload(leadA, Buffer.from('%PDF-1.4 /JavaScript alert(1)'), 'ataque.pdf')).status, 400)
  assert.equal((await upload(leadB)).status, 404, 'quem não vê a demanda não anexa')
  assert.equal((await upload(memberA)).status, 201, 'servidor do setor anexa')

  const attachment = (await detail(id)).attachments.find((item: { uploadedBy: string }) => item.uploadedBy.includes('lider-a'))
  assert.equal(attachment.name, 'relatorio.pdf')
  assert.ok(attachment.uploadedBy.includes('lider-a'))
  assert.ok(attachment.uploadedAt)
  assert.ok(!JSON.stringify(attachment).includes('storage'), 'a chave de armazenamento não sai do servidor')

  const content = `/demands/attachments/${attachment.id}/content`
  const download = await get(content, memberA)
  assert.equal(download.status, 200)
  assert.deepEqual(download.buffer, pdf)
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment/)
  assert.equal((await get(content, leadB)).status, 404)
  assert.equal((await call(content)).status, 401)
  const logged = await pool.query(`SELECT 1 FROM public.auth_audit_events WHERE action = 'attachment.downloaded' AND target_resource_id = $1`, [id])
  assert.equal(logged.rowCount, 1)

  assert.equal((await post(`/demands/attachments/${attachment.id}/remove`, leadB, { reason: 'Quero' })).status, 404)
  assert.equal((await post(`/demands/attachments/${attachment.id}/remove`, admin, { reason: 'Quero' })).status, 403)
  assert.equal((await post(`/demands/attachments/${attachment.id}/remove`, leadA, {})).status, 400)
  assert.equal((await post(`/demands/attachments/${attachment.id}/remove`, leadA, { reason: 'Enviado por engano' })).status, 200)
  assert.equal((await get(content, memberA)).status, 404)
  const after = await detail(id)
  assert.equal(after.attachments.find((item: { id: string }) => item.id === attachment.id).removalReason, 'Enviado por engano')
  const actions = after.history.map((item: { action: string }) => item.action)
  assert.ok(actions.includes('anexo_incluido') && actions.includes('anexo_removido'))
  // O histórico identifica o arquivo pelo próprio anexo; o nome não é copiado para o registro.
  const ofAttachment = after.history.filter((item: HistoryItem) => item.details.anexoId === attachment.id)
  assert.deepEqual(ofAttachment.map((item: HistoryItem) => [item.action, item.details.arquivo]), [
    ['anexo_incluido', 'relatorio.pdf'],
    ['anexo_removido', 'relatorio.pdf'],
  ])
  const stored = await pool.query(`SELECT detalhes FROM public.demand_history WHERE detalhes->>'anexoId' = $1`, [attachment.id])
  assert.ok(stored.rows.every((item) => !JSON.stringify(item.detalhes).includes('relatorio')))

  const capacity = await get('/attachments/capacity', admin)
  assert.ok(capacity.body.files >= 1, 'o anexo entra na conta da capacidade')

  // P-15: anexo vinculado a uma etapa, como a tela passa a enviar.
  const step = await post(`/demands/${id}/subtasks`, leadA, { title: 'Etapa com anexo' })
  assert.equal(step.status, 201, step.text)
  const stepId = (await detail(id)).subtasks.find((item: { title: string }) => item.title === 'Etapa com anexo').id
  const toStep = (target: string) =>
    call(`/demands/${id}/attachments?etapa=${target}`, { method: 'POST', session: leadA, raw: pdf, fileName: 'etapa.pdf' })
  assert.equal((await toStep(stepId)).status, 201)
  const linked = (await detail(id)).attachments.find((item: { name: string }) => item.name === 'etapa.pdf')
  assert.equal(linked.subtaskId, stepId)
  assert.equal((await toStep('nao-e-uuid')).status, 400)
  const other = await createDemand()
  await post(`/demands/${other.id}/subtasks`, leadA, { title: 'Etapa de outra demanda' })
  const foreignStep = (await detail(other.id)).subtasks[0].id
  assert.equal((await toStep(foreignStep)).status, 404, 'etapa de outra demanda é recusada')
})

test('filtros combinados e ordenação', async () => {
  const urgent = await createDemand(leadA, { title: 'Filtro urgente único', priority: 'urgente', dueDate: addDays(today, 1) })
  const late = await createDemand(leadA, { title: 'Filtro atrasada única', priority: 'baixa', dueDate: addDays(today, -3) })
  const names = async (query: string, session: Session = leadA) =>
    (await get(`/demands?pageSize=200&${query}`, session)).body.demands.map((item: { title: string }) => item.title) as string[]

  assert.deepEqual(await names(`q=${encodeURIComponent('Filtro urgente')}`), ['Filtro urgente único'])
  assert.deepEqual(await names(`q=${urgent.number}`), ['Filtro urgente único'])
  assert.ok((await names('q=lider-a')).length > 0, 'pesquisa por solicitante')
  assert.ok((await names(`q=${encodeURIComponent('Setor Alfa')}`)).length > 0, 'pesquisa por setor')
  assert.ok((await names('overdue=true')).includes('Filtro atrasada única'))
  assert.ok(!(await names('overdue=true')).includes('Filtro urgente único'))
  assert.deepEqual(await names(`priority=urgente&q=${encodeURIComponent('Filtro')}`), ['Filtro urgente único'])
  assert.ok((await names(`status=nao_iniciada&sectorId=${sectorA}&categoryId=${categoryId}&responsibleId=${memberA.id}`)).includes('Filtro urgente único'))
  assert.ok((await names('recurring=true')).every((name) => !name.startsWith('Filtro')))
  assert.ok((await names('shared=false')).includes('Filtro urgente único'))
  assert.ok((await names(`dueFrom=${addDays(today, -4)}&dueTo=${addDays(today, -2)}`)).includes('Filtro atrasada única'))
  assert.ok((await names('scope=mine', memberA)).includes('Filtro urgente único'))
  assert.ok(!(await names('scope=mine', leadA)).includes('Filtro urgente único'))
  assert.ok((await names('scope=sector', leadA)).includes('Filtro urgente único'))
  assert.equal((await get('/demands?priority=qualquer', leadA)).status, 400)

  const byDue = await names('sort=prazo&overdue=true')
  assert.ok(byDue.length > 0)
  const byPriority = await names('sort=prioridade')
  assert.equal(byPriority.indexOf('Filtro urgente único') < byPriority.indexOf('Filtro atrasada única'), true)
  void late
})

test('painel e relatórios usam dados reais, respeitando filtros e permissões', async () => {
  await pool.query(`UPDATE public.demand_notification_preferences SET silenciados = '{}'`)
  const concluded = await createDemand(leadB, {
    title: 'Concluída do Beta',
    originSectorId: sectorB,
    responsibleSectorId: sectorB,
    responsibleId: memberB.id,
    dueDate: addDays(today, -1),
  })
  await post(`/demands/${concluded.id}/complete`, leadB, { done: 'Feito' })
  const open = await createDemand(leadB, {
    title: 'Aberta sem responsável',
    originSectorId: sectorB,
    responsibleSectorId: sectorB,
    responsibleId: null,
    dueDate: addDays(today, 2),
  })

  const beta = await get(`/demands/dashboard?sectorId=${sectorB}`, leadB)
  assert.equal(beta.status, 200, beta.text)
  assert.ok(beta.body.totals.concluidas_no_mes >= 1)
  assert.ok(beta.body.totals.abertas >= 1)
  assert.ok(beta.body.totals.sem_responsavel >= 1)
  assert.ok(beta.body.unassigned.some((item: { id: string }) => item.id === open.id))
  assert.ok(beta.body.dueSoon.some((item: { id: string }) => item.id === open.id))
  assert.ok(beta.body.bySector.some((item: { label: string }) => item.label === 'Setor Beta'))
  assert.ok(beta.body.updates.length > 0)
  assert.ok(beta.body.monthly.length > 0)

  // Sem acesso ao setor, a mesma consulta não traz nada dele.
  const asAlpha = await get(`/demands/dashboard?sectorId=${sectorB}`, otherA)
  assert.equal(asAlpha.body.totals.concluidas_no_mes, 0)

  const report = await get(`/demands/reports?sectorId=${sectorB}`, manager)
  assert.equal(report.status, 200, report.text)
  assert.ok(report.body.totals.total >= 2)
  assert.ok(report.body.totals.tempo_medio_dias !== null)
  assert.ok(report.body.byStatus.some((item: { label: string }) => item.label === 'concluida'))
  assert.ok(report.body.byCategory.length > 0)
  assert.ok(report.body.byPriority.length > 0)
  assert.ok(report.body.byResponsible.length > 0)

  const pdfFile = await get('/demands/reports/export?format=pdf', manager)
  assert.equal(pdfFile.status, 200)
  assert.equal(detectKind(pdfFile.buffer), 'pdf')
  assert.ok(pdfFile.buffer.toString('latin1').includes('Controle de Demandas'))
  const xlsx = await get('/demands/reports/export?format=xlsx', manager)
  assert.equal(detectKind(xlsx.buffer), 'xlsx')
  assert.equal((await get('/demands/reports/export?format=doc', manager)).status, 400)
  assert.equal((await get('/demands/reports/export?format=pdf', memberA)).status, 403)
  const exported = await pool.query(`SELECT count(*)::int AS total FROM public.auth_audit_events WHERE action = 'demand.report_exported'`)
  assert.ok(exported.rows[0].total >= 2)
})

test('agenda individual, por setor e consolidada, com compromissos e previsão de recorrências', async () => {
  const date = addDays(today, 6)
  const mine = await createDemand(leadA, { title: 'Prazo na agenda', dueDate: date, startDate: addDays(today, 4) })
  const range = `from=${today}&to=${addDays(today, 30)}`
  const items = async (session: Session, query = '') =>
    (await get(`/demands/agenda?${range}${query}`, session)).body.items as { kind: string; title: string; date: string; demandId: string | null; key: string; canCancel?: boolean; eventId?: string; dueSoon: boolean; overdue: boolean }[]

  const consolidated = await items(manager)
  assert.ok(consolidated.some((item) => item.kind === 'prazo' && item.demandId === mine.id && item.date === date))
  assert.ok(consolidated.some((item) => item.kind === 'inicio' && item.demandId === mine.id))
  assert.ok((await items(memberA, '&scope=individual')).some((item) => item.demandId === mine.id))
  assert.ok(!(await items(leadA, '&scope=individual')).some((item) => item.demandId === mine.id))
  assert.ok((await items(leadA, `&scope=sector&sectorId=${sectorA}`)).some((item) => item.demandId === mine.id))
  assert.ok(!(await items(memberB, `&scope=sector&sectorId=${sectorA}`)).some((item) => item.demandId === mine.id))

  await createDemand(leadA, {
    title: 'Previsão recorrente da agenda',
    dueDate: undefined,
    recurrence: { frequency: 'semanal', startDate: today },
  })
  const projected = (await items(manager)).filter((item) => item.kind === 'recorrencia' && item.title === 'Previsão recorrente da agenda')
  assert.ok(projected.length >= 3, 'as próximas datas aparecem como previsão')
  assert.ok(projected.every((item) => item.demandId === null))

  const meeting = await post('/demands/agenda/events', leadA, {
    kind: 'reuniao',
    title: 'Reunião da Diretoria',
    start: `${addDays(today, 3)}T14:00:00.000Z`,
    sectorId: sectorA,
  })
  assert.equal(meeting.status, 201, meeting.text)
  assert.equal((await post('/demands/agenda/events', leadA, { kind: 'reuniao', title: 'Sem setor meu', start: `${today}T14:00:00.000Z`, sectorId: sectorB })).status, 403)
  assert.equal((await post('/demands/agenda/events', admin, { kind: 'reuniao', title: 'Do administrador', start: `${today}T14:00:00.000Z` })).status, 403)
  const seen = (await items(memberA)).find((item) => item.title === 'Reunião da Diretoria')
  assert.ok(seen)
  assert.equal(seen.canCancel, false)
  assert.ok(!(await items(memberB)).some((item) => item.title === 'Reunião da Diretoria'))
  assert.equal((await post(`/demands/agenda/events/${meeting.body.id}/cancel`, memberA)).status, 403)
  const agendaAudit = await pool.query(
    `SELECT actor_user_id::text AS actor, details->>'alteracao' AS alteracao, occurred_at
       FROM public.auth_audit_events WHERE action = 'demand.changed' AND target_resource_id = $1`,
    [meeting.body.id],
  )
  assert.equal(agendaAudit.rows[0]?.alteracao, 'compromisso criado')
  assert.equal(agendaAudit.rows[0]?.actor, leadA.id)
  assert.ok(agendaAudit.rows[0]?.occurred_at)
  assert.equal((await post('/demands/agenda/events', memberA, { kind: 'reuniao', title: 'Do servidor', start: `${today}T14:00:00.000Z` })).status, 403)
  assert.equal((await post(`/demands/agenda/events/${meeting.body.id}/cancel`, leadA)).status, 200)
  assert.ok(!(await items(memberA)).some((item) => item.title === 'Reunião da Diretoria'))

  assert.equal((await get(`/demands/agenda?from=${today}&to=${addDays(today, 200)}`, leadA)).status, 400)
  assert.equal((await get('/demands/agenda', leadA)).status, 400)
})

test('alertas de prazo chegam uma vez, respeitam o lembrete e voltam se o prazo mudar', async () => {
  const soon = await createDemand(leadA, { title: 'Vence amanhã', dueDate: addDays(today, 1) })
  const distant = await createDemand(leadA, { title: 'Vence em vinte dias', dueDate: addDays(today, 20), reminderDays: 1 })
  const custom = await createDemand(leadA, { title: 'Lembrete longo', dueDate: addDays(today, 20), reminderDays: 25 })
  const late = await createDemand(leadA, { title: 'Já venceu', dueDate: addDays(today, -1) })

  const count = async (id: string) =>
    (
      await pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM public.user_notifications n
           JOIN public.integration_events e ON e.id = n.event_id
          WHERE e.resource_id = $1 AND n.user_id = $2 AND e.event_type IN ('demand_prazo_proximo', 'demand_atraso')`,
        [id, memberA.id],
      )
    ).rows[0].total

  await publishDeadlineAlerts()
  await publishDeadlineAlerts()
  assert.equal(await count(soon.id), 1, 'não repete')
  assert.equal(await count(distant.id), 0, 'ainda longe')
  assert.equal(await count(custom.id), 1, 'lembrete configurado na demanda')
  assert.equal(await count(late.id), 1, 'atraso')

  assert.equal((await patch(`/demands/${soon.id}`, leadA, { dueDate: addDays(today, 2) })).status, 200)
  await publishDeadlineAlerts()
  assert.equal(await count(soon.id), 2, 'novo prazo, novo aviso')
})

test('vínculo com outros módulos respeita o acesso e não altera o registro de origem', async () => {
  const floor = (await post('/settings/catalog/floors', admin, { label: 'Térreo Demandas' })).body.option.id
  const service = (await post('/settings/catalog/serviceTypes', admin, { label: 'Elétrica Demandas' })).body.option.id
  const requester = await createUser('demandas-solicitante@example.gov.br')
  const request = await post('/maintenance/requests', requester, {
    andarId: floor,
    tipoServicoId: service,
    localServico: 'Sala de arquivo',
    descricao: 'Preventiva',
    avisoPrivacidade: 'manutencao-2026-11',
  })
  assert.equal(request.status, 201, request.text)
  const protocol = String(request.body.protocol)
  const originBefore = await pool.query(`SELECT status, updated_at FROM public.service_requests WHERE id = $1`, [request.body.id])

  const { id } = await createDemand()
  assert.equal((await post(`/demands/${id}/links`, leadA, { module: 'maintenance', protocol })).status, 404, 'quem não abre o registro não vincula')

  // Quem atende a Manutenção e integra o setor consegue.
  await put(`/admin/users/${leadA.id}/access`, admin, {
    role: 'slm_operator', slmMember: true, grantedPermissions: [], deniedPermissions: [],
  })
  const linked = await post(`/demands/${id}/links`, leadA, { module: 'maintenance', protocol })
  assert.equal(linked.status, 201, linked.text)
  assert.equal((await post(`/demands/${id}/links`, leadA, { module: 'maintenance', protocol })).status, 409)

  const seenByLead = (await detail(id)).links[0]
  assert.equal(seenByLead.path, `/manutencao/${request.body.id}`)
  const seenByMember = (await detail(id, memberA)).links[0]
  assert.equal(seenByMember.protocol, protocol)

  const originAfter = await pool.query(`SELECT status, updated_at FROM public.service_requests WHERE id = $1`, [request.body.id])
  assert.deepEqual(originAfter.rows[0], originBefore.rows[0], 'o registro de origem não muda')

  assert.equal((await post(`/demands/${id}/links/${linked.body.id}/remove`, leadB)).status, 404)
  assert.equal((await post(`/demands/${id}/links/${linked.body.id}/remove`, leadA)).status, 200)
  assert.equal((await detail(id)).links.length, 0)
  const actions = (await detail(id)).history.map((item: { action: string }) => item.action)
  assert.ok(actions.includes('vinculo_incluido') && actions.includes('vinculo_removido'))
})

test('categoria desativada sai dos formulários e continua nos registros', async () => {
  const created = await post('/demands/settings/categories', admin, { name: 'Categoria temporária', order: 500 })
  assert.equal(created.status, 201, created.text)
  const { id } = await createDemand(leadA, { categoryId: created.body.id })
  assert.equal(
    (await patch(`/demands/settings/categories/${created.body.id}`, admin, { name: 'Categoria temporária', order: 500, active: false })).status,
    200,
  )
  const options = await get('/demands/options', leadA)
  assert.ok(!options.body.categories.some((item: { id: string }) => item.id === created.body.id))
  assert.equal((await detail(id)).demand.category, 'Categoria temporária')
  assert.equal((await post('/demands', leadA, demandBody({ categoryId: created.body.id }))).status, 400)
  const audit = await pool.query(`SELECT 1 FROM public.auth_audit_events WHERE action = 'demand.config_changed' AND target_resource_id = $1`, [created.body.id])
  assert.equal(audit.rowCount, 2)
})

test('a sessão é a única identidade aceita: dados do corpo não mudam o acesso nem a autoria', async () => {
  const created = await post('/demands', memberA, demandBody({ createdBy: leadA.id, number: 'DEM-FORJADO', userId: leadA.id, directorate: true }))
  assert.equal(created.status, 201, created.text)
  assert.notEqual(created.body.number, 'DEM-FORJADO')
  const stored = await detail(created.body.id, memberA)
  assert.equal(stored.demand.createdById, memberA.id)
  const forged = await get(`/demands/${created.body.id}?directorate=true&userId=${leadB.id}`, leadB)
  assert.equal(forged.status, 404)
})

// ---------------------------------------------------------------------------
// Estrutura organizacional
// ---------------------------------------------------------------------------
async function setLinks(user: Session, body: unknown) {
  const result = await put(`/admin/users/${user.id}/institutional-links`, admin, body)
  assert.equal(result.status, 200, result.text)
  return result
}

const auditOf = async (userId: string) =>
  (
    await pool.query<{ action: string; actor: string; details: Record<string, string>; occurred_at: Date }>(
      `SELECT action, actor_user_id::text AS actor, details, occurred_at
         FROM public.auth_audit_events WHERE target_user_id = $1 ORDER BY occurred_at, id`,
      [userId],
    )
  ).rows

test('administrador acessa o módulo sem setor, consulta tudo e não altera nada', async () => {
  const context = await get('/demands/context', admin)
  assert.equal(context.body.hasAccess, true)
  assert.equal(context.body.memberships.length, 0)
  assert.equal(context.body.canCreate, false)
  assert.equal(context.body.canSeeReports, true)

  const secret = await createDemand(leadA, { title: 'Restrita para auditoria', restricted: true, responsibleId: leadA.id })
  const open = await createDemand()
  assert.ok((await get('/demands?pageSize=200', admin)).text.includes('Restrita para auditoria'))
  assert.equal((await get('/demands/reports', admin)).status, 200)

  const seen = await detail(secret.id, admin)
  assert.equal(seen.access.administrativeRead, true)
  assert.equal(seen.access.edit, false)
  const logged = await pool.query(
    `SELECT actor_user_id::text AS actor FROM public.auth_audit_events
      WHERE action = 'demand.admin_access' AND target_resource_id = $1`,
    [secret.id],
  )
  assert.deepEqual(logged.rows, [{ actor: admin.id }], 'a consulta de restrita fica registrada')

  const before = await pool.query(`SELECT count(*)::int AS n FROM public.auth_audit_events WHERE action = 'demand.admin_access'`)
  assert.equal((await detail(open.id, admin)).access.administrativeRead, false)
  const after = await pool.query(`SELECT count(*)::int AS n FROM public.auth_audit_events WHERE action = 'demand.admin_access'`)
  assert.equal(after.rows[0].n, before.rows[0].n, 'demanda comum não gera esse registro')

  for (const id of [secret.id, open.id]) {
    assert.equal((await post(`/demands/${id}/status`, admin, { status: 'em_andamento' })).status, 403)
    assert.equal((await patch(`/demands/${id}`, admin, { title: 'Alterada pela administração' })).status, 403)
    assert.equal((await post(`/demands/${id}/comments`, admin, { text: 'Oi' })).status, 403)
    assert.equal((await post(`/demands/${id}/follow`, admin, { following: true })).status, 403)
    assert.equal((await post(`/demands/${id}/assign`, admin, { responsibleId: null })).status, 403)
  }
  assert.equal((await post('/demands', admin, demandBody())).status, 403)

  const draft = await post('/demands', leadA, { title: 'Rascunho alheio', draft: true })
  assert.equal((await get(`/demands/${draft.body.id}`, admin)).status, 404, 'rascunho continua de quem criou')
})

test('aprovação define lotação, DA, setor, SLM, função e permissões, na mesma transação', async () => {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const email = 'demandas-aprovada@example.gov.br'
  await call('/auth/register', {
    method: 'POST',
    body: { fullName: 'Pessoa Aprovada', email, sector: 'Lotação informada', password, passwordConfirmation: password },
  })
  const pending = await get('/admin/registrations/pending', admin)
  const id = pending.body.registrations.find((item: { email: string }) => item.email === email).id

  const options = await get('/admin/registrations/institutional-options', admin)
  assert.equal(options.body.options.available, true)
  assert.ok(options.body.options.sectors.some((item: { id: string }) => item.id === sectorB))

  // Erro em qualquer parte desfaz a aprovação inteira.
  const failed = await post(`/admin/registrations/${id}/approve`, admin, {
    role: 'requester',
    setup: { institutional: { sectors: [{ sectorId: '00000000-0000-4000-8000-000000000000' }] } },
  })
  assert.equal(failed.status, 400, failed.text)
  assert.equal((await pool.query(`SELECT status FROM public.auth_users WHERE id = $1`, [id])).rows[0].status, 'pending')

  assert.equal((await post(`/admin/registrations/${id}/approve`, admin, { role: 'requester', setup: { slmMember: true } })).status, 400)
  assert.equal((await post(`/admin/registrations/${id}/approve`, admin, { role: 'requester', setup: { grantedPermissions: ['flights:cpf:read'] } })).status, 400)

  const approved = await post(`/admin/registrations/${id}/approve`, admin, {
    role: 'requester',
    setup: {
      lotation: 'Contabilidade',
      grantedPermissions: ['reports:read'],
      institutional: {
        directorate: { role: 'diretor', function: 'Analista' },
        sectors: [{ sectorId: sectorB, role: 'responsavel', chefia: true, function: 'Chefe de seção' }],
      },
    },
  })
  assert.equal(approved.status, 200, approved.text)
  const session = await signIn(email)

  const context = await get('/demands/context', session)
  assert.equal(context.body.hasAccess, true)
  assert.equal(context.body.directorate, true)
  assert.deepEqual(context.body.profiles, ['diretor', 'chefe'])
  assert.equal(context.body.memberships[0].role, 'responsavel', 'chefia responde pelo setor')
  assert.equal((await pool.query(`SELECT sector FROM public.auth_users WHERE id = $1`, [id])).rows[0].sector, 'Contabilidade')
  assert.ok((await get('/reports/summary', session)).status !== 403, 'a permissão adicional vale')

  const links = await get(`/admin/users/${id}/institutional-links`, admin)
  assert.equal(links.body.links.directorate.function, 'Analista')
  assert.equal(links.body.links.sectors[0].function, 'Chefe de seção')
  assert.equal(links.body.links.sectors[0].chefia, true)

  const actions = (await auditOf(id)).map((item) => item.action)
  for (const action of ['registration.approve', 'user.updated', 'user.permissions_changed', 'user.institutional_link_changed']) {
    assert.ok(actions.includes(action), action)
  }
})

test('quem só aprova cadastros não concede vínculos nem permissões', async () => {
  const approver = await createUser('demandas-aprovador@example.gov.br')
  await grant(approver, ['users:approve'])
  const target = 'demandas-sem-vinculo@example.gov.br'
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  await call('/auth/register', {
    method: 'POST',
    body: { fullName: 'Pessoa Sem Vínculo', email: target, sector: 'Protocolo', password, passwordConfirmation: password },
  })
  const pending = await get('/admin/registrations/pending', approver)
  const id = pending.body.registrations.find((item: { email: string }) => item.email === target).id
  for (const extra of [
    { institutional: { directorate: { role: 'diretor' } } },
    { grantedPermissions: ['reports:read'] },
    { lotation: 'Outra' },
  ]) {
    assert.equal((await post(`/admin/registrations/${id}/approve`, approver, { role: 'requester', setup: extra })).status, 403)
  }
  assert.equal((await post(`/admin/registrations/${id}/approve`, approver, { role: 'requester' })).status, 200, 'a aprovação simples continua igual')
  const session = await signIn(target)
  assert.equal((await get('/demands/context', session)).body.hasAccess, false, 'aprovar não dá vínculo')
  assert.equal((await get('/demands', session)).status, 403)
})

test('diretor sem setor cadastra; retirar o perfil tira o acesso e preserva o histórico', async () => {
  const person = await createUser('demandas-da@example.gov.br')
  assert.equal((await get('/demands', person)).status, 403)
  await setLinks(person, { directorate: { role: 'diretor', function: 'Diretor' }, sectors: [] })

  const context = await get('/demands/context', person)
  assert.equal(context.body.createAnywhere, true)
  const created = await post('/demands', person, demandBody({
    title: 'Cadastrada pelo diretor',
    originSectorId: sectorB,
    responsibleSectorId: sectorA,
  }))
  assert.equal(created.status, 201, created.text)

  const comment = await post(`/demands/${created.body.id}/comments`, person, { text: 'Registro antes de sair' })
  assert.equal(comment.status, 201, comment.text)

  await setLinks(person, { directorate: null, sectors: [] })
  assert.equal((await get('/demands', person)).status, 403, 'sem vínculo, sem acesso')
  const stored = await detail(created.body.id, leadA)
  assert.ok(stored.demand.createdBy.includes('demandas-da'), 'o cadastro continua com a autoria')
  assert.equal(stored.comments[0].text, 'Registro antes de sair')
  assert.equal((await pool.query(`SELECT ativo FROM public.user_directorate_links WHERE user_id = $1`, [person.id])).rows[0].ativo, false)

  const log = await auditOf(person.id)
  const changes = log.filter((item) => item.action === 'user.institutional_link_changed')
  assert.deepEqual(changes.map((item) => item.details.operation), ['Inclusão', 'Retirada'])
  assert.ok(changes.every((item) => item.actor === admin.id && item.occurred_at))
  const history = await get(`/admin/users/${person.id}/history`, admin)
  assert.ok(history.text.includes('user.institutional_link_changed'), 'aparece no histórico da pessoa')
})

test('retirar de um setor preserva o que a pessoa fez, e servidor em um setor + chefe em outro valem cada um no seu', async () => {
  const person = await createUser('demandas-dois-vinculos@example.gov.br')
  await setLinks(person, {
    directorate: null,
    sectors: [
      { sectorId: sectorA, role: 'colaborador' },
      { sectorId: sectorB, role: 'responsavel' },
    ],
  })
  const context = (await get('/demands/context', person)).body
  assert.equal(context.memberships.length, 2)
  assert.deepEqual(context.profiles, ['chefe', 'servidor'])
  assert.deepEqual([...context.creatableSectorIds].sort(), [sectorA, sectorB].sort())

  const own = await createDemand(person, { title: 'Do setor Beta', originSectorId: sectorB, responsibleSectorId: sectorB, responsibleId: null })
  assert.equal((await post(`/demands/${own.id}/assign`, person, { responsibleId: memberB.id })).status, 200, 'chefia o setor B')
  const other = await createDemand()
  assert.equal((await detail(other.id, person)).access.edit, true, 'no setor A edita como servidor')
  const restrictedA = await createDemand(leadA, { restricted: true, responsibleId: leadA.id })
  assert.equal((await get(`/demands/${restrictedA.id}`, person)).status, 404, 'no setor A não tem o alcance de chefe')
  assert.equal((await post('/demands', person, demandBody({ originSectorId: sectorC, responsibleSectorId: sectorC, responsibleId: null }))).status, 403)

  await setLinks(person, { directorate: null, sectors: [{ sectorId: sectorA, role: 'colaborador' }] })
  assert.equal((await post(`/demands/${own.id}/status`, person, { status: 'em_andamento' })).status, 404, 'perdeu o setor B')
  const kept = await detail(own.id, leadB)
  assert.ok(kept.history.some((item: { user: string }) => item.user?.includes('dois-vinculos')), 'o histórico continua')
  const member = await pool.query(`SELECT ativo FROM public.demand_sector_members WHERE sector_id = $1 AND user_id = $2`, [sectorB, person.id])
  assert.equal(member.rows[0].ativo, false, 'a retirada é lógica')
  const changes = (await auditOf(person.id)).filter((item) => item.action === 'user.institutional_link_changed')
  assert.ok(changes.some((item) => item.details.operation === 'Retirada' && item.details.link === 'Setor Setor Beta'))
})

test('alterar vínculos exige administrador, e ninguém altera os próprios', async () => {
  const manager2 = await createUser('demandas-gerencia-usuarios@example.gov.br')
  await grant(manager2, ['users:manage', 'users:read'])
  const target = await createUser('demandas-alvo@example.gov.br')
  const body = { directorate: { role: 'diretor' }, sectors: [] }
  assert.equal((await put(`/admin/users/${target.id}/institutional-links`, manager2, body)).status, 403)
  assert.equal((await put(`/admin/users/${target.id}/institutional-links`, target, body)).status, 403)
  assert.equal((await put(`/admin/users/${admin.id}/institutional-links`, admin, body)).status, 403, 'nem o administrador em si mesmo')
  assert.equal((await get(`/admin/users/${admin.id}/institutional-links`, target)).status, 403)
  assert.equal((await put(`/admin/users/${target.id}/institutional-links`, admin, { directorate: { role: 'dono' } })).status, 400)

  // Configurar o módulo não define diretores, e não existem outros papéis na DA.
  const configurator = await createUser('demandas-configura@example.gov.br')
  await grant(configurator, ['demands:configure'])
  assert.equal((await put(`/demands/settings/directorate/${target.id}`, configurator, { role: 'diretor' })).status, 403)
  assert.equal((await put(`/demands/settings/directorate/${configurator.id}`, configurator, { role: 'diretor' })).status, 403)
  for (const role of ['integrante', 'consulta']) {
    assert.equal((await put(`/demands/settings/directorate/${target.id}`, admin, { role })).status, 400, role)
  }
  assert.equal((await put(`/demands/settings/directorate/${target.id}`, admin, { role: 'diretor' })).status, 200)
  assert.equal((await post(`/demands/settings/directorate/${target.id}/remove`, configurator)).status, 403, 'nem retirar um diretor')
  assert.equal((await post(`/demands/settings/directorate/${target.id}/remove`, admin)).status, 200)
})

test('diretor vê e edita todos os setores e configura o módulo, sem poderes sobre usuários, diretores ou configurações gerais', async () => {
  const director = await createUser('demandas-diretor@example.gov.br')
  await setLinks(director, { directorate: { role: 'diretor' }, sectors: [] })
  const alpha = await createDemand()
  const beta = await createDemand(leadB, { originSectorId: sectorB, responsibleSectorId: sectorB, responsibleId: memberB.id })

  const context = (await get('/demands/context', director)).body
  assert.equal(context.directorate, true)
  assert.equal(context.canSeeReports, true)
  assert.equal((await get('/demands/dashboard', director)).status, 200)
  assert.equal((await get('/demands/reports', director)).status, 200)
  assert.equal(context.canConfigure, true)
  assert.equal((await get('/demands/settings/sectors', director)).status, 200)
  assert.equal((await get('/demands/settings/categories', director)).status, 200)
  const directorSector = await post('/demands/settings/sectors', director, { name: 'Setor do Diretor' })
  assert.equal(directorSector.status, 201, directorSector.text)
  assert.equal((await put(`/demands/settings/sectors/${directorSector.body.id}/members/${memberA.id}`, director, { role: 'responsavel' })).status, 200)
  assert.equal((await post(`/demands/settings/sectors/${directorSector.body.id}/members/${memberA.id}/remove`, director)).status, 200)
  const directorCategory = await post('/demands/settings/categories', director, { name: 'Categoria do Diretor' })
  assert.equal(directorCategory.status, 201, directorCategory.text)
  const configAudit = await pool.query(
    `SELECT actor_user_id::text AS actor FROM public.auth_audit_events WHERE action = 'demand.config_changed' AND target_resource_id = $1`,
    [directorCategory.body.id],
  )
  assert.equal(configAudit.rows[0]?.actor, director.id)
  // Definir diretores segue só com o administrador, e servidor e chefe não configuram.
  assert.equal((await get('/demands/settings/directorate', director)).status, 403)
  assert.equal((await put(`/demands/settings/directorate/${memberA.id}`, director, { role: 'diretor' })).status, 403)
  assert.equal((await post(`/demands/settings/directorate/${manager.id}/remove`, director)).status, 403)
  for (const session of [memberA, leadA]) {
    assert.equal((await get('/demands/settings/sectors', session)).status, 403)
    assert.equal((await post('/demands/settings/categories', session, { name: 'Sem poder' })).status, 403)
  }
  assert.equal((await get('/admin/users', director)).status, 403, 'não administra usuários')
  assert.equal((await get('/settings/parameters', director)).status, 403)

  for (const { id } of [alpha, beta]) {
    assert.equal((await post(`/demands/${id}/status`, director, { status: 'em_andamento' })).status, 200)
    assert.equal((await patch(`/demands/${id}`, director, { priority: 'urgente' })).status, 200)
    assert.equal((await post(`/demands/${id}/assign`, director, { responsibleId: null })).status, 200)
  }
  assert.equal((await post('/demands', director, demandBody({ title: 'Aberta pelo diretor' }))).status, 201)

  const secret = await createDemand(leadA, { restricted: true, responsibleId: leadA.id })
  assert.equal((await detail(secret.id, director)).access.edit, true, 'o Diretor alcança todas')
})

test('chefe vê e edita o setor todo, inclusive sem responder pela demanda', async () => {
  const chief = await createUser('demandas-chefe@example.gov.br')
  await setLinks(chief, { directorate: null, sectors: [{ sectorId: sectorB, role: 'colaborador', chefia: true, seesSector: false }] })
  const own = await createDemand(leadB, { originSectorId: sectorB, responsibleSectorId: sectorB, responsibleId: memberB.id })
  const other = await createDemand()
  assert.equal((await post(`/demands/${own.id}/status`, chief, { status: 'em_andamento' })).status, 200)
  assert.equal((await patch(`/demands/${own.id}`, chief, { priority: 'alta' })).status, 200)
  assert.equal((await post(`/demands/${own.id}/assign`, chief, { responsibleId: null })).status, 200)
  assert.equal((await get(`/demands/${other.id}`, chief)).status, 404, 'outro setor, sem acesso')
  const secret = await createDemand(leadB, { originSectorId: sectorB, responsibleSectorId: sectorB, responsibleId: leadB.id, restricted: true })
  assert.equal((await detail(secret.id, chief)).access.edit, true, 'o chefe vê todas as do próprio setor')
  assert.equal((await patch(`/demands/${own.id}`, chief, { responsibleSectorId: sectorA })).status, 403, 'só o Diretor transfere')
  assert.equal((await get('/demands/reports', chief)).status, 200)
})

test('não há outros níveis de acesso: equipe SLM e papéis antigos da DA não dão nada', async () => {
  const created = await post('/demands/settings/sectors', admin, { name: 'Setor SLM Teste', isSlm: true })
  assert.equal(created.status, 201, created.text)

  const operator = await createUser('demandas-operador-slm@example.gov.br')
  assert.equal(
    (await put(`/admin/users/${operator.id}/access`, admin, { role: 'slm_operator', slmMember: true, grantedPermissions: ['requests:create_on_behalf'], deniedPermissions: [] })).status,
    200,
  )
  assert.equal((await get('/demands/context', operator)).body.hasAccess, false)
  assert.equal((await get('/demands', operator)).status, 403)

  // Linhas antigas na tabela, se existirem, não valem.
  const legacy = await createUser('demandas-papel-antigo@example.gov.br')
  await pool.query(`INSERT INTO public.user_directorate_links (user_id, papel_demandas) VALUES ($1, 'integrante')`, [legacy.id])
  assert.equal((await get('/demands/context', legacy)).body.hasAccess, false)
  assert.equal((await post('/demands', legacy, demandBody())).status, 403)
})

test('a demanda identifica o gestor do acompanhamento, sem mudar a recorrência', async () => {
  const boss = await createUser('demandas-gestor-acompanha@example.gov.br')
  await setLinks(boss, { directorate: { role: 'diretor' }, sectors: [] })
  assert.equal((await post('/demands', leadA, demandBody({ followUpManagerId: memberA.id }))).status, 400, 'só um gestor')

  const created = await createDemand(leadA, {
    followUpManagerId: boss.id,
    restricted: true,
    responsibleId: leadA.id,
    dueDate: undefined,
    recurrence: { frequency: 'semanal', startDate: today },
  })
  const seen = await detail(created.id)
  assert.equal(seen.demand.followUpManagerId, boss.id)
  assert.equal((await get(`/demands/${created.id}`, boss)).status, 200, 'designado, vê mesmo restrita')

  await runUntil(addDays(today, 7))
  const next = await pool.query(
    `SELECT gestor_acompanhamento_id::text AS gestor, numero FROM public.demands WHERE series_id = $1 ORDER BY data_ocorrencia`,
    [seen.series.id],
  )
  assert.equal(next.rows.length, 2, 'cada ocorrência segue individualizada')
  assert.notEqual(next.rows[0].numero, next.rows[1].numero)
  assert.equal(next.rows[1].gestor, boss.id)

  const plain = await createDemand()
  assert.equal((await patch(`/demands/${plain.id}`, leadA, { followUpManagerId: boss.id })).status, 200)
  assert.ok((await detail(plain.id)).history.some((item: { action: string }) => item.action === 'gestor_alterado'))
})

test('setor desativado sai das opções e mantém as demandas e o histórico', async () => {
  const created = await post('/demands/settings/sectors', admin, { name: 'Setor a desativar' })
  const sectorId = created.body.id
  await member(sectorId, leadB, 'responsavel', { chefia: true, function: 'Chefe' })
  const listed = (await get('/demands/settings/sectors', admin)).body.sectors.find((item: { id: string }) => item.id === sectorId)
  assert.equal(listed.members[0].chefia, true)
  assert.equal(listed.members[0].function, 'Chefe')

  const { id } = await createDemand(leadB, { originSectorId: sectorId, responsibleSectorId: sectorId, responsibleId: leadB.id, title: 'Antes de desativar' })
  assert.equal((await patch(`/demands/settings/sectors/${sectorId}`, admin, { name: 'Setor a desativar', active: false })).status, 200)
  assert.ok(!(await get('/demands/options', leadB)).body.sectors.some((item: { id: string }) => item.id === sectorId))
  const stored = await detail(id, leadB)
  assert.equal(stored.demand.responsibleSector, 'Setor a desativar')
  assert.ok(stored.history.length > 0)
})

test('matriz definitiva: o que cada um dos quatro perfis vê e faz, inclusive por chamada direta', async () => {
  const servidorA = memberA
  const chefeA = leadA
  const diretor = await createUser('matriz-diretor@example.gov.br')
  await setLinks(diretor, { directorate: { role: 'diretor' }, sectors: [] })

  const inA = await createDemand(chefeA, { title: 'Matriz setor A' })
  const inB = await createDemand(leadB, { title: 'Matriz setor B', originSectorId: sectorB, responsibleSectorId: sectorB, responsibleId: memberB.id })
  const lista = async (session: Session) => (await get('/demands?pageSize=200', session)).text

  // O que cada perfil vê
  for (const [session, seesA, seesB] of [
    [servidorA, true, false],
    [chefeA, true, false],
    [diretor, true, true],
    [admin, true, true],
  ] as const) {
    const text = await lista(session)
    assert.equal(text.includes(inA.number), seesA)
    assert.equal(text.includes(inB.number), seesB)
    assert.equal((await get(`/demands/${inA.id}`, session)).status, seesA ? 200 : 404)
    assert.equal((await get(`/demands/${inB.id}`, session)).status, seesB ? 200 : 404)
  }

  // Cadastro
  const novo = (sector: string) => demandBody({ originSectorId: sector, responsibleSectorId: sector, responsibleId: null })
  assert.equal((await post('/demands', servidorA, novo(sectorA))).status, 201)
  assert.equal((await post('/demands', servidorA, novo(sectorB))).status, 403)
  assert.equal((await post('/demands', chefeA, novo(sectorA))).status, 201)
  assert.equal((await post('/demands', chefeA, novo(sectorB))).status, 403)
  assert.equal((await post('/demands', diretor, novo(sectorB))).status, 201)
  assert.equal((await post('/demands', admin, novo(sectorA))).status, 403)

  // Toda operação que altera o registro. Cada uma é uma chamada direta à API.
  const subtask = await post(`/demands/${inA.id}/subtasks`, chefeA, { title: 'Etapa', responsibleId: servidorA.id })
  assert.equal(subtask.status, 201, subtask.text)
  const attachment = await call(`/demands/${inA.id}/attachments`, { method: 'POST', session: chefeA, raw: pdf, fileName: 'matriz.pdf' })
  assert.equal(attachment.status, 201, attachment.text)
  const writes = (session: Session, id: string) => [
    () => patch(`/demands/${id}`, session, { title: 'Alterado', dueDate: addDays(today, 40) }),
    () => post(`/demands/${id}/status`, session, { status: 'em_andamento' }),
    () => post(`/demands/${id}/assign`, session, { responsibleId: null }),
    () => post(`/demands/${id}/complete`, session, { done: 'Feito' }),
    () => post(`/demands/${id}/reopen`, session, { reason: 'Motivo' }),
    () => post(`/demands/${id}/cancel`, session, { reason: 'Motivo' }),
    () => put(`/demands/${id}/collaboration`, session, { collaborators: [], collaboratorSectorIds: [], authorizedUserIds: [] }),
    () => post(`/demands/${id}/comments`, session, { text: 'Comentário' }),
    () => post(`/demands/${id}/subtasks`, session, { title: 'Nova etapa' }),
    () => call(`/demands/${id}/attachments`, { method: 'POST', session, raw: pdf, fileName: 'novo.pdf' }),
    () => post(`/demands/${id}/links`, session, { module: 'maintenance', protocol: 'X' }),
    () => post(`/demands/${id}/series/suspend`, session, { reason: 'Motivo' }),
    () => post(`/demands/${id}/discard`, session, {}),
    () => post(`/demands/${id}/publish`, session, {}),
  ]
  const snapshot = async () => (await pool.query(`SELECT d::text AS row FROM public.demands d WHERE id = $1`, [inA.id])).rows[0].row
  const before = await snapshot()

  // Administrador: tudo bloqueado, sem nenhuma mudança no registro.
  for (const write of writes(admin, inA.id)) assert.equal((await write()).status, 403, write.toString())
  assert.equal((await patch(`/demands/${inA.id}/subtasks/${subtask.body.id}`, admin, { status: 'concluida' })).status, 403)
  assert.equal((await post(`/demands/attachments/${attachment.body.id}/remove`, admin, { reason: 'Motivo' })).status, 403)
  assert.equal((await post(`/demands/${inA.id}/follow`, admin, { following: true })).status, 403)
  assert.equal(await snapshot(), before)

  // Fora do setor, a demanda nem existe para quem não a alcança.
  for (const write of writes(chefeA, inB.id)) assert.equal((await write()).status, 404, write.toString())
  for (const write of writes(servidorA, inB.id)) assert.equal((await write()).status, 404, write.toString())

  // Servidor, Chefe e Diretor alteram, e isso fica na auditoria.
  const auditTotal = async (actor: Session) =>
    (await pool.query(`SELECT count(*)::int AS n FROM public.auth_audit_events WHERE action = 'demand.changed' AND actor_user_id = $1`, [actor.id])).rows[0].n
  const inAForServer = await createDemand(chefeA, { title: 'Matriz do servidor' })
  for (const [session, id] of [[servidorA, inAForServer.id], [chefeA, inA.id], [diretor, inB.id]] as const) {
    const start = await auditTotal(session)
    assert.equal((await patch(`/demands/${id}`, session, { dueDate: addDays(today, 30) })).status, 200)
    assert.equal((await post(`/demands/${id}/status`, session, { status: 'em_andamento' })).status, 200)
    assert.equal((await post(`/demands/${id}/assign`, session, { responsibleId: null })).status, 200)
    assert.ok((await auditTotal(session)) >= start + 3, 'cada alteração entra na auditoria')
  }
  assert.equal((await patch(`/demands/${inA.id}`, chefeA, { originSectorId: sectorB })).status, 403, 'só o Diretor muda o setor')

  // A auditoria identifica quem, quando e o que mudou.
  const logged = await pool.query<{ actor: string; occurred_at: Date; details: Record<string, unknown> }>(
    `SELECT actor_user_id::text AS actor, occurred_at, details FROM public.auth_audit_events
      WHERE action = 'demand.changed' AND target_resource_id = $1 AND details->>'alteracao' = 'prazo alterado'`,
    [inAForServer.id],
  )
  assert.equal(logged.rows.length, 1)
  assert.equal(logged.rows[0].actor, servidorA.id)
  assert.ok(logged.rows[0].occurred_at)
  assert.equal(logged.rows[0].details.demanda, inAForServer.number)
  assert.equal(logged.rows[0].details.to, addDays(today, 30))

  // O administrador consulta anexos e indicadores, sem alterar nada.
  assert.equal((await get(`/demands/attachments/${attachment.body.id}/content`, admin)).status, 200)
  assert.equal((await get('/demands/reports', admin)).status, 200)
  assert.equal((await get('/demands/dashboard', admin)).status, 200)
  assert.equal((await get('/demands/reports', servidorA)).status, 403)

  // Acúmulo
  const adminDiretor = await createUser('matriz-admin-diretor@example.gov.br')
  await put(`/admin/users/${adminDiretor.id}/access`, admin, { role: 'administrator', slmMember: false, grantedPermissions: [], deniedPermissions: [] })
  const adminChefe = await createUser('matriz-admin-chefe@example.gov.br')
  await put(`/admin/users/${adminChefe.id}/access`, admin, { role: 'administrator', slmMember: false, grantedPermissions: [], deniedPermissions: [] })
  await setLinks(adminChefe, { directorate: null, sectors: [{ sectorId: sectorA, role: 'responsavel' }] })
  await setLinks(adminDiretor, { directorate: { role: 'diretor' }, sectors: [] })
  const relogged = { diretor: await signIn('matriz-admin-diretor@example.gov.br'), chefe: await signIn('matriz-admin-chefe@example.gov.br') }
  assert.equal((await post(`/demands/${inB.id}/status`, relogged.diretor, { status: 'aguardando_terceiros', waitingFor: 'Fornecedor' })).status, 200, 'administrador + diretor edita')
  assert.equal((await detail(inA.id, relogged.chefe)).access.edit, false, 'administrador sem Diretor só consulta')
  assert.equal((await post(`/demands/${inA.id}/status`, relogged.chefe, { status: 'em_andamento' })).status, 403)
  assert.equal((await post('/demands', relogged.chefe, novo(sectorA))).status, 403)
})

test('pesquisa específica: filtros combináveis, sempre dentro do que o perfil vê', async () => {
  const tag = 'Pesquisa-zebra'
  const a = await createDemand(memberA, { title: `${tag} alfa`, description: 'Texto único girafa', dueDate: addDays(today, 3), priority: 'baixa' })
  const b = await createDemand(leadA, { title: `${tag} segunda`, description: 'Outro texto', dueDate: addDays(today, 50), requesterId: otherA.id, responsibleId: otherA.id })
  const hidden = await createDemand(leadB, { title: `${tag} beta`, description: 'Texto único girafa', originSectorId: sectorB, responsibleSectorId: sectorB, responsibleId: memberB.id })
  const late = await createDemand(leadA, { title: `${tag} vencida`, responsibleId: memberA.id })
  await pool.query(`UPDATE public.demands SET prazo = ($2::date - 5) WHERE id = $1`, [late.id, today])
  const recurring = await createDemand(leadA, { title: `${tag} recorrente`, dueDate: undefined, recurrence: { frequency: 'semanal', startDate: today } })

  const ids = async (query: string, session: Session = memberA) => {
    const result = await get(`/demands?pageSize=200&${query}`, session)
    assert.equal(result.status, 200, result.text)
    return (result.body.demands as { id: string }[]).map((item) => item.id).sort()
  }
  const sorted = (...items: { id: string }[]) => items.map((item) => item.id).sort()
  const scoped = `text=${tag}`

  assert.deepEqual(await ids(scoped), sorted(a, b, late, recurring), 'o servidor não recebe a do outro setor')
  assert.deepEqual(await ids(scoped, manager), sorted(a, b, hidden, late, recurring), 'o Diretor vê todos os setores')
  assert.deepEqual(await ids(scoped, admin), sorted(a, b, hidden, late, recurring), 'o Administrador também')

  // Nenhum filtro alcança outro setor.
  assert.deepEqual(await ids(`number=${hidden.number}`), [])
  assert.deepEqual(await ids('text=girafa'), sorted(a))
  assert.deepEqual(await ids(`${scoped}&sectorId=${sectorB}`), [])
  assert.deepEqual(await ids(`${scoped}&responsibleId=${memberB.id}`), [])
  assert.deepEqual(await ids(`number=${hidden.number}`, leadA), [])
  assert.deepEqual(await ids(`number=${hidden.number}`, manager), sorted(hidden))

  // Cada filtro, e combinados.
  assert.deepEqual(await ids(`number=${a.number}`), sorted(a))
  assert.deepEqual(await ids('text=girafa'), sorted(a), 'alcança a descrição')
  assert.deepEqual(await ids(`${scoped}&requester=${encodeURIComponent('outro-a')}`), sorted(b))
  assert.deepEqual(await ids(`${scoped}&responsibleId=${otherA.id}`), sorted(b))
  assert.deepEqual(await ids(`${scoped}&status=nao_iniciada&sectorId=${sectorA}&dueTo=${addDays(today, 5)}`), sorted(a, late, recurring))
  assert.deepEqual(await ids(`${scoped}&dueFrom=${addDays(today, 40)}`), sorted(b))
  assert.deepEqual(await ids(`${scoped}&overdue=true`), sorted(late))
  assert.deepEqual(await ids(`${scoped}&recurring=true`), sorted(recurring))
  assert.deepEqual(await ids(`${scoped}&recurring=false&overdue=true&number=${late.number}`), sorted(late))
  assert.deepEqual(await ids(`${scoped}&from=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`), [], 'data de cadastro')
  assert.deepEqual(await ids(`${scoped}&to=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`), sorted(a, b, late, recurring))
  assert.deepEqual(await ids(`${scoped}&number=${a.number}&overdue=true`), [], 'combinar restringe')
  assert.deepEqual(await ids('text=%25'), [], 'curinga é texto literal')
  assert.equal((await get('/demands?status=invalido', memberA)).status, 400)
})

test('a migração só é desfeita sem dados', async () => {
  await assert.rejects(pool.query(schema('015_organizational_structure.rollback.sql')), /interrompida/)
  await assert.rejects(pool.query(schema('014_demands.rollback.sql')), /interrompida/)
})
