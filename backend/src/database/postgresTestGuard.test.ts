import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  postgresIntegrationTarget,
  localDockerAttestationVariable,
  normalizeIpAddress,
  resolvePostgresTestConnection,
  validateLocalDockerEndpoint,
  validateDisposableContainerDescriptor,
  verifyPostgresTestIdentity,
} from './postgresTestGuard.js'

const localTestUrl =
  'postgresql://postgres:test-only@127.0.0.1:55432/sistema_logistica_auth_test'

test('requires explicit opt-in and TEST_DATABASE_URL without DATABASE_URL fallback', () => {
  assert.throws(
    () => resolvePostgresTestConnection({ DATABASE_URL: localTestUrl }),
    /opt-in explícito ausente/,
  )
  assert.throws(
    () => resolvePostgresTestConnection({ RUN_POSTGRES_INTEGRATION_TESTS: '1' }),
    /TEST_DATABASE_URL ausente/,
  )
})

test('accepts only the exact loopback database target', () => {
  assert.deepEqual(
    resolvePostgresTestConnection({
      RUN_POSTGRES_INTEGRATION_TESTS: '1',
      TEST_DATABASE_URL: localTestUrl,
      DATABASE_URL: 'postgresql://remote.invalid/production',
    }),
    { connectionString: localTestUrl },
  )

  for (const connectionString of [
    'postgresql://postgres:test-only@remote.invalid:55432/sistema_logistica_auth_test',
    'postgresql://postgres:test-only@localhost:55432/sistema_logistica_auth_test',
    'postgresql://postgres:test-only@127.0.0.1:5432/sistema_logistica_auth_test',
    'postgresql://postgres:test-only@127.0.0.1:55432/production',
    'postgresql://other:test-only@127.0.0.1:55432/sistema_logistica_auth_test',
    `${localTestUrl}?sslmode=require`,
  ]) {
    assert.throws(
      () =>
        resolvePostgresTestConnection({
          RUN_POSTGRES_INTEGRATION_TESTS: '1',
          TEST_DATABASE_URL: connectionString,
        }),
      /destino fora dos limites/,
    )
  }
})

test('accepts only the labelled, pinned, loopback-bound disposable container', () => {
  validateDisposableContainerDescriptor({
    containerId: 'a'.repeat(64),
    label: 'true',
    image: postgresIntegrationTarget.image,
    ports: {
      '5432/tcp': [
        { HostIp: postgresIntegrationTarget.host, HostPort: postgresIntegrationTarget.hostPort },
      ],
    },
    mounts: [],
    autoRemove: true,
    running: true,
    networks: { bridge: { IPAddress: '172.18.0.2' } },
  })

  assert.throws(
    () =>
      validateDisposableContainerDescriptor({
        containerId: 'a'.repeat(64),
        label: 'true',
        image: 'postgres:latest',
        ports: {
          '5432/tcp': [
            { HostIp: '0.0.0.0', HostPort: postgresIntegrationTarget.hostPort },
          ],
        },
        mounts: ['/host/data'],
        autoRemove: false,
        running: true,
        networks: { bridge: { IPAddress: '172.18.0.2' } },
      }),
    /container não corresponde/,
  )
})

test('rejects Docker endpoints that are remote or not a local Unix socket', () => {
  assert.equal(
    validateLocalDockerEndpoint('unix:///var/run/docker.sock', false, true, true),
    '/var/run/docker.sock',
  )
  for (const endpoint of [
    'tcp://docker.example:2376',
    'ssh://docker.example',
    'npipe:////./pipe/docker_engine',
  ]) {
    assert.throws(
      () => validateLocalDockerEndpoint(endpoint, false, false, true),
      /daemon Docker não comprovadamente local/,
    )
  }
  assert.throws(
    () =>
      validateLocalDockerEndpoint(
        'unix:///var/run/docker.sock',
        true,
        true,
        true,
      ),
    /daemon Docker não comprovadamente local/,
  )
  assert.throws(
    () =>
      validateLocalDockerEndpoint(
        'unix:///var/run/docker.sock',
        false,
        true,
        false,
      ),
    /daemon Docker não comprovadamente local/,
  )
  assert.equal(localDockerAttestationVariable, 'POSTGRES_TEST_LOCAL_DOCKER_ATTESTATION')
})

test('normalizes IPv4, IPv6 and IPv4-mapped server addresses, rejecting invalid values', () => {
  assert.equal(normalizeIpAddress('172.18.0.2'), '172.18.0.2')
  assert.equal(normalizeIpAddress('2001:0db8:0:0:0:0:0:1'), '2001:db8::1')
  assert.equal(normalizeIpAddress('::ffff:172.18.0.2'), '172.18.0.2')
  assert.equal(normalizeIpAddress('not-an-ip'), null)
})

test('requires the database server address to match the inspected container', async () => {
  const pool = {
    query: async () => ({
      rows: [
        {
          database_name: postgresIntegrationTarget.databaseName,
          current_user: postgresIntegrationTarget.databaseUser,
          current_user_is_superuser: true,
          server_address: '172.18.0.2',
          server_port: postgresIntegrationTarget.serverPort,
          server_version_num: 170006,
        },
      ],
    }),
  }

  await verifyPostgresTestIdentity(pool as never, ['172.18.0.2'])
  await assert.rejects(
    () => verifyPostgresTestIdentity(pool as never, ['172.18.0.3']),
    /não corresponde ao alvo descartável/,
  )
})