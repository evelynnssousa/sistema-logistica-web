#!/usr/bin/env node
/**
 * Backup do schema public com pg_dump, em uma transação somente de leitura.
 * Usa DATABASE_URL do ambiente ou, na falta dela, de backend/.env.
 * Não imprime credenciais: elas chegam ao Docker por variáveis, e não por argumentos.
 *
 *   node scripts/backup-database.cjs                 estrutura e dados
 *   node scripts/backup-database.cjs --schema-only   apenas estrutura
 *   node scripts/backup-database.cjs --out <pasta>   destino (padrão: backups/)
 *
 * O arquivo com dados contém dados pessoais e hashes de senha: guarde-o com cuidado.
 */
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { chmodSync, mkdirSync, readFileSync, statSync } = require('node:fs')
const { basename, resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const image = 'postgres:17'

const isTestRun =
  process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT)

function readDatabaseUrl() {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim()
  // Em teste, as credenciais do arquivo .env nunca são lidas.
  if (isTestRun) throw new Error('Recusado: backup em teste exige banco local explícito.')
  const { parse } = require('dotenv')
  const url = parse(readFileSync(resolve(projectRoot, 'backend/.env'))).DATABASE_URL
  if (!url) throw new Error('DATABASE_URL não encontrada.')
  return url.trim()
}

function fail(message) {
  console.error(`Falha: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const schemaOnly = args.includes('--schema-only')
const outIndex = args.indexOf('--out')
const outDirectory = resolve(
  projectRoot,
  outIndex >= 0 ? args[outIndex + 1] ?? '' : 'backups',
)

let url
try {
  url = new URL(readDatabaseUrl())
} catch (error) {
  fail(error.message)
}
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
if (isTestRun && !isLocal) {
  fail('Recusado: testes não podem fazer backup de um banco remoto.')
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const fileName = `slm-${schemaOnly ? 'estrutura' : 'completo'}-${stamp}.dump`
const file = resolve(outDirectory, fileName)

mkdirSync(outDirectory, { recursive: true, mode: 0o700 })

const environment = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: url.pathname.slice(1),
  PGSSLMODE: isLocal ? 'disable' : 'verify-full',
  PGSSLROOTCERT: '/certs/prod-ca-2021.crt',
}

function runInContainer(command) {
  return spawnSync(
    'docker',
    [
      'run', '--rm', '--network', 'host',
      '--user', `${process.getuid()}:${process.getgid()}`,
      '-v', `${outDirectory}:/out`,
      '-v', `${resolve(projectRoot, 'backend/certificates')}:/certs:ro`,
      ...['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE', 'PGSSLROOTCERT']
        .flatMap((name) => ['-e', name]),
      image,
      ...command,
    ],
    { env: environment, encoding: 'utf8' },
  )
}

function sanitize(text) {
  return String(text ?? '')
    .replaceAll(environment.PGPASSWORD || '\0', '***')
    .replaceAll(environment.PGUSER || '\0', '***')
    .replaceAll(environment.PGHOST || '\0', '***')
}

const dump = runInContainer([
  'pg_dump',
  '--format=custom',
  '--schema=public',
  ...(schemaOnly ? ['--schema-only'] : []),
  `--file=/out/${basename(file)}`,
])
if (dump.status !== 0) fail(sanitize(dump.stderr).slice(0, 600))

chmodSync(file, 0o600)

const list = runInContainer(['pg_restore', '--list', `/out/${basename(file)}`])
if (list.status !== 0) fail('o arquivo gerado não pôde ser lido pelo pg_restore.')

const count = (pattern) => (list.stdout.match(pattern) ?? []).length
const digest = createHash('sha256').update(readFileSync(file)).digest('hex')

console.log(`Arquivo:          ${file}`)
console.log(`Tamanho:          ${statSync(file).size} bytes`)
console.log(`SHA-256:          ${digest}`)
console.log(`Tabelas:          ${count(/ TABLE public /g)}`)
console.log(`Blocos de dados:  ${count(/ TABLE DATA public /g)}`)
console.log(`Índices:          ${count(/ INDEX public /g)}`)
console.log(`Chaves estrang.:  ${count(/ FK CONSTRAINT public /g)}`)
console.log(`Tabelas com RLS:  ${count(/ ROW SECURITY public /g)}`)
console.log(`Políticas de RLS: ${count(/ POLICY public /g)}`)
console.log(`Privilégios:      ${count(/ ACL public /g)}`)
