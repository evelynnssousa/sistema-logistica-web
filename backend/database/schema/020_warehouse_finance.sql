-- Pendente: esta migração ainda não foi aplicada em nenhum banco remoto.
--
-- Valores do Almoxarifado (12/11/2026, pedido da responsável): controle orçamentário do estoque.
--
-- 1. public.warehouse_price_agreements: as atas de registro de preços, com o valor que pode ser
--    gasto. O gasto de cada ata é a soma das entradas vinculadas a ela.
-- 2. public.materials.valor_estoque: valor total do saldo de cada material. O custo médio é
--    valor_estoque / estoque_atual (custo médio ponderado). Começa em zero para todos.
-- 3. public.stock_movements: valor da movimentação (na entrada, o valor pago; na saída, o custo
--    médio do momento), se o valor foi digitado, nota fiscal, empenho, fornecedor e ata. As
--    movimentações anteriores ficam sem valor.
-- 4. public.material_value_adjustments: registro permanente de cada vez que alguém informa o valor
--    do saldo de um material (por exemplo, o valor do estoque que já existia antes desta migração).
--
-- Não apaga nem altera registros existentes. Depende da 009 (stock_movements permanente) e da 007
-- (reject_history_change). Sem ela, o sistema continua funcionando sem valores.
-- Para desfazer: 020_warehouse_finance.rollback.sql.
BEGIN;

CREATE TABLE public.warehouse_price_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero text NOT NULL CHECK (length(trim(numero)) BETWEEN 1 AND 60),
  fornecedor text CHECK (fornecedor IS NULL OR length(trim(fornecedor)) BETWEEN 1 AND 200),
  objeto text CHECK (objeto IS NULL OR length(trim(objeto)) BETWEEN 1 AND 500),
  valor_total numeric(14,2) NOT NULL CHECK (valor_total >= 0),
  vigencia_inicio date,
  vigencia_fim date,
  ativo boolean NOT NULL DEFAULT true,
  criado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (vigencia_inicio IS NULL OR vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio)
);

CREATE UNIQUE INDEX idx_warehouse_price_agreements_numero
  ON public.warehouse_price_agreements (lower(trim(numero)));

ALTER TABLE public.materials
  ADD COLUMN valor_estoque numeric(14,2) NOT NULL DEFAULT 0 CHECK (valor_estoque >= 0);

ALTER TABLE public.stock_movements
  ADD COLUMN valor_total numeric(14,2) CHECK (valor_total IS NULL OR valor_total >= 0),
  ADD COLUMN valor_informado boolean NOT NULL DEFAULT false,
  ADD COLUMN nota_fiscal text CHECK (nota_fiscal IS NULL OR length(trim(nota_fiscal)) BETWEEN 1 AND 60),
  ADD COLUMN empenho text CHECK (empenho IS NULL OR length(trim(empenho)) BETWEEN 1 AND 60),
  ADD COLUMN fornecedor text CHECK (fornecedor IS NULL OR length(trim(fornecedor)) BETWEEN 1 AND 200),
  ADD COLUMN ata_id uuid REFERENCES public.warehouse_price_agreements(id);

CREATE INDEX idx_sm_ata ON public.stock_movements (ata_id) WHERE ata_id IS NOT NULL;
CREATE INDEX idx_sm_created_at ON public.stock_movements (created_at);

CREATE TABLE public.material_value_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id uuid NOT NULL REFERENCES public.materials(id),
  quantidade numeric(12,2) NOT NULL CHECK (quantidade >= 0),
  valor_anterior numeric(14,2) NOT NULL CHECK (valor_anterior >= 0),
  valor_novo numeric(14,2) NOT NULL CHECK (valor_novo >= 0),
  justificativa text NOT NULL CHECK (length(trim(justificativa)) BETWEEN 3 AND 2000),
  usuario_id uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_material_value_adjustments_material ON public.material_value_adjustments (material_id, created_at DESC);

CREATE TRIGGER material_value_adjustments_immutable
  BEFORE UPDATE OR DELETE ON public.material_value_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- Fora do alcance da API pública do Supabase, como as demais tabelas.
ALTER TABLE public.warehouse_price_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_value_adjustments ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.warehouse_price_agreements, public.material_value_adjustments FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.warehouse_price_agreements, public.material_value_adjustments FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
