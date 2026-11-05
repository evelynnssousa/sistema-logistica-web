-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Monitoramento e revisão de acessos. Só acrescenta tabelas. Enquanto não for aplicada, os erros
-- técnicos continuam só no log, e nada mais muda. Para desfazer: 010_monitoring.rollback.sql.
BEGIN;

-- Só serviço, evento e código: nunca mensagens, parâmetros ou dados de pessoas.
CREATE TABLE public.technical_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service text NOT NULL CHECK (service IN ('api', 'database', 'email', 'calendar', 'storage', 'worker')),
  event text NOT NULL CHECK (length(event) BETWEEN 1 AND 80),
  error_name text CHECK (error_name IS NULL OR length(error_name) <= 80),
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 40),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_technical_events_created ON public.technical_events (created_at DESC);
CREATE INDEX idx_technical_events_service ON public.technical_events (service, created_at DESC);

-- Um período por mudança de estado, e não uma linha por verificação. "unknown": ninguém verificou
-- nesse intervalo, seja porque a API estava fora do ar ou porque o monitoramento estava desligado.
CREATE TABLE public.availability_periods (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service text NOT NULL CHECK (service IN ('api', 'database', 'email', 'calendar', 'storage', 'worker')),
  status text NOT NULL CHECK (status IN ('up', 'down', 'unknown')),
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  detail text CHECK (detail IS NULL OR length(detail) <= 80),
  CHECK (last_seen_at >= started_at)
);

CREATE INDEX idx_availability_service ON public.availability_periods (service, started_at DESC);

CREATE TABLE public.access_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.auth_users(id) ON DELETE CASCADE,
  revisado_por uuid NOT NULL REFERENCES public.auth_users(id),
  resultado text NOT NULL CHECK (resultado IN ('mantido', 'ajustado')),
  observacao text CHECK (observacao IS NULL OR length(trim(observacao)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_access_reviews_user ON public.access_reviews (user_id, created_at DESC);

ALTER TABLE public.technical_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.availability_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_reviews ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.technical_events, public.availability_periods, public.access_reviews FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SEQUENCE public.technical_events_id_seq, public.availability_periods_id_seq FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.technical_events, public.availability_periods, public.access_reviews FROM %I',
        api_role
      );
      EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.technical_events_id_seq, public.availability_periods_id_seq FROM %I', api_role);
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
