-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Configurações editáveis do Portal do Motorista. Os parâmetros ficam em system_settings e o histórico
-- em settings_change_history, que já existem. Aqui entram o cadastro de tipos de ocorrência e o que
-- preserva o passado: o nome do tipo usado em cada ocorrência e a jornada vigente em cada viagem.
-- Depende da migração 016. Para desfazer: 017_driver_portal_settings.rollback.sql.
BEGIN;

-- ---------------------------------------------------------------------------
-- Tipos de ocorrência. Não há exclusão: desativar tira o tipo das próximas escolhas, e a chave
-- estrangeira impede apagar um tipo já usado, mesmo por SQL.
-- ---------------------------------------------------------------------------
CREATE TABLE public.driver_occurrence_types (
  chave text PRIMARY KEY CHECK (chave ~ '^[a-z0-9_]{1,60}$'),
  nome text NOT NULL CHECK (length(trim(nome)) BETWEEN 2 AND 80),
  ativo boolean NOT NULL DEFAULT true,
  exige_justificativa boolean NOT NULL DEFAULT false,
  permite_anexos boolean NOT NULL DEFAULT true,
  pede_atraso boolean NOT NULL DEFAULT false,
  ordem integer NOT NULL DEFAULT 0,
  atualizado_por uuid REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX driver_occurrence_types_unique_name
  ON public.driver_occurrence_types (lower(trim(nome)));

CREATE TRIGGER trg_driver_occurrence_types_updated_at
  BEFORE UPDATE ON public.driver_occurrence_types
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- As mesmas chaves da migração 016, para as ocorrências já gravadas continuarem válidas.
INSERT INTO public.driver_occurrence_types (chave, nome, pede_atraso, ordem) VALUES
  ('atraso', 'Atraso', true, 10),
  ('veiculo', 'Problema mecânico', false, 20),
  ('percurso', 'Alteração de percurso', false, 30),
  ('impedimento', 'Impedimento de realização da viagem', false, 40),
  ('atendimento', 'Problema no local de destino', false, 50),
  ('outra', 'Outros', false, 60);

-- ---------------------------------------------------------------------------
-- Ocorrências: guardam o nome do tipo na data do registro. Editar o cadastro não reescreve o passado.
-- ---------------------------------------------------------------------------
ALTER TABLE public.request_occurrences
  ADD COLUMN categoria_nome text CHECK (categoria_nome IS NULL OR length(categoria_nome) <= 80),
  ADD COLUMN justificativa text CHECK (justificativa IS NULL OR length(trim(justificativa)) BETWEEN 3 AND 1000);

-- Quem já tinha a 016 mantém os nomes que apareciam quando a ocorrência foi registrada.
UPDATE public.request_occurrences
   SET categoria_nome = CASE categoria
     WHEN 'atraso' THEN 'Atraso'
     WHEN 'veiculo' THEN 'Problema com o veículo'
     WHEN 'percurso' THEN 'Alteração no percurso'
     WHEN 'atendimento' THEN 'Dificuldade no atendimento'
     WHEN 'impedimento' THEN 'Impedimento para realizar a viagem'
     WHEN 'outra' THEN 'Outra ocorrência'
   END
 WHERE categoria IS NOT NULL;

ALTER TABLE public.request_occurrences
  DROP CONSTRAINT request_occurrences_categoria_check,
  ADD CONSTRAINT request_occurrences_categoria_fkey
    FOREIGN KEY (categoria) REFERENCES public.driver_occurrence_types(chave)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Viagens: a jornada vigente no início e o que o motorista informou ao iniciar e ao finalizar.
-- Sem valor, a viagem é anterior a esta migração, e vale a referência fixa daquela época.
-- ---------------------------------------------------------------------------
ALTER TABLE public.service_requests
  ADD COLUMN execucao_registro jsonb;

-- ---------------------------------------------------------------------------
-- Fora do alcance da API pública do Supabase, como as demais tabelas.
-- ---------------------------------------------------------------------------
ALTER TABLE public.driver_occurrence_types ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.driver_occurrence_types FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.driver_occurrence_types FROM %I', api_role);
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
