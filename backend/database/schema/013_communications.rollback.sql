-- Desfaz a migração 013. Para com erro se já houver mensagens registradas, para não apagá-las sem
-- querer. Solicitações, anexos e e-mails automáticos não são afetados.
BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.manual_emails) THEN
    RAISE EXCEPTION 'Reversão da 013 interrompida: já há mensagens registradas.';
  END IF;
END
$guard$;

DROP TABLE public.manual_email_attachments;
DROP TABLE public.manual_emails;
DROP FUNCTION public.protect_manual_email();

COMMIT;
