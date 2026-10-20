import { execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { isIP } from 'node:net'
import { Pool } from 'pg'

export const postgresIntegrationTarget = {
  containerName: 'sistema-logistica-auth-test',
  databaseName: 'sistema_logistica_auth_test',
  databaseUser: 'postgres',
  image: 'postgres:17.6',
  host: '127.0.0.1',
  hostPort: '55432',
  serverPort: 5432,
  serverMajor: 17,
  containerLabel: 'com.sistema-logistica.postgres-test',
} as const

export const localDockerAttestationVariable =
  'POSTGRES_TEST_LOCAL_DOCKER_ATTESTATION'

export type PostgresTestConnectionConfig = {
  connectionString: string
}

export function normalizeIpAddress(address: string): string | null {
  if (isIP(address) === 0) return null
  if (isIP(address) === 4) return address

  const mappedIpv4 = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (mappedIpv4 && isIP(mappedIpv4[1]) === 4) return mappedIpv4[1]

  try {
    return new URL(`http://[${address}]/`).hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase()
  } catch {
    return null
  }
}

export type PostgresTestIdentity = {
  databaseName: string
  currentUser: string
  currentUserIsSuperuser: boolean
  serverAddress: string | null
  serverPort: number
  serverVersionMajor: number
}

export type DisposablePostgresContainer = {
  containerId: string
  networkAddresses: string[]
  dockerEndpoint: string
}

type ValidatedContainerDescriptor = Pick<
  DisposablePostgresContainer,
  'containerId' | 'networkAddresses'
>

type DockerPortBinding = {
  HostIp: string
  HostPort: string
}

type DockerContainerDescriptor = {
  containerId: string
  label: string
  image: string
  ports: Record<string, DockerPortBinding[] | null>
  mounts: unknown[] | null
  autoRemove: boolean
  running: boolean
  networks: Record<string, DockerNetwork> | null
}

type DockerNetwork = {
  IPAddress?: string
  GlobalIPv6Address?: string
}

export function resolvePostgresTestConnection(
  environment: NodeJS.ProcessEnv = process.env,
): PostgresTestConnectionConfig {
  if (environment.RUN_POSTGRES_INTEGRATION_TESTS !== '1') {
    throw new Error('Testes PostgreSQL bloqueados: opt-in explícito ausente.')
  }

  const connectionString = environment.TEST_DATABASE_URL?.trim()
  if (!connectionString) {
    throw new Error('Testes PostgreSQL bloqueados: TEST_DATABASE_URL ausente.')
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(connectionString)
  } catch {
    throw new Error('Testes PostgreSQL bloqueados: URL de teste inválida.')
  }

  if (
    !['postgres:', 'postgresql:'].includes(parsedUrl.protocol) ||
    parsedUrl.hostname !== postgresIntegrationTarget.host ||
    parsedUrl.port !== postgresIntegrationTarget.hostPort ||
    parsedUrl.username !== postgresIntegrationTarget.databaseUser ||
    !parsedUrl.password ||
    parsedUrl.pathname !== `/${postgresIntegrationTarget.databaseName}` ||
    parsedUrl.search !== '' ||
    parsedUrl.hash !== ''
  ) {
    throw new Error(
      'Testes PostgreSQL bloqueados: destino fora dos limites locais de teste.',
    )
  }
  return { connectionString }
}

export function validateDisposableContainerDescriptor(
  descriptor: DockerContainerDescriptor,
): ValidatedContainerDescriptor {
  const portBindings = descriptor.ports['5432/tcp'] ?? []
  const onlyExpectedPort =
    Object.keys(descriptor.ports).length === 1 &&
    portBindings.length === 1 &&
    portBindings[0].HostIp === postgresIntegrationTarget.host &&
    portBindings[0].HostPort === postgresIntegrationTarget.hostPort

  const networkAddresses = Object.values(descriptor.networks ?? {})
    .flatMap((network) => [network.IPAddress, network.GlobalIPv6Address])
    .filter((address): address is string => Boolean(address))
    .map(normalizeIpAddress)
    .filter((address): address is string => address !== null)

  if (
    descriptor.label !== 'true' ||
    descriptor.image !== postgresIntegrationTarget.image ||
    !/^[a-f0-9]{64}$/i.test(descriptor.containerId) ||
    !onlyExpectedPort ||
    descriptor.mounts === null ||
    descriptor.mounts.length !== 0 ||
    descriptor.autoRemove !== true ||
    descriptor.running !== true ||
    networkAddresses.length === 0
  ) {
    throw new Error(
      'Testes PostgreSQL bloqueados: container não corresponde ao alvo descartável aprovado.',
    )
  }

  return { containerId: descriptor.containerId, networkAddresses }
}

export function validateLocalDockerEndpoint(
  endpoint: string,
  hasRemoteOverride: boolean,
  isLocalSocket: boolean,
  localDaemonAttested: boolean,
): string {
  const socketPrefix = 'unix://'
  if (
    hasRemoteOverride ||
    !endpoint.startsWith('unix:///') ||
    !isLocalSocket ||
    !localDaemonAttested
  ) {
    throw new Error('Testes PostgreSQL bloqueados: daemon Docker não comprovadamente local.')
  }

  return endpoint.slice(socketPrefix.length)
}

function getLocalDockerEnvironment(): {
  environment: NodeJS.ProcessEnv
  endpoint: string
} {
  const dockerEnvironment = { ...process.env }
  const overrideVariables = [
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
  ] as const
  const hasRemoteOverride = overrideVariables.some((name) =>
    Boolean(dockerEnvironment[name]),
  )
  if (hasRemoteOverride) {
    throw new Error('Testes PostgreSQL bloqueados: override de endpoint Docker não permitido.')
  }
  if (dockerEnvironment[localDockerAttestationVariable] !== '1') {
    throw new Error(
      'Testes PostgreSQL bloqueados: origem local direta do socket Docker não foi atestada.',
    )
  }

  let endpoint: string
  try {
    endpoint = execFileSync(
      'docker',
      [
        '--context',
        'default',
        'context',
        'inspect',
        'default',
        '--format',
        '{{.Endpoints.docker.Host}}',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
        env: dockerEnvironment,
      },
    ).trim()
  } catch {
    throw new Error('Testes PostgreSQL bloqueados: contexto Docker local indisponível.')
  }

  const socketPath = endpoint.startsWith('unix:///')
    ? endpoint.slice('unix://'.length)
    : ''
  let isLocalSocket = false
  try {
    isLocalSocket = Boolean(socketPath) && lstatSync(socketPath).isSocket()
  } catch {
    isLocalSocket = false
  }
  validateLocalDockerEndpoint(endpoint, false, isLocalSocket, true)
  return { environment: dockerEnvironment, endpoint }
}

export function assertLocalDockerDaemon(): string {
  return getLocalDockerEnvironment().endpoint
}

export function assertDisposablePostgresContainer(): DisposablePostgresContainer {
  const { environment: dockerEnvironment, endpoint } = getLocalDockerEnvironment()
  if (
    !dockerEnvironment.POSTGRES_TEST_DOCKER_HOST ||
    dockerEnvironment.POSTGRES_TEST_DOCKER_HOST !== endpoint
  ) {
    throw new Error(
      'Testes PostgreSQL bloqueados: endpoint Docker mudou ou não foi fixado pelo preflight.',
    )
  }
  const format = [
    '{{.Id}}',
    '{{index .Config.Labels "com.sistema-logistica.postgres-test"}}',
    '{{.Config.Image}}',
    '{{json .NetworkSettings.Ports}}',
    '{{json .Mounts}}',
    '{{.HostConfig.AutoRemove}}',
    '{{.State.Running}}',
    '{{json .NetworkSettings.Networks}}',
  ].join('\n')

  let output: string
  try {
    output = execFileSync(
      'docker',
      [
        '--host',
        endpoint,
        'inspect',
        '--format',
        format,
        postgresIntegrationTarget.containerName,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
        env: dockerEnvironment,
      },
    ).trim()
  } catch {
    throw new Error(
      'Testes PostgreSQL bloqueados: container descartável esperado não está disponível.',
    )
  }

  const [containerId, label, image, portsJson, mountsJson, autoRemove, running, networksJson] =
    output.split('\n')
  try {
    return {
      ...validateDisposableContainerDescriptor({
      containerId,
      label,
      image,
      ports: JSON.parse(portsJson) as Record<string, DockerPortBinding[] | null>,
      mounts: JSON.parse(mountsJson) as unknown[] | null,
      autoRemove: autoRemove === 'true',
      running: running === 'true',
      networks: JSON.parse(networksJson) as Record<string, DockerNetwork> | null,
      }),
      dockerEndpoint: endpoint,
    }
  } catch {
    throw new Error(
      'Testes PostgreSQL bloqueados: configuração do container não é segura ou está incompleta.',
    )
  }
}

export async function verifyPostgresTestIdentity(
  pool: Pick<Pool, 'query'>,
  expectedContainerAddresses: readonly string[],
): Promise<void> {
  let identity: PostgresTestIdentity
  try {
    const result = await pool.query<{
      database_name: string
      current_user: string
      current_user_is_superuser: boolean
      server_address: string | null
      server_port: number
      server_version_num: number
    }>(`SELECT current_database() AS database_name,
               current_user,
               (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS current_user_is_superuser,
               inet_server_addr()::text AS server_address,
               inet_server_port() AS server_port,
               current_setting('server_version_num')::integer AS server_version_num`)
    const row = result.rows[0]
    if (!row) throw new Error()
    identity = {
      databaseName: row.database_name,
      currentUser: row.current_user,
      currentUserIsSuperuser: row.current_user_is_superuser,
      serverAddress: row.server_address,
      serverPort: row.server_port,
      serverVersionMajor: Math.floor(row.server_version_num / 10_000),
    }
  } catch {
    throw new Error('Testes PostgreSQL bloqueados: identidade do servidor não pôde ser verificada.')
  }

  if (
    identity.databaseName !== postgresIntegrationTarget.databaseName ||
    identity.currentUser !== postgresIntegrationTarget.databaseUser ||
    identity.currentUserIsSuperuser !== true ||
    identity.serverAddress === null ||
    !expectedContainerAddresses.some(
      (address) =>
        normalizeIpAddress(address) === normalizeIpAddress(identity.serverAddress!),
    ) ||
    identity.serverPort !== postgresIntegrationTarget.serverPort ||
    identity.serverVersionMajor !== postgresIntegrationTarget.serverMajor
  ) {
    throw new Error(
      'Testes PostgreSQL bloqueados: servidor não corresponde ao alvo descartável aprovado.',
    )
  }
}