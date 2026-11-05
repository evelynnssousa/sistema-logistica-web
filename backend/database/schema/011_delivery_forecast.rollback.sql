-- Desfaz a migração 011. Para com erro se já houver previsões, e-mails ou histórico, para não
-- apagá-los sem querer. As entregas registradas continuam em entregue_em, que não é afetada.
BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.material_delivery_history)
     OR EXISTS (
       SELECT 1 FROM public.material_requests
        WHERE previsao_entrega IS NOT NULL OR solicitante_email IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Reversão da 011 interrompida: já há registros desta migração.';
  END IF;
END
$guard$;

DROP TABLE public.material_delivery_history;

ALTER TABLE public.material_requests
  DROP CONSTRAINT material_requests_forecast_has_revision,
  DROP CONSTRAINT material_requests_requester_email_only_external,
  DROP COLUMN solicitante_email,
  DROP COLUMN previsao_revisao,
  DROP COLUMN previsao_entrega;

COMMIT;
