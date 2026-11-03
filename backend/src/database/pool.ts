
import { Pool } from 'pg'
import type { PoolConfig } from 'pg'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describeError, logSecurityEvent } from '../security/logger.js'
import { assertDatabaseAllowedForRuntime, isLoopbackHost } from './databaseSafety.js'

export type DatabaseConfiguration = {
  connectionString: string
  max: number
}

export function getDatabaseConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfiguration {
  const connectionString = environment.DATABASE_URL?.trim()

  if (!connectionString) {
    throw new Error('DATABASE_URL ausente ou inválida.')
  }

  try {
    const parsedUrl = new URL(connectionString)

    if (
      !['postgres:', 'postgresql:'].includes(parsedUrl.protocol) ||
      !parsedUrl.hostname ||
      parsedUrl.pathname.length < 2
    ) {
      throw new Error()
    }
  } catch {
    throw new Error('DATABASE_URL ausente ou inválida.')
  }

  const configuredMax = environment.DB_POOL_MAX?.trim()
  const max = configuredMax ? Number(configuredMax) : 5

  if (!Number.isSafeInteger(max) || max < 1) {
    throw new Error('DB_POOL_MAX deve ser um inteiro positivo.')
  }

  return { connectionString, max }
}

// backend/src/database em desenvolvimento e backend/dist/database após o build.
const backendDirectory = resolve(__dirname, '..', '..')
export const defaultCertificatePath = resolve(
  backendDirectory,
  'certificates',
  'prod-ca-2021.crt',
)

const tlsConnectionParameters = [
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'sslpassword',
  'uselibpqcompat',
]

/**
 * O TLS é definido somente aqui. Parâmetros como sslmode na URL não podem seguir
 * para o driver, porque ele os usaria no lugar desta configuração e descartaria o
 * certificado confiável. Fora da máquina local, a conexão é sempre verificada.
 */
export function buildPoolOptions(
  configuration: DatabaseConfiguration,
  environment: NodeJS.ProcessEnv = process.env,
  readCertificate: (path: string) => string = (path) =>
    readFileSync(path, 'utf8'),
): PoolConfig {
  const url = new URL(configuration.connectionString)
  const requestedMode = url.searchParams.get('sslmode')
  const isLoopback = isLoopbackHost(url.hostname)

  if (!isLoopback && requestedMode === 'disable') {
    throw new Error('Conexões remotas com o banco precisam usar TLS.')
  }

  const hasTlsParameters = tlsConnectionParameters.some((name) =>
    url.searchParams.has(name),
  )
  tlsConnectionParameters.forEach((name) => url.searchParams.delete(name))

  const usesTls =
    !isLoopback ||
    requestedMode === 'require' ||
    requestedMode === 'verify-ca' ||
    requestedMode === 'verify-full'

  const certificatePath = environment.DATABASE_SSL_CA_PATH?.trim()
    ? resolve(backendDirectory, environment.DATABASE_SSL_CA_PATH.trim())
    : defaultCertificatePath

  return {
    ...configuration,
    connectionString: hasTlsParameters
      ? url.toString()
      : configuration.connectionString,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ssl: usesTls
      ? { ca: readCertificate(certificatePath), rejectUnauthorized: true }
      : false,
  }
}

let pool: Pool | undefined

// Somente para os testes de integração, que usam um banco descartável local.
export function setDatabasePoolForTests(testPool: Pool) {
  pool = testPool
}

export function getDatabasePool(): Pool {
  if (!pool) {
    const configuration = getDatabaseConfiguration()
    assertDatabaseAllowedForRuntime(configuration.connectionString)
    pool = new Pool(buildPoolOptions(configuration))

    // Sem este ouvinte, a queda de uma conexão ociosa encerraria o processo.
    pool.on('error', (error) => {
      logSecurityEvent('database_pool_error', describeError(error))
    })
  }

  return pool
}
