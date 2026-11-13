-- Desfaz 023_patrimony.sql. Para com erro se já houver bem cadastrado ou conferência registrada:
-- desfazer apagaria o patrimônio e o histórico sem cópia.
BEGIN;

DO $rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM public.patrimony_assets) OR EXISTS (SELECT 1 FROM public.patrimony_checks) THEN
    RAISE EXCEPTION 'Há bens ou conferências de patrimônio registrados. A migração 023 não pode ser desfeita sem perdê-los.';
  END IF;
END
$rollback$;

DROP TABLE public.patrimony_check_reads;
DROP TABLE public.patrimony_checks;
DROP TABLE public.patrimony_movements;
DROP TABLE public.patrimony_assets;

COMMIT;
