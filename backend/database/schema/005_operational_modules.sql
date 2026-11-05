-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Estrutura dos módulos operacionais: solicitações, configurações, almoxarifado,
-- conferência de inventário, proteção do CPF e imutabilidade do histórico.
--
-- Depende das migrações 003 e 004. Não reescreve registros: status antigos continuam
-- aceitos e são traduzidos na leitura. Para desfazer: 005_operational_modules.rollback.sql.
BEGIN;

-- ---------------------------------------------------------------------------
-- Configurações. Setores continuam em public.setores; as demais listas ficam aqui.
-- ---------------------------------------------------------------------------
CREATE TABLE public.catalog_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  categoria text NOT NULL
    CHECK (categoria IN ('floor', 'service_type', 'warehouse_category', 'measurement_unit')),
  nome text NOT NULL
    CHECK (length(trim(nome)) BETWEEN 1 AND 120),
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX catalog_options_unique_name
  ON public.catalog_options (categoria, lower(trim(nome)));

CREATE TRIGGER trg_catalog_options_updated_at
  BEFORE UPDATE ON public.catalog_options
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE UNIQUE INDEX setores_unique_name ON public.setores (lower(trim(nome)));

-- ---------------------------------------------------------------------------
-- Solicitações: status institucionais, autoria, agendamento e execução.
-- ---------------------------------------------------------------------------
ALTER TABLE public.service_requests
  DROP CONSTRAINT service_requests_status_check,
  ADD CONSTRAINT service_requests_status_check CHECK (status = ANY (ARRAY[
    -- Valores anteriores, mantidos para não invalidar registros existentes.
    'pendente', 'em_analise', 'agendada', 'concluida', 'cancelada', 'rejeitada',
    -- Manutenção e Frota.
    'aguardando_agendamento', 'agendado', 'reagendado', 'em_andamento', 'concluido', 'cancelado',
    -- Passagens aéreas. O cancelamento usa 'cancelada'.
    'em_cotacao', 'aguardando_aprovacao', 'em_emissao', 'emitida'
  ])),
  ADD COLUMN aberto_por uuid REFERENCES public.auth_users(id),
  ADD COLUMN em_nome_de_outro_setor boolean NOT NULL DEFAULT false,
  -- Nomes copiados: renomear ou desativar uma opção não altera o histórico.
  ADD COLUMN setor_nome text,
  ADD COLUMN andar_id uuid REFERENCES public.catalog_options(id),
  ADD COLUMN andar_nome text,
  ADD COLUMN tipo_servico_id uuid REFERENCES public.catalog_options(id),
  ADD COLUMN tipo_servico_nome text,
  ADD COLUMN agendamento_fim timestamptz,
  ADD COLUMN agendado_por uuid REFERENCES public.auth_users(id),
  ADD COLUMN execucao_inicio timestamptz,
  ADD COLUMN execucao_fim timestamptz,
  ADD COLUMN motivo_cancelamento text,
  ADD CONSTRAINT service_requests_schedule_order
    CHECK (agendamento_fim IS NULL OR data_agendada IS NULL OR agendamento_fim >= data_agendada),
  ADD CONSTRAINT service_requests_execution_order
    CHECK (execucao_fim IS NULL OR execucao_inicio IS NULL OR execucao_fim >= execucao_inicio);

CREATE INDEX idx_sr_created ON public.service_requests (created_at DESC);
CREATE INDEX idx_sr_agenda ON public.service_requests (data_agendada)
  WHERE data_agendada IS NOT NULL;

ALTER TABLE public.request_history
  ADD COLUMN detalhes jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE public.request_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.service_requests(id) ON DELETE RESTRICT,
  tipo text NOT NULL CHECK (tipo IN ('ocorrencia', 'atraso')),
  descricao text NOT NULL CHECK (length(trim(descricao)) BETWEEN 3 AND 2000),
  atraso_minutos integer CHECK (atraso_minutos IS NULL OR atraso_minutos BETWEEN 1 AND 100000),
  registrado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_request_occurrences_request
  ON public.request_occurrences (request_id, created_at);

-- ---------------------------------------------------------------------------
-- Passageiros: o CPF passa a ser cifrado pela aplicação (AES-256-GCM), com a chave fora
-- do banco. A coluna antiga, em texto, deixa de receber dados.
-- ---------------------------------------------------------------------------
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.flight_request_passengers) THEN
    RAISE EXCEPTION
      'Migração 005 interrompida: já há passageiros com CPF em texto. Cifre-os antes de migrar.';
  END IF;
END
$guard$;

ALTER TABLE public.flight_request_passengers
  ALTER COLUMN cpf DROP NOT NULL,
  ADD COLUMN cpf_encrypted text,
  ADD COLUMN cpf_masked text,
  ADD CONSTRAINT flight_request_passengers_cpf_present
    CHECK (cpf IS NOT NULL OR (cpf_encrypted IS NOT NULL AND cpf_masked IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Almoxarifado: reutiliza materials, material_requests e material_request_items.
-- ---------------------------------------------------------------------------
ALTER TABLE public.materials
  ADD COLUMN categoria_id uuid REFERENCES public.catalog_options(id),
  ADD COLUMN categoria_nome text;

CREATE UNIQUE INDEX materials_unique_name ON public.materials (lower(trim(nome)));

ALTER TABLE public.material_requests
  DROP CONSTRAINT material_requests_status_check,
  ADD CONSTRAINT material_requests_status_check CHECK (status = ANY (ARRAY[
    'pendente', 'em_analise', 'atendido_parcial', 'atendido', 'entregue', 'rejeitado', 'cancelado'
  ])),
  ADD COLUMN origem text NOT NULL DEFAULT 'interna'
    CHECK (origem IN ('interna', 'governamental')),
  ADD COLUMN referencia_externa text
    CHECK (referencia_externa IS NULL OR length(trim(referencia_externa)) BETWEEN 1 AND 120),
  ADD COLUMN solicitante_externo text
    CHECK (solicitante_externo IS NULL OR length(trim(solicitante_externo)) BETWEEN 2 AND 120),
  ADD COLUMN registrado_por uuid REFERENCES public.auth_users(id),
  ADD COLUMN setor_nome text,
  ADD COLUMN entregue_em timestamptz,
  ADD COLUMN entregue_por uuid REFERENCES public.auth_users(id),
  ADD COLUMN recebido_por text,
  ADD CONSTRAINT material_requests_reference_only_external
    CHECK (origem = 'governamental' OR referencia_externa IS NULL);

CREATE INDEX idx_mr_origem ON public.material_requests (origem, created_at DESC);

ALTER TABLE public.material_request_items
  ADD COLUMN material_nome text,
  ADD COLUMN unidade text;

CREATE UNIQUE INDEX material_request_items_unique_material
  ON public.material_request_items (material_request_id, material_id);

CREATE TABLE public.material_request_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_request_id uuid NOT NULL REFERENCES public.material_requests(id) ON DELETE RESTRICT,
  usuario_id uuid REFERENCES public.auth_users(id),
  acao text NOT NULL,
  status_anterior text,
  status_novo text,
  comentario text,
  detalhes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_mrh_request ON public.material_request_history (material_request_id, created_at);

CREATE TABLE public.inventory_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocolo bigint GENERATED ALWAYS AS IDENTITY,
  titulo text NOT NULL CHECK (length(trim(titulo)) BETWEEN 3 AND 160),
  data_referencia date NOT NULL,
  observacao text,
  status text NOT NULL DEFAULT 'em_andamento'
    CHECK (status IN ('em_andamento', 'concluida', 'cancelada')),
  criado_por uuid NOT NULL REFERENCES public.auth_users(id),
  encerrado_por uuid REFERENCES public.auth_users(id),
  encerrado_em timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_inventory_checks_updated_at
  BEFORE UPDATE ON public.inventory_checks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.inventory_check_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL REFERENCES public.inventory_checks(id) ON DELETE RESTRICT,
  material_id uuid NOT NULL REFERENCES public.materials(id),
  material_nome text NOT NULL,
  unidade text NOT NULL,
  -- Quantidade informada pelo sistema governamental, digitada por quem confere.
  quantidade_governamental numeric(12,2) NOT NULL CHECK (quantidade_governamental >= 0),
  quantidade_contada numeric(12,2) CHECK (quantidade_contada >= 0),
  diferenca numeric(12,2)
    GENERATED ALWAYS AS (quantidade_contada - quantidade_governamental) STORED,
  observacao text,
  atualizado_por uuid REFERENCES public.auth_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (check_id, material_id)
);

-- ---------------------------------------------------------------------------
-- Histórico e auditoria não são alterados nem apagados, nem por engano da aplicação.
-- Apenas anular o usuário é aceito, para a exclusão de contas (ON DELETE SET NULL).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.reject_history_change()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND TG_TABLE_NAME = 'auth_audit_events'
     AND NEW.id = OLD.id
     AND NEW.action = OLD.action
     AND NEW.result = OLD.result
     AND NEW.details = OLD.details
     AND NEW.occurred_at = OLD.occurred_at
     AND NEW.target_resource_id IS NOT DISTINCT FROM OLD.target_resource_id
     AND (NEW.actor_user_id IS NULL OR NEW.actor_user_id = OLD.actor_user_id)
     AND (NEW.target_user_id IS NULL OR NEW.target_user_id = OLD.target_user_id) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Registros de histórico e auditoria não podem ser alterados.'
    USING ERRCODE = 'integrity_constraint_violation';
END
$function$;

CREATE TRIGGER auth_audit_events_immutable
  BEFORE UPDATE OR DELETE ON public.auth_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();
CREATE TRIGGER request_history_immutable
  BEFORE UPDATE OR DELETE ON public.request_history
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();
CREATE TRIGGER material_request_history_immutable
  BEFORE UPDATE OR DELETE ON public.material_request_history
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- ---------------------------------------------------------------------------
-- Mesmo tratamento das demais tabelas: fora do alcance da API pública do Supabase.
-- ---------------------------------------------------------------------------
ALTER TABLE public.catalog_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_request_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_check_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.catalog_options,
  public.request_occurrences,
  public.material_request_history,
  public.inventory_checks,
  public.inventory_check_items
FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.reject_history_change() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SEQUENCE public.inventory_checks_protocolo_seq FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.catalog_options, public.request_occurrences, public.material_request_history, public.inventory_checks, public.inventory_check_items FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.reject_history_change() FROM %I',
        api_role
      );
      EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.inventory_checks_protocolo_seq FROM %I', api_role);
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
