-- Desfaz 018_public_api_privileges.sql: devolve exatamente os privilégios que o banco real tinha
-- antes dela, conferidos em 05/11/2026 (auditoria, P-02). Não toca em dados.
-- ATENÇÃO: reabre as 8 tabelas e as 2 sequências da versão anterior à API pública do Supabase.
-- Use só para voltar ao estado anterior em caso de problema comprovado causado pela 018.
BEGIN;

DO $rollback$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'GRANT ALL PRIVILEGES ON TABLE public.materials, public.material_requests, public.material_request_items, public.request_forms, public.request_history, public.service_requests, public.setores, public.stock_movements TO %I',
        api_role
      );
      EXECUTE format(
        'GRANT ALL PRIVILEGES ON SEQUENCE public.service_requests_protocolo_seq, public.material_requests_protocolo_seq TO %I',
        api_role
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.apply_stock_movement(), public.set_updated_at() TO %I',
        api_role
      );
    END IF;
  END LOOP;
END
$rollback$;

GRANT EXECUTE ON FUNCTION public.apply_stock_movement(), public.set_updated_at() TO PUBLIC;

ALTER FUNCTION public.apply_stock_movement() RESET search_path;
ALTER FUNCTION public.set_updated_at() RESET search_path;

COMMIT;
