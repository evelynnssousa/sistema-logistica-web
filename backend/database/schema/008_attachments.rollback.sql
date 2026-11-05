-- Desfaz a migração 008. Para com erro se já houver anexos: os arquivos ficariam sem registro.
BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.request_attachments) THEN
    RAISE EXCEPTION 'Reversão da 008 interrompida: já há anexos registrados.';
  END IF;
END
$guard$;

DROP TABLE public.request_attachments;
DROP FUNCTION public.protect_attachment_record();

COMMIT;
