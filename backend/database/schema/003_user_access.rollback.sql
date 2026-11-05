-- Desfaz a migração 003, sem resíduos e sem efeito sobre usuários, sessões e auditoria.
-- Perde-se apenas o que foi definido depois dela: equipe SLM e permissões individuais.
-- Depois, reinicie a API.
BEGIN;

DROP TRIGGER auth_users_access_coherence ON public.auth_users;
DROP TABLE public.auth_user_access;
DROP FUNCTION public.assert_user_access_coherent();

COMMIT;
