-- Desfaz 004_flight_passengers.sql. Para com erro se a 005 ainda estiver aplicada (desfaça-a
-- antes) ou se já houver passageiros: apagá-los perderia dados pessoais registrados.
BEGIN;

DO $rollback$
BEGIN
  IF to_regclass('public.catalog_options') IS NOT NULL THEN
    RAISE EXCEPTION 'A migração 005 está aplicada. Desfaça a 005 antes da 004.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.flight_request_passengers) THEN
    RAISE EXCEPTION 'Já há passageiros cadastrados. A migração 004 não pode ser desfeita sem perdê-los.';
  END IF;
END
$rollback$;

DROP TABLE public.flight_request_passengers;

COMMIT;
