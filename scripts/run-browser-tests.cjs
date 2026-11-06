#!/usr/bin/env node
/**
 * Testes de navegador totalmente isolados:
 * - portas próprias, recusadas se estiverem ocupadas, sem reutilizar nada;
 * - banco descartável e senha aleatória, nova a cada execução;
 * - backend e frontend iniciados aqui, sem herdar variáveis do terminal;
 * - cada resposta da API precisa trazer o identificador desta execução;
 * - no fim, confere que os dados chegaram ao banco descartável.
 */
require('../backend/testing/block-remote-connections.cjs')
const { execFileSync, spawn, spawnSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const {
  assertPortsFree,
  isolatedEnvironment,
  projectRoot,
  startDisposablePostgres,
  testPorts,
} = require('./testing/isolation.cjs')

const apiPort = testPorts.browserApi
const frontendPort = testPorts.browserFrontend
const apiUrl = `http://127.0.0.1:${apiPort}`
const frontendUrl = `http://127.0.0.1:${frontendPort}`
const started = []

function startProcess(label, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  child.stdout.on('data', (chunk) => output.push(chunk))
  child.stderr.on('data', (chunk) => output.push(chunk))
  const entry = { label, child, output: () => Buffer.concat(output).toString('utf8') }
  started.push(entry)
  return entry
}

// O grupo de processos foi criado aqui: nada de fora é atingido.
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (entry.child.exitCode !== null) {
      throw new Error(`${entry.label} terminou ao iniciar:\n${entry.output().slice(-800)}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) {
        const header = response.headers.get('x-slm-e2e-run')
        if (header !== runId) {
          throw new Error(`${url} respondeu, mas não é o backend desta execução. Teste cancelado.`)
        }
        return
      }
    } catch (error) {
      if (error.message.includes('não é o backend')) throw error
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`${entry.label} não respondeu a tempo:\n${entry.output().slice(-800)}`)
}

function remoteSocketsOfStartedProcesses() {
  const groups = started.map(({ child }) => String(child.pid))
  const pids = new Set()
  for (const group of groups) {
    const result = spawnSync('ps', ['-o', 'pid=', '-g', group], { encoding: 'utf8' })
    result.stdout.split('\n').map((item) => item.trim()).filter(Boolean).forEach((pid) => pids.add(pid))
  }

  return execFileSync('ss', ['-tnp'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => [...pids].some((pid) => line.includes(`pid=${pid},`)))
    .filter((line) => {
      const peer = line.trim().split(/\s+/)[4] ?? ''
      return !/^(127\.|\[::1\]|\[::ffff:127\.)/.test(peer)
    })
}

async function prepareDatabase(url, passwordHash) {
  const { Client } = require('pg')

  for (const file of [
    '001_public_schema_snapshot.sql',
    '002_password_recovery.sql',
    '003_user_access.sql',
    '004_flight_passengers.sql',
    '005_operational_modules.sql',
    '006_integrations.sql',
    '007_operations_center.sql',
    '008_attachments.sql',
    '009_module_extensions.sql',
    '010_monitoring.sql',
    '011_delivery_forecast.sql',
    '012_operational_transparency.sql',
    '013_communications.sql',
    '014_demands.sql',
    '015_organizational_structure.sql',
    '016_driver_portal.sql',
    '017_driver_portal_settings.sql',
    '018_public_api_privileges.sql',
    // E2E_REAL_ENV reproduz o desenvolvimento: só as migrações presentes no banco real e a tela do Vite.
  ].filter((file) => !process.env.E2E_REAL_ENV || /^00[12]_/.test(file))) {
    const client = new Client({ connectionString: url })
    await client.connect()
    if (file.startsWith('001')) {
      await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
    }
    await client.query(
      readFileSync(resolve(projectRoot, 'backend/database/schema', file), 'utf8'),
    )
    await client.end()
  }

  const client = new Client({ connectionString: url })
  await client.connect()
  await client.query(
    `INSERT INTO public.auth_users
      (full_name, email, sector, password_hash, status, role, decided_at)
     VALUES ('Administradora E2E', 'e2e-admin@slm-e2e.invalid', 'TI', $1, 'approved', 'admin', now())`,
    [passwordHash],
  )
  // Operadora da equipe SLM, com as concessões de agendar e de previsão de entrega (P-08). A
  // administradora acima fica fora da equipe, como no banco real: ela administra o sistema e o
  // Almoxarifado, mas não agenda nem informa previsão.
  if (!process.env.E2E_REAL_ENV) {
    await client.query(
      `INSERT INTO public.auth_users
        (full_name, email, sector, password_hash, status, role, decided_at)
       VALUES ('Operadora SLM E2E', 'e2e-slm@slm-e2e.invalid', 'SLM', $1, 'approved', 'operator', now())`,
      [passwordHash],
    )
    await client.query(
      `INSERT INTO public.auth_user_access (user_id, profile, slm_member, granted_permissions)
       SELECT id, 'slm_operator', true, ARRAY['requests:schedule', 'warehouse:manage', 'warehouse:forecast']
         FROM public.auth_users WHERE email = 'e2e-slm@slm-e2e.invalid'`,
    )
  }
  // Contas do cenário demand-permissions, criadas aqui para não gastar o limite de cadastros por IP.
  for (const key of ['servidor', 'chefe', 'diretor']) {
    await client.query(
      `INSERT INTO public.auth_users
        (full_name, email, sector, password_hash, status, role, decided_at)
       VALUES ($1, $2, 'Administração', $3, 'approved', 'operator', now())`,
      [`Pessoa matriz ${key}`, `e2e-matriz-${key}@slm-e2e.invalid`, passwordHash],
    )
  }
  // Contas do cenário driver-portal. O perfil Motorista é definido pelo próprio cenário, como na vida real.
  for (const key of ['um', 'dois', 'config']) {
    await client.query(
      `INSERT INTO public.auth_users
        (full_name, email, sector, password_hash, status, role, decided_at)
       VALUES ($1, $2, 'Transporte', $3, 'approved', 'operator', now())`,
      [`Pessoa motorista ${key}`, `e2e-motorista-${key}@slm-e2e.invalid`, passwordHash],
    )
  }
  await client.end()
}

async function confirmDataReachedDisposableDatabase(url) {
  const { Client } = require('pg')
  const client = new Client({ connectionString: url })
  await client.connect()
  const accounts = await client.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE email NOT LIKE '%@slm-e2e.invalid')::int AS outras
       FROM public.auth_users`,
  )
  const audit = await client.query(
    `SELECT count(*) FILTER (WHERE action = 'auth.login')::int AS logins,
            count(*) FILTER (WHERE action = 'registration.requested')::int AS cadastros
       FROM public.auth_audit_events`,
  )
  await client.end()

  const { total, outras } = accounts.rows[0]
  const { logins, cadastros } = audit.rows[0]
  if (outras !== 0 || cadastros < 1 || logins < 1) {
    throw new Error('Os dados do teste não chegaram ao banco descartável como esperado.')
  }
  return { contas: total, logins, cadastros }
}

async function main() {
  await assertPortsFree([apiPort, frontendPort, testPorts.browserDatabase])

  let playwright
  try {
    playwright = require('playwright')
  } catch {
    throw new Error('Playwright não encontrado. Rode: npm ci')
  }
  if (!existsSync(playwright.chromium.executablePath())) {
    throw new Error('Navegador não encontrado. Rode: npx playwright install chromium')
  }

  const runId = randomBytes(16).toString('hex')
  const password = randomBytes(24).toString('hex')
  const buildDirectory = mkdtempSync(join(tmpdir(), 'slm-e2e-'))
  const attachmentsDirectory = mkdtempSync(join(tmpdir(), 'slm-e2e-anexos-'))
  let database

  const finish = () => {
    stopStarted()
    database?.stop()
    rmSync(buildDirectory, { recursive: true, force: true })
    rmSync(attachmentsDirectory, { recursive: true, force: true })
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      finish()
      process.exit(130)
    })
  }

  try {
    database = await startDisposablePostgres({
      port: testPorts.browserDatabase,
      database: 'slm_navegador_test',
    })

    const argon2 = require('argon2')
    await prepareDatabase(
      database.url,
      await argon2.hash(password, { type: argon2.argon2id }),
    )

    const api = startProcess(
      'A API de teste',
      resolve(projectRoot, 'node_modules/.bin/tsx'),
      ['backend/src/server.ts'],
      {
        cwd: projectRoot,
        env: isolatedEnvironment({
          DATABASE_URL: database.url,
          PORT: String(apiPort),
          FRONTEND_URL: frontendUrl,
          E2E_RUN_ID: runId,
          // Chave descartável, nova a cada execução. Os CPFs fictícios somem com o banco.
          PASSENGER_DATA_KEY: randomBytes(32).toString('base64'),
          // Simulados: nada sai da máquina. O worker processa as filas como em produção.
          EMAIL_TRANSPORT: 'simulated',
          GOOGLE_CALENDAR_TRANSPORT: 'simulated',
          INTEGRATIONS_WORKER_ENABLED: 'true',
          DEMANDS_WORKER_ENABLED: 'true',
          // Pasta descartável para os anexos fictícios desta execução.
          ATTACHMENTS_DIR: attachmentsDirectory,
        }),
      },
    )
    await waitForRun(`${apiUrl}/api/health`, runId, api)

    const frontendDirectory = resolve(projectRoot, 'frontend')
    const viteEnvironment = isolatedEnvironment({
      API_PROXY_TARGET: apiUrl,
      E2E_RUN_ID: runId,
      NODE_ENV: 'production',
    })
    const vite = resolve(frontendDirectory, 'node_modules/.bin/vite')
    const build = process.env.E2E_REAL_ENV
      ? { status: 0 }
      : spawnSync(
          vite,
          ['build', '--outDir', buildDirectory, '--emptyOutDir', '--logLevel', 'error'],
          { cwd: frontendDirectory, env: viteEnvironment, encoding: 'utf8' },
        )
    if (build.status !== 0) {
      throw new Error(`Falha ao gerar a tela de teste:\n${build.stderr.slice(-800)}`)
    }

    const frontend = startProcess(
      'A tela de teste',
      vite,
      process.env.E2E_REAL_ENV
        ? ['--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort']
        : ['preview', '--outDir', buildDirectory, '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'],
      { cwd: frontendDirectory, env: viteEnvironment },
    )
    // Passa pelo proxy: confirma o caminho inteiro, da tela até o backend desta execução.
    await waitForRun(`${frontendUrl}/api/health`, runId, frontend)

    // E2E_ONLY roda cenários escolhidos, separados por vírgula, durante uma investigação.
    const selected = process.env.E2E_ONLY?.split(',')
    for (const scenario of selected ?? ['session-persistence', 'access-control', 'operational-modules', 'integrations', 'operations-center', 'transparency', 'communications', 'demands', 'demand-permissions', 'driver-portal', 'driver-portal-settings', 'visual-review']) {
      await require(`../e2e/${scenario}.e2e.cjs`).run({
        playwright,
        baseUrl: frontendUrl,
        runId,
        password,
        // Opcional: pasta para guardar as capturas de tela, com dados fictícios desta execução.
        screenshotDirectory: process.env.E2E_SCREENSHOT_DIR,
      })
    }

    const remoteSockets = remoteSocketsOfStartedProcesses()
    if (remoteSockets.length > 0) {
      throw new Error('Um processo de teste abriu conexão fora da própria máquina.')
    }

    const landed = await confirmDataReachedDisposableDatabase(database.url)
    console.log(
      `\nBanco descartável: ${landed.contas} contas fictícias, ${landed.cadastros} cadastros, ${landed.logins} logins.`,
    )
    console.log('Conexões de rede dos processos de teste fora da máquina: nenhuma.')
    console.log('Testes de navegador concluídos.')
  } finally {
    finish()
  }
}

main().catch((error) => {
  console.error(`\nTestes de navegador interrompidos: ${error.message}`)
  process.exitCode = 1
})
