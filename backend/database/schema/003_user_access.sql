-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Cria o controle de acesso granular: perfil, equipe SLM e permissões individuais.
--
-- É apenas aditiva. Nenhuma coluna de auth_users é alterada e nenhum registro é
-- removido. O sistema já funciona sem esta tabela, lendo as colunas antigas.
--
-- Para desfazer, sem efeito sobre usuários, sessões e auditoria:
--   DROP TABLE public.auth_user_access;
BEGIN;

CREATE TABLE public.auth_user_access (
  user_id uuid PRIMARY KEY
    REFERENCES public.auth_users(id) ON DELETE CASCADE,
  profile text NOT NULL
    CHECK (profile IN ('administrator', 'slm_operator', 'requester')),
  slm_member boolean NOT NULL DEFAULT false,
  granted_permissions text[] NOT NULL DEFAULT '{}',
  denied_permissions text[] NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES public.auth_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- O perfil operacional só existe para quem está na equipe SLM.
  CHECK (profile <> 'slm_operator' OR slm_member),
  -- A mesma permissão não pode estar concedida e retirada.
  CHECK (NOT (granted_permissions && denied_permissions))
);

CREATE INDEX auth_user_access_slm_member_idx
  ON public.auth_user_access (user_id)
  WHERE slm_member;

-- Preserva o acesso das contas já decididas. Ninguém entra na equipe SLM por
-- pertencer a um setor: só quem já tinha permissão de escrita nos módulos.
INSERT INTO public.auth_user_access
  (user_id, profile, slm_member, granted_permissions)
SELECT
  u.id,
  classified.profile,
  classified.profile = 'slm_operator',
  ARRAY(
    SELECT DISTINCT CASE legacy
      WHEN 'flights:cpf:read' THEN 'flights:cpf:read'
      WHEN 'settings:read' THEN 'settings:read'
      WHEN 'settings:write' THEN 'settings:manage'
      WHEN 'warehouse:write' THEN 'warehouse:manage'
    END
    FROM unnest(u.permissions) AS legacy
    WHERE legacy IN (
      'flights:cpf:read', 'settings:read', 'settings:write', 'warehouse:write'
    )
  )
FROM public.auth_users u
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN u.role = 'admin' THEN 'administrator'
    WHEN u.permissions && ARRAY[
      'maintenance:write', 'fleet:write', 'flights:write', 'warehouse:write'
    ]::text[] THEN 'slm_operator'
    ELSE 'requester'
  END AS profile
) AS classified
WHERE u.role IS NOT NULL;

-- Mesmo tratamento das demais tabelas de autenticação: fora do alcance da API pública.
ALTER TABLE public.auth_user_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.auth_user_access FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.auth_user_access FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
