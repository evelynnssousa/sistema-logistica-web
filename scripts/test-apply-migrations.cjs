#!/usr/bin/env node
/**
 * Testa a aplicação das migrações em um PostgreSQL descartável, com os papéis e os privilégios
 * automáticos do Supabase, para conferir que nada novo fica ao alcance da API pública.
 */
require('../backend/testing/block-remote-connections.cjs')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { assertPortsFree, projectRoot, startDisposablePostgres, testPorts } = require('./testing/isolation.cjs')

function run(args, url, extra = {}) {
  return spawnSync(process.execPath, [resolve(projectRoot, 'scripts/apply-migrations.cjs'), ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', DATABASE_URL: url, ...extra },
  })
}

const apply = ['--aplicar', '--confirmar=APLICAR-MIGRACOES', '--sem-backup']

const newSequences = [
  'inventory_checks_protocolo_seq',
  'integration_attempts_id_seq',
  'technical_events_id_seq',
  'availability_periods_id_seq',
  'demand_history_id_seq',
]

const legacyTables = [
  'materials', 'material_requests', 'material_request_items', 'request_forms',
  'request_history', 'service_requests', 'setores', 'stock_movements',
]
const legacySequences = ['service_requests_protocolo_seq', 'material_requests_protocolo_seq']
// MAINTAIN: PostgreSQL 17, como o Supabase real e o banco descartável dos testes.
const tablePrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']

/** Privilégios de um papel em uma tabela, pelo próprio catálogo do banco. */
async function tableRights(client, role, table) {
  const rights = []
  for (const privilege of tablePrivileges) {
    const { rows } = await client.query(`SELECT has_table_privilege($1, $2, $3) AS allowed`, [role, `public.${table}`, privilege])
    if (rows[0].allowed) rights.push(privilege)
  }
  return rights
}

const present = async (client, table) =>
  (await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`public.${table}`])).rows[0].found

/** Executa um comando no banco descartável quando a migração cria a tabela indicada. */
const onCreatingTable = (table, command) => `
  CREATE FUNCTION public.test_on_create() RETURNS event_trigger LANGUAGE plpgsql AS $test$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE object_identity = 'public.${table}') THEN
      ${command}
    END IF;
  END
  $test$;
  CREATE EVENT TRIGGER test_on_create ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
    EXECUTE FUNCTION public.test_on_create();
`

async function prepare(url, extra) {
  const { Client } = require('pg')
  const client = new Client({ connectionString: url })
  // O banco descartável pode parar com a conexão aberta, ao fim de um teste que falhou.
  client.on('error', () => undefined)
  await client.connect()
  await client.query(`DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;`)
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    END $$;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  `)
  await client.query(readFileSync(resolve(projectRoot, 'backend/database/schema/001_public_schema_snapshot.sql'), 'utf8'))
  await client.query(`
    ALTER TABLE public.setores ENABLE ROW LEVEL SECURITY;
    INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, decided_at)
    VALUES ('Administradora', 'migra-admin@example.gov.br', 'TI', 'x', 'approved', 'admin', now());
  `)
  if (extra) await client.query(extra)
  return client
}

async function twoStepBackup(url) {
  const directory = mkdtempSync(join(tmpdir(), 'slm-migracoes-'))
  const extra = { SLM_BACKUP_DIR: directory }
  const confirm = '--confirmar=APLICAR-MIGRACOES'
  const client = await prepare(url)
  try {
    const first = run(['--aplicar', confirm], url, extra)
    assert.equal(first.status, 5, `${first.stdout}\n${first.stderr}`)
    assert.match(first.stdout, /NADA FOI APLICADO/)
    assert.equal(await present(client, 'password_recovery_codes'), false, 'a primeira etapa não aplica')
    const file = /Arquivo: (.+)/.exec(first.stdout)[1].trim()
    assert.ok(file.startsWith(directory), 'a cópia de teste fica na pasta temporária')
    assert.equal(statSync(`${file}.manifesto.json`).mode & 0o777, 0o600)
    assert.ok(!readFileSync(`${file}.manifesto.json`, 'utf8').includes(new URL(url).password))
    console.log('✔ primeira etapa: gera e testa o backup, sai com 5 e não aplica nada')

    const second = ['--aplicar', confirm, `--backup=${file}`]
    const refused = async (args, pattern, why) => {
      const result = run(args, url, extra)
      assert.equal(result.status, 1, `${why}: ${result.stdout}\n${result.stderr}`)
      assert.match(result.stderr, pattern)
      assert.equal(await present(client, 'password_recovery_codes'), false, `${why}: nada é aplicado`)
    }

    await refused(['--aplicar', `--backup=${file}`], /--confirmar/, 'sem confirmação')
    await refused([`--backup=${file}`], /só vale com --aplicar/, 'sem --aplicar')
    console.log('✔ segunda etapa: também exige --aplicar e a confirmação')

    const original = `${file}.original`
    copyFileSync(file, original)
    appendFileSync(file, 'x')
    await refused(second, /O arquivo de backup mudou/, 'arquivo alterado')
    renameSync(original, file)
    console.log('✔ arquivo alterado depois do backup é recusado, e nada é aplicado')

    renameSync(`${file}.manifesto.json`, `${file}.guardado`)
    await refused(second, /não tem o registro da primeira etapa/, 'sem registro')
    renameSync(`${file}.guardado`, `${file}.manifesto.json`)
    await refused(['--aplicar', confirm, '--backup=/nao/existe.dump'], /não foi encontrado/, 'arquivo inexistente')

    // Pooler do Supabase: mesmo host e mesmo banco para projetos diferentes; só o usuário muda.
    // Com dados idênticos, a identidade do banco é o que recusa a cópia.
    const otherPassword = 'outra-senha-de-teste'
    await client.query(`DROP ROLE IF EXISTS outro_projeto; CREATE ROLE outro_projeto LOGIN SUPERUSER PASSWORD '${otherPassword}'`)
    const otherUrl = new URL(url)
    otherUrl.username = 'outro_projeto'
    otherUrl.password = otherPassword
    const otherProject = run(second, otherUrl.toString(), extra)
    assert.equal(otherProject.status, 1, `${otherProject.stdout}\n${otherProject.stderr}`)
    assert.match(otherProject.stderr, /Este backup é de outro banco/)
    assert.equal(await present(client, 'password_recovery_codes'), false, 'outro projeto: nada é aplicado')
    await client.query('DROP ROLE outro_projeto')
    console.log('✔ cópia de outro projeto no mesmo host e banco (outro usuário) é recusada')

    const account = `(SELECT id FROM public.auth_users WHERE email = 'migra-admin@example.gov.br')`
    await client.query(`UPDATE public.auth_users SET sector = 'Outro' WHERE id = ${account}`)
    assert.ok(existsSync(file))
    await refused(second, /Os dados do banco mudaram/, 'linha alterada')
    await client.query(`UPDATE public.auth_users SET sector = 'TI' WHERE id = ${account}`)
    await client.query(`INSERT INTO public.setores (nome) VALUES ('Setor novo')`)
    await refused(second, /Os dados do banco mudaram/, 'linha criada')
    await client.query(`DELETE FROM public.setores WHERE nome = 'Setor novo'`)
    console.log('✔ dados alterados ou criados depois do backup são recusados, com o arquivo íntegro')

    const applied = run(second, url, extra)
    assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`)
    assert.match(applied.stdout, /Backup conferido/)
    assert.match(applied.stdout, /22 migrações aplicadas/)
    assert.equal(await present(client, 'driver_occurrence_types'), true)
    console.log('✔ com arquivo e dados iguais, a segunda etapa aplica as 22 migrações')
  } finally {
    await client.end().catch(() => undefined)
    rmSync(directory, { recursive: true, force: true })
  }
}

async function main() {
  // O teste de restauração usa a porta backupDatabase; a origem fica em outra.
  await assertPortsFree([testPorts.integrationDatabase, testPorts.backupDatabase])
  const database = await startDisposablePostgres({ port: testPorts.integrationDatabase, database: 'slm_migracoes_test' })
  try {
    const { url } = database

    let client = await prepare(url)
    const secret = new URL(url).password

    const check = run([], url)
    assert.equal(check.status, 0, check.stderr)
    assert.match(check.stdout, /PENDENTE {2}002_password_recovery/)
    assert.match(check.stdout, /PENDENTE {2}016_driver_portal/)
    assert.match(check.stdout, /PENDENTE {2}017_driver_portal_settings/)
    assert.match(check.stdout, /PENDENTE {2}018_public_api_privileges/)
    assert.match(check.stdout, /Nada foi alterado/)
    assert.equal((await client.query(`SELECT to_regclass('public.auth_user_access') AS t`)).rows[0].t, null, 'conferir não altera')
    console.log('✔ sem opções, só confere e não altera nada')

    const noConfirmation = run(['--aplicar', '--sem-backup'], url)
    assert.equal(noConfirmation.status, 1)
    assert.match(noConfirmation.stderr, /--confirmar/)
    assert.equal((await client.query(`SELECT to_regclass('public.auth_user_access') AS t`)).rows[0].t, null)
    console.log('✔ aplicar exige a confirmação')

    const typo = run(['--aplicar', '--confirmar=sim', '--sem-backup'], url)
    assert.equal(typo.status, 1)
    console.log('✔ opção desconhecida é recusada')

    const remote = run(['--sem-backup'], 'postgresql://u:p@banco.example.gov.br:5432/real')
    assert.equal(remote.status, 1)
    assert.match(remote.stderr, /Recusado/)
    console.log('✔ em teste, banco remoto é recusado')

    // Antes da 018, o ensaio reproduz o banco real: as tabelas da versão anterior abertas a anon.
    assert.ok((await tableRights(client, 'anon', 'materials')).includes('TRUNCATE'), 'ensaio: anon começa com TRUNCATE')
    assert.ok((await tableRights(client, 'anon', 'materials')).includes('MAINTAIN'), 'ensaio: anon começa com MAINTAIN, como no banco real')

    const applied = run(apply, url)
    assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`)
    assert.match(applied.stdout, /22 migrações aplicadas/)
    assert.match(applied.stdout, /aplicada {2}018_public_api_privileges/)
    assert.match(applied.stdout, /Objetos de public acessíveis à API pública: nenhum/)
    assert.match(applied.stdout, /Tabelas novas acessíveis à API pública: nenhuma/)
    assert.match(applied.stdout, /Funções novas executáveis pela API pública: nenhuma/)
    assert.ok(!`${applied.stdout}${applied.stderr}`.includes(secret), 'a senha não pode aparecer')
    const account = await client.query(`SELECT count(*)::int AS n FROM public.auth_users`)
    assert.equal(account.rows[0].n, 1)
    const access = await client.query(`SELECT profile, slm_member FROM public.auth_user_access`)
    assert.deepEqual(access.rows, [{ profile: 'administrator', slm_member: false }])
    console.log('✔ aplica as 22 migrações e a conferência final passa, com os privilégios do Supabase')

    assert.match(applied.stdout, /Sequências novas acessíveis à API pública: nenhuma/)
    for (const sequence of newSequences) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const rights = await client.query(
          `SELECT has_sequence_privilege($1, $2, 'USAGE') OR has_sequence_privilege($1, $2, 'SELECT')
               OR has_sequence_privilege($1, $2, 'UPDATE') AS allowed`,
          [role, `public.${sequence}`],
        )
        assert.equal(rights.rows[0].allowed, false, `${role} alcança ${sequence}`)
      }
      for (const role of ['anon', 'authenticated']) {
        await client.query(`SET ROLE ${role}`)
        await assert.rejects(client.query(`SELECT nextval('public.${sequence}')`), /permission denied/)
        await client.query('RESET ROLE')
      }
      const open = await client.query(
        `SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) AS privilege
          WHERE c.oid = $1::regclass AND privilege.grantee = 0`,
        [`public.${sequence}`],
      )
      assert.equal(open.rows.length, 0, `PUBLIC alcança ${sequence}`)
    }
    assert.doesNotMatch(applied.stdout, /AVISO {5}Sequência anterior/)
    console.log('✔ as 5 sequências novas ficam fechadas a anon, authenticated, service_role e PUBLIC')

    // P-02: depois da 018, nenhum papel da API pública alcança as tabelas e sequências antigas.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const table of legacyTables) {
        assert.deepEqual(await tableRights(client, role, table), [], `${role} ainda alcança ${table}`)
      }
      for (const sequence of [...legacySequences, ...newSequences]) {
        const rights = await client.query(
          `SELECT has_sequence_privilege($1, $2, 'USAGE') OR has_sequence_privilege($1, $2, 'SELECT')
               OR has_sequence_privilege($1, $2, 'UPDATE') AS allowed`,
          [role, `public.${sequence}`],
        )
        assert.equal(rights.rows[0].allowed, false, `${role} alcança ${sequence}`)
      }
      const functions = await client.query(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND has_function_privilege($1, p.oid, 'EXECUTE')`,
        [role],
      )
      assert.deepEqual(functions.rows, [], `${role} executa funções de public`)
    }
    // Teste negativo direto, como cada papel: ler, gravar, esvaziar e numerar são recusados.
    // row_security = on, como na API do Supabase: com off, o banco recusa antes por causa da RLS.
    await client.query('SET row_security = on')
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await client.query(`SET ROLE ${role}`)
      for (const table of legacyTables) {
        await assert.rejects(client.query(`SELECT 1 FROM public.${table} LIMIT 1`), /permission denied/, `${role} lê ${table}`)
        await assert.rejects(client.query(`TRUNCATE public.${table} CASCADE`), /permission denied/, `${role} esvazia ${table}`)
      }
      await assert.rejects(client.query(`INSERT INTO public.setores (nome) VALUES ('Invasor')`), /permission denied/)
      await assert.rejects(client.query(`DELETE FROM public.auth_users`), /permission denied/)
      for (const sequence of legacySequences) {
        await assert.rejects(client.query(`SELECT nextval('public.${sequence}')`), /permission denied/)
      }
      await client.query('RESET ROLE')
    }
    const pinned = await client.query(
      `SELECT proname, proconfig FROM pg_proc WHERE proname IN ('apply_stock_movement', 'set_updated_at') ORDER BY 1`,
    )
    for (const row of pinned.rows) assert.deepEqual(row.proconfig, ['search_path=pg_catalog, public'], row.proname)
    // O gatilho antigo continua funcionando com o search_path fixo, e a API (dona) segue lendo.
    await client.query(`INSERT INTO public.setores (nome) VALUES ('Setor da 018')`)
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM public.setores WHERE nome = 'Setor da 018'`)).rows[0].n, 1)
    await client.query(`DELETE FROM public.setores WHERE nome = 'Setor da 018'`)
    console.log('✔ 018: anon, authenticated e service_role não leem, gravam, esvaziam nem numeram nada em public')

    // Reversão devolve exatamente o estado anterior, e reaplicar volta a fechar.
    const schemaFile = (name) => readFileSync(resolve(projectRoot, 'backend/database/schema', name), 'utf8')
    await client.query(schemaFile('018_public_api_privileges.rollback.sql'))
    assert.ok((await tableRights(client, 'anon', 'materials')).includes('TRUNCATE'), 'reversão devolve o privilégio anterior')
    assert.deepEqual(await tableRights(client, 'anon', 'demands'), [], 'reversão não abre tabelas novas')
    const reverted = run([], url)
    assert.equal(reverted.status, 0, reverted.stderr)
    assert.match(reverted.stdout, /presente {2}017_driver_portal_settings/)
    assert.match(reverted.stdout, /PENDENTE {2}018_public_api_privileges/)
    const reapplied = run(apply, url)
    assert.equal(reapplied.status, 0, `${reapplied.stdout}\n${reapplied.stderr}`)
    assert.match(reapplied.stdout, /1 migrações aplicadas/)
    await client.query(schemaFile('018_public_api_privileges.sql'))
    assert.deepEqual(await tableRights(client, 'anon', 'materials'), [], 'aplicar de novo não muda nada')
    console.log('✔ 018: reversão restaura o estado anterior, a conferência a vê pendente, e reaplicar é idempotente')

    const again = run(apply, url)
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /Nenhuma migração pendente/)
    console.log('✔ rodar de novo não repete nada')
    await client.end()

    client = await prepare(url, `INSERT INTO public.auth_users (full_name, email, sector, password_hash, status, role, permissions, decided_at)
      VALUES ('Operadora', 'migra-op@example.gov.br', 'TI', 'x', 'approved', 'operator', ARRAY['fleet:write'], now());`)
    const blocked = run(apply, url)
    assert.equal(blocked.status, 1)
    assert.match(blocked.stdout, /BLOQUEIO {2}003/)
    assert.equal((await client.query(`SELECT to_regclass('public.password_recovery_codes') AS t`)).rows[0].t, null, 'nada é aplicado')
    console.log('✔ um bloqueio conhecido impede tudo, antes de aplicar a primeira')
    await client.end()

    // Falha no meio: uma migração anterior já criou a tabela que a 007 cria.
    client = await prepare(url, `CREATE TABLE public.protocol_counters (x int);`)
    const failed = run(apply, url)
    assert.equal(failed.status, 2, `${failed.stdout}\n${failed.stderr}`)
    assert.match(failed.stderr, /ERRO {6}007_operations_center/)
    assert.match(failed.stderr, /006_integrations/)
    assert.equal((await client.query(`SELECT to_regclass('public.integration_events') AS t`)).rows[0].t !== null, true, 'as anteriores ficam')
    assert.equal((await client.query(`SELECT to_regclass('public.system_settings') AS t`)).rows[0].t, null, 'a que falhou é desfeita')
    assert.equal((await client.query(`SELECT to_regclass('public.request_attachments') AS t`)).rows[0].t, null, 'as seguintes não rodam')
    console.log('✔ erro no meio: desfaz aquela, mantém as anteriores e não tenta as seguintes')
    await client.end()

    await twoStepBackup(url)

    // Algo que reabra uma sequência durante a 018 precisa ser detectado, para cada papel.
    for (const role of ['anon', 'authenticated', 'service_role', 'PUBLIC']) {
      client = await prepare(url, `
        CREATE FUNCTION public.test_on_alter() RETURNS event_trigger LANGUAGE plpgsql AS $test$
        BEGIN
          IF to_regclass('public.demand_history_id_seq') IS NOT NULL THEN
            GRANT USAGE ON SEQUENCE public.demand_history_id_seq TO ${role};
          END IF;
        END
        $test$;
        CREATE EVENT TRIGGER test_on_alter ON ddl_command_end WHEN TAG IN ('ALTER FUNCTION')
          EXECUTE FUNCTION public.test_on_alter();
      `)
      const leaked = run(apply, url)
      assert.equal(leaked.status, 2, `${role}: ${leaked.stdout}\n${leaked.stderr}`)
      assert.match(leaked.stderr, /ERRO {6}018_public_api_privileges.*ainda há objetos abertos à API pública/)
      const check = run([], url)
      assert.match(check.stdout, /PENDENTE {2}018_public_api_privileges/, role)
      await client.query('DROP EVENT TRIGGER test_on_alter')
      await client.end()
    }
    console.log('✔ sequência reaberta a anon, authenticated, service_role ou PUBLIC deixa a 018 pendente e sai com 2')

    // Queda de conexão no meio da 007: o próprio banco encerra a sessão que aplica.
    client = await prepare(url, onCreatingTable('system_settings', 'PERFORM pg_terminate_backend(pg_backend_pid());'))
    const dropped = run(apply, url)
    assert.equal(dropped.status, 2, `${dropped.stdout}\n${dropped.stderr}`)
    assert.match(dropped.stderr, /ERRO {6}007_operations_center/)
    assert.match(dropped.stderr, /A conexão caiu/)
    assert.equal(await present(client, 'integration_events'), true, 'as anteriores ficam')
    assert.equal(await present(client, 'system_settings'), false, 'o banco desfaz a que estava aberta')
    assert.equal(await present(client, 'request_attachments'), false, 'as seguintes não rodam')
    console.log('✔ queda de conexão com parte aplicada sai com 2, e nunca com 1')
    await client.query(`DROP EVENT TRIGGER test_on_create`)
    const resumed = run(apply, url)
    assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`)
    assert.match(resumed.stdout, /presente {2}006_integrations/)
    assert.match(resumed.stdout, /aplicada {2}007_operations_center/)
    assert.match(resumed.stdout, /17 migrações aplicadas/)
    console.log('✔ rodar de novo retoma de onde parou, sem repetir as aplicadas')
    await client.end()

    // Reversões da 002 e da 004, criadas em 06/11/2026: recusam quando perderiam dados.
    client = await prepare(url)
    const sql = (name) => readFileSync(resolve(projectRoot, 'backend/database/schema', name), 'utf8')
    for (const name of ['002_password_recovery.sql', '003_user_access.sql', '004_flight_passengers.sql']) await client.query(sql(name))
    const adminId = (await client.query(`SELECT id FROM public.auth_users LIMIT 1`)).rows[0].id
    await client.query(
      `INSERT INTO public.password_recovery_codes (user_id, code_hash, expires_at) VALUES ($1, $2, now() + interval '10 minutes')`,
      [adminId, 'a'.repeat(64)],
    )
    await assert.rejects(client.query(sql('002_password_recovery.rollback.sql')), /recuperação de senha em andamento/)
    await client.query('ROLLBACK') // o script recusado deixa a própria transação aberta e abortada
    assert.equal(await present(client, 'password_recovery_codes'), true)
    await client.query(`UPDATE public.password_recovery_codes SET consumed_at = now()`)
    const request = await client.query(
      `INSERT INTO public.service_requests (tipo, solicitante_id, titulo) VALUES ('passagem', $1, 'Viagem fictícia') RETURNING id`,
      [adminId],
    )
    await client.query(`INSERT INTO public.flight_request_passengers (request_id, full_name, cpf) VALUES ($1, 'Pessoa Fictícia', '12345678909')`, [request.rows[0].id])
    await assert.rejects(client.query(sql('004_flight_passengers.rollback.sql')), /Já há passageiros/)
    await client.query('ROLLBACK') // o script recusado deixa a própria transação aberta e abortada
    assert.equal(await present(client, 'flight_request_passengers'), true)
    await client.query(`DELETE FROM public.flight_request_passengers`)
    await client.query(`DELETE FROM public.service_requests`)
    await client.query(sql('005_operational_modules.sql'))
    await assert.rejects(client.query(sql('004_flight_passengers.rollback.sql')), /Desfaça a 005 antes/)
    await client.query('ROLLBACK') // o script recusado deixa a própria transação aberta e abortada
    await client.query(sql('005_operational_modules.rollback.sql'))
    await client.query(sql('004_flight_passengers.rollback.sql'))
    assert.equal(await present(client, 'flight_request_passengers'), false)
    await client.query(sql('002_password_recovery.rollback.sql'))
    assert.equal(await present(client, 'password_recovery_codes'), false)
    await client.query(sql('004_flight_passengers.sql'))
    await client.query(sql('002_password_recovery.sql'))
    console.log('✔ reversões da 002 e da 004 recusam com dados em uso e desfazem por completo sem eles')
    await client.end()

    // A última migração deixa a conferência sem uma tabela que ela consulta.
    client = await prepare(url, onCreatingTable('patrimony_check_reads', 'ALTER TABLE public.setores RENAME TO setores_outro;'))
    const unfinished = run(apply, url)
    assert.equal(unfinished.status, 4, `${unfinished.stdout}\n${unfinished.stderr}`)
    assert.match(unfinished.stderr, /a conferência final não terminou/)
    assert.equal(await present(client, 'patrimony_check_reads'), true, 'todas ficam aplicadas')
    console.log('✔ conferência que não termina sai com 4, e nunca com 1')
    await client.end()
  } finally {
    database.stop()
  }
}

main().then(
  () => console.log('Teste de aplicação das migrações concluído.'),
  (error) => {
    console.error(`Teste interrompido: ${error.message}`)
    process.exitCode = 1
  },
)
