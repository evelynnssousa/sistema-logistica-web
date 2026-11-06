-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Fecha à API pública do Supabase (anon, authenticated e service_role) e a PUBLIC tudo o que ficou
-- aberto no schema public antes das migrações deste projeto: as 8 tabelas da versão anterior
-- (materials, material_requests, material_request_items, request_forms, request_history,
-- service_requests, setores, stock_movements), as 2 sequências de protocolo e as 2 funções de gatilho.
-- RLS sem política já negava leitura e escrita a anon e authenticated, mas não TRUNCATE, e
-- service_role ignora RLS. A API do sistema conecta como dona das tabelas e não depende destes
-- privilégios. Achado P-02 da auditoria de 05/11/2026.
--
-- Não apaga nem altera dados. Pode ser executada de novo sem efeito adicional. Depende da 017.
-- Para desfazer: 018_public_api_privileges.rollback.sql, que devolve os privilégios anteriores.
BEGIN;

-- Os privilégios automáticos do Supabase também alcançam tabelas futuras; cada migração nova
-- continua obrigada a fechar as suas, e o script de aplicação confere.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I', api_role);
    END IF;
  END LOOP;
END
$migration$;

-- As duas funções da versão anterior não fixavam o search_path. O corpo continua igual.
ALTER FUNCTION public.apply_stock_movement() SET search_path = pg_catalog, public;
ALTER FUNCTION public.set_updated_at() SET search_path = pg_catalog, public;

COMMIT;
