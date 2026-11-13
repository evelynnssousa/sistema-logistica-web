-- Pendente: esta migração ainda não foi aplicada em nenhum banco remoto.
--
-- Controle de patrimônio (13/11/2026, pedido da responsável): a SLM cuida de todo o patrimônio do
-- órgão, registra os bens com leitor de código de barras e confere onde cada um está.
--
-- 1. public.patrimony_assets: cada bem, pelo número de patrimônio (o do código de barras), com
--    descrição, setor, sala, situação, marca, modelo, número de série, data em que foi patrimoniado,
--    valor de aquisição, nota fiscal e fornecedor. O número é único sem contar pontos, traços e
--    espaços: "123.456" e "123456" são o mesmo bem.
-- 2. public.patrimony_movements: histórico permanente (não se altera nem se apaga) de cada cadastro,
--    importação, alteração, mudança de setor ou sala, mudança de situação e conferência.
-- 3. public.patrimony_checks e public.patrimony_check_reads: conferências por setor ou sala. Cada
--    leitura do código de barras fica registrada com o resultado (no local, em outro local, não
--    cadastrado ou baixado) e o local onde o sistema dizia que o bem estava. As leituras também são
--    permanentes.
--
-- Não altera nenhuma tabela existente. Depende da 007 (reject_history_change).
-- Para desfazer: 023_patrimony.rollback.sql.
BEGIN;

CREATE TABLE public.patrimony_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero text NOT NULL CHECK (length(trim(numero)) BETWEEN 1 AND 60 AND numero ~ '[A-Za-z0-9]'),
  descricao text NOT NULL CHECK (length(trim(descricao)) BETWEEN 2 AND 500),
  setor_id uuid REFERENCES public.setores(id),
  sala text CHECK (sala IS NULL OR length(trim(sala)) BETWEEN 1 AND 120),
  situacao text NOT NULL DEFAULT 'em_uso'
    CHECK (situacao IN ('em_uso', 'ocioso', 'em_manutencao', 'inservivel', 'baixado')),
  marca text CHECK (marca IS NULL OR length(trim(marca)) BETWEEN 1 AND 120),
  modelo text CHECK (modelo IS NULL OR length(trim(modelo)) BETWEEN 1 AND 120),
  numero_serie text CHECK (numero_serie IS NULL OR length(trim(numero_serie)) BETWEEN 1 AND 120),
  data_tombamento date,
  valor_aquisicao numeric(14,2) CHECK (valor_aquisicao IS NULL OR valor_aquisicao >= 0),
  nota_fiscal text CHECK (nota_fiscal IS NULL OR length(trim(nota_fiscal)) BETWEEN 1 AND 60),
  fornecedor text CHECK (fornecedor IS NULL OR length(trim(fornecedor)) BETWEEN 1 AND 200),
  observacao text CHECK (observacao IS NULL OR length(trim(observacao)) BETWEEN 1 AND 2000),
  ultima_conferencia_em timestamptz,
  ultima_conferencia_por uuid REFERENCES public.auth_users(id),
  criado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- O leitor de código de barras e a digitação podem diferir em pontos, traços e espaços.
CREATE UNIQUE INDEX idx_patrimony_assets_numero
  ON public.patrimony_assets (upper(regexp_replace(numero, '[^A-Za-z0-9]', '', 'g')));
CREATE INDEX idx_patrimony_assets_local ON public.patrimony_assets (setor_id, lower(sala));
CREATE INDEX idx_patrimony_assets_situacao ON public.patrimony_assets (situacao);

CREATE TABLE public.patrimony_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES public.patrimony_assets(id),
  tipo text NOT NULL CHECK (tipo IN ('cadastro', 'importacao', 'alteracao', 'mudanca_local', 'situacao', 'conferencia')),
  setor_anterior_id uuid REFERENCES public.setores(id),
  setor_novo_id uuid REFERENCES public.setores(id),
  sala_anterior text,
  sala_nova text,
  situacao_anterior text,
  situacao_nova text,
  -- Campos alterados, com o valor anterior e o novo (nunca o valor de aquisição em texto livre).
  detalhes jsonb,
  observacao text CHECK (observacao IS NULL OR length(trim(observacao)) BETWEEN 1 AND 2000),
  usuario_id uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_patrimony_movements_asset ON public.patrimony_movements (asset_id, created_at DESC);

CREATE TRIGGER patrimony_movements_immutable
  BEFORE UPDATE OR DELETE ON public.patrimony_movements
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

CREATE TABLE public.patrimony_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo text NOT NULL CHECK (length(trim(titulo)) BETWEEN 3 AND 160),
  setor_id uuid REFERENCES public.setores(id),
  sala text CHECK (sala IS NULL OR length(trim(sala)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'em_andamento' CHECK (status IN ('em_andamento', 'concluida', 'cancelada')),
  comentario text CHECK (comentario IS NULL OR length(trim(comentario)) BETWEEN 1 AND 2000),
  criado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  encerrada_por uuid REFERENCES public.auth_users(id),
  encerrada_em timestamptz,
  CHECK ((status = 'em_andamento') = (encerrada_em IS NULL))
);

CREATE INDEX idx_patrimony_checks_created ON public.patrimony_checks (created_at DESC);

CREATE TABLE public.patrimony_check_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL REFERENCES public.patrimony_checks(id),
  numero_lido text NOT NULL CHECK (length(trim(numero_lido)) BETWEEN 1 AND 60),
  asset_id uuid REFERENCES public.patrimony_assets(id),
  resultado text NOT NULL CHECK (resultado IN ('no_local', 'outro_local', 'nao_cadastrado', 'baixado')),
  -- Onde o sistema dizia que o bem estava no momento da leitura.
  setor_registrado_id uuid REFERENCES public.setores(id),
  sala_registrada text,
  lido_por uuid NOT NULL REFERENCES public.auth_users(id),
  lido_em timestamptz NOT NULL DEFAULT now(),
  CHECK ((asset_id IS NULL) = (resultado = 'nao_cadastrado'))
);

-- O mesmo bem lido duas vezes na mesma conferência conta uma vez.
CREATE UNIQUE INDEX idx_patrimony_check_reads_unique
  ON public.patrimony_check_reads (check_id, upper(regexp_replace(numero_lido, '[^A-Za-z0-9]', '', 'g')));

CREATE TRIGGER patrimony_check_reads_immutable
  BEFORE UPDATE OR DELETE ON public.patrimony_check_reads
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- Fora do alcance da API pública do Supabase, como as demais tabelas.
ALTER TABLE public.patrimony_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patrimony_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patrimony_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patrimony_check_reads ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.patrimony_assets, public.patrimony_movements,
  public.patrimony_checks, public.patrimony_check_reads FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.patrimony_assets, public.patrimony_movements, public.patrimony_checks, public.patrimony_check_reads FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
