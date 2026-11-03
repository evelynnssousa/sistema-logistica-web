import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

// Verifica os executores de teste. Nada aqui usa banco, Docker ou rede externa.

const projectRoot = resolve(__dirname, '..', '..')
const blockPath = resolve(projectRoot, 'backend/testing/block-remote-connections.cjs')
const remoteUrl = 'postgresql://u:p@aws-0-exemplo.pooler.supabase.com:5432/postgres'

/* eslint-disable @typescript-eslint/no-require-imports */
require(blockPath)
const isolation = require(resolve(projectRoot, 'scripts/testing/isolation.cjs'))

const minimalEnvironment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: 'test',
}

function runNode(args: string[], environment: NodeJS.ProcessEnv = minimalEnvironment) {
  return spawnSync(process.execPath, args, {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8',
    input: '',
    timeout: 30_000,
  })
}

test('a trava de rede recusa qualquer conexão remota, antes de sair da máquina', () => {
  for (const attempt of [
    () => connect({ host: 'aws-0-exemplo.pooler.supabase.com', port: 5432 }),
    () => connect(5432, 'aws-0-exemplo.pooler.supabase.com'),
    () => connect({ host: '8.8.8.8', port: 53 }),
  ]) {
    assert.throws(attempt, { code: 'E_REMOTE_CONNECTION_BLOCKED' })
  }
})

test('a trava de rede permite a própria máquina', async () => {
  const server = createServer((socket) => socket.end())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo

  for (const host of ['127.0.0.1', 'localhost']) {
    const socket = connect({ host, port })
    await once(socket, 'connect')
    socket.destroy()
  }

  server.close()
})

test('o driver do banco e o fetch também são barrados, mesmo fora do pool da aplicação', () => {
  const result = runNode(
    [
      '-e',
      `const { Client } = require('pg');
       new Client({ connectionString: process.env.DATABASE_URL }).connect()
         .then(() => console.log('CONECTOU'), (e) => console.log('pg:', e.code));
       fetch('https://aws-0-exemplo.pooler.supabase.com/')
         .then(() => console.log('CONECTOU'), (e) => console.log('fetch:', e.cause?.code ?? e.code));`,
    ],
    {
      ...minimalEnvironment,
      DATABASE_URL: remoteUrl,
      NODE_OPTIONS: `--require=${blockPath}`,
    },
  )

  assert.doesNotMatch(result.stdout, /CONECTOU/)
  assert.match(result.stdout, /pg: E_REMOTE_CONNECTION_BLOCKED/)
  assert.match(result.stdout, /fetch: E_REMOTE_CONNECTION_BLOCKED/)
})

test('todo comando de teste carrega a trava de rede e o ambiente de teste', () => {
  const { scripts } = JSON.parse(
    readFileSync(join(projectRoot, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> }

  for (const name of ['test:backend', 'test:backend:postgres']) {
    assert.match(scripts[name], /^NODE_ENV=test /, name)
    assert.match(scripts[name], /block-remote-connections\.cjs/, name)
    assert.match(scripts[name], / DATABASE_URL= /, `${name} descarta a variável do terminal`)
  }
  for (const [name, file] of [
    ['test:integration', 'scripts/run-integration-tests.cjs'],
    ['test:e2e', 'scripts/run-browser-tests.cjs'],
  ]) {
    assert.match(scripts[name], new RegExp(file.replace('.', '\\.')), name)
    assert.match(
      readFileSync(join(projectRoot, file), 'utf8'),
      /require\('\.\.\/backend\/testing\/block-remote-connections\.cjs'\)/,
      file,
    )
  }
  assert.equal(scripts['dev:backend'].includes('NODE_ENV=test'), false)
})

test('o ambiente dos processos de teste não herda DATABASE_URL nem segredos', () => {
  const previous = { ...process.env }
  process.env.DATABASE_URL = remoteUrl
  process.env.RESEND_API_KEY = 'segredo'
  process.env.PASSWORD_RESET_PEPPER = 'segredo'

  try {
    const environment = isolation.isolatedEnvironment({ PORT: '1' })
    assert.equal(environment.DATABASE_URL, undefined)
    assert.equal(environment.RESEND_API_KEY, undefined)
    assert.equal(environment.PASSWORD_RESET_PEPPER, undefined)
    assert.equal(environment.NODE_ENV, 'test')
    assert.match(environment.NODE_OPTIONS, /block-remote-connections/)
    assert.equal(environment.PORT, '1')
  } finally {
    process.env = previous
  }
})

test('as portas de teste não são as do desenvolvimento, e usá-las é recusado', async () => {
  for (const port of Object.values(isolation.testPorts) as number[]) {
    assert.equal(isolation.sharedPorts.includes(port), false, String(port))
  }
  await assert.rejects(() => isolation.assertPortsFree([3000]), /desenvolvimento/)
  await assert.rejects(() => isolation.assertPortsFree([5173]), /desenvolvimento/)
})

test('porta ocupada interrompe com mensagem clara e não encerra o ocupante', async () => {
  const server = createServer()
  server.listen(0, '0.0.0.0')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo

  try {
    await assert.rejects(
      () => isolation.assertPortsFree([port]),
      (error: Error) => {
        assert.match(error.message, new RegExp(`porta ${port}`))
        assert.match(error.message, /ocupada/)
        assert.match(error.message, /Nada foi encerrado nem reutilizado/)
        return true
      },
    )
    assert.equal(server.listening, true)
  } finally {
    server.close()
  }
})

test('o executor de navegador para antes de iniciar qualquer coisa se a porta estiver ocupada', async () => {
  const server = createServer()
  server.listen(isolation.testPorts.browserApi, '0.0.0.0')
  await once(server, 'listening')

  try {
    const child = spawn(process.execPath, ['scripts/run-browser-tests.cjs'], {
      cwd: projectRoot,
      env: minimalEnvironment,
    })
    let errorOutput = ''
    child.stderr.on('data', (chunk) => {
      errorOutput += chunk
    })
    const [code] = await once(child, 'exit')

    assert.equal(code, 1)
    assert.match(errorOutput, /está ocupada/)
    assert.match(errorOutput, /Nada foi encerrado/)
    assert.equal(server.listening, true)
  } finally {
    server.close()
  }
})

test('os executores não têm como atingir processos de terceiros', () => {
  const files = [
    'scripts/run-browser-tests.cjs',
    'scripts/run-integration-tests.cjs',
    'scripts/testing/isolation.cjs',
    'scripts/backup-database.cjs',
    'e2e/access-control.e2e.cjs',
  ]
  for (const file of files) {
    const source = readFileSync(join(projectRoot, file), 'utf8')
    assert.doesNotMatch(source, /pkill|killall|fuser|lsof|kill_port|free_port/, file)
    assert.doesNotMatch(source, /:(3000|5173)\b/, file)
  }

  for (const file of readdirSync(join(projectRoot, 'e2e'))) {
    const source = readFileSync(join(projectRoot, 'e2e', file), 'utf8')
    assert.doesNotMatch(source, /process\.env/, `${file} só usa o que o executor entrega`)
    assert.doesNotMatch(source, /https?:\/\//, `${file} não tem endereço fixo`)
  }
})

test('o script de backup recusa banco remoto em teste e não lê o .env', () => {
  const remote = runNode(['scripts/backup-database.cjs', '--schema-only'], {
    ...minimalEnvironment,
    DATABASE_URL: remoteUrl,
  })
  assert.equal(remote.status, 1)
  assert.match(remote.stderr, /Recusado/)
  assert.doesNotMatch(remote.stderr, /supabase/)

  const withoutUrl = runNode(['scripts/backup-database.cjs', '--schema-only'])
  assert.equal(withoutUrl.status, 1)
  assert.match(withoutUrl.stderr, /Recusado/)
})

test('os CLIs de administrador recusam banco remoto em teste', () => {
  const result = runNode(
    ['--require', 'tsx/cjs', 'backend/src/cli/create-initial-admin.ts'],
    { ...minimalEnvironment, DATABASE_URL: remoteUrl },
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Recusado/)
})

test('a API iniciada em modo de teste com banco remoto não conecta e não cai', async () => {
  const child = spawn(
    process.execPath,
    ['--require', 'tsx/cjs', 'backend/src/server.ts'],
    {
      cwd: projectRoot,
      env: {
        ...minimalEnvironment,
        DATABASE_URL: remoteUrl,
        PORT: '3902',
        NODE_OPTIONS: `--require=${blockPath}`,
      },
    },
  )

  try {
    let ready = false
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      ready = await fetch('http://127.0.0.1:3902/api/health').then(
        (response) => response.ok,
        () => false,
      )
      if (!ready) await new Promise((done) => setTimeout(done, 250))
    }
    assert.ok(ready, 'a API não iniciou')

    const login = await fetch('http://127.0.0.1:3902/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'x@jucesp.sp.gov.br', password: 'qualquer-senha' }),
    })
    assert.equal(login.status, 503)
    assert.doesNotMatch(await login.text(), /supabase|Recusado/)
  } finally {
    child.kill()
    await once(child, 'exit')
  }
})

test('em teste de navegador, a tela recusa encaminhar para a API do desenvolvimento', () => {
  const vite = resolve(projectRoot, 'frontend/node_modules/.bin/vite')

  for (const target of [undefined, 'http://localhost:3000', 'https://api.exemplo.com']) {
    const result = spawnSync(vite, ['build', '--outDir', '/nao-usado'], {
      cwd: resolve(projectRoot, 'frontend'),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        E2E_RUN_ID: 'execucao',
        ...(target ? { API_PROXY_TARGET: target } : {}),
      },
      encoding: 'utf8',
      timeout: 30_000,
    })

    assert.notEqual(result.status, 0, String(target))
    assert.match(`${result.stdout}${result.stderr}`, /API_PROXY_TARGET/, String(target))
  }
})
