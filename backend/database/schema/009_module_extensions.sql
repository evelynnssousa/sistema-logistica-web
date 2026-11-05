-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Ampliações dos módulos: veículos, equipamentos, execução de manutenção, cotações de passagens
-- e proteção das movimentações de estoque. Depende da migração 007.
-- Só acrescenta: o veículo digitado nas solicitações de Frota continua como está.
-- Para desfazer: 009_module_extensions.rollback.sql.
BEGIN;

-- ---------------------------------------------------------------------------
-- Frota
-- ---------------------------------------------------------------------------
CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placa text NOT NULL CHECK (placa ~ '^[A-Z0-9-]{5,10}$'),
  modelo text NOT NULL CHECK (length(trim(modelo)) BETWEEN 2 AND 120),
  identificacao text CHECK (identificacao IS NULL OR length(trim(identificacao)) BETWEEN 1 AND 120),
  situacao text NOT NULL DEFAULT 'disponivel'
    CHECK (situacao IN ('disponivel', 'em_uso', 'em_manutencao', 'inativo')),
  km_atual integer NOT NULL DEFAULT 0 CHECK (km_atual >= 0),
  -- Revisão preventiva: por quilometragem, por data ou pelas duas, conforme o veículo.
  proxima_revisao_km integer CHECK (proxima_revisao_km IS NULL OR proxima_revisao_km >= 0),
  proxima_revisao_data date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX vehicles_unique_plate ON public.vehicles (placa);

CREATE TRIGGER trg_vehicles_updated_at
  BEFORE UPDATE ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.vehicle_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE RESTRICT,
  request_id uuid REFERENCES public.service_requests(id) ON DELETE RESTRICT,
  tipo text NOT NULL CHECK (tipo IN ('utilizacao', 'ocorrencia', 'abastecimento', 'manutencao')),
  data_registro timestamptz NOT NULL,
  km_inicial integer CHECK (km_inicial IS NULL OR km_inicial >= 0),
  km_final integer CHECK (km_final IS NULL OR km_final >= 0),
  litros numeric(8,2) CHECK (litros IS NULL OR litros > 0),
  valor numeric(12,2) CHECK (valor IS NULL OR valor >= 0),
  descricao text NOT NULL CHECK (length(trim(descricao)) BETWEEN 3 AND 2000),
  registrado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_logs_km_order CHECK (km_final IS NULL OR km_inicial IS NULL OR km_final >= km_inicial)
);

CREATE INDEX idx_vehicle_logs_vehicle ON public.vehicle_logs (vehicle_id, data_registro DESC);

CREATE TRIGGER vehicle_logs_immutable
  BEFORE UPDATE OR DELETE ON public.vehicle_logs
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- ---------------------------------------------------------------------------
-- Manutenção. Cadastro de equipamentos é opcional: a execução funciona sem ele.
-- ---------------------------------------------------------------------------
CREATE TABLE public.equipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL CHECK (length(trim(nome)) BETWEEN 2 AND 160),
  identificacao text CHECK (identificacao IS NULL OR length(trim(identificacao)) BETWEEN 1 AND 120),
  local text CHECK (local IS NULL OR length(trim(local)) BETWEEN 2 AND 160),
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX equipments_unique_name_location
  ON public.equipments (lower(trim(nome)), lower(trim(coalesce(local, ''))), lower(trim(coalesce(identificacao, ''))));

CREATE TRIGGER trg_equipments_updated_at
  BEFORE UPDATE ON public.equipments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.maintenance_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.service_requests(id) ON DELETE RESTRICT,
  equipment_id uuid REFERENCES public.equipments(id) ON DELETE RESTRICT,
  executado_por text NOT NULL CHECK (length(trim(executado_por)) BETWEEN 2 AND 160),
  executado_em timestamptz NOT NULL,
  servico_realizado text NOT NULL CHECK (length(trim(servico_realizado)) BETWEEN 3 AND 4000),
  pendencias text CHECK (pendencias IS NULL OR length(trim(pendencias)) BETWEEN 1 AND 2000),
  registrado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_maintenance_executions_request ON public.maintenance_executions (request_id, executado_em);
CREATE INDEX idx_maintenance_executions_equipment ON public.maintenance_executions (equipment_id, executado_em DESC)
  WHERE equipment_id IS NOT NULL;

CREATE TRIGGER maintenance_executions_immutable
  BEFORE UPDATE OR DELETE ON public.maintenance_executions
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- ---------------------------------------------------------------------------
-- Passagens. Cotações ficam guardadas para comparação; só a escolha muda depois de registrada.
-- ---------------------------------------------------------------------------
CREATE TABLE public.flight_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.service_requests(id) ON DELETE RESTRICT,
  companhia text NOT NULL CHECK (length(trim(companhia)) BETWEEN 2 AND 120),
  voos text NOT NULL CHECK (length(trim(voos)) BETWEEN 2 AND 500),
  valor numeric(12,2) NOT NULL CHECK (valor >= 0),
  condicoes text CHECK (condicoes IS NULL OR length(trim(condicoes)) BETWEEN 1 AND 2000),
  validade timestamptz,
  selecionada boolean NOT NULL DEFAULT false,
  registrado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_flight_quotes_request ON public.flight_quotes (request_id, created_at);
CREATE UNIQUE INDEX flight_quotes_one_selected ON public.flight_quotes (request_id) WHERE selecionada;

CREATE FUNCTION public.protect_flight_quote()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'selecionada') = (to_jsonb(OLD) - 'selecionada') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cotações registradas não podem ser alteradas.'
    USING ERRCODE = 'integrity_constraint_violation';
END
$function$;

CREATE TRIGGER flight_quotes_protected
  BEFORE UPDATE OR DELETE ON public.flight_quotes
  FOR EACH ROW EXECUTE FUNCTION public.protect_flight_quote();

-- ---------------------------------------------------------------------------
-- Almoxarifado: stock_movements já existe e atualiza o saldo por gatilho. Passa a ser permanente.
-- ---------------------------------------------------------------------------
CREATE TRIGGER stock_movements_immutable
  BEFORE UPDATE OR DELETE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- ---------------------------------------------------------------------------
-- Mesmo tratamento das demais tabelas: fora do alcance da API pública do Supabase.
-- ---------------------------------------------------------------------------
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flight_quotes ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.vehicles, public.vehicle_logs, public.equipments, public.maintenance_executions, public.flight_quotes
FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.protect_flight_quote() FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.vehicles, public.vehicle_logs, public.equipments, public.maintenance_executions, public.flight_quotes FROM %I',
        api_role
      );
      EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION public.protect_flight_quote() FROM %I', api_role);
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
