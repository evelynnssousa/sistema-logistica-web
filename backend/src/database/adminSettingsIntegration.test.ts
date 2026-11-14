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
import { authRateLimits } from '../security/authRateLimits.js'
import { resetAccessSchemaCacheForTests } from './accessSchema.js'
import { requireDisposableDatabaseUrl } from './databaseSafety.js'
import { setDatabasePoolForTests } from './pool.js'
import { setProfileAdjustments } from '../auth/permissions.js'
import { lastDueMonth, openRetentionDemands, retentionDeadline } from './retentionRepository.js'
import { Readable } from 'node:stream'
import { setAttachmentStorageForTests } from '../attachments/storage.js'

// Administração do sistema em Configurações (13/11/2026). API real, PostgreSQL descartável, 001 a 022.

const password = randomBytes(24).toString('hex')
const schema = (file: string) => readFileSync(resolve(process.cwd(), 'backend/database/schema', file), 'utf8')

let pool: Pool
let server: Server
let baseUrl: string
let admin: Session
let requester: Session
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
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8')
  const type = response.headers.get('content-type') ?? ''
  const body = (type.includes('json') ? JSON.parse(text) : {}) as Record<string, any>
  const setCookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  if (setCookie && body.csrfToken) csrfTokens.set(setCookie, body.csrfToken)
  return { status: response.status, body, text, setCookie }
}

const get = (path: string, session: Session) => call(path, { session })
const post = (path: string, session: Session, body: unknown = {}) => call(path, { method: 'POST', session, body })
const put = (path: string, session: Session, body: unknown) => call(path, { method: 'PUT', session, body })

async function signIn(email: string): Promise<Session> {
  authRateLimits.loginPair.reset(`127.0.0.1|${email}`)
  authRateLimits.loginPair.reset(`::ffff:127.0.0.1|${email}`)
  authRateLimits.loginAccount.reset(email)
  const result = await call('/auth/login', { method: 'POST', body: { identifier: email, password } })
  assert.equal(result.status, 200, `login de ${email}: ${result.text}`)
  return { cookie: result.setCookie, id: result.body.user.id }
}

async function createUser(email: string, role = 'requester'): Promise<Session> {
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { fullName: `Pessoa ${email.split('@')[0]}`, email, sector: 'Protocolo', password, passwordConfirmation: password },
  })
  assert.equal(registered.status, 202, registered.text)
  const pending = await get('/admin/registrations/pending', admin)
  const id = pending.body.registrations.find((item: { email: string }) => item.email === email).id as string
  const approved = await post(`/admin/registrations/${id}/approve`, admin, { role })
  assert.equal(approved.status, 200, approved.text)
  return signIn(email)
}

before(async () => {
  process.env.PASSENGER_DATA_KEY = randomBytes(32).toString('base64')
  process.env.EMAIL_TRANSPORT = 'simulated'
  pool = new Pool({ connectionString: requireDisposableDatabaseUrl() })
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  for (const file of [
    '001_public_schema_snapshot.sql', '002_password_recovery.sql', '003_user_access.sql', '004_flight_passengers.sql',
    '005_operational_modules.sql', '006_integrations.sql', '007_operations_center.sql', '008_attachments.sql',
    '009_module_extensions.sql', '010_monitoring.sql', '011_delivery_forecast.sql', '012_operational_transparency.sql',
    '013_communications.sql', '014_demands.sql', '015_organizational_structure.sql', '016_driver_portal.sql',
    '017_driver_portal_settings.sql', '018_public_api_privileges.sql', '019_email_quota.sql', '020_warehouse_finance.sql',
    '021_contract_instruments.sql', '022_forms_and_links.sql',
  ]) {
    await pool.query(schema(file))
  }
  resetAccessSchemaCacheForTests()
  await pool.query(
    `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora', 'admin-config@example.gov.br', 'TI', $1, 'approved', 'admin', now())`,
    [await hashPassword(password)],
  )
  setDatabasePoolForTests(pool)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  admin = await signIn('admin-config@example.gov.br')
  requester = await createUser('pessoa-config@example.gov.br')
})

after(async () => {
  setProfileAdjustments({})
  for (const name of ['PASSENGER_DATA_KEY', 'EMAIL_TRANSPORT']) delete process.env[name]
  if (server) await new Promise((done) => server.close(done))
  await pool.end()
})

const save = (section: string, body: unknown, session = admin) => put(`/settings/parameters/${section}`, session, body)

test('só quem administra as configurações grava as novas seções', async () => {
  assert.equal((await save('announcement', { active: true, text: 'Teste' }, requester)).status, 403)
  assert.equal((await save('holidays', { list: [{ date: '2026-02-30', name: 'Inválido' }] })).status, 400)
})

test('aviso geral e mensagens: na tela de entrada sem sessão e em /system/info', async () => {
  assert.equal((await save('announcement', { active: true, text: 'Almoxarifado fechado dia 20', tone: 'warning', until: '2099-12-31' })).status, 200)
  assert.equal((await save('texts', { loginMessage: 'Use o e-mail institucional.', homeMessage: 'Bem-vindo ao SLM.' })).status, 200)
  const screen = await fetch(`${baseUrl}/api/public/screen`).then((response) => response.json())
  assert.equal(screen.loginMessage, 'Use o e-mail institucional.')
  assert.equal(screen.announcement.text, 'Almoxarifado fechado dia 20')
  const info = await get('/system/info', requester)
  assert.equal(info.body.homeMessage, 'Bem-vindo ao SLM.')
  assert.equal(info.body.announcement.tone, 'warning')
  assert.equal((await fetch(`${baseUrl}/api/system/info`)).status, 401)
  assert.equal((await save('announcement', { active: true, text: 'Vencido', until: '2020-01-01' })).status, 200)
  assert.equal((await get('/system/info', requester)).body.announcement, null)
})

test('domínios do cadastro: a lista da tela vale para novos pedidos de conta', async () => {
  assert.equal((await save('registration', { allowedDomains: ['jucesp.sp.gov.br'] })).status, 200)
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const refused = await call('/auth/register', {
    method: 'POST',
    body: { fullName: 'Pessoa de Fora', email: 'fora@example.gov.br', sector: 'Protocolo', password, passwordConfirmation: password },
  })
  assert.equal(refused.status, 400)
  assert.equal((await save('registration', { allowedDomains: [] })).status, 200)
  authRateLimits.registerIp.reset('127.0.0.1')
  authRateLimits.registerIp.reset('::ffff:127.0.0.1')
  const accepted = await call('/auth/register', {
    method: 'POST',
    body: { fullName: 'Pessoa de Fora', email: 'fora@example.gov.br', sector: 'Protocolo', password, passwordConfirmation: password },
  })
  assert.equal(accepted.status, 202, accepted.text)
})

test('módulo desligado: sai do /system/info e não recebe pedido novo; religado, volta', async () => {
  assert.equal((await save('modules', { maintenance: false, demands: false })).status, 200)
  assert.equal((await get('/system/info', requester)).body.modules.maintenance, false)
  const blocked = await post('/maintenance/requests', requester, {})
  assert.equal(blocked.status, 409)
  assert.match(blocked.text, /desligado/)
  assert.equal((await post('/warehouse/requests', requester, { items: [] })).status, 400, 'o Almoxarifado continua ligado')
  assert.equal((await save('modules', {})).status, 200)
  assert.notEqual((await post('/maintenance/requests', requester, {})).status, 409)
})

test('permissões padrão: o ajuste vale para as contas do perfil, e nada administrativo passa', async () => {
  const permissions = async () => (await get('/auth/me', requester)).body.user.permissions as string[]
  assert.equal((await permissions()).includes('reports:read'), false)
  assert.equal((await save('profileDefaults', { requester: { add: ['users:manage'] } })).status, 400)
  assert.equal((await save('profileDefaults', { requester: { add: ['reports:read'], remove: ['flights:create'] } })).status, 200)
  const adjusted = await permissions()
  assert.equal(adjusted.includes('reports:read'), true)
  assert.equal(adjusted.includes('flights:create'), false)
  const options = (await get('/settings/parameters', admin)).body.options.profileDefaults
  assert.ok(options.base.requester.includes('flights:create'), 'o padrão do código continua visível')
  assert.equal((await save('profileDefaults', {})).status, 200)
  assert.equal((await permissions()).includes('reports:read'), false)
})

// ---------------------------------------------------------------------------
// Formulários de leiaute fixo: nomes e campos novos (13/11/2026).
// ---------------------------------------------------------------------------
async function publishWithExtra(key: string, extra: Record<string, unknown>, rename?: { id: string; label: string }) {
  const library = await get(`/config/forms/${key}`, admin)
  assert.equal(library.status, 200, library.text)
  const base = library.body.default as { sections: unknown[]; fields: { id: string; label: string }[] }
  const fields = base.fields.map((field) => (rename && field.id === rename.id ? { ...field, label: rename.label } : field))
  const published = await post(`/config/forms/${key}/publish`, admin, {
    conteudo: {
      sections: base.sections,
      fields: [...fields, { id: 'custom-extra', label: 'Campo extra', type: 'shortText', required: true, active: true, section: 'adicionais', options: [], ...extra }],
    },
    observacao: 'Teste',
  })
  assert.equal(published.status, 200, published.text)
}

test('formulários novos: listados no gerenciador e sem campo protegido removível', async () => {
  const library = await get('/config/forms', admin)
  const keys = library.body.forms.map((form: { key: string }) => form.key)
  for (const key of ['warehouseRequest', 'warehouseExternal', 'warehouseDelivery', 'material', 'demand', 'contractInstrument', 'vehicle', 'driver', 'driverOccurrence', 'equipment', 'maintenanceExecution', 'flightQuote']) {
    assert.ok(keys.includes(key), `faltou ${key}`)
  }
  assert.equal(library.body.forms.find((form: { key: string }) => form.key === 'demand').fixedLayout, true)
  const base = (await get('/config/forms/vehicle', admin)).body.default
  const withoutPlate = base.fields.filter((field: { id: string }) => field.id !== 'plate')
  assert.equal((await post('/config/forms/vehicle/publish', admin, { conteudo: { ...base, fields: withoutPlate } })).status, 400)
})

test('campo novo obrigatório: exigido, gravado com o nome usado e devolvido na consulta', async () => {
  await publishWithExtra('vehicle', {}, { id: 'model', label: 'Modelo do veículo' })
  const managed = await get('/forms/managed/vehicle', requester)
  assert.equal(managed.status, 200)
  assert.equal(managed.body.content.fields.find((field: { id: string }) => field.id === 'model').label, 'Modelo do veículo')

  const body = { placa: 'ABC1D23', modelo: 'Van', situacao: 'disponivel', kmAtual: 10 }
  assert.equal((await post('/fleet/vehicles', admin, body)).status, 400, 'sem o campo obrigatório')
  const created = await post('/fleet/vehicles', admin, { ...body, customFields: { 'custom-extra': 'Patrimônio 123' } })
  assert.equal(created.status, 201, created.text)
  const vehicle = (await get('/fleet/vehicles', admin)).body.vehicles.find((item: { id: string }) => item.id === created.body.id)
  assert.deepEqual(vehicle.customFields, [{ id: 'custom-extra', label: 'Campo extra', value: 'Patrimônio 123' }])
  // Alterar sem enviar os campos novos não os apaga.
  assert.equal((await call(`/fleet/vehicles/${created.body.id}`, { method: 'PATCH', session: admin, body: { ...body, modelo: 'Van 2' } })).status, 200)
  const after = (await get('/fleet/vehicles', admin)).body.vehicles.find((item: { id: string }) => item.id === created.body.id)
  assert.equal(after.customFields[0].value, 'Patrimônio 123')
})

test('cadastro de equipamento: campo novo gravado; opção fora da lista é recusada', async () => {
  await publishWithExtra('equipment', { required: false })
  const equipment = await post('/maintenance/equipments', admin, { nome: 'Elevador 1', customFields: { 'custom-extra': 'Contrato 9' } })
  assert.equal(equipment.status, 201, equipment.text)
  const listed = (await get('/maintenance/equipments', admin)).body.equipments.find((item: { id: string }) => item.id === equipment.body.id)
  assert.equal(listed.customFields[0].value, 'Contrato 9')
  // Campo de lista com opção inválida é recusado no servidor.
  await publishWithExtra('equipment', { type: 'singleSelect', options: ['A', 'B'], required: false })
  assert.equal((await post('/maintenance/equipments', admin, { nome: 'Elevador 2', customFields: { 'custom-extra': 'C' } })).status, 400)
})

test('página inicial: rascunho público, fotos só de imagem, e foto sem uso sai depois', async () => {
  const home = await fetch(`${baseUrl}/api/public/home`)
  assert.equal(home.status, 200)
  const draft = (await home.json()) as { page: { heroTitle: string; faq: unknown[]; team: unknown[]; contactEmail: string } }
  assert.match(draft.page.heroTitle, /Logística e Manutenção/)
  assert.ok(draft.page.faq.length >= 3)

  const upload = async (session: Session, content: Buffer) => {
    const cookie = session.cookie
    const response = await fetch(`${baseUrl}/api/settings/public-page/photos`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', cookie, 'x-csrf-token': csrfTokens.get(cookie) ?? '' },
      body: new Uint8Array(content),
    })
    return { status: response.status, body: (await response.json()) as Record<string, string> }
  }
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
  assert.equal((await upload(requester, png)).status, 403)
  assert.equal((await upload(admin, Buffer.from('<svg onload="x">'))).status, 400)
  const first = await upload(admin, png)
  assert.equal(first.status, 201)
  const unused = await upload(admin, png)

  const saved = await put('/settings/parameters/publicPage', admin, {
    ...draft.page,
    contactEmail: 'slm@example.gov.br',
    team: [{ name: 'Pessoa da Equipe', role: 'Coordenação', photoId: first.body.photoId }],
    news: [{ date: '2026-11-13', title: 'Sistema em testes', text: 'Primeira versão.' }],
  })
  assert.equal(saved.status, 200, saved.text)
  assert.equal((await put('/settings/parameters/publicPage', admin, { ...draft.page, contactEmail: 'não-é-email' })).status, 400)
  assert.equal((await put('/settings/parameters/publicPage', admin, { ...draft.page, heroTitle: '<script>' })).status, 400)

  const published = (await (await fetch(`${baseUrl}/api/public/home`)).json()) as { page: { team: { name: string; photoUrl: string }[]; contactEmail: string } }
  assert.equal(published.page.contactEmail, 'slm@example.gov.br')
  assert.deepEqual(published.page.team.map((member) => member.name), ['Pessoa da Equipe'])
  assert.equal('photoId' in published.page.team[0], false)
  const photo = await fetch(`${baseUrl}${published.page.team[0].photoUrl}`)
  assert.equal(photo.status, 200)
  assert.equal(photo.headers.get('content-type'), 'image/png')
  assert.equal((await fetch(`${baseUrl}/api/public/team-photos/${'0'.repeat(32)}`)).status, 404)

  // Foto enviada e não usada: sai na próxima gravação, passado um dia.
  // O gatilho de updated_at refaria a data: desligado só para envelhecer as fotos no teste.
  await pool.query(`SET session_replication_role = replica; UPDATE public.system_settings SET updated_at = now() - interval '2 days' WHERE secao LIKE 'foto%'; SET session_replication_role = origin;`)
  await put('/settings/parameters/publicPage', admin, { ...draft.page, team: [{ name: 'Pessoa da Equipe', role: 'Coordenação', photoId: first.body.photoId }] })
  assert.equal((await fetch(`${baseUrl}/api/public/team-photos/${unused.body.photoId}`)).status, 404)
  assert.equal((await fetch(`${baseUrl}/api/public/team-photos/${first.body.photoId}`)).status, 200)
})


test('manuais: só PDF, só quem administra envia, e só o publicado abre na página inicial', async () => {
  // Armazenamento em memória no lugar do Supabase.
  const files = new Map<string, Buffer>()
  setAttachmentStorageForTests({
    save: async (key, content) => void files.set(key, content),
    open: async (key) => {
      const content = files.get(key)
      if (!content) throw Object.assign(new Error('ausente'), { code: 'ENOENT' })
      return Readable.from(content)
    },
    remove: async (key) => void files.delete(key),
    check: async () => undefined,
  })
  try {
    const draft = ((await (await fetch(`${baseUrl}/api/public/home`)).json()) as { page: Record<string, unknown> }).page
    const send = async (session: Session, content: Buffer, name = 'Manual do Solicitante.pdf') => {
      const response = await fetch(`${baseUrl}/api/settings/public-page/manuals?nome=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', cookie: session.cookie, 'x-csrf-token': csrfTokens.get(session.cookie) ?? '' },
        body: new Uint8Array(content),
      })
      return { status: response.status, body: (await response.json()) as Record<string, string | number> }
    }
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
    assert.equal((await send(requester, pdf)).status, 403)
    assert.equal((await send(admin, Buffer.from('não é pdf'))).status, 400)
    assert.equal((await send(admin, Buffer.from('%PDF-1.4\n<< /OpenAction << /S /JavaScript >> >>'))).status, 400, 'PDF com script')
    const sent = await send(admin, pdf)
    assert.equal(sent.status, 201, JSON.stringify(sent.body))
    assert.equal(sent.body.fileName, 'Manual do Solicitante.pdf')
    const fileId = String(sent.body.fileId)

    // Antes de salvar a página, o arquivo não abre.
    assert.equal((await fetch(`${baseUrl}/api/public/manuals/${fileId}`)).status, 404)
    // Arquivo inexistente ou sem arquivo: recusado.
    const missing = await put('/settings/parameters/publicPage', admin, { ...draft, manuals: [{ title: 'Sem arquivo', audience: '', fileId: '00000000-0000-4000-8000-000000000000' }] })
    assert.equal(missing.status, 400)
    assert.equal((await put('/settings/parameters/publicPage', admin, { ...draft, manuals: [{ title: 'Sem arquivo', audience: '', fileId: '' }] })).status, 400)

    // O nome e o tamanho vêm do servidor, não do que a tela mandou.
    const saved = await put('/settings/parameters/publicPage', admin, {
      ...draft,
      manuals: [{ title: 'Manual do Solicitante', audience: 'Solicitante', fileId, fileName: 'outro.exe', sizeBytes: 1 }],
    })
    assert.equal(saved.status, 200, saved.text)
    const home = (await (await fetch(`${baseUrl}/api/public/home`)).json()) as { page: { manuals: { title: string; audience: string; fileName: string; sizeBytes: number; url: string }[] } }
    assert.deepEqual(home.page.manuals, [
      { title: 'Manual do Solicitante', audience: 'Solicitante', fileName: 'Manual do Solicitante.pdf', sizeBytes: pdf.length, url: `/api/public/manuals/${fileId}` },
    ])
    const opened = await fetch(`${baseUrl}${home.page.manuals[0].url}`)
    assert.equal(opened.status, 200)
    assert.equal(opened.headers.get('content-type'), 'application/pdf')
    assert.match(opened.headers.get('content-disposition') ?? '', /^inline; filename\*=UTF-8''Manual%20do%20Solicitante\.pdf$/)
    assert.deepEqual(Buffer.from(await opened.arrayBuffer()), pdf)

    // Tirado da página: deixa de abrir e, passado um dia, sai do armazenamento.
    await put('/settings/parameters/publicPage', admin, { ...draft, manuals: [] })
    assert.equal((await fetch(`${baseUrl}/api/public/manuals/${fileId}`)).status, 404)
    await pool.query(`SET session_replication_role = replica; UPDATE public.system_settings SET updated_at = now() - interval '2 days' WHERE secao LIKE 'manual%'; SET session_replication_role = origin;`)
    await put('/settings/parameters/publicPage', admin, { ...draft, manuals: [] })
    assert.equal(files.has(fileId), false)
  } finally {
    setAttachmentStorageForTests(undefined)
  }
})

test('guarda dos dados: demanda para imprimir os relatórios antes do prazo, uma por mês', async () => {
  assert.equal(retentionDeadline('2025-11', 12), '2026-11-01')
  assert.equal(lastDueMonth('2026-11-14', 12, 30), '2025-12')
  assert.equal(lastDueMonth('2026-11-14', 12, 10), '2025-11')

  const adminId = (await pool.query<{ id: string }>(`SELECT id::text AS id FROM public.auth_users WHERE email = 'admin-config@example.gov.br'`)).rows[0].id
  const sector = await pool.query<{ id: string }>(`INSERT INTO public.demand_sectors (nome) VALUES ('Guarda SLM') RETURNING id::text AS id`)
  await pool.query(`INSERT INTO public.demand_categories (nome) VALUES ('Acompanhamento de processos') ON CONFLICT DO NOTHING`)
  // Pedidos de materiais de novembro e de dezembro de 2025, e um de agora.
  for (const at of ['2025-11-10T12:00:00Z', '2025-11-20T12:00:00Z', '2025-12-05T12:00:00Z']) {
    await pool.query(
      `INSERT INTO public.material_requests (origem, status, solicitante_id, registrado_por, created_at) VALUES ('interna', 'pendente', $1, $1, $2)`,
      [adminId, at],
    )
  }

  // Sem setor escolhido, nada é aberto.
  assert.equal(await openRetentionDemands('2026-11-14'), 0)
  assert.equal((await put('/settings/parameters/retention', admin, { months: 12, noticeDays: 30, sectorId: 'x' })).status, 400)
  const saved = await put('/settings/parameters/retention', admin, { months: 12, noticeDays: 30, sectorId: sector.rows[0].id })
  assert.equal(saved.status, 200, saved.text)

  // Em 25/10/2026, a menos de 30 dias de 01/11/2026: só novembro de 2025 entra; repetir não duplica.
  assert.equal(await openRetentionDemands('2026-10-25'), 1)
  assert.equal(await openRetentionDemands('2026-10-25'), 0)
  const opened = await pool.query<{ titulo: string; prazo: string; descricao: string }>(
    `SELECT titulo, to_char(prazo, 'YYYY-MM-DD') AS prazo, descricao FROM public.demands WHERE titulo LIKE 'Guarda de dados%' ORDER BY numero`,
  )
  assert.deepEqual(opened.rows.map((row) => [row.titulo, row.prazo]), [['Guarda de dados (LGPD): imprimir os relatórios de novembro de 2025', '2026-11-01']])
  assert.match(opened.rows[0].descricao, /Pedidos de materiais: 2/)
  assert.match(opened.rows[0].descricao, /01\/11\/2025 a 30\/11\/2025/)

  // Mais tarde, dezembro de 2025 também entra.
  assert.equal(await openRetentionDemands('2026-11-14'), 1)
  assert.equal((await pool.query(`SELECT 1 FROM public.demands WHERE titulo LIKE 'Guarda de dados%'`)).rowCount, 2)
})
