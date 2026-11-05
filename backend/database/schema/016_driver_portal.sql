-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Portal do Motorista. A viagem continua sendo a solicitação de Frota (service_requests): aqui entram
-- o cadastro de motoristas, que não existia, o vínculo da viagem com o motorista e o registro de
-- correções de horário. Depende da migração 015. Nenhum registro existente muda, e ninguém vira
-- motorista por causa dela. Para desfazer: 016_driver_portal.rollback.sql.
BEGIN;

-- ---------------------------------------------------------------------------
-- Perfil Motorista: exclusivo, sem equipe SLM e sem concessões individuais.
-- ---------------------------------------------------------------------------
ALTER TABLE public.auth_user_access
  DROP CONSTRAINT auth_user_access_profile_check,
  ADD CONSTRAINT auth_user_access_profile_check
    CHECK (profile IN ('administrator', 'slm_operator', 'requester', 'driver')),
  ADD CONSTRAINT auth_user_access_driver_exclusive
    CHECK (profile <> 'driver' OR (NOT slm_member AND granted_permissions = '{}'::text[]));

-- ---------------------------------------------------------------------------
-- Cadastro de motoristas da Frota. A conta é opcional: o motorista pode ser cadastrado antes de
-- ter acesso. Sem CPF, CNH ou contato: o portal não precisa desses dados.
-- ---------------------------------------------------------------------------
CREATE TABLE public.fleet_drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL CHECK (length(trim(nome)) BETWEEN 3 AND 160),
  matricula text CHECK (matricula IS NULL OR length(trim(matricula)) BETWEEN 1 AND 40),
  user_id uuid UNIQUE REFERENCES public.auth_users(id) ON DELETE RESTRICT,
  ativo boolean NOT NULL DEFAULT true,
  criado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX fleet_drivers_unique_registration
  ON public.fleet_drivers (lower(trim(matricula))) WHERE matricula IS NOT NULL;

CREATE TRIGGER trg_fleet_drivers_updated_at
  BEFORE UPDATE ON public.fleet_drivers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- A viagem é a própria solicitação de Frota. O responsável (responsavel_id) segue sendo quem
-- coordena o atendimento; o motorista é quem executa.
-- ---------------------------------------------------------------------------
ALTER TABLE public.service_requests
  ADD COLUMN motorista_id uuid REFERENCES public.fleet_drivers(id) ON DELETE RESTRICT,
  -- Só o que a equipe escreveu para o motorista. As observações internas não chegam ao portal.
  ADD COLUMN motorista_observacoes text
    CHECK (motorista_observacoes IS NULL OR length(motorista_observacoes) <= 1000),
  ADD CONSTRAINT service_requests_driver_fleet_only CHECK (motorista_id IS NULL OR tipo = 'frota');

CREATE INDEX idx_sr_driver ON public.service_requests (motorista_id, data_agendada)
  WHERE motorista_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Ocorrências registradas pelo motorista: mesma tabela das registradas pela equipe.
-- ---------------------------------------------------------------------------
ALTER TABLE public.request_occurrences
  ADD COLUMN categoria text CHECK (categoria IS NULL OR categoria IN (
    'atraso', 'veiculo', 'percurso', 'atendimento', 'impedimento', 'outra'
  )),
  ADD COLUMN motorista_id uuid REFERENCES public.fleet_drivers(id) ON DELETE RESTRICT;

CREATE INDEX idx_request_occurrences_driver ON public.request_occurrences (motorista_id, created_at)
  WHERE motorista_id IS NOT NULL;

-- O arquivo é um anexo comum da solicitação; aqui fica só a qual ocorrência ele pertence.
CREATE TABLE public.request_occurrence_attachments (
  occurrence_id uuid NOT NULL REFERENCES public.request_occurrences(id) ON DELETE RESTRICT,
  attachment_id uuid NOT NULL REFERENCES public.request_attachments(id) ON DELETE RESTRICT,
  PRIMARY KEY (occurrence_id, attachment_id)
);

CREATE TRIGGER request_occurrence_attachments_immutable
  BEFORE UPDATE OR DELETE ON public.request_occurrence_attachments
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- ---------------------------------------------------------------------------
-- Correção de horários: guarda os valores anteriores e nunca é alterada nem apagada.
-- ---------------------------------------------------------------------------
CREATE TABLE public.fleet_execution_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.service_requests(id) ON DELETE RESTRICT,
  inicio_anterior timestamptz,
  fim_anterior timestamptz,
  inicio_novo timestamptz,
  fim_novo timestamptz,
  motivo text NOT NULL CHECK (length(trim(motivo)) BETWEEN 3 AND 1000),
  corrigido_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fleet_execution_corrections_request
  ON public.fleet_execution_corrections (request_id, created_at);

CREATE TRIGGER fleet_execution_corrections_immutable
  BEFORE UPDATE OR DELETE ON public.fleet_execution_corrections
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- ---------------------------------------------------------------------------
-- Fora do alcance da API pública do Supabase, como as demais tabelas.
-- ---------------------------------------------------------------------------
ALTER TABLE public.fleet_drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_occurrence_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_execution_corrections ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.fleet_drivers, public.request_occurrence_attachments, public.fleet_execution_corrections
FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.fleet_drivers, public.request_occurrence_attachments, public.fleet_execution_corrections FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
