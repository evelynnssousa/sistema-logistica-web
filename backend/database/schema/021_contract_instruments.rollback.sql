-- Desfaz 021_contract_instruments.sql. Para com erro se já houver ata ou contrato cadastrado:
-- desfazer apagaria o acompanhamento (itens, utilizações, aditivos, anexos e vínculos) sem cópia.
BEGIN;

DO $rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM public.contract_instruments) THEN
    RAISE EXCEPTION 'Há atas ou contratos cadastrados. A migração 021 não pode ser desfeita sem perdê-los.';
  END IF;
END
$rollback$;

DROP INDEX public.idx_demands_instrumento;
ALTER TABLE public.demands DROP COLUMN instrumento_id;

DROP TABLE public.contract_instrument_attachments;
DROP TABLE public.contract_instrument_amendments;
DROP TABLE public.contract_instrument_usages;
DROP TABLE public.contract_instrument_items;
DROP TABLE public.contract_instrument_sectors;
DROP TABLE public.contract_instruments;

COMMIT;
