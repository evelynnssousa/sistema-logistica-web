#!/usr/bin/env node
/**
 * npm run db:inspect
 * Inspeção do banco de backend/.env (ou DATABASE_URL), em transação SOMENTE LEITURA: estrutura,
 * donos, RLS, privilégios dos papéis da API do Supabase, funções, gatilhos, contagens, contas por
 * perfil e situação, bloqueios conhecidos e, depois da 003, o resumo de acesso. Não imprime
 * credenciais nem colunas pessoais: contas aparecem só como contagens e domínios.
 */
const root = require('node:path').resolve(__dirname, '..')
const isTestRun = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT)
const { readFileSync, readdirSync } = require('node:fs')
const { Client } = require(`${root}/node_modules/pg`)
const { parse } = require(`${root}/node_modules/dotenv`)
const raw = (process.env.DATABASE_URL?.trim() || (isTestRun ? '' : parse(readFileSync(`${root}/backend/.env`)).DATABASE_URL?.trim()) || '')
if (!raw) { console.error('DATABASE_URL não encontrada.'); process.exit(1) }
const url = new URL(raw)
const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
if (isTestRun && !local) { console.error('Recusado: em teste, só banco local.'); process.exit(1) }
for (const n of ['sslmode','sslcert','sslkey','sslrootcert','sslpassword','uselibpqcompat']) url.searchParams.delete(n)
const client = new Client({ connectionString: url.toString(), ...(local ? {} : { ssl: { ca: readFileSync(`${root}/backend/certificates/prod-ca-2021.crt`, 'utf8'), rejectUnauthorized: true } }) })
console.log(`Banco: ${local ? 'LOCAL' : 'REMOTO'} (somente leitura)`)
const q = async (label, sql) => { const r = await client.query(sql); console.log(`\n## ${label}`); console.table(r.rows) }
;(async () => {
  await client.connect()
  await client.query('BEGIN TRANSACTION READ ONLY')
  try {
    await q('Sessão', `SELECT current_user, session_user, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser, current_setting('server_version') AS versao, current_setting('transaction_read_only') AS somente_leitura`)
    await q('Papéis de que current_user é membro', `SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE u.rolname=current_user ORDER BY 1`)
    await q('Tabelas de public: dono, RLS, políticas, linhas estimadas', `SELECT c.relname AS tabela, pg_get_userbyid(c.relowner) AS dono, c.relrowsecurity AS rls, (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname)::int AS politicas FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') ORDER BY 1`)
    const tables = (await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1`)).rows.map(r=>r.relname)
    const counts = []
    for (const t of tables) counts.push({ tabela: t, registros: Number((await client.query(`SELECT count(*) FROM public."${t}"`)).rows[0].count) })
    console.log('\n## Contagem exata de registros'); console.table(counts)
    await q('Privilégios em tabelas/sequências de public para papéis da API, com quem concedeu', `SELECT c.relname AS objeto, CASE c.relkind WHEN 'S' THEN 'sequência' ELSE 'tabela' END AS tipo, CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS papel, pg_get_userbyid(a.grantor) AS concedido_por, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS privilegios FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE n.nspname='public' AND (a.grantee=0 OR pg_get_userbyid(a.grantee) IN ('anon','authenticated','service_role')) GROUP BY 1,2,3,4 ORDER BY 1,3`)
    await q('Funções de public', `SELECT p.proname AS funcao, pg_get_userbyid(p.proowner) AS dono, p.prosecdef AS security_definer, p.proconfig AS config, p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1`)
    await q('Gatilhos em public', `SELECT tgrelid::regclass::text AS tabela, tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'public.%' OR (NOT tgisinternal AND tgrelid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')) ORDER BY 1,2`)
    await q('Gatilhos de evento (afetam DDL das migrações)', `SELECT evtname, evtevent, pg_get_userbyid(evtowner) AS dono, evtenabled, evttags::text FROM pg_event_trigger ORDER BY 1`)
    await q('Privilégios padrão em public', `SELECT pg_get_userbyid(d.defaclrole) AS para_objetos_de, d.defaclobjtype AS tipo, d.defaclacl::text AS acl FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname='public' ORDER BY 1,2`)
    await q('Extensões', `SELECT extname, extversion, extnamespace::regnamespace::text AS schema FROM pg_extension ORDER BY 1`)
    // Tabelas que as migrações criariam e já existem: conflito.
    const created = new Set()
    for (const f of readdirSync(`${root}/backend/database/schema`).filter(f => /^0(0[2-9]|1[0-8])_.*\.sql$/.test(f) && !f.includes('rollback'))) {
      for (const m of readFileSync(`${root}/backend/database/schema/${f}`, 'utf8').matchAll(/CREATE TABLE (?:IF NOT EXISTS )?public\.(\w+)/g)) created.add(m[1])
    }
    const conflicts = []
    for (const t of created) if ((await client.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${t}`])).rows[0].e) conflicts.push(t)
    console.log(`\n## Tabelas criadas pelas migrações 002-018: ${created.size}; já existentes no banco: ${conflicts.length ? conflicts.join(', ') : 'nenhuma'}`)
    // Contas: só contagens. Domínios reservados a teste conforme o código.
    await q('Contas por perfil antigo e situação', `SELECT role, status, count(*)::int AS contas, count(*) FILTER (WHERE email ~* '@([a-z0-9-]+\\.)*(example\\.gov\\.br|example\\.com|example\\.org|example\\.net|example|test|invalid|localhost)$')::int AS dominio_de_teste, count(*) FILTER (WHERE cardinality(permissions) > 0)::int AS com_permissoes_antigas FROM public.auth_users GROUP BY 1,2 ORDER BY 1,2`)
    await q('Permissões antigas presentes (nomes, sem pessoas)', `SELECT p AS permissao, u.role, u.status, count(*)::int FROM public.auth_users u CROSS JOIN LATERAL unnest(u.permissions) p GROUP BY 1,2,3 ORDER BY 1,2,3`)
    await q('Domínios de e-mail (só o domínio, contagem)', `SELECT lower(split_part(email,'@',2)) AS dominio, status, count(*)::int FROM public.auth_users GROUP BY 1,2 ORDER BY 3 DESC`)
    await q('Sessões', `SELECT count(*)::int AS total, count(*) FILTER (WHERE expires_at > now())::int AS nao_vencidas, max(last_seen_at) AS ultimo_uso FROM public.auth_sessions`)
    await q('Auditoria: últimos eventos por ação (sem detalhes)', `SELECT action, result, count(*)::int AS eventos, max(occurred_at) AS ultimo FROM public.auth_audit_events GROUP BY 1,2 ORDER BY 4 DESC LIMIT 15`)
    await q('Bloqueios conhecidos da 003 e da 005', `SELECT
      (SELECT count(*) FROM public.auth_users WHERE role='operator' AND status='approved' AND permissions && ARRAY['maintenance:write','fleet:write','flights:write','warehouse:write']::text[])::int AS b003_operadores_com_escrita,
      (SELECT count(*) FROM (SELECT 1 FROM public.setores GROUP BY lower(trim(nome)) HAVING count(*)>1) x)::int AS b005_setores_repetidos,
      (SELECT count(*) FROM (SELECT 1 FROM public.materials GROUP BY lower(trim(nome)) HAVING count(*)>1) x)::int AS b005_materiais_repetidos,
      (SELECT count(*) FROM (SELECT 1 FROM public.material_request_items GROUP BY material_request_id, material_id HAVING count(*)>1) x)::int AS b005_itens_repetidos`)
    await q('Integridade: chaves estrangeiras não validadas e órfãos básicos', `SELECT
      (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT c.convalidated)::int AS restricoes_nao_validadas,
      (SELECT count(*) FROM public.auth_sessions s WHERE NOT EXISTS (SELECT 1 FROM public.auth_users u WHERE u.id=s.user_id))::int AS sessoes_orfas`)
    await q('Valores de status nas tabelas antigas', `SELECT 'service_requests' AS tabela, status, count(*)::int FROM public.service_requests GROUP BY 1,2 UNION ALL SELECT 'material_requests', status, count(*)::int FROM public.material_requests GROUP BY 1,2`)
    if ((await client.query(`SELECT to_regclass('public.auth_user_access') IS NOT NULL AS e`)).rows[0].e) {
      await q('Acesso depois da 003 (sem identificar pessoas)', `SELECT a.profile AS perfil, a.slm_member AS equipe_slm, u.status, count(*)::int AS contas, sum(cardinality(a.granted_permissions))::int AS concessoes FROM public.auth_user_access a JOIN public.auth_users u ON u.id=a.user_id GROUP BY 1,2,3 ORDER BY 1,2,3`)
    }
    await q('Schemas do Supabase em uso pelo sistema', `SELECT (SELECT count(*) FROM auth.users)::int AS auth_users, (SELECT count(*) FROM storage.objects)::int AS storage_objects`)
  } finally {
    await client.query('ROLLBACK'); await client.end()
  }
})().catch(e => { console.error('Falha:', e.code ?? '', String(e.message).slice(0,200)); process.exitCode = 1 })
