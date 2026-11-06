-- Desfaz 002_password_recovery.sql. Os códigos valem 10 minutos e são de uso único: só para se
-- houver código ainda válido, para não invalidar uma recuperação em andamento.
BEGIN;

DO $rollback$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.password_recovery_codes
     WHERE consumed_at IS NULL AND expires_at > now()
  ) THEN
    RAISE EXCEPTION 'Há recuperação de senha em andamento. Aguarde os códigos vencerem antes de desfazer a migração 002.';
  END IF;
END
$rollback$;

DROP TABLE public.password_recovery_codes;

COMMIT;
