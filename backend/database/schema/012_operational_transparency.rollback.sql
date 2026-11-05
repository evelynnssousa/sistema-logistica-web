-- Desfaz a migração 012. Para com erro se já houver devoluções, motivos, reservas ou histórico, para
-- não apagá-los sem querer. Solicitações, pedidos e materiais continuam como estavam.
BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.request_returns)
     OR EXISTS (SELECT 1 FROM public.material_item_changes)
     OR EXISTS (SELECT 1 FROM public.settings_change_history)
     OR EXISTS (SELECT 1 FROM public.config_versions)
     OR EXISTS (SELECT 1 FROM public.warehouse_control_records)
     OR EXISTS (SELECT 1 FROM public.auth_users WHERE dados_cadastrais <> '{}'::jsonb)
     OR EXISTS (SELECT 1 FROM public.materials WHERE quantidade_reservada <> 0)
     OR EXISTS (
       SELECT 1 FROM public.material_request_items
        WHERE motivo_codigo IS NOT NULL OR observacao IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Reversão da 012 interrompida: já há registros desta migração.';
  END IF;
END
$guard$;

DROP TABLE public.warehouse_control_records;
DROP TABLE public.config_versions;
ALTER TABLE public.auth_users DROP COLUMN formulario_versao, DROP COLUMN dados_cadastrais;
ALTER TABLE public.service_requests DROP COLUMN formulario_versao;
DROP TABLE public.settings_change_history;
DROP TABLE public.material_item_changes;
DROP TABLE public.request_returns;
DROP FUNCTION public.protect_request_return();

ALTER TABLE public.material_request_items
  DROP COLUMN observacao,
  DROP COLUMN motivo_nome,
  DROP COLUMN motivo_codigo;

ALTER TABLE public.materials DROP COLUMN quantidade_reservada;

DROP INDEX public.idx_sr_aguardando_externo;

ALTER TABLE public.service_requests
  DROP COLUMN espera_externa_segundos,
  DROP COLUMN aguardando_externo_desde;

COMMIT;
