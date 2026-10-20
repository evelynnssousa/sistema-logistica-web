import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from 'dotenv'
import { Pool } from 'pg'

const backendDirectory = resolve(__dirname, '../..')
config({ path: resolve(backendDirectory, '.env') })

const databaseUrl = process.env.DATABASE_URL

function readCertificate(path: string): Buffer {
  return readFileSync(resolve(backendDirectory, path))
}

function createSecurePool(): Pool | null {
  if (!databaseUrl) return null

  const connectionUrl = new URL(databaseUrl)
  const caPath = process.env.DATABASE_CA_CERT_PATH || connectionUrl.searchParams.get('sslrootcert')
  const clientCertPath = connectionUrl.searchParams.get('sslcert')
  const clientKeyPath = connectionUrl.searchParams.get('sslkey')

  for (const parameter of ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) {
    connectionUrl.searchParams.delete(parameter)
  }

  return new Pool({
    connectionString: connectionUrl.toString(),
    ssl: {
      rejectUnauthorized: true,
      ...(caPath ? { ca: readCertificate(caPath) } : {}),
      ...(clientCertPath ? { cert: readCertificate(clientCertPath) } : {}),
      ...(clientKeyPath ? { key: readCertificate(clientKeyPath) } : {}),
    },
  })
}

export const pool = createSecurePool()