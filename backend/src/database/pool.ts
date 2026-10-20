
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

let pool: Pool | undefined

export function getDatabasePool(): Pool {
  if (!pool) {
    const configuration = getDatabaseConfiguration()
    const certificatePath = resolve(
  process.cwd(),
  'backend',
  'certificates',
  'prod-ca-2021.crt',
)

    pool = new Pool({
      ...configuration,
      ssl: {
        ca: readFileSync(certificatePath, 'utf8'),
        rejectUnauthorized: true,
      },
    })
  }

  return pool
}
