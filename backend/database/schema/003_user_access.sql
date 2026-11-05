-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Cria o controle de acesso granular: perfil, equipe SLM e permissões individuais.
--
-- Não altera colunas nem registros de auth_users, sessões ou auditoria. Acrescenta
-- um gatilho em auth_users, que só recusa divergência entre as duas tabelas. O sistema
-- já funciona sem esta migração, lendo as colunas antigas.
--
-- Para desfazer: 003_user_access.rollback.sql. Depois, reinicie a API.
BEGIN;

-- Quem hoje opera com escrita perderia esse acesso sem aviso, porque ninguém entra
-- automaticamente na equipe SLM. Exige uma decisão antes de migrar.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.auth_users
     WHERE role = 'operator'
       AND status = 'approved'
       AND permissions && ARRAY[
         'maintenance:write', 'fleet:write', 'flights:write', 'warehouse:write'
       ]::text[]
  ) THEN
    RAISE EXCEPTION
      'Migração 003 interrompida: há operadores ativos com permissão de escrita. Defina a equipe SLM antes de migrar.';
  END IF;
END
$guard$;

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
  -- Só Administrador e Operador SLM podem integrar a equipe.
  CHECK (profile <> 'requester' OR NOT slm_member),
  -- A mesma permissão não pode estar concedida e retirada.
  CHECK (NOT (granted_permissions && denied_permissions))
);

CREATE INDEX auth_user_access_slm_member_idx
  ON public.auth_user_access (user_id)
  WHERE slm_member;

-- Registra toda conta já decidida, ativa ou não, sem equipe SLM e sem permissões
-- especiais. Permissões antigas de CPF ou de armazém precisam de nova concessão.
INSERT INTO public.auth_user_access
  (user_id, profile, slm_member, granted_permissions)
SELECT
  u.id,
  CASE WHEN u.role = 'admin' THEN 'administrator' ELSE 'requester' END,
  false,
  ARRAY(
    SELECT DISTINCT CASE legacy
      WHEN 'settings:read' THEN 'settings:read'
      WHEN 'settings:write' THEN 'settings:manage'
    END
    FROM unnest(u.permissions) AS legacy
    WHERE legacy IN ('settings:read', 'settings:write')
  )
FROM public.auth_users u
WHERE u.role IS NOT NULL;

-- Mantém auth_users.role e auth_user_access.profile coerentes. Conta sem linha de
-- acesso não é verificada. A checagem é adiada para o fim da transação, porque as
-- duas tabelas são gravadas em comandos separados.
CREATE FUNCTION public.assert_user_access_coherent()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $function$
DECLARE
  target_id uuid;
  account_role text;
  access_profile text;
  expected_role text;
BEGIN
  IF TG_TABLE_NAME = 'auth_users' THEN
    target_id := NEW.id;
  ELSE
    target_id := NEW.user_id;
  END IF;

  SELECT u.role, a.profile
    INTO account_role, access_profile
    FROM public.auth_users u
    JOIN public.auth_user_access a ON a.user_id = u.id
   WHERE u.id = target_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  expected_role := CASE WHEN access_profile = 'administrator' THEN 'admin' ELSE 'operator' END;

  IF account_role IS DISTINCT FROM expected_role THEN
    RAISE EXCEPTION 'Perfil de acesso divergente do papel da conta.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER auth_user_access_coherence
  AFTER INSERT OR UPDATE OF profile ON public.auth_user_access
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_user_access_coherent();

CREATE CONSTRAINT TRIGGER auth_users_access_coherence
  AFTER UPDATE OF role ON public.auth_users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_user_access_coherent();

-- Mesmo tratamento das demais tabelas de autenticação: fora do alcance da API pública.
ALTER TABLE public.auth_user_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.auth_user_access FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_user_access_coherent() FROM PUBLIC;

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
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.assert_user_access_coherent() FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
