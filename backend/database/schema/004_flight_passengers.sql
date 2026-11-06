-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Guarda os passageiros fora de service_requests.dados. Assim, o CPF não vem junto
-- quando uma solicitação é lida: só sai pela rota própria, autorizada e auditada.
--
-- Depende de service_requests. É apenas aditiva. Para desfazer, se ainda não houver
-- passageiros cadastrados: 004_flight_passengers.rollback.sql.
BEGIN;

CREATE TABLE public.flight_request_passengers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL
    REFERENCES public.service_requests(id) ON DELETE RESTRICT,
  full_name text NOT NULL
    CHECK (length(trim(full_name)) BETWEEN 2 AND 120),
  cpf char(11) NOT NULL
    CHECK (cpf ~ '^[0-9]{11}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX flight_request_passengers_request_idx
  ON public.flight_request_passengers (request_id);

ALTER TABLE public.flight_request_passengers ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.flight_request_passengers FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.flight_request_passengers FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
