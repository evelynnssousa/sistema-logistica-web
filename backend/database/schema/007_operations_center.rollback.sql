-- Desfaz a migração 007. Só use antes de os novos protocolos circularem: reaplicar a 007 gera
-- os códigos de novo, e os já comunicados por e-mail ou agenda podem deixar de corresponder.
-- Para com erro se já houver observações internas, para não apagá-las sem querer.
BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.request_internal_notes) THEN
    RAISE EXCEPTION 'Reversão da 007 interrompida: já há observações internas registradas.';
  END IF;
END
$guard$;

DROP TABLE public.system_settings;
DROP TABLE public.request_internal_notes;

DROP INDEX public.idx_sr_prazo;
DROP INDEX public.idx_sr_responsavel;

DROP TRIGGER trg_sr_protocol_permanent ON public.service_requests;
DROP TRIGGER trg_mr_protocol_permanent ON public.material_requests;
DROP TRIGGER trg_ic_protocol_permanent ON public.inventory_checks;
DROP TRIGGER trg_sr_protocol_code ON public.service_requests;
DROP TRIGGER trg_mr_protocol_code ON public.material_requests;
DROP TRIGGER trg_ic_protocol_code ON public.inventory_checks;

ALTER TABLE public.service_requests
  DROP COLUMN atribuida_em,
  DROP COLUMN complexidade,
  DROP COLUMN prazo_em,
  DROP COLUMN protocolo_codigo;
ALTER TABLE public.material_requests DROP COLUMN protocolo_codigo;
ALTER TABLE public.inventory_checks DROP COLUMN protocolo_codigo;

DROP FUNCTION public.reject_protocol_code_change();
DROP FUNCTION public.assign_protocol_code();
DROP FUNCTION public.protocol_year(timestamptz);
DROP FUNCTION public.next_protocol_code(text, integer);
DROP TABLE public.protocol_counters;

COMMIT;
