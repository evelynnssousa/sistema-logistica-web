-- Pendente: esta migração ainda não foi aplicada em nenhum banco remoto.
--
-- Atas e contratos no Controle de Demandas (12/11/2026, pedido da responsável): acompanhamento de
-- atas de registro de preços e contratos de materiais, serviços e cursos.
--
-- 1. public.contract_instruments: a ata ou o contrato, do setor responsável (setor do Controle de
--    Demandas), com valor, vigência e antecedência do aviso de vencimento.
-- 2. public.contract_instrument_sectors: setores com quem o instrumento é compartilhado.
-- 3. public.contract_instrument_items: itens com quantidade registrada e valor unitário.
-- 4. public.contract_instrument_usages: cada utilização (empenho, pedido, ordem de serviço) de um
--    item. Permanente; o saldo é a quantidade registrada menos as utilizações.
-- 5. public.contract_instrument_amendments: aditivos e prorrogações. Permanente; prorrogar muda a
--    vigência, e acréscimo ou supressão muda o valor.
-- 6. public.contract_instrument_attachments: PDF da ata, do contrato e dos aditivos, com as mesmas
--    garantias dos anexos das demandas (conteúdo fora do banco, nunca apagado).
-- 7. public.demands.instrumento_id: vínculo opcional da demanda com uma ata ou contrato.
--
-- Não altera registros existentes. Depende da 014 (demandas) e da 007 (reject_history_change).
-- Para desfazer: 021_contract_instruments.rollback.sql.
BEGIN;

CREATE TABLE public.contract_instruments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL CHECK (tipo IN ('ata', 'contrato')),
  numero text NOT NULL CHECK (length(trim(numero)) BETWEEN 1 AND 60),
  objeto text NOT NULL CHECK (length(trim(objeto)) BETWEEN 3 AND 1000),
  categoria text NOT NULL CHECK (categoria IN ('material', 'servico', 'curso', 'outro')),
  fornecedor text CHECK (fornecedor IS NULL OR length(trim(fornecedor)) BETWEEN 1 AND 200),
  processo text CHECK (processo IS NULL OR length(trim(processo)) BETWEEN 1 AND 60),
  valor_total numeric(14,2) NOT NULL CHECK (valor_total >= 0),
  vigencia_inicio date,
  vigencia_fim date,
  setor_responsavel_id uuid NOT NULL REFERENCES public.demand_sectors(id),
  gestor_id uuid REFERENCES public.auth_users(id),
  aviso_dias integer NOT NULL DEFAULT 90 CHECK (aviso_dias BETWEEN 0 AND 365),
  -- Demanda de renovação aberta automaticamente; volta a nulo quando a vigência é prorrogada.
  renovacao_demanda_id uuid,
  encerrado boolean NOT NULL DEFAULT false,
  observacoes text CHECK (observacoes IS NULL OR length(observacoes) <= 4000),
  criado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (vigencia_inicio IS NULL OR vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio)
);

CREATE UNIQUE INDEX idx_contract_instruments_numero ON public.contract_instruments (tipo, lower(trim(numero)));
CREATE INDEX idx_contract_instruments_setor ON public.contract_instruments (setor_responsavel_id);
CREATE INDEX idx_contract_instruments_vigencia ON public.contract_instruments (vigencia_fim) WHERE NOT encerrado;

CREATE TABLE public.contract_instrument_sectors (
  instrument_id uuid NOT NULL REFERENCES public.contract_instruments(id) ON DELETE CASCADE,
  sector_id uuid NOT NULL REFERENCES public.demand_sectors(id),
  PRIMARY KEY (instrument_id, sector_id)
);
CREATE INDEX idx_contract_instrument_sectors_sector ON public.contract_instrument_sectors (sector_id);

CREATE TABLE public.contract_instrument_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id uuid NOT NULL REFERENCES public.contract_instruments(id) ON DELETE RESTRICT,
  numero_item text CHECK (numero_item IS NULL OR length(trim(numero_item)) BETWEEN 1 AND 20),
  descricao text NOT NULL CHECK (length(trim(descricao)) BETWEEN 2 AND 500),
  unidade text NOT NULL CHECK (length(trim(unidade)) BETWEEN 1 AND 40),
  quantidade_registrada numeric(14,2) NOT NULL CHECK (quantidade_registrada >= 0),
  valor_unitario numeric(14,4) NOT NULL CHECK (valor_unitario >= 0),
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_contract_instrument_items_instrument ON public.contract_instrument_items (instrument_id);

CREATE TABLE public.contract_instrument_usages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id uuid NOT NULL REFERENCES public.contract_instruments(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES public.contract_instrument_items(id) ON DELETE RESTRICT,
  quantidade numeric(14,2) NOT NULL CHECK (quantidade > 0),
  valor_total numeric(14,2) NOT NULL CHECK (valor_total >= 0),
  data_utilizacao date NOT NULL,
  documento text CHECK (documento IS NULL OR length(trim(documento)) BETWEEN 1 AND 120),
  observacao text CHECK (observacao IS NULL OR length(observacao) <= 2000),
  demanda_id uuid REFERENCES public.demands(id),
  registrado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_contract_instrument_usages_instrument ON public.contract_instrument_usages (instrument_id, data_utilizacao);
CREATE INDEX idx_contract_instrument_usages_item ON public.contract_instrument_usages (item_id);
CREATE TRIGGER contract_instrument_usages_immutable
  BEFORE UPDATE OR DELETE ON public.contract_instrument_usages
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

CREATE TABLE public.contract_instrument_amendments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id uuid NOT NULL REFERENCES public.contract_instruments(id) ON DELETE RESTRICT,
  tipo text NOT NULL CHECK (tipo IN ('prorrogacao', 'acrescimo', 'supressao', 'reajuste', 'outro')),
  numero text CHECK (numero IS NULL OR length(trim(numero)) BETWEEN 1 AND 60),
  data_assinatura date,
  vigencia_fim_anterior date,
  vigencia_fim_nova date,
  valor_anterior numeric(14,2) NOT NULL CHECK (valor_anterior >= 0),
  valor_novo numeric(14,2) NOT NULL CHECK (valor_novo >= 0),
  descricao text NOT NULL CHECK (length(trim(descricao)) BETWEEN 3 AND 2000),
  registrado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_contract_instrument_amendments_instrument ON public.contract_instrument_amendments (instrument_id, created_at);
CREATE TRIGGER contract_instrument_amendments_immutable
  BEFORE UPDATE OR DELETE ON public.contract_instrument_amendments
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

CREATE TABLE public.contract_instrument_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id uuid NOT NULL REFERENCES public.contract_instruments(id) ON DELETE RESTRICT,
  amendment_id uuid REFERENCES public.contract_instrument_amendments(id) ON DELETE RESTRICT,
  nome_original text NOT NULL CHECK (length(nome_original) BETWEEN 1 AND 180),
  tipo text NOT NULL CHECK (tipo IN ('pdf', 'png', 'jpeg', 'webp', 'docx', 'xlsx', 'txt')),
  tamanho_bytes bigint NOT NULL CHECK (tamanho_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL UNIQUE,
  enviado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  removido_em timestamptz,
  removido_por uuid REFERENCES public.auth_users(id),
  motivo_remocao text,
  CONSTRAINT contract_instrument_attachments_removal_complete CHECK (
    (removido_em IS NULL AND removido_por IS NULL AND motivo_remocao IS NULL)
    OR (removido_em IS NOT NULL AND removido_por IS NOT NULL AND motivo_remocao IS NOT NULL)
  )
);
CREATE INDEX idx_contract_instrument_attachments_instrument ON public.contract_instrument_attachments (instrument_id, created_at);
CREATE TRIGGER contract_instrument_attachments_not_deleted
  BEFORE DELETE ON public.contract_instrument_attachments
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

ALTER TABLE public.contract_instruments
  ADD CONSTRAINT contract_instruments_renovacao_fk FOREIGN KEY (renovacao_demanda_id) REFERENCES public.demands(id);

ALTER TABLE public.demands ADD COLUMN instrumento_id uuid REFERENCES public.contract_instruments(id);
CREATE INDEX idx_demands_instrumento ON public.demands (instrumento_id) WHERE instrumento_id IS NOT NULL;

-- Fora do alcance da API pública do Supabase, como as demais tabelas.
ALTER TABLE public.contract_instruments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_instrument_sectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_instrument_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_instrument_usages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_instrument_amendments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_instrument_attachments ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.contract_instruments, public.contract_instrument_sectors, public.contract_instrument_items,
  public.contract_instrument_usages, public.contract_instrument_amendments, public.contract_instrument_attachments
FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.contract_instruments, public.contract_instrument_sectors, '
        'public.contract_instrument_items, public.contract_instrument_usages, '
        'public.contract_instrument_amendments, public.contract_instrument_attachments FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
