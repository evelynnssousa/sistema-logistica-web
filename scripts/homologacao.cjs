#!/usr/bin/env node
/**
 * Único caminho para operar o banco de HOMOLOGAÇÃO (projeto Supabase rrqulhpnghoetgrdswqr).
 * Antes de qualquer coisa, confere que o destino é exatamente esse projeto e que não é o banco do
 * backend/.env. Nunca imprime a senha nem o endereço de conexão.
 *
 * Credencial (uma das duas, nunca versionada):
 *   SLM_HOMOLOG_DATABASE_URL   segredo do Codespaces (recomendado)
 *   backend/.env.homologacao   linha DATABASE_URL=..., arquivo ignorado pelo Git, permissão 600
 * Formato: Session pooler do Supabase, porta 5432, usuário postgres.rrqulhpnghoetgrdswqr, sem sslmode.
 *
 *   node scripts/homologacao.cjs verificar
 *       Só leitura: identidade, TLS, papel, permissões, extensões e conteúdo atual do banco.
 *   node scripts/homologacao.cjs estrutura --confirmar=HOMOLOGACAO-rrqulhpnghoetgrdswqr
 *       Grava: aplica a estrutura inicial (001) em transação única, só se public estiver vazio.
 *   node scripts/homologacao.cjs -- <comando> [argumentos]
 *       Roda o comando com DATABASE_URL da homologação, backups em backups/homologacao/,
 *       API na porta 3100 e tela na 5174 (as de desenvolvimento, 3000 e 5173, seguem livres).
 */
const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync, statSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const projectRef = 'rrqulhpnghoetgrdswqr'
const expectedUser = `postgres.${projectRef}`
const confirmation = `HOMOLOGACAO-${projectRef}`
const apiPort = process.env.SLM_HOMOLOG_API_PORT || '3100'
const frontendPort = process.env.SLM_HOMOLOG_FRONTEND_PORT || '5174'

class Refused extends Error {}

const defaults = {
  homologFile: resolve(projectRoot, 'backend/.env.homologacao'),
  realEnvFile: resolve(projectRoot, 'backend/.env'),
}

function readCandidate(environment, file) {
  const fromSecret = environment.SLM_HOMOLOG_DATABASE_URL?.trim()
  if (fromSecret) return { source: 'segredo SLM_HOMOLOG_DATABASE_URL', raw: fromSecret }
  if (existsSync(file)) {
    if ((statSync(file).mode & 0o077) !== 0) throw new Refused('backend/.env.homologacao precisa ter permissão 600 (chmod 600 backend/.env.homologacao).')
    const { parse } = require('dotenv')
    const raw = parse(readFileSync(file)).DATABASE_URL?.trim()
    if (raw) return { source: 'backend/.env.homologacao', raw }
  }
  throw new Refused('Credencial da homologação não encontrada. Defina o segredo SLM_HOMOLOG_DATABASE_URL (veja docs/PLANO_HOMOLOGACAO.md).')
}

/** Confere o destino sem conectar. Devolve a URL limpa e uma descrição sem segredo. */
function resolveTarget({ environment = process.env, homologFile = defaults.homologFile, realEnvFile = defaults.realEnvFile } = {}) {
  const { source, raw } = readCandidate(environment, homologFile)
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Refused('O endereço da homologação não é uma URL válida.')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Refused('O endereço precisa começar com postgresql://.')
  if (decodeURIComponent(url.username) !== expectedUser) {
    throw new Refused(`O usuário precisa ser ${expectedUser} (Session pooler do projeto de homologação). Nada foi feito.`)
  }
  if (!/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname)) {
    throw new Refused('Use o Session pooler do Supabase (host *.pooler.supabase.com). A conexão direta é só IPv6, que o Codespace não tem.')
  }
  if (url.port !== '5432') throw new Refused('Use a porta 5432 (Session pooler). A 6543 (Transaction pooler) não serve para migrações nem backup.')
  if (url.pathname !== '/postgres') throw new Refused('O banco precisa ser /postgres.')
  if (!url.password) throw new Refused('O endereço não tem senha.')
  for (const name of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword', 'uselibpqcompat']) url.searchParams.delete(name)

  // Nunca o mesmo projeto do backend/.env (o banco real).
  if (existsSync(realEnvFile)) {
    const { parse } = require('dotenv')
    const realRaw = parse(readFileSync(realEnvFile)).DATABASE_URL?.trim()
    if (realRaw) {
      const real = new URL(realRaw)
      if (decodeURIComponent(real.username) === expectedUser) {
        throw new Refused('backend/.env aponta para o projeto de homologação. Corrija antes: ele é reservado ao banco real.')
      }
      if (real.password && real.password === url.password) {
        throw new Refused('A senha da homologação é igual à do banco real. Gere outra no painel do Supabase.')
      }
    }
  }
  return { url, source, description: `projeto ${projectRef}, ${url.hostname}:5432 (Session pooler), usuário ${expectedUser}` }
}

function connectionOptions(url) {
  return {
    connectionString: url.toString(),
    ssl: { ca: readFileSync(resolve(projectRoot, 'backend/certificates/prod-ca-2021.crt'), 'utf8'), rejectUnauthorized: true },
    application_name: 'slm-homologacao',
  }
}

async function inspect(client) {
  const one = async (sql) => (await client.query(sql)).rows[0]
  const all = async (sql) => (await client.query(sql)).rows
  return {
    session: await one(`SELECT current_user AS usuario, current_database() AS banco, current_setting('server_version') AS versao,
      current_setting('server_version_num')::int AS versao_num,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superusuario,
      (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls_pooler_banco,
      pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname = 'public')) AS dono_public,
      has_schema_privilege(current_user, 'public', 'CREATE') AS cria_em_public,
      has_database_privilege(current_user, current_database(), 'CREATE') AS cria_no_banco`),
    roles: (await all(`SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','supabase_admin','authenticator') ORDER BY 1`)).map((r) => r.rolname),
    memberOf: (await all(`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user) ORDER BY 1`)).map((r) => r.rolname),
    tables: (await all(`SELECT c.relname, pg_get_userbyid(c.relowner) AS dono FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m') ORDER BY 1`)),
    otherObjects: (await one(`SELECT
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS funcoes,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S') AS sequencias,
      (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype IN ('e','c','d') ) AS tipos`)),
    extensions: (await all(`SELECT extname || ' (' || extnamespace::regnamespace || ')' AS e FROM pg_extension ORDER BY 1`)).map((r) => r.e),
    eventTriggers: (await all(`SELECT evtname FROM pg_event_trigger ORDER BY 1`)).map((r) => r.evtname),
    defaultAcl: (await all(`SELECT pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::text AS d FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace WHERE n.nspname = 'public' ORDER BY 1`)).map((r) => r.d),
    supabase: await one(`SELECT (SELECT count(*)::int FROM auth.users) AS auth_users, (SELECT count(*)::int FROM storage.objects) AS storage_objects`).catch(() => null),
  }
}

/** Marcadoras das migrações 002 em diante, sem repetição (a 018 não cria tabela). */
function migrationMarkers() {
  const { migrations } = require('./migration-list.cjs')
  return [...new Set(migrations.map((item) => item.marker))]
}

/**
 * Situação de public: vazio, só a 001, a 001 com migrações (a partir da 002), ou outra coisa.
 * "com-migracoes" não diz quais estão completas: isso é com `migrations:check`, que confere cada uma.
 */
function stateOf(tables) {
  const legacy = ['auth_audit_events', 'auth_sessions', 'auth_users', 'material_request_items', 'material_requests', 'materials', 'request_forms', 'request_history', 'service_requests', 'setores', 'stock_movements']
  const names = tables.map((t) => t.relname)
  if (names.length === 0) return 'vazio'
  const hasLegacy = legacy.every((t) => names.includes(t))
  if (hasLegacy && names.length === legacy.length) return 'estrutura-inicial'
  // A 002 é a primeira: sem ela, tabelas a mais não vieram das migrações.
  if (hasLegacy && names.includes(migrationMarkers()[0])) return 'com-migracoes'
  return 'outro'
}

/** Quantas marcadoras existem, para o resumo do `verificar`. */
function markersPresent(tables) {
  const names = new Set(tables.map((t) => t.relname))
  const markers = migrationMarkers()
  return { present: markers.filter((marker) => names.has(marker)).length, total: markers.length }
}

/** TLS da conexão do Codespace até o pooler, lido do próprio socket (o certificado já foi verificado). */
function clientTls(client) {
  const socket = client.connection?.stream
  return socket && socket.encrypted ? { on: true, protocol: socket.getProtocol?.() ?? 'TLS', authorized: socket.authorized === true } : { on: false }
}

async function withReadOnly(url, work) {
  const { Client } = require('pg')
  const client = new Client(connectionOptions(url))
  client.on('error', () => undefined)
  await client.connect()
  const tls = clientTls(client)
  await client.query('BEGIN TRANSACTION READ ONLY')
  try {
    return { ...(await work(client)), tls }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    await client.end().catch(() => undefined)
  }
}

async function verify(target) {
  console.log(`Destino: ${target.description}`)
  console.log(`Credencial lida de: ${target.source}`)
  const report = await withReadOnly(target.url, inspect)
  const s = report.session
  const state = stateOf(report.tables)
  console.log('Conexão: estabelecida, em transação SOMENTE LEITURA')
  const tls = report.tls
  console.log(`TLS (Codespace → pooler): ${tls.on ? `sim, ${tls.protocol}, certificado ${tls.authorized ? 'verificado' : 'NÃO verificado'} com backend/certificates/prod-ca-2021.crt` : 'NÃO'}`)
  console.log(`TLS (pooler → banco, informado pelo servidor): ${s.tls_pooler_banco === null ? 'não informado' : s.tls_pooler_banco ? 'sim' : 'não (rede interna do Supabase)'}`)
  console.log(`Servidor: PostgreSQL ${s.versao}; banco ${s.banco}; papel ${s.usuario}; superusuário: ${s.superusuario ? 'sim' : 'não'}`)
  console.log(`Schema public: dono ${s.dono_public}; pode criar objetos: ${s.cria_em_public ? 'sim' : 'NÃO'}`)
  console.log(`Papéis do Supabase presentes: ${report.roles.join(', ') || 'nenhum'}`)
  console.log(`O papel é membro de: ${report.memberOf.join(', ') || 'nenhum'}`)
  console.log(`Extensões: ${report.extensions.join(', ')}`)
  console.log(`Gatilhos de evento: ${report.eventTriggers.join(', ') || 'nenhum'}`)
  console.log(`Privilégios padrão em public: ${report.defaultAcl.join(', ') || 'nenhum'}`)
  console.log(`Objetos em public: ${report.tables.length} tabelas, ${report.otherObjects.funcoes} funções, ${report.otherObjects.sequencias} sequências, ${report.otherObjects.tipos} tipos`)
  if (report.supabase) console.log(`Supabase Auth/Storage: ${report.supabase.auth_users} usuários, ${report.supabase.storage_objects} arquivos (o sistema não usa)`)
  const problems = []
  if (!tls.on || !tls.authorized) problems.push('conexão sem TLS verificado')
  if (s.usuario !== 'postgres') problems.push(`papel inesperado: ${s.usuario}`)
  // A 001 usa SET transaction_timeout, que só existe no PostgreSQL 17, a versão do banco real.
  if (s.versao_num < 170000) problems.push(`PostgreSQL ${s.versao}: a estrutura inicial e os testes usam a versão 17, a mesma do banco real`)
  if (!s.cria_em_public) problems.push('o papel não pode criar objetos em public')
  if (state === 'outro') problems.push(`public tem objetos inesperados: ${report.tables.map((t) => t.relname).join(', ')}`)
  const markers = markersPresent(report.tables)
  const described = {
    vazio: 'VAZIO, pronto para a estrutura inicial',
    'estrutura-inicial': 'só a estrutura inicial (001), pronto para as migrações',
    'com-migracoes': `estrutura inicial e migrações (${markers.present} de ${markers.total} tabelas marcadoras presentes); confira cada uma com: npm run homolog -- -- npm run migrations:check`,
    outro: 'COM OBJETOS INESPERADOS',
  }
  console.log(`Situação: ${described[state]}`)
  for (const problem of problems) console.log(`PROBLEMA  ${problem}`)
  if (problems.length) process.exitCode = 1
  return { state, problems }
}

async function applyInitialStructure(target, args) {
  if (!args.includes(`--confirmar=${confirmation}`)) {
    throw new Refused(`Para gravar a estrutura inicial, use --confirmar=${confirmation}. Nada foi feito.`)
  }
  const { state, problems } = await verify(target)
  if (problems.length || state !== 'vazio') throw new Refused('A estrutura inicial só é aplicada em public vazio e sem problemas. Nada foi feito.')
  const { Client } = require('pg')
  const client = new Client(connectionOptions(target.url))
  await client.connect()
  try {
    await applyStructureWith(client)
    console.log('Estrutura inicial aplicada: 11 tabelas, sem dados. Próximo passo: as migrações 002 a 020.')
  } finally {
    await client.end().catch(() => undefined)
  }
}

/** A 001 em transação única: ou entra inteira, ou nada muda. */
async function applyStructureWith(client) {
  const sql = readFileSync(resolve(projectRoot, 'backend/database/schema/001_public_schema_snapshot.sql'), 'utf8')
  try {
    await client.query('BEGIN')
    await client.query(sql)
    // A 001 desliga o search_path desta sessão; a conferência usa nomes completos.
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`)
    if (rows[0].n !== 11) throw new Error(`esperadas 11 tabelas, encontradas ${rows[0].n}`)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw new Error(`A estrutura inicial falhou e foi desfeita: ${String(error.message).slice(0, 200)}`)
  }
}

function runCommand(target, command) {
  if (command.length === 0) throw new Refused('Informe o comando depois de --.')
  const backupDir = resolve(projectRoot, 'backups/homologacao')
  require('node:fs').mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  console.log(`Homologação: ${target.description}. Backups em backups/homologacao/. API ${apiPort}, tela ${frontendPort}.`)
  const result = spawnSync(command[0], command.slice(1), {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: target.url.toString(),
      SLM_TARGET: 'homologacao',
      SLM_BACKUP_DIR: backupDir,
      PORT: apiPort,
      SLM_FRONTEND_PORT: frontendPort,
      API_PROXY_TARGET: `http://localhost:${apiPort}`,
      FRONTEND_URL: process.env.SLM_HOMOLOG_FRONTEND_URL || `http://localhost:${frontendPort}`,
    },
  })
  process.exitCode = result.status ?? 1
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2)
  if (!['verificar', 'estrutura', '--'].includes(mode)) {
    throw new Refused('Uso: node scripts/homologacao.cjs verificar | estrutura --confirmar=... | -- <comando>')
  }
  const target = resolveTarget()
  if (mode === 'verificar') await verify(target)
  else if (mode === 'estrutura') await applyInitialStructure(target, rest)
  else runCommand(target, rest)
}

if (require.main === module) {
  main().catch((error) => {
    // Mensagens de erro do driver podem repetir o endereço: só o código e um texto curto saem.
    const message = error instanceof Refused ? error.message : `${error.code ?? ''} ${String(error.message).replace(/postgres(ql)?:\/\/\S+/g, '<endereço>').slice(0, 200)}`
    console.error(`Recusado ou interrompido: ${message}`)
    process.exitCode = process.exitCode || 1
  })
}

module.exports = { resolveTarget, stateOf, inspect, applyStructureWith, projectRef, expectedUser, Refused }
