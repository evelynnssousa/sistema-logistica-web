#!/usr/bin/env node
/**
 * Aplica as migrações pendentes, uma de cada vez e na ordem, parando no primeiro erro.
 * Usa DATABASE_URL do ambiente ou, na falta dela, de backend/.env. Nunca imprime credenciais.
 *
 *   node scripts/apply-migrations.cjs
 *       Só confere, em transação somente leitura: mostra o que falta e o que impediria aplicar.
 *
 *   node scripts/apply-migrations.cjs --aplicar --confirmar=APLICAR-MIGRACOES
 *       Primeira etapa: gera um backup, testa a restauração e para, sem aplicar. Exige Docker.
 *
 *   node scripts/apply-migrations.cjs --aplicar --confirmar=APLICAR-MIGRACOES --backup=<arquivo.dump>
 *       Segunda etapa, depois de guardar a cópia fora do Codespace: confere o arquivo e os dados
 *       e aplica. Recusa se o arquivo mudou ou se os dados do banco mudaram desde o backup.
 *
 * --sem-backup vale só para banco local. Em teste, banco remoto é sempre recusado.
 * Cada migração tem a própria transação: um erro desfaz só aquela, e as anteriores permanecem.
 *
 * Códigos de saída:
 *   0  concluído, ou nada pendente
 *   1  recusado antes de aplicar: nada mudou no banco
 *   2  a aplicação começou e falhou: as anteriores permanecem, e as seguintes não rodaram
 *   3  todas aplicadas, e a conferência final encontrou um problema
 *   4  todas aplicadas, e a conferência final não conseguiu terminar
 *   5  primeira etapa concluída: backup pronto, nada aplicado, falta a segunda etapa
 */
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const confirmation = 'APLICAR-MIGRACOES'
const isTestRun = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT)

// Decide o código de saída de um erro inesperado: 1 só vale enquanto nada foi tentado no banco.
let phase = 'before'

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

/** Quem, entre os papéis da API pública e PUBLIC, alcança cada sequência de public. */
async function sequenceAccess(client) {
  const rows = (await client.query(
    `SELECT c.relname AS sequence, r.rolname AS role
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.rolname IN ('anon', 'authenticated', 'service_role')
      WHERE n.nspname = 'public' AND c.relkind = 'S'
        AND (has_sequence_privilege(r.oid, c.oid, 'USAGE')
          OR has_sequence_privilege(r.oid, c.oid, 'SELECT')
          OR has_sequence_privilege(r.oid, c.oid, 'UPDATE'))
     UNION ALL
     SELECT c.relname, 'PUBLIC'
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) AS privilege
      WHERE n.nspname = 'public' AND c.relkind = 'S' AND privilege.grantee = 0
      ORDER BY 1, 2`,
  )).rows
  const access = new Map()
  for (const { sequence, role } of rows) access.set(sequence, [...(access.get(sequence) ?? []), role])
  return access
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

const sha256 = (content) => createHash('sha256').update(content).digest('hex')
const manifestOf = (file) => `${file}.manifesto.json`

/**
 * Resume os dados de public em um só valor: colunas e o conteúdo de cada linha de cada tabela.
 * Só leitura, em uma fotografia única do banco. Muda com qualquer linha criada, alterada ou apagada.
 */
async function dataFingerprint(client) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    // O texto de datas não pode depender da configuração da sessão.
    await client.query(`SET LOCAL TimeZone TO 'UTC'; SET LOCAL DateStyle TO 'ISO, YMD'; SET LOCAL IntervalStyle TO 'postgres'`)
    const columns = await client.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
    )
    const parts = [JSON.stringify(columns.rows)]
    const tables = await client.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
    )
    for (const { relname } of tables.rows) {
      const name = relname.replaceAll('"', '""')
      const row = (await client.query(
        `SELECT count(*)::text AS total, coalesce(md5(string_agg(line, '' ORDER BY line)), '') AS content
           FROM (SELECT md5(t::text) AS line FROM public."${name}" t) AS lines`,
      )).rows[0]
      parts.push(`${relname}:${row.total}:${row.content}`)
    }
    await client.query('COMMIT')
    return sha256(parts.join('\n'))
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
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

  const access = await sequenceAccess(client)
  const newSequences = [...access].filter(([sequence]) => !before.__sequences.includes(sequence))
  if (newSequences.length > 0) {
    problems.push(`Sequências novas acessíveis à API pública: ${newSequences.map(([sequence, roles]) => `${sequence} (${roles.join(', ')})`).join('; ')}.`)
  } else {
    console.log('Sequências novas acessíveis à API pública: nenhuma')
  }
  for (const [sequence, roles] of access) {
    if (before.__sequences.includes(sequence)) console.log(`AVISO     Sequência anterior às migrações, sem alteração: ${sequence} (${roles.join(', ')})`)
  }

  for (const item of applied) {
    if (!(await exists(client, item.marker))) problems.push(`${item.file}: a tabela ${item.marker} não existe.`)
  }
  return problems
}

function createVerifiedBackup() {
  const environment = { ...process.env }
  // Só os testes escolhem outra pasta, para não misturar cópias fictícias com as reais.
  const destination = isTestRun && process.env.SLM_BACKUP_DIR ? ['--out', process.env.SLM_BACKUP_DIR] : []
  console.log('Gerando o backup...')
  const backup = spawnSync(process.execPath, [resolve(projectRoot, 'scripts/backup-database.cjs'), ...destination], { cwd: projectRoot, env: environment, encoding: 'utf8' })
  if (backup.status !== 0) throw new Error('O backup falhou. Nada foi aplicado.')
  const file = /Arquivo:\s+(.+)/.exec(backup.stdout)?.[1]?.trim()
  if (!file) throw new Error('Não foi possível identificar o backup. Nada foi aplicado.')
  console.log(`Backup: ${file}`)
  console.log('Testando a restauração...')
  const restored = spawnSync(process.execPath, [resolve(projectRoot, 'scripts/verify-backup.cjs'), file], { cwd: projectRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8' })
  if (restored.status !== 0) throw new Error('O teste de restauração falhou. Nada foi aplicado.')
  console.log('Restauração aprovada.')
  return file
}

/** Primeira etapa: a cópia só é registrada se os dados não mudaram enquanto ela era gerada. */
async function prepareBackup(client, databaseId) {
  const before = await dataFingerprint(client)
  const file = createVerifiedBackup()
  const after = await dataFingerprint(client)
  if (before !== after) {
    throw new Error('Os dados mudaram enquanto o backup era gerado. Pare o uso do sistema e gere outro. Nada foi aplicado.')
  }
  writeFileSync(
    manifestOf(file),
    `${JSON.stringify({ criadoEm: new Date().toISOString(), banco: databaseId, sha256: sha256(readFileSync(file)), dados: after }, null, 2)}\n`,
    { mode: 0o600 },
  )
  console.log('')
  console.log('Backup pronto. NADA FOI APLICADO.')
  console.log(`Arquivo: ${file}`)
  console.log(`SHA-256: ${sha256(readFileSync(file))}`)
  console.log('Guarde uma cópia cifrada fora do Codespace e confira o SHA-256 no destino. Depois, aplique com:')
  console.log(`  node scripts/apply-migrations.cjs --aplicar --confirmar=${confirmation} --backup=${file}`)
  console.log('Mantenha o sistema parado até lá: qualquer dado novo faz a aplicação recusar esta cópia.')
}

/** Segunda etapa: o SHA-256 prova que o arquivo é o mesmo; a impressão dos dados, que o banco também é. */
async function checkBackup(client, file, databaseId) {
  if (!existsSync(file)) throw new Error('O arquivo de backup não foi encontrado. Nada foi aplicado.')
  if (!existsSync(manifestOf(file))) {
    throw new Error('Este backup não tem o registro da primeira etapa. Gere outro. Nada foi aplicado.')
  }
  const manifest = JSON.parse(readFileSync(manifestOf(file), 'utf8'))
  if (manifest.banco !== databaseId) throw new Error('Este backup é de outro banco. Nada foi aplicado.')
  if (sha256(readFileSync(file)) !== manifest.sha256) {
    throw new Error('O arquivo de backup mudou desde a primeira etapa. Nada foi aplicado.')
  }
  if ((await dataFingerprint(client)) !== manifest.dados) {
    throw new Error('Os dados do banco mudaram desde o backup. Gere outro e guarde a nova cópia. Nada foi aplicado.')
  }
  console.log('Backup conferido: o arquivo e os dados do banco são os mesmos da primeira etapa.')
}

async function main() {
  const args = process.argv.slice(2)
  const known = ['--aplicar', '--sem-backup', `--confirmar=${confirmation}`]
  const unknown = args.filter((arg) => !known.includes(arg) && !/^--backup=.+/.test(arg))
  if (unknown.length > 0) throw new Error(`Opção não reconhecida: ${unknown[0].split('=')[0]}. Nada foi aplicado.`)
  const apply = args.includes('--aplicar')
  const confirmed = args.includes(`--confirmar=${confirmation}`)
  const withoutBackup = args.includes('--sem-backup')
  const backupArg = args.find((arg) => arg.startsWith('--backup='))?.slice('--backup='.length)

  const { Client } = require('pg')
  const target = connectionOptions(readDatabaseUrl())
  if (isTestRun && !target.local) throw new Error('Recusado: testes não podem usar banco remoto.')
  if (withoutBackup && !target.local) throw new Error('Recusado: banco remoto sempre exige backup.')
  if (backupArg && !apply) throw new Error('--backup só vale com --aplicar. Nada foi aplicado.')
  if (backupArg && withoutBackup) throw new Error('Use --backup ou --sem-backup, e não os dois. Nada foi aplicado.')
  if (apply && !confirmed) {
    throw new Error(`Para aplicar, use também --confirmar=${confirmation}. Nada foi aplicado.`)
  }

  const client = new Client(target.options)
  // Sem isto, uma queda de conexão encerraria o processo com código 1, como se nada tivesse mudado.
  let connectionLost = false
  client.on('error', () => {
    connectionLost = true
  })
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

    const databaseId = sha256(`${target.host}/${new URL(target.options.connectionString).pathname}`)
    if (!withoutBackup && !backupArg) {
      await prepareBackup(client, databaseId)
      process.exitCode = 5
      return
    }
    if (backupArg) await checkBackup(client, resolve(backupArg), databaseId)

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

    before.__sequences = (await client.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'S'`,
    )).rows.map((row) => row.relname)

    const applied = []
    phase = 'applying'
    for (const item of pending) {
      try {
        await client.query(readFileSync(resolve(projectRoot, 'backend/database/schema', `${item.file}.sql`), 'utf8'))
        if (!(await exists(client, item.marker))) throw new Error('a tabela esperada não apareceu')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        console.error(`ERRO      ${item.file}: ${error.code ?? ''} ${String(error.message).slice(0, 200)}`)
        console.error(`Aplicadas antes do erro: ${applied.map((entry) => entry.file).join(', ') || 'nenhuma'}.`)
        console.error(
          connectionLost
            ? 'A conexão caiu: não há como saber aqui se esta migração terminou. Rode a conferência para ver o estado.'
            : 'Esta migração foi desfeita, e as seguintes não foram tentadas.',
        )
        process.exitCode = 2
        return
      }
      applied.push(item)
      console.log(`aplicada  ${item.file}`)
    }

    phase = 'verifying'
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
  if (phase === 'verifying') {
    console.error('As migrações ficaram aplicadas, mas a conferência final não terminou. Rode a conferência antes de usar.')
    process.exitCode = 4
  } else {
    process.exitCode = phase === 'applying' ? 2 : 1
  }
})
