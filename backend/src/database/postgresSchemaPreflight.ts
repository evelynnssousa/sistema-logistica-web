import { Pool } from 'pg'
import {
  assertDisposablePostgresContainer,
  resolvePostgresTestConnection,
  verifyPostgresTestIdentity,
} from './postgresTestGuard.js'

async function runPreflight() {
  const { connectionString } = resolvePostgresTestConnection()
  const container = assertDisposablePostgresContainer()
  const pool = new Pool({ connectionString, max: 1 })

  try {
    await verifyPostgresTestIdentity(pool, container.networkAddresses)

    const schema = await pool.query<{ schema_exists: boolean }>(
      `SELECT to_regnamespace('app_private') IS NOT NULL AS schema_exists`,
    )
    if (schema.rows[0]?.schema_exists !== false) {
      throw new Error('Schema app_private já existe.')
    }

    const relations = await pool.query<{ relation_count: string }>(
      `SELECT count(*)::text AS relation_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname !~ '^pg_'
          AND n.nspname <> 'information_schema'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`,
    )
    const otherObjects = await pool.query<{ object_count: string }>(
      `SELECT
         (SELECT count(*)
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname !~ '^pg_'
             AND n.nspname <> 'information_schema')
         +
         (SELECT count(*)
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname !~ '^pg_'
             AND n.nspname <> 'information_schema')
         +
         (SELECT count(*)
            FROM pg_extension e
            JOIN pg_namespace n ON n.oid = e.extnamespace
           WHERE n.nspname !~ '^pg_'
             AND n.nspname <> 'information_schema')
         +
         (SELECT count(*) FROM pg_largeobject_metadata)
         AS object_count`,
    )
    const schemas = await pool.query<{ schema_count: string }>(
      `SELECT count(*)::text AS schema_count
         FROM pg_namespace
        WHERE nspname !~ '^pg_'
          AND nspname NOT IN ('information_schema', 'public')`,
    )
    if (
      relations.rows[0]?.relation_count !== '0' ||
      otherObjects.rows[0]?.object_count !== '0' ||
      schemas.rows[0]?.schema_count !== '0'
    ) {
      throw new Error('Banco contém schemas ou relações de aplicação existentes.')
    }

    return container
  } finally {
    await pool.end()
  }
}

void runPreflight()
  .then(({ containerId, dockerEndpoint }) => {
    process.stdout.write(
      `Preflight somente leitura aprovado. Docker endpoint: ${dockerEndpoint}\nContainer ID: ${containerId}\n`,
    )
  })
  .catch(() => {
    process.stderr.write(
      'Preflight bloqueado: o destino não pôde ser comprovado como banco descartável vazio. Nenhum DDL foi executado.\n',
    )
    process.exitCode = 1
  })