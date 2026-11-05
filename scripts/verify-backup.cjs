#!/usr/bin/env node
/**
 * Confere uma cópia e testa a restauração em um PostgreSQL descartável, sem conexão com o banco
 * real: nenhuma credencial do projeto é lida. Uma cópia só é confiável depois de passar aqui.
 *
 *   node scripts/verify-backup.cjs <arquivo.dump>
 *
 * Exige Docker. O banco temporário é removido ao final, com os dados restaurados.
 */
require('../backend/testing/block-remote-connections.cjs')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { appendFileSync, existsSync, readFileSync } = require('node:fs')
const { basename, dirname, resolve } = require('node:path')
const { assertPortsFree, startDisposablePostgres, testPorts } = require('./testing/isolation.cjs')

const image = 'postgres:17'

function recordRun(entry) {
  const path = process.env.BACKUP_LOG_PATH?.trim()
  if (!path) return
  appendFileSync(path, `${JSON.stringify({ type: 'restore_test', at: new Date().toISOString(), ...entry })}\n`, {
    mode: 0o600,
  })
}

function checkDigest(file) {
  const expectedFile = `${file}.sha256`
  if (!existsSync(expectedFile)) return 'sem arquivo .sha256 para comparar'
  const expected = readFileSync(expectedFile, 'utf8').trim().split(/\s+/)[0]
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (expected !== actual) throw new Error('O SHA-256 do arquivo não confere: a cópia foi alterada ou está incompleta.')
  return 'confere'
}

/** Roda um cliente do PostgreSQL em um contêiner, só com a cópia, em modo somente leitura. */
function client(file, connection, command) {
  return spawnSync(
    'docker',
    [
      'run', '--rm', '--network', 'host',
      '-v', `${dirname(file)}:/copia:ro`,
      '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGDATABASE', '-e', 'PGSSLMODE',
      image,
      ...command,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PGHOST: '127.0.0.1',
        PGPORT: connection.port,
        PGUSER: decodeURIComponent(connection.username),
        PGPASSWORD: decodeURIComponent(connection.password),
        PGDATABASE: connection.pathname.slice(1),
        PGSSLMODE: 'disable',
      },
    },
  )
}

async function main() {
  const file = resolve(process.argv[2] ?? '')
  if (!process.argv[2] || !existsSync(file)) throw new Error('Informe o caminho da cópia.')

  console.log(`SHA-256: ${checkDigest(file)}`)

  await assertPortsFree([testPorts.backupDatabase])
  const database = await startDisposablePostgres({
    port: testPorts.backupDatabase,
    database: 'slm_restauracao_test',
  })

  try {
    const connection = new URL(database.url)
    const name = `/copia/${basename(file)}`

    const listing = client(file, connection, ['pg_restore', '--list', name])
    if (listing.status !== 0) throw new Error('O arquivo não pôde ser lido pelo pg_restore.')
    const expectedTables = (listing.stdout.match(/ TABLE public /g) ?? []).length

    // Algumas cópias recriam o schema public, conforme o dono dele na origem. Este banco é
    // descartável e nunca é o de origem.
    if (/ SCHEMA - public /.test(listing.stdout)) {
      const emptied = client(file, connection, ['psql', '-At', '-v', 'ON_ERROR_STOP=1', '-c', 'DROP SCHEMA public CASCADE'])
      if (emptied.status !== 0) throw new Error('Não foi possível preparar o banco temporário.')
    }

    const restored = client(file, connection, [
      'pg_restore', '--no-owner', '--no-privileges', '--exit-on-error', '--dbname=slm_restauracao_test', name,
    ])
    if (restored.status !== 0) throw new Error(`A restauração falhou: ${restored.stderr.slice(0, 300)}`)

    const query = (sql) => client(file, connection, ['psql', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql])
    const tables = query(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)
    if (tables.status !== 0) throw new Error('Não foi possível consultar o banco restaurado.')
    const restoredTables = Number(tables.stdout.trim())
    if (restoredTables !== expectedTables) {
      throw new Error(`Esperava ${expectedTables} tabelas e encontrou ${restoredTables}.`)
    }

    // Só quantidades: o conteúdo da cópia não aparece no terminal.
    const counts = query(
      `SELECT c.relname || ': ' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname), false, true, '')))[1]::text
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`,
    )
    if (counts.status !== 0) throw new Error('Não foi possível contar os registros restaurados.')

    console.log(`Tabelas restauradas: ${restoredTables} de ${expectedTables}`)
    console.log(counts.stdout.trim())
    console.log('Teste de restauração aprovado.')
    recordRun({ ok: true, tables: restoredTables })
  } finally {
    database.stop()
  }
}

main().catch((error) => {
  console.error(`Teste de restauração reprovado: ${error.message}`)
  recordRun({ ok: false })
  process.exitCode = 1
})
