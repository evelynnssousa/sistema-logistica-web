-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Devolução para correção, tempo de espera do solicitante, motivos do atendimento parcial, saldo
-- reservado, histórico administrativo dos parâmetros, versões de modelos e formulários e controle
-- interno do Almoxarifado. Depende das migrações 005, 006 e 007.
-- Só acrescenta: nenhum registro é reescrito. As justificativas de agendamento e cancelamento não
-- precisam de tabela: ficam em request_history.detalhes, que já é imutável.
-- Enquanto não for aplicada, os fluxos anteriores continuam funcionando, e só o que depende dela
-- responde 503. Para desfazer: 012_operational_transparency.rollback.sql.
BEGIN;

-- ---------------------------------------------------------------------------
-- Devolução ao solicitante: a mesma solicitação, com o mesmo protocolo. O status não muda; a
-- espera é um estado à parte, para não misturar "o que falta fazer" com "de quem é a vez".
-- ---------------------------------------------------------------------------
ALTER TABLE public.service_requests
  -- Preenchida enquanto há devolução aberta. O prazo interno não corre nesse período.
  ADD COLUMN aguardando_externo_desde timestamptz,
  -- Total das esperas já encerradas.
  ADD COLUMN espera_externa_segundos integer NOT NULL DEFAULT 0
    CHECK (espera_externa_segundos >= 0);

CREATE INDEX idx_sr_aguardando_externo ON public.service_requests (aguardando_externo_desde)
  WHERE aguardando_externo_desde IS NOT NULL;

CREATE TABLE public.request_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.service_requests(id) ON DELETE RESTRICT,
  tipo text NOT NULL CHECK (tipo IN ('correcao', 'complementacao')),
  motivo text NOT NULL CHECK (length(trim(motivo)) BETWEEN 3 AND 2000),
  -- Chaves dos campos a corrigir, conferidas pela aplicação.
  campos text[] NOT NULL DEFAULT '{}',
  situacao text NOT NULL DEFAULT 'aberta' CHECK (situacao IN ('aberta', 'atendida', 'encerrada')),
  devolvida_por uuid NOT NULL REFERENCES public.auth_users(id),
  devolvida_em timestamptz NOT NULL DEFAULT now(),
  -- Resposta do solicitante ou motivo de a equipe encerrar a devolução.
  resposta text CHECK (resposta IS NULL OR length(trim(resposta)) BETWEEN 1 AND 2000),
  -- Dados da solicitação logo antes da correção. Nunca contém CPF: ele fica em outra tabela.
  dados_anteriores jsonb,
  finalizada_por uuid REFERENCES public.auth_users(id),
  finalizada_em timestamptz,
  CONSTRAINT request_returns_finished CHECK (
    (situacao = 'aberta') = (finalizada_em IS NULL)
    AND (situacao = 'aberta') = (finalizada_por IS NULL)
  )
);

CREATE INDEX idx_request_returns_request ON public.request_returns (request_id, devolvida_em);
-- Uma devolução aberta por solicitação: duas pessoas não devolvem ao mesmo tempo.
CREATE UNIQUE INDEX request_returns_one_open ON public.request_returns (request_id)
  WHERE situacao = 'aberta';

-- Uma devolução é registrada uma vez e finalizada uma vez. Depois disso, não muda nem some.
CREATE FUNCTION public.protect_request_return()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.situacao = 'aberta'
     AND NEW.situacao <> 'aberta'
     AND NEW.id = OLD.id
     AND NEW.request_id = OLD.request_id
     AND NEW.tipo = OLD.tipo
     AND NEW.motivo = OLD.motivo
     AND NEW.campos = OLD.campos
     AND NEW.devolvida_por = OLD.devolvida_por
     AND NEW.devolvida_em = OLD.devolvida_em THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Registros de histórico e auditoria não podem ser alterados.'
    USING ERRCODE = 'integrity_constraint_violation';
END
$function$;

CREATE TRIGGER request_returns_protected
  BEFORE UPDATE OR DELETE ON public.request_returns
  FOR EACH ROW EXECUTE FUNCTION public.protect_request_return();

-- ---------------------------------------------------------------------------
-- Almoxarifado: motivo por item e saldo reservado. O saldo físico continua em estoque_atual, e
-- nada aqui obriga a fornecer o que está em estoque.
-- ---------------------------------------------------------------------------
ALTER TABLE public.materials
  ADD COLUMN quantidade_reservada numeric(12,2) NOT NULL DEFAULT 0
    CHECK (quantidade_reservada >= 0);

ALTER TABLE public.material_request_items
  ADD COLUMN motivo_codigo text CHECK (motivo_codigo IS NULL OR length(motivo_codigo) BETWEEN 1 AND 60),
  -- Nome copiado: renomear um motivo não altera o que foi registrado.
  ADD COLUMN motivo_nome text CHECK (motivo_nome IS NULL OR length(motivo_nome) BETWEEN 1 AND 120),
  ADD COLUMN observacao text CHECK (observacao IS NULL OR length(trim(observacao)) BETWEEN 1 AND 2000);

-- Interno, separado de material_request_history porque aquele é exibido ao solicitante.
CREATE TABLE public.material_item_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_request_id uuid NOT NULL REFERENCES public.material_requests(id) ON DELETE RESTRICT,
  material_id uuid NOT NULL REFERENCES public.materials(id),
  material_nome text NOT NULL,
  unidade text NOT NULL,
  solicitada numeric(12,2) NOT NULL,
  atendida_anterior numeric(12,2),
  atendida_nova numeric(12,2) NOT NULL,
  motivo_codigo text,
  motivo_nome text,
  observacao text,
  usuario_id uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_material_item_changes_request
  ON public.material_item_changes (material_request_id, created_at);

CREATE TRIGGER material_item_changes_immutable
  BEFORE UPDATE OR DELETE ON public.material_item_changes
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- ---------------------------------------------------------------------------
-- Histórico administrativo dos parâmetros, incluindo os modelos de e-mail.
-- ---------------------------------------------------------------------------
CREATE TABLE public.settings_change_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secao text NOT NULL CHECK (length(secao) BETWEEN 1 AND 60),
  valor_anterior jsonb,
  valor_novo jsonb NOT NULL,
  usuario_id uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_settings_change_history ON public.settings_change_history (secao, created_at DESC);

CREATE TRIGGER settings_change_history_immutable
  BEFORE UPDATE OR DELETE ON public.settings_change_history
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- ---------------------------------------------------------------------------
-- Modelos de e-mail e formulários administráveis (Supercomando 07). Cada salvamento é uma nova
-- versão, que não muda depois. O que está em uso é a publicada mais recente de cada chave, e
-- restaurar publica uma cópia: nenhuma versão anterior se perde.
-- ---------------------------------------------------------------------------
CREATE TABLE public.config_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL CHECK (tipo IN ('email_template', 'form')),
  chave text NOT NULL CHECK (chave ~ '^[A-Za-z0-9_-]{1,80}$'),
  versao integer NOT NULL CHECK (versao >= 1),
  situacao text NOT NULL CHECK (situacao IN ('rascunho', 'publicada')),
  conteudo jsonb NOT NULL,
  observacao text CHECK (observacao IS NULL OR length(trim(observacao)) BETWEEN 1 AND 500),
  usuario_id uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tipo, chave, versao)
);

CREATE INDEX idx_config_versions_published ON public.config_versions (tipo, chave, versao DESC)
  WHERE situacao = 'publicada';

CREATE TRIGGER config_versions_immutable
  BEFORE UPDATE OR DELETE ON public.config_versions
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- Versão do formulário usada em cada cadastro, e campos próprios do formulário de conta.
ALTER TABLE public.service_requests ADD COLUMN formulario_versao integer;
ALTER TABLE public.auth_users
  ADD COLUMN dados_cadastrais jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN formulario_versao integer;

-- Controle interno do Almoxarifado. Não é um pedido de materiais: só referencia, quando houver,
-- a solicitação feita no sistema governamental, e não movimenta saldo.
CREATE TABLE public.warehouse_control_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referencia_externa text CHECK (referencia_externa IS NULL OR length(trim(referencia_externa)) BETWEEN 1 AND 120),
  setor_id uuid REFERENCES public.setores(id),
  setor_nome text,
  material_id uuid NOT NULL REFERENCES public.materials(id),
  material_nome text NOT NULL,
  unidade text NOT NULL,
  descricao text CHECK (descricao IS NULL OR length(trim(descricao)) BETWEEN 1 AND 2000),
  quantidade_referencia numeric(12,2) CHECK (quantidade_referencia >= 0),
  quantidade_conferida numeric(12,2) CHECK (quantidade_conferida >= 0),
  quantidade_disponibilizada numeric(12,2) CHECK (quantidade_disponibilizada >= 0),
  observacoes text CHECK (observacoes IS NULL OR length(trim(observacoes)) BETWEEN 1 AND 2000),
  justificativa text CHECK (justificativa IS NULL OR length(trim(justificativa)) BETWEEN 1 AND 2000),
  campos_adicionais jsonb NOT NULL DEFAULT '{}'::jsonb,
  formulario_versao integer,
  registrado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_warehouse_control_created ON public.warehouse_control_records (created_at DESC);

CREATE TRIGGER warehouse_control_records_immutable
  BEFORE UPDATE OR DELETE ON public.warehouse_control_records
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- ---------------------------------------------------------------------------
-- Mesmo tratamento das demais tabelas: fora do alcance da API pública do Supabase.
-- ---------------------------------------------------------------------------
ALTER TABLE public.request_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_item_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings_change_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.config_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_control_records ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.request_returns,
  public.material_item_changes,
  public.settings_change_history,
  public.config_versions,
  public.warehouse_control_records
FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.protect_request_return() FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.request_returns, public.material_item_changes, public.settings_change_history, public.config_versions, public.warehouse_control_records FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.protect_request_return() FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
