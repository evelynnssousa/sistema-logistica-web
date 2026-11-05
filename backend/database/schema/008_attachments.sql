-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Anexos de solicitações e de pedidos do Almoxarifado. O banco guarda só os dados de controle:
-- o conteúdo fica no armazenamento configurado em ATTACHMENTS_DIR, sem endereço público.
-- Depende da migração 007. Só acrescenta tabela. Para desfazer: 008_attachments.rollback.sql.
BEGIN;

CREATE TABLE public.request_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid REFERENCES public.service_requests(id) ON DELETE RESTRICT,
  material_request_id uuid REFERENCES public.material_requests(id) ON DELETE RESTRICT,
  categoria text NOT NULL CHECK (categoria IN (
    'orcamento', 'comprovante', 'fotografia_antes', 'fotografia_depois', 'fotografia',
    'execucao', 'bilhete', 'relatorio', 'outro'
  )),
  nome_original text NOT NULL CHECK (length(nome_original) BETWEEN 1 AND 180),
  tipo text NOT NULL CHECK (tipo IN ('pdf', 'png', 'jpeg', 'webp', 'docx', 'xlsx', 'txt')),
  tamanho_bytes bigint NOT NULL CHECK (tamanho_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL UNIQUE,
  -- Restrito: só quem atende o módulo e quem enviou, mesmo que outra pessoa leia a solicitação.
  restrito boolean NOT NULL DEFAULT false,
  enviado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  removido_em timestamptz,
  removido_por uuid REFERENCES public.auth_users(id),
  motivo_remocao text,
  CONSTRAINT request_attachments_one_owner CHECK (num_nonnulls(request_id, material_request_id) = 1),
  CONSTRAINT request_attachments_removal_complete CHECK (
    (removido_em IS NULL AND removido_por IS NULL AND motivo_remocao IS NULL)
    OR (removido_em IS NOT NULL AND removido_por IS NOT NULL AND motivo_remocao IS NOT NULL)
  )
);

CREATE INDEX idx_attachments_request ON public.request_attachments (request_id, created_at)
  WHERE request_id IS NOT NULL;
CREATE INDEX idx_attachments_material ON public.request_attachments (material_request_id, created_at)
  WHERE material_request_id IS NOT NULL;

-- O registro é histórico: só aceita a remoção lógica, uma vez, e nunca é apagado.
CREATE FUNCTION public.protect_attachment_record()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.removido_em IS NULL
     AND (to_jsonb(NEW) - 'removido_em' - 'removido_por' - 'motivo_remocao')
       = (to_jsonb(OLD) - 'removido_em' - 'removido_por' - 'motivo_remocao') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Registros de anexos não podem ser alterados.'
    USING ERRCODE = 'integrity_constraint_violation';
END
$function$;

CREATE TRIGGER request_attachments_protected
  BEFORE UPDATE OR DELETE ON public.request_attachments
  FOR EACH ROW EXECUTE FUNCTION public.protect_attachment_record();

ALTER TABLE public.request_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.request_attachments FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.protect_attachment_record() FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.request_attachments FROM %I', api_role);
      EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION public.protect_attachment_record() FROM %I', api_role);
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
