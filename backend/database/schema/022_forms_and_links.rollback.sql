-- Desfaz 022_forms_and_links.sql. Para com erro se algum campo personalizado ou ligação com ata já
-- tiver sido gravado: desfazer apagaria esses valores sem cópia.
BEGIN;

DO $rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM public.material_requests WHERE campos_personalizados IS NOT NULL OR campos_entrega IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.demands WHERE campos_personalizados IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.contract_instruments WHERE campos_personalizados IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.vehicles WHERE campos_personalizados IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.equipments WHERE campos_personalizados IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.materials WHERE campos_personalizados IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.fleet_drivers WHERE campos_personalizados IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.flight_quotes WHERE campos_personalizados IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.maintenance_executions WHERE campos_personalizados IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.request_occurrences WHERE campos_personalizados IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.stock_movements WHERE instrumento_item_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.materials WHERE localizacao IS NOT NULL) THEN
    RAISE EXCEPTION 'Há campos personalizados, localizações de materiais ou entradas ligadas a atas. A migração 022 não pode ser desfeita sem perdê-los.';
  END IF;
END
$rollback$;

ALTER TABLE public.contract_instrument_usages DROP COLUMN stock_movement_id;
DROP INDEX public.idx_sm_instrumento_item;
ALTER TABLE public.stock_movements DROP COLUMN instrumento_item_id;

DROP INDEX public.idx_materials_localizacao;
ALTER TABLE public.materials DROP COLUMN localizacao;

ALTER TABLE public.request_occurrences DROP COLUMN formulario_versao, DROP COLUMN campos_personalizados;
ALTER TABLE public.maintenance_executions DROP COLUMN formulario_versao, DROP COLUMN campos_personalizados;
ALTER TABLE public.flight_quotes DROP COLUMN formulario_versao, DROP COLUMN campos_personalizados;
ALTER TABLE public.fleet_drivers DROP COLUMN formulario_versao, DROP COLUMN campos_personalizados;
ALTER TABLE public.materials DROP COLUMN formulario_versao, DROP COLUMN campos_personalizados;
ALTER TABLE public.equipments DROP COLUMN formulario_versao, DROP COLUMN campos_personalizados;
ALTER TABLE public.vehicles DROP COLUMN formulario_versao, DROP COLUMN campos_personalizados;
ALTER TABLE public.contract_instruments DROP COLUMN formulario_versao, DROP COLUMN campos_personalizados;
ALTER TABLE public.demands DROP COLUMN formulario_versao, DROP COLUMN campos_personalizados;
ALTER TABLE public.material_requests DROP COLUMN campos_entrega, DROP COLUMN formulario_versao, DROP COLUMN campos_personalizados;

COMMIT;
