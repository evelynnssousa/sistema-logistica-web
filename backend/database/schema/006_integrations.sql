-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Rotinas institucionais: eventos, fila de e-mails, notificações internas e sincronização
-- da agenda com um calendário externo. Depende da migração 005.
--
-- Só acrescenta tabelas: não altera nem reescreve registros existentes. Enquanto não for
-- aplicada, as solicitações continuam funcionando, e as comunicações não são geradas.
-- Para desfazer: 006_integrations.rollback.sql.
BEGIN;

-- ---------------------------------------------------------------------------
-- Um acontecimento de uma solicitação. event_key impede registrar o mesmo fato duas vezes.
-- O conteúdo não guarda CPF, passageiros nem dados de contato.
-- ---------------------------------------------------------------------------
CREATE TABLE public.integration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE CHECK (length(event_key) BETWEEN 1 AND 200),
  event_type text NOT NULL,
  module text NOT NULL CHECK (module IN ('maintenance', 'fleet', 'flights', 'warehouse', 'system')),
  resource_id uuid,
  protocol text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_integration_events_resource
  ON public.integration_events (resource_id, created_at);

-- ---------------------------------------------------------------------------
-- Fila de e-mails. Uma linha por destinatário: a restrição única impede envio duplicado.
-- O corpo é montado na hora do envio, a partir do modelo e do evento.
-- ---------------------------------------------------------------------------
CREATE TABLE public.email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.integration_events(id) ON DELETE RESTRICT,
  template_key text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('requester', 'internal')),
  recipient text NOT NULL CHECK (length(recipient) BETWEEN 3 AND 320),
  cc text[] NOT NULL DEFAULT '{}',
  subject text NOT NULL,
  -- not_configured: gerado sem serviço de e-mail ativo. Só sai por reprocessamento autorizado,
  -- para que ligar o serviço não dispare mensagens antigas de uma vez.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'not_configured')),
  simulated boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error_code text,
  provider text,
  provider_message_id text,
  delivery_status text,
  delivery_checked_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, recipient)
);

CREATE INDEX idx_email_deliveries_queue
  ON public.email_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'sending');
CREATE INDEX idx_email_deliveries_created
  ON public.email_deliveries (created_at DESC);

CREATE TRIGGER trg_email_deliveries_updated_at
  BEFORE UPDATE ON public.email_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Notificações internas. O texto é mínimo, e required_permissions é conferida de novo em
-- cada leitura: quem perde a permissão deixa de ver a notificação.
-- ---------------------------------------------------------------------------
CREATE TABLE public.user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.integration_events(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.auth_users(id) ON DELETE CASCADE,
  category text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  link text,
  required_permissions text[] NOT NULL DEFAULT '{}',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);

CREATE INDEX idx_user_notifications_user
  ON public.user_notifications (user_id, created_at DESC);
CREATE INDEX idx_user_notifications_unread
  ON public.user_notifications (user_id)
  WHERE read_at IS NULL;

-- ---------------------------------------------------------------------------
-- Estado desejado de cada agendamento no calendário externo. A agenda interna continua
-- lendo service_requests: esta tabela não é uma segunda fonte de agendamentos, e sim o
-- controle do que falta refletir lá fora.
-- ---------------------------------------------------------------------------
CREATE TABLE public.calendar_sync_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES public.service_requests(id) ON DELETE RESTRICT,
  module text NOT NULL CHECK (module IN ('maintenance', 'fleet')),
  desired_action text NOT NULL CHECK (desired_action IN ('upsert', 'delete')),
  -- Cresce a cada mudança. Quando revision = synced_revision, não há nada a enviar.
  revision integer NOT NULL DEFAULT 1,
  synced_revision integer NOT NULL DEFAULT 0,
  external_event_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'syncing', 'synced', 'failed', 'not_configured')),
  simulated boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error_code text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_calendar_sync_queue
  ON public.calendar_sync_items (next_attempt_at)
  WHERE status IN ('pending', 'syncing');

CREATE TRIGGER trg_calendar_sync_items_updated_at
  BEFORE UPDATE ON public.calendar_sync_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Registro de cada tentativa de envio ou sincronização.
-- ---------------------------------------------------------------------------
CREATE TABLE public.integration_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel text NOT NULL CHECK (channel IN ('email', 'calendar')),
  item_id uuid NOT NULL,
  attempt integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'retry', 'failure')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_integration_attempts_item
  ON public.integration_attempts (channel, item_id, id);

-- Eventos e tentativas são registros históricos: não mudam nem são apagados.
CREATE FUNCTION public.reject_integration_record_change()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Registros de integração não podem ser alterados.'
    USING ERRCODE = 'integrity_constraint_violation';
END
$function$;

CREATE TRIGGER integration_events_immutable
  BEFORE UPDATE OR DELETE ON public.integration_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_integration_record_change();
CREATE TRIGGER integration_attempts_immutable
  BEFORE UPDATE OR DELETE ON public.integration_attempts
  FOR EACH ROW EXECUTE FUNCTION public.reject_integration_record_change();

-- ---------------------------------------------------------------------------
-- Mesmo tratamento das demais tabelas: fora do alcance da API pública do Supabase.
-- ---------------------------------------------------------------------------
ALTER TABLE public.integration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_sync_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.integration_events,
  public.email_deliveries,
  public.user_notifications,
  public.calendar_sync_items,
  public.integration_attempts
FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.reject_integration_record_change() FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.integration_events, public.email_deliveries, public.user_notifications, public.calendar_sync_items, public.integration_attempts FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.reject_integration_record_change() FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
