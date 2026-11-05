-- Desfaz a migração 006. Apaga a fila, as notificações internas e o registro de sincronização.
-- Solicitações, histórico e auditoria não são afetados.
-- Eventos já criados em um calendário externo não são removidos por este script.
BEGIN;

DROP TABLE public.integration_attempts;
DROP TABLE public.calendar_sync_items;
DROP TABLE public.user_notifications;
DROP TABLE public.email_deliveries;
DROP TABLE public.integration_events;
DROP FUNCTION public.reject_integration_record_change();

COMMIT;
