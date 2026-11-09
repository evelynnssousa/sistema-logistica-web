-- Pendente: esta migração ainda não foi aplicada em nenhum banco remoto.
--
-- Proteção da cota diária do serviço de e-mail (achado A1 da auditoria de 08/11/2026).
--
-- 1. public.email_daily_usage: quanto já foi consumido em cada dia (UTC), separado entre a fila de
--    notificações (inclui as mensagens manuais e o envio de teste de modelo) e a recuperação de senha.
--    É o registro que sobrevive a reinícios do Render e é atualizado com UPDATE condicional, que trava
--    a linha do dia: dois workers simultâneos nunca passam do limite configurado.
-- 2. public.email_deliveries.grouped_count: quantos acontecimentos equivalentes uma mensagem de aviso
--    administrativo representa. Avisos repetidos dentro da janela de agrupamento somam aqui, em vez
--    de gerar uma mensagem por ocorrência.
--
-- 3. Selagem da fila anterior à proteção: toda mensagem ainda "pendente" ou "não configurada" no
--    momento da aplicação foi gerada antes da cota, da validade e da lista de destinatários de teste.
--    Ela vira falha definitiva BLOCKED_BEFORE_ACTIVATION, com registro em integration_attempts, e
--    nunca mais é enviada nem reprocessada (o código recusa o reprocessamento desse código, mesmo
--    depois de remover a lista de testes). Nada é apagado: registro, evento e histórico ficam.
--    Na homologação, em 08/11/2026, eram 4 mensagens para o domínio institucional.
-- 4. Índice de agrupamento (modelo, destinatário, data), usado pela busca do aviso a agrupar.
--
-- Não apaga registros. As mensagens já gravadas ficam com grouped_count = 1.
-- Depende da 006 (email_deliveries) e da 013 (manual_emails). Sem ela, o código não envia notificações quando há limite
-- configurado e mantém o comportamento anterior na recuperação de senha.
-- Para desfazer: 019_email_quota.rollback.sql.
BEGIN;

CREATE TABLE public.email_daily_usage (
  day date PRIMARY KEY,
  notifications_used integer NOT NULL DEFAULT 0 CHECK (notifications_used >= 0),
  recovery_used integer NOT NULL DEFAULT 0 CHECK (recovery_used >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.email_deliveries
  ADD COLUMN grouped_count integer NOT NULL DEFAULT 1 CHECK (grouped_count >= 1);

CREATE INDEX idx_email_deliveries_grouping
  ON public.email_deliveries (template_key, recipient, created_at DESC);

-- Selagem: nada gerado antes desta proteção sai depois dela.
WITH sealed AS (
  UPDATE public.email_deliveries
     SET status = 'failed', last_error_code = 'BLOCKED_BEFORE_ACTIVATION', locked_until = NULL
   WHERE status IN ('pending', 'not_configured')
  RETURNING id, attempts
)
INSERT INTO public.integration_attempts (channel, item_id, attempt, outcome, error_code)
SELECT 'email', id, attempts + 1, 'failure', 'BLOCKED_BEFORE_ACTIVATION' FROM sealed;

UPDATE public.manual_emails
   SET status = 'failed', codigo_erro = 'BLOCKED_BEFORE_ACTIVATION', travado_ate = NULL
 WHERE status IN ('pending', 'not_configured');

-- Fora do alcance da API pública do Supabase, como as demais tabelas.
ALTER TABLE public.email_daily_usage ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.email_daily_usage FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.email_daily_usage FROM %I', api_role);
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
