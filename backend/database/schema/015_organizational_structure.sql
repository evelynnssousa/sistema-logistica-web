-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Estrutura organizacional da Diretoria Administrativa. Depende da migração 014.
-- Os vínculos são independentes e cumulativos, e reaproveitam o que já existe:
--   lotação original    -> auth_users.sector e auth_users.setor_id
--   equipe SLM          -> auth_user_access.slm_member
--   setor de atuação    -> demand_sector_members
--   vínculo com a DA    -> user_directorate_links (nova)
--
-- Só acrescenta: uma tabela e colunas com valor padrão. Nenhum registro existente muda de sentido,
-- e ninguém ganha vínculo ou acesso com esta migração. Para desfazer: 015_organizational_structure.rollback.sql.
BEGIN;

-- Marca o setor cujas demandas são atendidas pela equipe SLM, sem nome fixo no código.
ALTER TABLE public.demand_sectors ADD COLUMN e_slm boolean NOT NULL DEFAULT false;

-- Chefia é um título sobre o papel de responsável pelo setor, que continua decidindo o acesso.
ALTER TABLE public.demand_sector_members
  ADD COLUMN funcao text CHECK (funcao IS NULL OR length(funcao) <= 120),
  ADD COLUMN chefia boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT demand_members_chefia_is_responsible CHECK (NOT chefia OR papel = 'responsavel');

-- Quem acompanha a execução. Opcional, e nenhuma demanda existente é alterada.
ALTER TABLE public.demands ADD COLUMN gestor_acompanhamento_id uuid REFERENCES public.auth_users(id);

-- Participação na Diretoria Administrativa, independente de setor e de lotação.
-- Retirar é lógico: o vínculo antigo continua explicando o histórico.
CREATE TABLE public.user_directorate_links (
  user_id uuid PRIMARY KEY REFERENCES public.auth_users(id) ON DELETE RESTRICT,
  ativo boolean NOT NULL DEFAULT true,
  papel_demandas text NOT NULL DEFAULT 'integrante'
    CHECK (papel_demandas IN ('integrante', 'consulta', 'diretor')),
  funcao text CHECK (funcao IS NULL OR length(funcao) <= 120),
  atualizado_por uuid REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_user_directorate_links_updated_at
  BEFORE UPDATE ON public.user_directorate_links
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Mesmo tratamento das demais tabelas: fora do alcance da API pública do Supabase.
ALTER TABLE public.user_directorate_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.user_directorate_links FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.user_directorate_links FROM %I', api_role);
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
