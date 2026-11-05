-- Desfaz 016_driver_portal.sql. Para com erro se o portal já tiver dados, para nada se perder.
BEGIN;

DO $rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fleet_drivers)
     OR EXISTS (SELECT 1 FROM public.auth_user_access WHERE profile = 'driver')
     OR EXISTS (SELECT 1 FROM public.fleet_execution_corrections) THEN
    RAISE EXCEPTION 'O Portal do Motorista já tem dados. A migração 016 não pode ser desfeita sem perdê-los.';
  END IF;
END
$rollback$;

DROP TABLE public.fleet_execution_corrections;
DROP TABLE public.request_occurrence_attachments;

ALTER TABLE public.request_occurrences
  DROP COLUMN motorista_id,
  DROP COLUMN categoria;

ALTER TABLE public.service_requests
  DROP CONSTRAINT service_requests_driver_fleet_only,
  DROP COLUMN motorista_observacoes,
  DROP COLUMN motorista_id;

DROP TABLE public.fleet_drivers;

ALTER TABLE public.auth_user_access
  DROP CONSTRAINT auth_user_access_driver_exclusive,
  DROP CONSTRAINT auth_user_access_profile_check,
  ADD CONSTRAINT auth_user_access_profile_check
    CHECK (profile IN ('administrator', 'slm_operator', 'requester'));

COMMIT;
