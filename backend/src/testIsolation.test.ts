import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { shouldRunSessionCleanup } from './auth/sessionCleanupPolicy.js'
import {
  assertDatabaseAllowedForRuntime,
  isTestRuntime,
  requireDisposableDatabaseUrl,
} from './database/databaseSafety.js'
import { getDatabasePool } from './database/pool.js'

// Nenhum destes testes abre conexão com banco de dados.

const sourceRoot = __dirname
const projectRoot = resolve(sourceRoot, '..', '..')

function testFiles(directory = sourceRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return testFiles(path)
    return entry.name.endsWith('.test.ts') ? [path] : []
  })
}

const remoteUrl = 'postgresql://u:p@aws-0-exemplo.pooler.supabase.com:5432/postgres'

test('o banco de teste precisa ser local e ter nome terminado em _test', () => {
  for (const url of [
    remoteUrl,
    'postgresql://u:p@aws-0-exemplo.pooler.supabase.com:5432/banco_test',
    'postgresql://u:p@localhost:5432/postgres',
    'postgresql://u:p@127.0.0.1:5432/producao',
    'postgresql://u:p@localhost.exemplo.com:5432/banco_test',
    'postgresql://u:p@127.0.0.1.exemplo.com:5432/banco_test',
    'nao-e-url',
  ]) {
    assert.throws(
      () => requireDisposableDatabaseUrl({ TEST_DATABASE_URL: url }),
      /Recusado/,
      url,
    )
  }

  assert.throws(() => requireDisposableDatabaseUrl({}), /Defina TEST_DATABASE_URL/)

  // DATABASE_URL nunca serve de substituta.
  assert.throws(
    () => requireDisposableDatabaseUrl({ DATABASE_URL: 'postgresql://u:p@localhost/x_test' }),
    /Defina TEST_DATABASE_URL/,
  )

  const local = 'postgresql://u:p@127.0.0.1:55432/slm_public_test'
  assert.equal(requireDisposableDatabaseUrl({ TEST_DATABASE_URL: local }), local)
})

test('reconhece execução de teste por qualquer um dos caminhos', () => {
  const argv = ['node', 'backend/src/server.ts']

  assert.equal(isTestRuntime({ NODE_ENV: 'test' }, argv), true)
  assert.equal(isTestRuntime({ NODE_TEST_CONTEXT: 'child-v8' }, argv), true)
  assert.equal(isTestRuntime({}, ['node', 'backend/src/routes/x.test.ts']), true)
  assert.equal(isTestRuntime({}, argv), false)
  assert.equal(isTestRuntime({ NODE_ENV: 'production' }, argv), false)
})

test('em teste, o pool comum recusa o banco remoto, mesmo com DATABASE_URL definida', () => {
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = remoteUrl

  try {
    assert.throws(() => getDatabasePool(), /Recusado/)
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }

  assert.throws(
    () => assertDatabaseAllowedForRuntime(remoteUrl, { NODE_ENV: 'test' }, ['node', 'x.ts']),
    /Recusado/,
  )
  assert.doesNotThrow(() =>
    assertDatabaseAllowedForRuntime(remoteUrl, {}, ['node', 'backend/src/server.ts']),
  )
})

test('em teste, o arquivo .env do backend não é carregado', () => {
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: 'test' }

  const result = spawnSync(
    process.execPath,
    [
      '--require',
      'tsx/cjs',
      '-e',
      `require('./backend/src/loadEnvironment.ts');
       console.log(Object.keys(process.env).includes('DATABASE_URL'))`,
    ],
    { cwd: projectRoot, env: environment, encoding: 'utf8' },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim().split('\n').at(-1), 'false')
})

test('nenhum teste importa o carregador do .env, o servidor ou o dotenv', () => {
  for (const file of testFiles()) {
    if (file === __filename) continue
    const source = readFileSync(file, 'utf8')
    const name = relative(projectRoot, file)

    assert.doesNotMatch(source, /loadEnvironment/, name)
    assert.doesNotMatch(source, /from 'dotenv'|require\('dotenv'\)/, name)
    assert.doesNotMatch(source, /['/]server\.js'/, name)
  }
})

test('todo teste que abre conexão própria usa o banco descartável verificado', () => {
  for (const file of testFiles()) {
    if (file === __filename) continue
    const source = readFileSync(file, 'utf8')

    if (/new Pool\(/.test(source)) {
      assert.match(
        source,
        /new Pool\(\{ connectionString: requireDisposableDatabaseUrl\(\) \}\)/,
        relative(projectRoot, file),
      )
    }
  }
})

test('os comandos de teste marcam o ambiente e cobrem todos os arquivos de teste', () => {
  const { scripts } = JSON.parse(
    readFileSync(join(projectRoot, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> }

  assert.match(scripts['test:backend'], /^NODE_ENV=test /)
  assert.match(scripts['test:backend:postgres'], /^NODE_ENV=test /)

  const listed = `${scripts['test:backend']} ${scripts['test:backend:postgres']}`
  for (const file of testFiles()) {
    const name = relative(projectRoot, file).replaceAll('\\', '/')
    assert.ok(listed.includes(name), `${name} não está em nenhum comando de teste`)
  }
})

test('a limpeza de sessões só roda sozinha em produção', () => {
  assert.equal(shouldRunSessionCleanup({}), false)
  assert.equal(shouldRunSessionCleanup({ NODE_ENV: 'development' }), false)
  assert.equal(shouldRunSessionCleanup({ NODE_ENV: 'test' }), false)
  assert.equal(shouldRunSessionCleanup({ NODE_ENV: 'production' }), true)

  assert.equal(
    shouldRunSessionCleanup({ NODE_ENV: 'production', SESSION_CLEANUP_ENABLED: 'false' }),
    false,
  )
  assert.equal(
    shouldRunSessionCleanup({ NODE_ENV: 'development', SESSION_CLEANUP_ENABLED: 'true' }),
    true,
  )
})

test('fora dos testes, só pool.ts abre conexão com o banco', () => {
  const visit = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return visit(path)
      return /\.[cm]?[jt]s$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : []
    })

  const openers = visit(sourceRoot).filter((file) =>
    /new (Pool|Client)\(/.test(readFileSync(file, 'utf8')),
  )
  assert.deepEqual(
    openers.map((file) => relative(projectRoot, file).replaceAll('\\', '/')),
    ['backend/src/database/pool.ts'],
  )
})

test('testes que gravam no banco só usam contas de domínios reservados', () => {
  for (const file of testFiles()) {
    if (!/Integration|accessMigration/.test(file)) continue
    const emails = readFileSync(file, 'utf8').match(/[\w.-]+@[\w.-]+\.[a-z]+/g) ?? []
    for (const email of emails) {
      assert.match(
        email,
        /@(example\.gov\.br|x\.test|slm-e2e\.invalid)$/,
        relative(projectRoot, file),
      )
    }
  }
})
