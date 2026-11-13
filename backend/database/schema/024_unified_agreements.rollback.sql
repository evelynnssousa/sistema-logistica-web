-- Desfaz 024_unified_agreements.sql. Para com erro se alguma ata do Almoxarifado já foi convertida:
-- as utilizações criadas são permanentes, e desfazer deixaria o gasto contado em dobro.
BEGIN;

DO $rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM public.warehouse_price_agreements WHERE instrumento_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Há atas do Almoxarifado convertidas em atas do Controle de Demandas. A migração 024 não pode ser desfeita sem perder o vínculo.';
  END IF;
END
$rollback$;

ALTER TABLE public.warehouse_price_agreements DROP COLUMN instrumento_id;

COMMIT;
