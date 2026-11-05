-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Central de comunicação: e-mails escritos pelos operadores, com anexos e histórico. Depende das
-- migrações 005, 007 e 008. Só acrescenta: nenhum registro existente muda, e os e-mails automáticos
-- seguem na fila própria. Enquanto não for aplicada, o restante do sistema continua funcionando,
-- e só o envio manual responde 503. Para desfazer: 013_communications.rollback.sql.
BEGIN;

CREATE TABLE public.manual_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid REFERENCES public.service_requests(id) ON DELETE RESTRICT,
  material_request_id uuid REFERENCES public.material_requests(id) ON DELETE RESTRICT,
  modulo text NOT NULL CHECK (modulo IN ('maintenance', 'fleet', 'flights', 'warehouse')),
  protocolo text NOT NULL,
  tipo text NOT NULL DEFAULT 'geral' CHECK (tipo IN ('geral', 'passagem')),
  modelo text,
  -- Sem chave estrangeira: um passageiro pode sair da solicitação, e o registro do envio continua.
  passageiro_id uuid,
  destinatarios text[] NOT NULL CHECK (cardinality(destinatarios) BETWEEN 1 AND 50),
  copias text[] NOT NULL DEFAULT '{}',
  assunto text NOT NULL CHECK (length(trim(assunto)) BETWEEN 1 AND 200),
  corpo_texto text NOT NULL CHECK (length(trim(corpo_texto)) BETWEEN 1 AND 20000),
  corpo_html text NOT NULL,
  -- Mesma chave do envio repetido por clique duplo: o segundo não cria outra mensagem.
  chave_idempotencia uuid NOT NULL UNIQUE,
  reenvio_de uuid REFERENCES public.manual_emails(id) ON DELETE RESTRICT,
  enviado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Situação do envio: "sent" só depois de o serviço aceitar a mensagem.
  status text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'not_configured')),
  tentativas integer NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  proxima_tentativa timestamptz NOT NULL DEFAULT now(),
  travado_ate timestamptz,
  codigo_erro text,
  provedor text,
  simulado boolean NOT NULL DEFAULT false,
  id_mensagem_provedor text,
  enviado_em timestamptz,
  CONSTRAINT manual_emails_one_owner CHECK (num_nonnulls(request_id, material_request_id) = 1)
);

CREATE INDEX idx_manual_emails_request ON public.manual_emails (request_id, created_at DESC)
  WHERE request_id IS NOT NULL;
CREATE INDEX idx_manual_emails_material ON public.manual_emails (material_request_id, created_at DESC)
  WHERE material_request_id IS NOT NULL;
CREATE INDEX idx_manual_emails_queue ON public.manual_emails (proxima_tentativa)
  WHERE status IN ('pending', 'sending');

-- O que foi escrito não muda nem some. Só a situação do envio é atualizada; reenviar cria outro.
CREATE FUNCTION public.protect_manual_email()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.id = OLD.id
     AND NEW.request_id IS NOT DISTINCT FROM OLD.request_id
     AND NEW.material_request_id IS NOT DISTINCT FROM OLD.material_request_id
     AND NEW.modulo = OLD.modulo
     AND NEW.protocolo = OLD.protocolo
     AND NEW.tipo = OLD.tipo
     AND NEW.modelo IS NOT DISTINCT FROM OLD.modelo
     AND NEW.passageiro_id IS NOT DISTINCT FROM OLD.passageiro_id
     AND NEW.destinatarios = OLD.destinatarios
     AND NEW.copias = OLD.copias
     AND NEW.assunto = OLD.assunto
     AND NEW.corpo_texto = OLD.corpo_texto
     AND NEW.corpo_html = OLD.corpo_html
     AND NEW.chave_idempotencia = OLD.chave_idempotencia
     AND NEW.reenvio_de IS NOT DISTINCT FROM OLD.reenvio_de
     AND NEW.enviado_por = OLD.enviado_por
     AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Registros de histórico e auditoria não podem ser alterados.'
    USING ERRCODE = 'integrity_constraint_violation';
END
$function$;

CREATE TRIGGER manual_emails_protected
  BEFORE UPDATE OR DELETE ON public.manual_emails
  FOR EACH ROW EXECUTE FUNCTION public.protect_manual_email();

-- Cópia dos dados do arquivo no momento do envio: o conteúdo continua nos anexos, sem link público.
CREATE TABLE public.manual_email_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid NOT NULL REFERENCES public.manual_emails(id) ON DELETE RESTRICT,
  attachment_id uuid NOT NULL REFERENCES public.request_attachments(id) ON DELETE RESTRICT,
  nome text NOT NULL,
  tipo text NOT NULL,
  categoria text NOT NULL,
  tamanho_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  UNIQUE (email_id, attachment_id)
);

CREATE TRIGGER manual_email_attachments_immutable
  BEFORE UPDATE OR DELETE ON public.manual_email_attachments
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- ---------------------------------------------------------------------------
-- Mesmo tratamento das demais tabelas: fora do alcance da API pública do Supabase.
-- ---------------------------------------------------------------------------
ALTER TABLE public.manual_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manual_email_attachments ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.manual_emails, public.manual_email_attachments FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.protect_manual_email() FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.manual_emails, public.manual_email_attachments FROM %I',
        api_role
      );
      EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION public.protect_manual_email() FROM %I', api_role);
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
