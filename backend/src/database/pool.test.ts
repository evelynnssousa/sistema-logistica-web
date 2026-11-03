import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildPoolOptions,
  defaultCertificatePath,
  getDatabaseConfiguration,
  getDatabasePool,
} from './pool.js'

test('rejects a missing DATABASE_URL without exposing a value', () => {
  assert.throws(
    () => getDatabaseConfiguration({}),
    { message: 'DATABASE_URL ausente ou inválida.' },
  )
})

test('accepts a PostgreSQL URL and uses the default pool size', () => {
  const connectionString = 'postgresql://user:password@localhost:5432/logistica'

  assert.deepEqual(
    getDatabaseConfiguration({ DATABASE_URL: connectionString }),
    { connectionString, max: 5 },
  )
})

test('accepts a configured positive pool size', () => {
  assert.deepEqual(
    getDatabaseConfiguration({
      DATABASE_URL: 'postgres://user:password@localhost/logistica',
      DB_POOL_MAX: '12',
    }),
    {
      connectionString: 'postgres://user:password@localhost/logistica',
      max: 12,
    },
  )
})

test('rejects malformed or non-PostgreSQL connection URLs', () => {
  for (const connectionString of [
    'not-a-url',
    'https://user:password@localhost/logistica',
    'postgresql://localhost/',
  ]) {
    assert.throws(
      () => getDatabaseConfiguration({ DATABASE_URL: connectionString }),
      { message: 'DATABASE_URL ausente ou inválida.' },
    )
  }
})

test('rejects non-positive or non-integer pool sizes', () => {
  for (const max of ['0', '-1', '1.5', 'invalid']) {
    assert.throws(
      () =>
        getDatabaseConfiguration({
          DATABASE_URL: 'postgresql://localhost/logistica',
          DB_POOL_MAX: max,
        }),
      { message: 'DB_POOL_MAX deve ser um inteiro positivo.' },
    )
  }
})

test('validates configuration only when the pool is requested', () => {
  const previousUrl = process.env.DATABASE_URL
  delete process.env.DATABASE_URL

  try {
    assert.throws(
      () => getDatabasePool(),
      { message: 'DATABASE_URL ausente ou inválida.' },
    )
  } finally {
    if (previousUrl === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = previousUrl
    }
  }
})

const remoteUrl = 'postgresql://user:p%40ss@db.example.com:5432/logistica'
const fakeCertificate = () => 'CERTIFICADO-DE-TESTE'

function optionsFor(url: string, environment: NodeJS.ProcessEnv = {}) {
  return buildPoolOptions(
    { connectionString: url, max: 5 },
    environment,
    fakeCertificate,
  )
}

test('remote connections always verify the certificate', () => {
  const options = optionsFor(remoteUrl)

  assert.deepEqual(options.ssl, {
    ca: 'CERTIFICADO-DE-TESTE',
    rejectUnauthorized: true,
  })
  assert.equal(options.connectionString, remoteUrl)
})

test('the driver keeps the trusted certificate when the URL has sslmode', () => {
  // Sem a limpeza da URL, o driver trocava esta configuração por "ssl: {}".
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ConnectionParameters = require('pg/lib/connection-parameters')

  for (const mode of ['require', 'prefer', 'verify-full', 'no-verify']) {
    const options = optionsFor(`${remoteUrl}?sslmode=${mode}&application_name=slm`)
    const effective = new ConnectionParameters(options)

    assert.equal(effective.ssl.ca, 'CERTIFICADO-DE-TESTE', mode)
    assert.equal(effective.ssl.rejectUnauthorized, true, mode)
    assert.doesNotMatch(String(options.connectionString), /sslmode/)
    assert.match(String(options.connectionString), /application_name=slm/)
    assert.match(String(options.connectionString), /p%40ss/)
  }
})

test('refuses to connect to a remote database without TLS', () => {
  assert.throws(
    () => optionsFor(`${remoteUrl}?sslmode=disable`),
    { message: 'Conexões remotas com o banco precisam usar TLS.' },
  )
})

test('a local database does not use TLS unless it is requested', () => {
  const local = 'postgresql://postgres:x@127.0.0.1:55432/slm_public_test'

  assert.equal(optionsFor(local).ssl, false)
  assert.equal(optionsFor(`${local}?sslmode=disable`).ssl, false)
  assert.deepEqual(optionsFor(`${local}?sslmode=require`).ssl, {
    ca: 'CERTIFICADO-DE-TESTE',
    rejectUnauthorized: true,
  })
})

test('a host that only looks local still uses TLS', () => {
  assert.ok(optionsFor('postgresql://u:p@127.0.0.1.example.com/db').ssl)
  assert.ok(optionsFor('postgresql://u:p@localhost.example.com/db').ssl)
})

test('finds the certificate regardless of the working directory', () => {
  const previous = process.cwd()
  assert.ok(existsSync(defaultCertificatePath))
  assert.ok(defaultCertificatePath.endsWith(join('backend', 'certificates', 'prod-ca-2021.crt')))

  try {
    process.chdir('/')
    const options = buildPoolOptions({ connectionString: remoteUrl, max: 5 }, {})
    assert.deepEqual(options.ssl, {
      ca: readFileSync(defaultCertificatePath, 'utf8'),
      rejectUnauthorized: true,
    })
  } finally {
    process.chdir(previous)
  }
})

test('DATABASE_SSL_CA_PATH selects another certificate', () => {
  const requested: string[] = []
  buildPoolOptions(
    { connectionString: remoteUrl, max: 5 },
    { DATABASE_SSL_CA_PATH: '/tmp/outra-ca.crt' },
    (path) => {
      requested.push(path)
      return 'OUTRA'
    },
  )

  assert.deepEqual(requested, ['/tmp/outra-ca.crt'])
})
