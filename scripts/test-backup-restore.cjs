#!/usr/bin/env node
/**
 * Prova o caminho completo da cópia, só com dados fictícios: cria um banco descartável com todas
 * as migrações, faz a cópia com backup-database.cjs, restaura com verify-backup.cjs, confere o
 * registro de execução e comprova que uma cópia adulterada é reprovada.
 */
require('../backend/testing/block-remote-connections.cjs')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { Client } = require('pg')
const { assertPortsFree, projectRoot, startDisposablePostgres, testPorts } = require('./testing/isolation.cjs')

const migrations = [
  '001_public_schema_snapshot.sql',
  '002_password_recovery.sql',
  '003_user_access.sql',
  '004_flight_passengers.sql',
  '005_operational_modules.sql',
  '006_integrations.sql',
  '007_operations_center.sql',
  '008_attachments.sql',
  '009_module_extensions.sql',
  '010_monitoring.sql',
  '011_delivery_forecast.sql',
  '012_operational_transparency.sql',
  '013_communications.sql',
  '014_demands.sql',
  '015_organizational_structure.sql',
  '016_driver_portal.sql',
  '017_driver_portal_settings.sql',
  '018_public_api_privileges.sql',
  '019_email_quota.sql',
  '020_warehouse_finance.sql',
  '021_contract_instruments.sql',
  '022_forms_and_links.sql',
  '023_patrimony.sql',
  '024_unified_agreements.sql',
]

function run(script, args, environment) {
  return spawnSync('node', [resolve(projectRoot, 'scripts', script), ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    // Ambiente mínimo: nenhuma credencial do terminal chega aos scripts.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment },
  })
}

async function main() {
  await assertPortsFree([testPorts.integrationDatabase])
  const directory = mkdtempSync(join(tmpdir(), 'slm-teste-backup-'))
  const log = join(directory, 'registro.jsonl')
  const source = await startDisposablePostgres({
    port: testPorts.integrationDatabase,
    database: 'slm_origem_test',
  })

  try {
    const client = new Client({ connectionString: source.url })
    await client.connect()
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
    for (const file of migrations) {
      await client.query(readFileSync(resolve(projectRoot, 'backend/database/schema', file), 'utf8'))
    }
    await client.query(
      `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
       VALUES ('Pessoa Fictícia', 'backup@slm-e2e.invalid', 'TI', 'x', 'approved', 'admin', now())`,
    )
    await client.end()

    const backup = run('backup-database.cjs', ['--out', directory], {
      NODE_ENV: 'test',
      DATABASE_URL: source.url,
      BACKUP_LOG_PATH: log,
    })
    assert.equal(backup.status, 0, `${backup.stderr}\n${backup.stdout}\n${backup.error ?? ''}`)
    assert.ok(!backup.stdout.includes(new URL(source.url).password), 'a senha não pode aparecer na saída')

    const dump = readdirSync(directory).find((name) => name.endsWith('.dump'))
    assert.ok(dump, 'a cópia precisa existir')
    const dumpPath = join(directory, dump)

    const verified = run('verify-backup.cjs', [dumpPath], { BACKUP_LOG_PATH: log })
    assert.equal(verified.status, 0, `${verified.stderr}\n${verified.stdout}`)
    assert.match(verified.stdout, /SHA-256: confere/)
    assert.match(verified.stdout, /auth_users: 1/)
    assert.match(verified.stdout, /aprovado/)

    // Adulterar a cópia reprova, antes mesmo de restaurar.
    appendFileSync(dumpPath, 'x')
    const tampered = run('verify-backup.cjs', [dumpPath], { BACKUP_LOG_PATH: log })
    assert.notEqual(tampered.status, 0)
    assert.match(tampered.stderr, /não confere/)

    const entries = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(
      entries.map((entry) => [entry.type, entry.ok]),
      [['backup', true], ['restore_test', true], ['restore_test', false]],
    )
    assert.ok(!readFileSync(log, 'utf8').includes('password'))

    console.log('✔ cópia, restauração, conferência do SHA-256, reprovação de cópia adulterada e registro')
  } finally {
    source.stop()
    rmSync(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`Teste de backup interrompido: ${error.message}`)
  process.exitCode = 1
})
