-- Desfaz 020_warehouse_finance.sql. Para com erro se já houver valor registrado: desfazer apagaria
-- o controle orçamentário (valores pagos, notas, empenhos e atas) sem cópia.
-- As movimentações de estoque e as quantidades não são alteradas.
BEGIN;

DO $rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM public.warehouse_price_agreements)
     OR EXISTS (SELECT 1 FROM public.material_value_adjustments)
     OR EXISTS (SELECT 1 FROM public.stock_movements WHERE valor_total IS NOT NULL AND valor_total > 0) THEN
    RAISE EXCEPTION 'Há valores do Almoxarifado registrados. A migração 020 não pode ser desfeita sem perdê-los.';
  END IF;
END
$rollback$;

DROP TABLE public.material_value_adjustments;

DROP INDEX public.idx_sm_created_at;
DROP INDEX public.idx_sm_ata;

ALTER TABLE public.stock_movements
  DROP COLUMN ata_id,
  DROP COLUMN fornecedor,
  DROP COLUMN empenho,
  DROP COLUMN nota_fiscal,
  DROP COLUMN valor_informado,
  DROP COLUMN valor_total;

ALTER TABLE public.materials DROP COLUMN valor_estoque;

DROP TABLE public.warehouse_price_agreements;

COMMIT;
