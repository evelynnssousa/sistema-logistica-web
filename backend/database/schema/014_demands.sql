-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Controle de Demandas da Diretoria Administrativa: setores e integrantes, categorias, demandas,
-- recorrências, colaboração, anexos, histórico e agenda. Depende das migrações 005, 006 e 007.
--
-- O que muda em tabelas existentes: as listas de valores aceitos em protocol_counters.prefixo e
-- integration_events.module ganham um valor novo cada. Nenhum registro existente é alterado.
-- Enquanto não for aplicada, o módulo fica oculto e o restante do sistema segue igual.
-- Nenhum setor é criado aqui: os nomes e integrantes são cadastrados em Configurações. As categorias
-- iniciais são apenas pontos de partida, e podem ser editadas ou desativadas.
-- Para desfazer: 014_demands.rollback.sql.
BEGIN;

ALTER TABLE public.protocol_counters DROP CONSTRAINT protocol_counters_prefixo_check;
ALTER TABLE public.protocol_counters ADD CONSTRAINT protocol_counters_prefixo_check
  CHECK (prefixo IN ('MAN', 'FRO', 'PAS', 'ALM', 'DEM'));

ALTER TABLE public.integration_events DROP CONSTRAINT integration_events_module_check;
ALTER TABLE public.integration_events ADD CONSTRAINT integration_events_module_check
  CHECK (module IN ('maintenance', 'fleet', 'flights', 'warehouse', 'system', 'demands'));

-- ---------------------------------------------------------------------------
-- Setores da Diretoria Administrativa. Independentes de public.setores, que lista todos os setores
-- da instituição: estar em um setor de lá nunca dá acesso a este módulo.
-- ---------------------------------------------------------------------------
CREATE TABLE public.demand_sectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL CHECK (length(trim(nome)) BETWEEN 2 AND 120),
  sigla text CHECK (sigla IS NULL OR length(trim(sigla)) BETWEEN 1 AND 20),
  descricao text CHECK (descricao IS NULL OR length(descricao) <= 500),
  ativo boolean NOT NULL DEFAULT true,
  ordem integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX demand_sectors_unique_name ON public.demand_sectors (lower(trim(nome)));
CREATE TRIGGER trg_demand_sectors_updated_at
  BEFORE UPDATE ON public.demand_sectors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Quem sai de um setor fica como inativo: o vínculo antigo continua explicando o histórico.
CREATE TABLE public.demand_sector_members (
  sector_id uuid NOT NULL REFERENCES public.demand_sectors(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.auth_users(id) ON DELETE RESTRICT,
  papel text NOT NULL DEFAULT 'colaborador' CHECK (papel IN ('colaborador', 'responsavel')),
  pode_cadastrar boolean NOT NULL DEFAULT true,
  ver_setor boolean NOT NULL DEFAULT true,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sector_id, user_id)
);
CREATE INDEX idx_demand_members_user ON public.demand_sector_members (user_id) WHERE ativo;
CREATE TRIGGER trg_demand_members_updated_at
  BEFORE UPDATE ON public.demand_sector_members
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.demand_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL CHECK (length(trim(nome)) BETWEEN 2 AND 120),
  descricao text CHECK (descricao IS NULL OR length(descricao) <= 500),
  ativo boolean NOT NULL DEFAULT true,
  ordem integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX demand_categories_unique_name ON public.demand_categories (lower(trim(nome)));
CREATE TRIGGER trg_demand_categories_updated_at
  BEFORE UPDATE ON public.demand_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.demand_categories (nome, ordem) VALUES
  ('Atividades administrativas', 10),
  ('Levantamentos', 20),
  ('Relatórios', 30),
  ('Controles internos', 40),
  ('Planejamento', 50),
  ('Reuniões', 60),
  ('Documentação', 70),
  ('Acompanhamento de processos', 80),
  ('Providências externas', 90),
  ('Atividades periódicas', 100);

-- ---------------------------------------------------------------------------
-- Série recorrente. proxima_execucao é o controle da próxima ocorrência a gerar; "modelo" guarda o
-- que cada nova ocorrência copia. Encerrar ou cancelar nunca apaga as ocorrências já geradas.
-- ---------------------------------------------------------------------------
CREATE TABLE public.demand_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  frequencia text NOT NULL CHECK (frequencia IN (
    'diaria', 'semanal', 'quinzenal', 'mensal', 'bimestral', 'trimestral', 'semestral', 'anual', 'personalizada'
  )),
  intervalo integer NOT NULL CHECK (intervalo BETWEEN 1 AND 365),
  unidade text NOT NULL CHECK (unidade IN ('dia', 'semana', 'mes', 'ano')),
  dias_semana integer[] NOT NULL DEFAULT '{}',
  dias_mes integer[] NOT NULL DEFAULT '{}',
  data_inicio date NOT NULL,
  fim_tipo text NOT NULL CHECK (fim_tipo IN ('sem_fim', 'quantidade', 'data')),
  fim_quantidade integer CHECK (fim_quantidade IS NULL OR fim_quantidade BETWEEN 1 AND 1000),
  fim_data date,
  antecedencia_dias integer NOT NULL DEFAULT 0 CHECK (antecedencia_dias BETWEEN 0 AND 60),
  inicio_offset_dias integer NOT NULL DEFAULT 0 CHECK (inicio_offset_dias BETWEEN 0 AND 60),
  status text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'suspensa', 'cancelada', 'encerrada')),
  proxima_execucao date,
  ocorrencias_contadas integer NOT NULL DEFAULT 0 CHECK (ocorrencias_contadas >= 0),
  ultima_execucao_em timestamptz,
  modelo jsonb NOT NULL,
  criado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT demand_series_end_consistent CHECK (
    (fim_tipo = 'sem_fim' AND fim_quantidade IS NULL AND fim_data IS NULL)
    OR (fim_tipo = 'quantidade' AND fim_quantidade IS NOT NULL AND fim_data IS NULL)
    OR (fim_tipo = 'data' AND fim_quantidade IS NULL AND fim_data IS NOT NULL)
  )
);
CREATE INDEX idx_demand_series_due ON public.demand_series (proxima_execucao) WHERE status = 'ativa';
CREATE TRIGGER trg_demand_series_updated_at
  BEFORE UPDATE ON public.demand_series
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER demand_series_not_deleted
  BEFORE DELETE ON public.demand_series
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- ---------------------------------------------------------------------------
-- Demandas. Exclusão só lógica, e só de rascunhos: o gatilho recusa DELETE.
-- ---------------------------------------------------------------------------
CREATE TABLE public.demands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero text NOT NULL UNIQUE,
  titulo text NOT NULL CHECK (length(trim(titulo)) BETWEEN 3 AND 200),
  descricao text CHECK (descricao IS NULL OR length(descricao) <= 8000),
  categoria_id uuid REFERENCES public.demand_categories(id),
  setor_origem_id uuid REFERENCES public.demand_sectors(id),
  setor_responsavel_id uuid REFERENCES public.demand_sectors(id),
  solicitante_id uuid REFERENCES public.auth_users(id),
  responsavel_id uuid REFERENCES public.auth_users(id),
  criado_por uuid NOT NULL REFERENCES public.auth_users(id),
  data_abertura timestamptz NOT NULL DEFAULT now(),
  inicio_previsto date,
  prazo date,
  prioridade text NOT NULL DEFAULT 'media' CHECK (prioridade IN ('baixa', 'media', 'alta', 'urgente')),
  status text NOT NULL DEFAULT 'nao_iniciada' CHECK (status IN (
    'nao_iniciada', 'em_andamento', 'aguardando_terceiros', 'aguardando_autorizacao',
    'suspensa', 'concluida', 'cancelada'
  )),
  rascunho boolean NOT NULL DEFAULT false,
  restrita boolean NOT NULL DEFAULT false,
  observacoes text CHECK (observacoes IS NULL OR length(observacoes) <= 4000),
  referencias text CHECK (referencias IS NULL OR length(referencias) <= 2000),
  lembrete_dias integer CHECK (lembrete_dias IS NULL OR lembrete_dias BETWEEN 0 AND 60),
  aguardando_quem text CHECK (aguardando_quem IS NULL OR length(aguardando_quem) <= 200),
  suspensao_motivo text CHECK (suspensao_motivo IS NULL OR length(suspensao_motivo) <= 2000),
  suspensao_retomada date,
  conclusao_realizado text,
  conclusao_resultado text,
  conclusao_observacoes text,
  concluida_em timestamptz,
  concluida_por uuid REFERENCES public.auth_users(id),
  reaberturas integer NOT NULL DEFAULT 0 CHECK (reaberturas >= 0),
  cancelamento_motivo text,
  cancelada_em timestamptz,
  cancelada_por uuid REFERENCES public.auth_users(id),
  series_id uuid REFERENCES public.demand_series(id) ON DELETE RESTRICT,
  data_ocorrencia date,
  ocorrencia_personalizada boolean NOT NULL DEFAULT false,
  recorrencia_rascunho jsonb,
  versao integer NOT NULL DEFAULT 1 CHECK (versao >= 1),
  ultima_atividade_em timestamptz NOT NULL DEFAULT now(),
  excluida_em timestamptz,
  excluida_por uuid REFERENCES public.auth_users(id),
  motivo_exclusao text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Um rascunho só exige o título; publicada, a demanda precisa estar identificada.
  CONSTRAINT demands_published_complete CHECK (
    rascunho OR (
      descricao IS NOT NULL AND categoria_id IS NOT NULL AND setor_origem_id IS NOT NULL
      AND setor_responsavel_id IS NOT NULL AND solicitante_id IS NOT NULL
    )
  ),
  CONSTRAINT demands_occurrence_consistent CHECK ((series_id IS NULL) = (data_ocorrencia IS NULL)),
  CONSTRAINT demands_deletion_only_draft CHECK (excluida_em IS NULL OR rascunho),
  CONSTRAINT demands_completion_complete CHECK (
    status <> 'concluida' OR (conclusao_realizado IS NOT NULL AND concluida_em IS NOT NULL AND concluida_por IS NOT NULL)
  ),
  CONSTRAINT demands_cancellation_complete CHECK (
    status <> 'cancelada' OR (cancelamento_motivo IS NOT NULL AND cancelada_em IS NOT NULL AND cancelada_por IS NOT NULL)
  ),
  CONSTRAINT demands_suspension_justified CHECK (status <> 'suspensa' OR suspensao_motivo IS NOT NULL),
  CONSTRAINT demands_waiting_identified CHECK (status <> 'aguardando_terceiros' OR aguardando_quem IS NOT NULL)
);

-- A última barreira contra duplicidade: a mesma data de uma série nunca gera duas demandas.
CREATE UNIQUE INDEX demands_unique_occurrence ON public.demands (series_id, data_ocorrencia)
  WHERE series_id IS NOT NULL;
CREATE INDEX idx_demands_status ON public.demands (status) WHERE excluida_em IS NULL;
CREATE INDEX idx_demands_prazo ON public.demands (prazo) WHERE excluida_em IS NULL;
CREATE INDEX idx_demands_responsavel ON public.demands (responsavel_id) WHERE excluida_em IS NULL;
CREATE INDEX idx_demands_setor ON public.demands (setor_responsavel_id) WHERE excluida_em IS NULL;
CREATE INDEX idx_demands_origem ON public.demands (setor_origem_id) WHERE excluida_em IS NULL;
CREATE INDEX idx_demands_atividade ON public.demands (ultima_atividade_em DESC) WHERE excluida_em IS NULL;

CREATE TRIGGER trg_demands_updated_at
  BEFORE UPDATE ON public.demands
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER demands_not_deleted
  BEFORE DELETE ON public.demands
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- Registro de cada data de uma série. A chave única torna o reprocessamento seguro.
CREATE TABLE public.demand_series_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id uuid NOT NULL REFERENCES public.demand_series(id) ON DELETE RESTRICT,
  data_prevista date NOT NULL,
  situacao text NOT NULL CHECK (situacao IN ('gerada', 'pulada')),
  demand_id uuid REFERENCES public.demands(id) ON DELETE RESTRICT,
  motivo text,
  registrado_por uuid REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (series_id, data_prevista)
);

-- ---------------------------------------------------------------------------
-- Participação: colaboradores (com atividade própria), autorizados a ver demandas restritas e
-- quem acompanha. Sair é lógico, para o histórico continuar coerente.
-- ---------------------------------------------------------------------------
CREATE TABLE public.demand_participants (
  demand_id uuid NOT NULL REFERENCES public.demands(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.auth_users(id) ON DELETE RESTRICT,
  tipo text NOT NULL CHECK (tipo IN ('colaborador', 'autorizado', 'acompanhante')),
  atividade text CHECK (atividade IS NULL OR length(atividade) <= 500),
  prazo date,
  adicionado_por uuid REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (demand_id, user_id, tipo)
);
CREATE INDEX idx_demand_participants_user ON public.demand_participants (user_id);

CREATE TABLE public.demand_sector_links (
  demand_id uuid NOT NULL REFERENCES public.demands(id) ON DELETE RESTRICT,
  sector_id uuid NOT NULL REFERENCES public.demand_sectors(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (demand_id, sector_id)
);
CREATE INDEX idx_demand_sector_links_sector ON public.demand_sector_links (sector_id);

CREATE TABLE public.demand_subtasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id uuid NOT NULL REFERENCES public.demands(id) ON DELETE RESTRICT,
  titulo text NOT NULL CHECK (length(trim(titulo)) BETWEEN 2 AND 200),
  descricao text CHECK (descricao IS NULL OR length(descricao) <= 4000),
  responsavel_id uuid REFERENCES public.auth_users(id),
  prazo date,
  status text NOT NULL DEFAULT 'nao_iniciada'
    CHECK (status IN ('nao_iniciada', 'em_andamento', 'concluida', 'cancelada')),
  observacoes text CHECK (observacoes IS NULL OR length(observacoes) <= 4000),
  concluida_em timestamptz,
  concluida_por uuid REFERENCES public.auth_users(id),
  criado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_demand_subtasks_demand ON public.demand_subtasks (demand_id, created_at);
CREATE INDEX idx_demand_subtasks_user ON public.demand_subtasks (responsavel_id);
CREATE TRIGGER trg_demand_subtasks_updated_at
  BEFORE UPDATE ON public.demand_subtasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER demand_subtasks_not_deleted
  BEFORE DELETE ON public.demand_subtasks
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- Comentários, providências e andamentos não mudam nem somem.
CREATE TABLE public.demand_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id uuid NOT NULL REFERENCES public.demands(id) ON DELETE RESTRICT,
  tipo text NOT NULL DEFAULT 'comentario' CHECK (tipo IN ('comentario', 'providencia', 'andamento')),
  texto text NOT NULL CHECK (length(trim(texto)) BETWEEN 1 AND 4000),
  mencoes uuid[] NOT NULL DEFAULT '{}',
  autor_id uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_demand_comments_demand ON public.demand_comments (demand_id, created_at);
CREATE TRIGGER demand_comments_immutable
  BEFORE UPDATE OR DELETE ON public.demand_comments
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- Histórico de uma demanda, de uma série ou das duas. Sem autor: ação automática do sistema.
CREATE TABLE public.demand_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  demand_id uuid REFERENCES public.demands(id) ON DELETE RESTRICT,
  series_id uuid REFERENCES public.demand_series(id) ON DELETE RESTRICT,
  usuario_id uuid REFERENCES public.auth_users(id),
  acao text NOT NULL,
  comentario text,
  detalhes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT demand_history_has_owner CHECK (num_nonnulls(demand_id, series_id) >= 1)
);
CREATE INDEX idx_demand_history_demand ON public.demand_history (demand_id, created_at);
CREATE INDEX idx_demand_history_series ON public.demand_history (series_id, created_at);
CREATE INDEX idx_demand_history_recent ON public.demand_history (created_at DESC);
CREATE TRIGGER demand_history_immutable
  BEFORE UPDATE OR DELETE ON public.demand_history
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- Mesmas garantias de request_attachments: conteúdo fora do banco, sem endereço público.
CREATE TABLE public.demand_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id uuid NOT NULL REFERENCES public.demands(id) ON DELETE RESTRICT,
  subtask_id uuid REFERENCES public.demand_subtasks(id) ON DELETE RESTRICT,
  categoria text NOT NULL DEFAULT 'documento' CHECK (categoria IN ('documento', 'comprovante')),
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
  CONSTRAINT demand_attachments_removal_complete CHECK (
    (removido_em IS NULL AND removido_por IS NULL AND motivo_remocao IS NULL)
    OR (removido_em IS NOT NULL AND removido_por IS NOT NULL AND motivo_remocao IS NOT NULL)
  )
);
CREATE INDEX idx_demand_attachments_demand ON public.demand_attachments (demand_id, created_at);
CREATE TRIGGER demand_attachments_not_deleted
  BEFORE DELETE ON public.demand_attachments
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- Vínculo informativo com um registro de outro módulo: nunca altera o registro de origem.
CREATE TABLE public.demand_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id uuid NOT NULL REFERENCES public.demands(id) ON DELETE RESTRICT,
  modulo text NOT NULL CHECK (modulo IN ('maintenance', 'fleet', 'flights', 'warehouse')),
  recurso_id uuid NOT NULL,
  protocolo text NOT NULL,
  criado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  removido_em timestamptz,
  removido_por uuid REFERENCES public.auth_users(id)
);
CREATE UNIQUE INDEX demand_links_unique_active ON public.demand_links (demand_id, modulo, recurso_id)
  WHERE removido_em IS NULL;
CREATE INDEX idx_demand_links_demand ON public.demand_links (demand_id);

-- Reuniões, entregas e atividades programadas da agenda do módulo.
CREATE TABLE public.demand_agenda_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL CHECK (tipo IN ('reuniao', 'entrega', 'atividade')),
  titulo text NOT NULL CHECK (length(trim(titulo)) BETWEEN 3 AND 200),
  descricao text CHECK (descricao IS NULL OR length(descricao) <= 2000),
  inicio timestamptz NOT NULL,
  fim timestamptz,
  setor_id uuid REFERENCES public.demand_sectors(id),
  demand_id uuid REFERENCES public.demands(id) ON DELETE RESTRICT,
  criado_por uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelado_em timestamptz,
  cancelado_por uuid REFERENCES public.auth_users(id),
  CONSTRAINT demand_agenda_events_period CHECK (fim IS NULL OR fim >= inicio)
);
CREATE INDEX idx_demand_agenda_events_inicio ON public.demand_agenda_events (inicio)
  WHERE cancelado_em IS NULL;

-- Preferências de cada pessoa. O e-mail fica registrado, mas ainda não dispara envio.
CREATE TABLE public.demand_notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES public.auth_users(id) ON DELETE CASCADE,
  lembrete_dias integer NOT NULL DEFAULT 3 CHECK (lembrete_dias BETWEEN 0 AND 60),
  silenciados text[] NOT NULL DEFAULT '{}',
  email boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_demand_preferences_updated_at
  BEFORE UPDATE ON public.demand_notification_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Mesmo tratamento das demais tabelas: fora do alcance da API pública do Supabase.
-- ---------------------------------------------------------------------------
DO $migration$
DECLARE
  tabela text;
  api_role name;
BEGIN
  FOREACH tabela IN ARRAY ARRAY[
    'demand_sectors', 'demand_sector_members', 'demand_categories', 'demand_series', 'demands',
    'demand_series_occurrences', 'demand_participants', 'demand_sector_links', 'demand_subtasks',
    'demand_comments', 'demand_history', 'demand_attachments', 'demand_links', 'demand_agenda_events',
    'demand_notification_preferences'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tabela);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC', tabela);
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I', tabela, api_role);
      END IF;
    END LOOP;
  END LOOP;
END
$migration$;

COMMIT;
