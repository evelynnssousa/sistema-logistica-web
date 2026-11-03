#!/usr/bin/env node
/**
 * Testes de integração: cria um PostgreSQL descartável, roda os testes e o remove.
 * Só o endereço desse banco chega aos testes.
 */
require('../backend/testing/block-remote-connections.cjs')
const { spawnSync } = require('node:child_process')
const {
  assertPortsFree,
  isolatedEnvironment,
  projectRoot,
  startDisposablePostgres,
  testPorts,
} = require('./testing/isolation.cjs')

async function main() {
  await assertPortsFree([testPorts.integrationDatabase])

  const database = await startDisposablePostgres({
    port: testPorts.integrationDatabase,
    database: 'slm_integracao_test',
  })

  try {
    const result = spawnSync('npm', ['run', 'test:backend:postgres'], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: isolatedEnvironment({ TEST_DATABASE_URL: database.url }),
    })
    process.exitCode = result.status ?? 1
  } finally {
    database.stop()
  }
}

main().catch((error) => {
  console.error(`Testes de integração interrompidos: ${error.message}`)
  process.exitCode = 1
})
