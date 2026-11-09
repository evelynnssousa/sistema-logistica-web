-- Desfaz 019_email_quota.sql. O contador diário é só controle de consumo e pode ser descartado.
-- Para com erro se houver mensagem agrupada ainda não enviada: sem a coluna, ela perderia a contagem.
-- A selagem NÃO é desfeita, de propósito: as mensagens BLOCKED_BEFORE_ACTIVATION continuam como falha
-- definitiva, e o código continua recusando o reprocessamento delas.
BEGIN;

DO $rollback$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.email_deliveries
     WHERE grouped_count > 1 AND status IN ('pending', 'sending', 'not_configured')
  ) THEN
    RAISE EXCEPTION 'Há avisos agrupados ainda não enviados. A migração 019 não pode ser desfeita sem perdê-los.';
  END IF;
END
$rollback$;

DROP INDEX public.idx_email_deliveries_grouping;

ALTER TABLE public.email_deliveries DROP COLUMN grouped_count;

DROP TABLE public.email_daily_usage;

COMMIT;
