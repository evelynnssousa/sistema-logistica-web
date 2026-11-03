-- Pendente: esta tabela ainda não existe no banco real.
BEGIN;

CREATE TABLE public.password_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
    REFERENCES public.auth_users(id) ON DELETE CASCADE,
  code_hash char(64) NOT NULL
    CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0
    CHECK (attempts BETWEEN 0 AND 5),
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX password_recovery_user_created_idx
  ON public.password_recovery_codes (user_id, created_at DESC);

-- Mesmo tratamento das demais tabelas de autenticação: fora do alcance da API pública.
ALTER TABLE public.password_recovery_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.password_recovery_codes FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.password_recovery_codes FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
