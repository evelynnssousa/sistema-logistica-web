#!/usr/bin/env node
/**
 * Aplica as migrações pendentes, uma de cada vez e na ordem, parando no primeiro erro.
 * Usa DATABASE_URL do ambiente ou, na falta dela, de backend/.env. Nunca imprime credenciais.
 *
 *   node scripts/apply-migrations.cjs
 *       Só confere, em transação somente leitura: mostra o que falta e o que impediria aplicar.
 *
 *   node scripts/apply-migrations.cjs --aplicar --confirmar=APLICAR-MIGRACOES
 *       Gera um backup, testa a restauração e só então aplica. Exige Docker.
 *
 * --sem-backup vale só para banco local. Em teste, banco remoto é sempre recusado.
 * Cada migração tem a própria transação: um erro desfaz só aquela, e as anteriores permanecem.
 */
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const confirmation = 'APLICAR-MIGRACOES'
const isTestRun = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT)

// A presença de cada tabela é o único registro de migração que este banco tem.
const migrations = [
  { file: '002_password_recovery', marker: 'password_recovery_codes' },
  { file: '003_user_access', marker: 'auth_user_access' },
  { file: '004_flight_passengers', marker: 'flight_request_passengers' },
  { file: '005_operational_modules', marker: 'catalog_options' },
  { file: '006_integrations', marker: 'integration_events' },
  { file: '007_operations_center', marker: 'system_settings' },
  { file: '008_attachments', marker: 'request_attachments' },
  { file: '009_module_extensions', marker: 'vehicles' },
  { file: '010_monitoring', marker: 'technical_events' },
  { file: '011_delivery_forecast', marker: 'material_delivery_history' },
  { file: '012_operational_transparency', marker: 'config_versions' },
  { file: '013_communications', marker: 'manual_emails' },
  { file: '014_demands', marker: 'demands' },
  { file: '015_organizational_structure', marker: 'user_directorate_links' },
  { file: '016_driver_portal', marker: 'fleet_drivers' },
  { file: '017_driver_portal_settings', marker: 'driver_occurrence_types' },
]

function readDatabaseUrl() {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim()
  if (isTestRun) throw new Error('Recusado: em teste, informe um banco local em DATABASE_URL.')
  const { parse } = require('dotenv')
  const url = parse(readFileSync(resolve(projectRoot, 'backend/.env'))).DATABASE_URL
  if (!url) throw new Error('DATABASE_URL não encontrada.')
  return url.trim()
}

/** O mesmo TLS da API: fora da máquina local, a conexão é sempre verificada. */
function connectionOptions(raw) {
  const url = new URL(raw)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  for (const name of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword', 'uselibpqcompat']) {
    url.searchParams.delete(name)
  }
  return {
    local,
    host: url.hostname,
    options: {
      connectionString: url.toString(),
      ...(local
        ? {}
        : { ssl: { ca: readFileSync(resolve(projectRoot, 'backend/certificates/prod-ca-2021.crt'), 'utf8'), rejectUnauthorized: true } }),
    },
  }
}

const exists = async (client, table) =>
  (await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${table}`])).rows[0].present

/** O que faria uma migração parar com erro, conferido antes de tocar em qualquer coisa. */
async function blockers(client, pending) {
  const found = []
  const will = (name) => pending.some((item) => item.file.startsWith(name))
  const any = async (sql) => (await client.query(sql)).rows.length > 0

  if (will('003') && await any(`SELECT 1 FROM public.auth_users
      WHERE role = 'operator' AND status = 'approved'
        AND permissions && ARRAY['maintenance:write','fleet:write','flights:write','warehouse:write']::text[] LIMIT 1`)) {
    found.push('003: há operadores ativos com permissão de escrita. Defina a equipe SLM antes.')
  }
  if (will('005')) {
    if ((await exists(client, 'flight_request_passengers')) && await any(`SELECT 1 FROM public.flight_request_passengers LIMIT 1`)) {
      found.push('005: já há passageiros com CPF em texto. Cifre-os antes.')
    }
    if (await any(`SELECT 1 FROM public.setores GROUP BY lower(trim(nome)) HAVING count(*) > 1 LIMIT 1`)) {
      found.push('005: há nomes repetidos em setores.')
    }
    if (await any(`SELECT 1 FROM public.materials GROUP BY lower(trim(nome)) HAVING count(*) > 1 LIMIT 1`)) {
      found.push('005: há nomes repetidos em materiais.')
    }
    if (await any(`SELECT 1 FROM public.material_request_items GROUP BY material_request_id, material_id HAVING count(*) > 1 LIMIT 1`)) {
      found.push('005: há material repetido em um mesmo pedido.')
    }
  }
  return found
}

async function counts(client) {
  const result = await client.query(
    `SELECT (SELECT count(*)::int FROM public.auth_users) AS contas,
            (SELECT count(*)::int FROM public.service_requests) AS solicitacoes,
            (SELECT count(*)::int FROM public.material_requests) AS pedidos,
            (SELECT count(*)::int FROM public.materials) AS materiais,
            (SELECT count(*)::int FROM public.setores) AS setores`,
  )
  return result.rows[0]
}

/** Conferência final. Só leitura. Devolve os problemas encontrados, sem desfazer nada. */
async function verify(client, applied, before) {
  const problems = []
  const rls = (await client.query(
    `SELECT count(*)::int AS tabelas, count(*) FILTER (WHERE c.relrowsecurity)::int AS com_rls
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  )).rows[0]
  console.log(`Tabelas: ${rls.tabelas}, com RLS: ${rls.com_rls}`)
  if (rls.tabelas !== rls.com_rls) problems.push('Há tabela sem RLS.')

  const after = await counts(client)
  console.log(`Registros: ${JSON.stringify(after)}`)
  for (const [key, value] of Object.entries(before)) {
    if (key.startsWith('__')) continue
    if (after[key] < value) problems.push(`Menos registros que antes em ${key}.`)
  }

  if (await exists(client, 'auth_user_access')) {
    const divergent = (await client.query(
      `SELECT count(*)::int AS total FROM public.auth_users u
         JOIN public.auth_user_access a ON a.user_id = u.id
        WHERE u.role IS DISTINCT FROM CASE WHEN a.profile = 'administrator' THEN 'admin' ELSE 'operator' END`,
    )).rows[0].total
    console.log(`Divergências de perfil: ${divergent}`)
    if (divergent > 0) problems.push('Há perfis divergentes entre auth_users e auth_user_access.')
  }

  // Tabelas criadas agora não podem ficar ao alcance da API pública do Supabase.
  const known = new Set(before.__tables)
  const grants = (await client.query(
    `SELECT DISTINCT table_name FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'service_role')`,
  )).rows.map((row) => row.table_name).filter((name) => !known.has(name))
  if (grants.length > 0) problems.push(`Tabelas novas acessíveis à API pública: ${grants.join(', ')}.`)
  else console.log('Tabelas novas acessíveis à API pública: nenhuma')

  const functions = (await client.query(
    `SELECT DISTINCT p.proname FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_roles r ON r.rolname IN ('anon', 'authenticated', 'service_role')
      WHERE n.nspname = 'public' AND has_function_privilege(r.oid, p.oid, 'EXECUTE')`,
  )).rows.map((row) => row.proname).filter((name) => !before.__functions.includes(name))
  if (functions.length > 0) problems.push(`Funções novas executáveis pela API pública: ${functions.join(', ')}.`)
  else console.log('Funções novas executáveis pela API pública: nenhuma')

  for (const item of applied) {
    if (!(await exists(client, item.marker))) problems.push(`${item.file}: a tabela ${item.marker} não existe.`)
  }
  return problems
}

function backupFirst() {
  const environment = { ...process.env }
  console.log('Gerando o backup...')
  const backup = spawnSync(process.execPath, [resolve(projectRoot, 'scripts/backup-database.cjs')], { cwd: projectRoot, env: environment, encoding: 'utf8' })
  if (backup.status !== 0) throw new Error('O backup falhou. Nada foi aplicado.')
  const file = /Arquivo:\s+(.+)/.exec(backup.stdout)?.[1]?.trim()
  if (!file) throw new Error('Não foi possível identificar o backup. Nada foi aplicado.')
  console.log(`Backup: ${file}`)
  console.log('Testando a restauração...')
  const restored = spawnSync(process.execPath, [resolve(projectRoot, 'scripts/verify-backup.cjs'), file], { cwd: projectRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8' })
  if (restored.status !== 0) throw new Error('O teste de restauração falhou. Nada foi aplicado.')
  console.log('Restauração aprovada.')
}

async function main() {
  const args = process.argv.slice(2)
  const known = ['--aplicar', '--sem-backup', `--confirmar=${confirmation}`]
  const unknown = args.filter((arg) => !known.includes(arg))
  if (unknown.length > 0) throw new Error(`Opção não reconhecida: ${unknown[0].split('=')[0]}. Nada foi aplicado.`)
  const apply = args.includes('--aplicar')
  const confirmed = args.includes(`--confirmar=${confirmation}`)
  const withoutBackup = args.includes('--sem-backup')

  const { Client } = require('pg')
  const target = connectionOptions(readDatabaseUrl())
  if (isTestRun && !target.local) throw new Error('Recusado: testes não podem usar banco remoto.')
  if (withoutBackup && !target.local) throw new Error('Recusado: banco remoto sempre exige backup.')
  if (apply && !confirmed) {
    throw new Error(`Para aplicar, use também --confirmar=${confirmation}. Nada foi aplicado.`)
  }

  const client = new Client(target.options)
  await client.connect()
  console.log(`Banco: ${target.local ? 'LOCAL' : 'REMOTO'}`)
  // Sem --aplicar, o próprio banco recusa qualquer gravação nesta conexão.
  if (!apply) await client.query('BEGIN TRANSACTION READ ONLY')
  try {
    const states = []
    for (const item of migrations) states.push({ ...item, present: await exists(client, item.marker) })
    const firstPending = states.findIndex((item) => !item.present)
    const pending = states.filter((item) => !item.present)
    if (firstPending >= 0 && states.slice(firstPending).some((item) => item.present)) {
      throw new Error('As migrações presentes estão fora de ordem. Confira o banco à mão. Nada foi aplicado.')
    }
    for (const item of states) console.log(`${item.present ? 'presente' : 'PENDENTE'}  ${item.file}`)

    const found = await blockers(client, pending)
    for (const message of found) console.log(`BLOQUEIO  ${message}`)
    if (pending.length === 0) {
      console.log('Nenhuma migração pendente.')
      return
    }
    if (found.length > 0) throw new Error('Resolva os bloqueios acima. Nada foi aplicado.')
    if (!apply) {
      console.log(`Conferência concluída: ${pending.length} pendentes, sem bloqueios. Nada foi alterado.`)
      return
    }

    // Duas execuções ao mesmo tempo não disputam a mesma migração.
    const lock = await client.query(`SELECT pg_try_advisory_lock(hashtext('slm:aplicar-migracoes')) AS ok`)
    if (!lock.rows[0].ok) throw new Error('Já há uma aplicação em andamento. Nada foi aplicado.')

    if (!withoutBackup) backupFirst()

    const before = await counts(client)
    before.__tables = (await client.query(
      `SELECT DISTINCT table_name FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'service_role')`,
    )).rows.map((row) => row.table_name)
    before.__functions = (await client.query(
      `SELECT DISTINCT p.proname FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_roles r ON r.rolname IN ('anon', 'authenticated', 'service_role')
        WHERE n.nspname = 'public' AND has_function_privilege(r.oid, p.oid, 'EXECUTE')`,
    )).rows.map((row) => row.proname)

    const applied = []
    for (const item of pending) {
      try {
        await client.query(readFileSync(resolve(projectRoot, 'backend/database/schema', `${item.file}.sql`), 'utf8'))
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        console.error(`ERRO      ${item.file}: ${error.code ?? ''} ${String(error.message).slice(0, 200)}`)
        console.error(`Aplicadas antes do erro: ${applied.map((entry) => entry.file).join(', ') || 'nenhuma'}.`)
        console.error('Esta migração foi desfeita, e as seguintes não foram tentadas.')
        process.exitCode = 2
        return
      }
      if (!(await exists(client, item.marker))) throw new Error(`${item.file}: a tabela esperada não apareceu.`)
      applied.push(item)
      console.log(`aplicada  ${item.file}`)
    }

    console.log('--- Conferência final')
    const problems = await verify(client, applied, before)
    if (problems.length > 0) {
      for (const message of problems) console.error(`PROBLEMA  ${message}`)
      console.error('As migrações ficaram aplicadas. Revise os problemas acima.')
      process.exitCode = 3
      return
    }
    console.log(`Concluído: ${applied.length} migrações aplicadas, e a conferência não encontrou problemas.`)
  } finally {
    if (!apply) await client.query('ROLLBACK').catch(() => undefined)
    await client.end().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(`Falha: ${error.message}`)
  process.exitCode = 1
})
