#!/usr/bin/env node
/**
 * Ambiente demonstrativo do Controle de Demandas, para inspeção visual em desenvolvimento.
 *
 * Nunca alcança o banco real: mesmo isolamento dos testes de navegador (portas próprias, recusadas se
 * ocupadas; PostgreSQL descartável, em memória; ambiente sem as variáveis do terminal; trava de rede).
 * Os dados demonstrativos só existem aqui: este script não faz parte do servidor nem das migrações,
 * e tudo some ao encerrar. A senha é nova a cada execução.
 */
require('../backend/testing/block-remote-connections.cjs')
const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const {
  assertPortsFree,
  isolatedEnvironment,
  projectRoot,
  startDisposablePostgres,
  testPorts,
} = require('./testing/isolation.cjs')

const apiPort = testPorts.demoApi
const frontendPort = testPorts.demoFrontend
const apiUrl = `http://127.0.0.1:${apiPort}`
const domain = 'slm-demo.invalid'

const { CODESPACE_NAME, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN } = process.env
const publicUrl =
  CODESPACE_NAME && GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
    ? `https://${CODESPACE_NAME}-${frontendPort}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
    : `http://localhost:${frontendPort}`

const accounts = [
  { key: 'servidorCompras', name: 'Sofia Servidora', profile: 'Servidor do setor (Compras)' },
  { key: 'chefeCompras', name: 'Caio Chefe', profile: 'Chefe do setor (Compras)' },
  { key: 'servidorContratos', name: 'Sérgio Servidor', profile: 'Servidor do setor (Contratos)' },
  { key: 'chefeContratos', name: 'Clara Chefe', profile: 'Chefe do setor (Contratos)' },
  { key: 'diretor', name: 'Dora Diretora', profile: 'Diretor da DA' },
  { key: 'administrador', name: 'Ana Administradora', profile: 'Administrador do sistema' },
  { key: 'adminDiretor', name: 'Davi Administrador e Diretor', profile: 'Administrador + Diretor' },
  { key: 'servidorChefe', name: 'Sara Servidora e Chefe', profile: 'Servidor (Compras) + Chefe (Patrimônio)' },
].map((item) => ({ ...item, email: `${item.key.replace(/[A-Z]/g, (letter) => `.${letter.toLowerCase()}`)}@${domain}` }))

const started = []

function startProcess(label, command, args, options) {
  const child = spawn(command, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = []
  child.stdout.on('data', (chunk) => output.push(chunk))
  child.stderr.on('data', (chunk) => output.push(chunk))
  const entry = { label, child, output: () => Buffer.concat(output).toString('utf8') }
  started.push(entry)
  return entry
}

function stopStarted() {
  for (const { child } of started) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // Já encerrado.
    }
  }
}

async function waitForRun(url, runId, entry) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (entry.child.exitCode !== null) throw new Error(`${entry.label} terminou ao iniciar:\n${entry.output().slice(-800)}`)
    try {
      const response = await fetch(url)
      if (response.ok) {
        if (response.headers.get('x-slm-e2e-run') !== runId) throw new Error(`${url} respondeu, mas não é desta execução.`)
        return
      }
    } catch (error) {
      if (error.message.includes('não é desta')) throw error
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`${entry.label} não respondeu a tempo:\n${entry.output().slice(-800)}`)
}

async function prepareDatabase(url, passwordHash) {
  const { Client } = require('pg')
  const directory = resolve(projectRoot, 'backend/database/schema')
  const files = readdirSync(directory).filter((file) => /^\d{3}_.*\.sql$/.test(file) && !file.endsWith('.rollback.sql')).sort()
  for (const file of files) {
    const client = new Client({ connectionString: url })
    await client.connect()
    if (file.startsWith('001')) await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
    await client.query(readFileSync(join(directory, file), 'utf8'))
    await client.end()
  }
  const client = new Client({ connectionString: url })
  await client.connect()
  // A administradora entra aprovada; as demais contas passam pela aprovação real da API.
  for (const account of accounts) {
    const isAdmin = account.key === 'administrador'
    await client.query(
      `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
       VALUES ($1, $2, 'Diretoria Administrativa', $3, $4, $5, CASE WHEN $4 = 'approved' THEN now() END)`,
      [account.name, account.email, passwordHash, isAdmin ? 'approved' : 'pending', isAdmin ? 'admin' : null],
    )
  }
  return client
}

/** Sessão real na API, com o cookie e o token CSRF de cada pessoa. */
async function signIn(email, password) {
  const login = await fetch(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: email, password }),
  })
  const body = await login.json()
  if (login.status !== 200) throw new Error(`Login de ${email}: ${login.status}`)
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  const send = async (method, path, payload, raw) => {
    const response = await fetch(`${apiUrl}/api${path}`, {
      method,
      headers: {
        cookie,
        'x-csrf-token': body.csrfToken,
        'content-type': raw ? 'application/octet-stream' : 'application/json',
        ...(raw ? { 'x-file-name': encodeURIComponent(raw.name) } : {}),
      },
      body: raw ? raw.content : payload === undefined ? undefined : JSON.stringify(payload),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`)
    return data
  }
  return { id: body.user.id, get: (path) => send('GET', path), post: (path, data = {}) => send('POST', path, data), put: (path, data = {}) => send('PUT', path, data), upload: (path, raw) => send('POST', path, undefined, raw) }
}

const addDays = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')

async function seed(client, password) {
  const admin = await signIn('administrador@' + domain, password)
  const pending = (await admin.get('/admin/registrations/pending')).registrations
  const ids = {}
  for (const account of accounts) {
    if (account.key === 'administrador') continue
    const { id } = pending.find((item) => item.email === account.email)
    ids[account.key] = id
    await admin.post(`/admin/registrations/${id}/approve`, { role: 'requester' })
  }
  await admin.put(`/admin/users/${ids.adminDiretor}/access`, { role: 'administrator', slmMember: false, grantedPermissions: [], deniedPermissions: [] })

  const sector = async (name, acronym) => (await admin.post('/demands/settings/sectors', { name, acronym })).id
  const compras = await sector('Compras', 'COMP')
  const contratos = await sector('Contratos', 'CONT')
  const patrimonio = await sector('Patrimônio', 'PATR')
  const member = (sectorId, userId, role) =>
    admin.put(`/demands/settings/sectors/${sectorId}/members/${userId}`, { role, chefia: role === 'responsavel' })
  await member(compras, ids.servidorCompras, 'colaborador')
  await member(compras, ids.chefeCompras, 'responsavel')
  await member(contratos, ids.servidorContratos, 'colaborador')
  await member(contratos, ids.chefeContratos, 'responsavel')
  await member(compras, ids.servidorChefe, 'colaborador')
  await member(patrimonio, ids.servidorChefe, 'responsavel')
  await admin.put(`/demands/settings/directorate/${ids.diretor}`, { role: 'diretor', function: 'Diretora Administrativa' })
  await admin.put(`/demands/settings/directorate/${ids.adminDiretor}`, { role: 'diretor' })

  const diretor = await signIn(`diretor@${domain}`, password)
  const servidor = await signIn(`servidor.compras@${domain}`, password)
  const categories = (await diretor.get('/demands/options')).categories
  const base = (title, sectorId, extra = {}) => ({
    title,
    description: `Demanda demonstrativa: ${title.toLowerCase()}.`,
    categoryId: categories[0].id,
    originSectorId: sectorId,
    responsibleSectorId: sectorId,
    priority: 'media',
    dueDate: addDays(15),
    ...extra,
  })
  const create = (who, title, sectorId, extra) => who.post('/demands', base(title, sectorId, extra))

  const atrasada = await create(diretor, 'Renovar contrato de limpeza', compras, { responsibleId: ids.servidorCompras, priority: 'alta' })
  await diretor.post(`/demands/${atrasada.id}/status`, { status: 'em_andamento' })
  await diretor.post(`/demands/${atrasada.id}/subtasks`, { title: 'Reunir as três cotações', responsibleId: ids.servidorCompras, dueDate: addDays(3) })
  await diretor.post(`/demands/${atrasada.id}/comments`, { text: 'Aguardando a última cotação do fornecedor.', kind: 'andamento' })
  await diretor.upload(`/demands/${atrasada.id}/attachments`, { name: 'cotacoes.pdf', content: pdf })

  await create(servidor, 'Levantar o estoque de papel', compras, { priority: 'baixa' })
  await create(diretor, 'Prestação de contas semanal', compras, { dueDate: undefined, responsibleId: ids.chefeCompras, recurrence: { frequency: 'semanal', startDate: addDays(0) } })
  const concluida = await create(diretor, 'Comprar cadeiras para a recepção', compras, { responsibleId: ids.servidorCompras })
  await diretor.post(`/demands/${concluida.id}/complete`, { done: 'Cadeiras entregues e conferidas.' })
  await create(diretor, 'Apurar compra sem cotação', compras, { restricted: true, responsibleId: ids.chefeCompras, priority: 'urgente' })
  await create(diretor, 'Aditivo do contrato de TI', contratos, { collaboratorSectorIds: [compras], responsibleId: ids.chefeContratos })

  const terceiros = await create(diretor, 'Revisar contrato de vigilância', contratos, { responsibleId: ids.servidorContratos })
  await diretor.post(`/demands/${terceiros.id}/status`, { status: 'aguardando_terceiros', waitingFor: 'Procuradoria' })
  await create(diretor, 'Renovar o seguro predial', contratos, { priority: 'alta' })
  await create(diretor, 'Inventário anual de bens', patrimonio, { responsibleId: ids.servidorChefe })

  // Deixa exemplos vencidos, que o cadastro normal não aceitaria criar.
  await client.query(`UPDATE public.demands SET prazo = current_date - 5 WHERE id = $1`, [atrasada.id])
  await client.query(`UPDATE public.demands SET prazo = current_date - 2 WHERE id = $1`, [terceiros.id])
}

async function main() {
  await assertPortsFree([apiPort, frontendPort, testPorts.demoDatabase])

  const runId = randomBytes(16).toString('hex')
  const password = `Demo-${randomBytes(6).toString('hex')}`
  const attachmentsDirectory = mkdtempSync(join(tmpdir(), 'slm-demo-anexos-'))
  let database

  const finish = () => {
    stopStarted()
    database?.stop()
    rmSync(attachmentsDirectory, { recursive: true, force: true })
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      finish()
      process.exit(0)
    })
  }

  try {
    database = await startDisposablePostgres({ port: testPorts.demoDatabase, database: 'slm_demo_demandas_test' })
    const argon2 = require('argon2')
    const client = await prepareDatabase(database.url, await argon2.hash(password, { type: argon2.argon2id }))

    const api = startProcess('A API demonstrativa', resolve(projectRoot, 'node_modules/.bin/tsx'), ['watch', 'backend/src/server.ts'], {
      cwd: projectRoot,
      env: isolatedEnvironment({
        DATABASE_URL: database.url,
        PORT: String(apiPort),
        FRONTEND_URL: publicUrl,
        E2E_RUN_ID: runId,
        PASSENGER_DATA_KEY: randomBytes(32).toString('base64'),
        EMAIL_TRANSPORT: 'simulated',
        INTEGRATIONS_WORKER_ENABLED: 'true',
        DEMANDS_WORKER_ENABLED: 'true',
        ATTACHMENTS_DIR: attachmentsDirectory,
      }),
    })
    await waitForRun(`${apiUrl}/api/health`, runId, api)
    await seed(client, password)
    await client.end()

    // Servidor de desenvolvimento: as alterações na tela aparecem sem reiniciar.
    const frontendDirectory = resolve(projectRoot, 'frontend')
    const frontend = startProcess(
      'A tela demonstrativa',
      resolve(frontendDirectory, 'node_modules/.bin/vite'),
      ['--port', String(frontendPort), '--strictPort'],
      {
        cwd: frontendDirectory,
        env: isolatedEnvironment({
          NODE_ENV: 'development',
          API_PROXY_TARGET: apiUrl,
          E2E_RUN_ID: runId,
          SLM_FRONTEND_PORT: String(frontendPort),
          ...(CODESPACE_NAME && GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ? { CODESPACE_NAME, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN } : {}),
        }),
      },
    )
    await waitForRun(`http://127.0.0.1:${frontendPort}/api/health`, runId, frontend)

    console.log('\nControle de Demandas: ambiente demonstrativo no ar. Nada aqui toca o banco real.\n')
    console.log(`Endereço: ${publicUrl}/demandas`)
    console.log(`Senha de todas as contas: ${password}\n`)
    for (const account of accounts) console.log(`  ${account.profile.padEnd(42)} ${account.email}`)
    console.log('\nCtrl+C encerra e apaga todos os dados demonstrativos.')

    await new Promise((_, reject) => {
      for (const entry of started) {
        entry.child.once('exit', () => reject(new Error(`${entry.label} encerrou:\n${entry.output().slice(-800)}`)))
      }
    })
  } catch (error) {
    finish()
    throw error
  }
}

main().catch((error) => {
  console.error(`\nAmbiente demonstrativo interrompido: ${error.message}`)
  process.exitCode = 1
})
