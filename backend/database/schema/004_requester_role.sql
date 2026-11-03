-- Permite o perfil requester em instalações já existentes.
-- Esta migração deve ser aplicada somente em uma etapa autorizada.
BEGIN;

ALTER TABLE app_private.users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE app_private.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('administrator', 'slm_operator', 'requester'));

COMMIT;
