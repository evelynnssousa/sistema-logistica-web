-- Desfaz 017_driver_portal_settings.sql. Para com erro se já houver dados que só existem nela.
-- Os parâmetros em system_settings e o histórico ficam: sem esta migração, o código os ignora.
BEGIN;

DO $rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM public.service_requests WHERE execucao_registro IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.request_occurrences WHERE justificativa IS NOT NULL)
     OR EXISTS (
       SELECT 1 FROM public.request_occurrences
        WHERE categoria IS NOT NULL
          AND categoria NOT IN ('atraso', 'veiculo', 'percurso', 'atendimento', 'impedimento', 'outra')
     ) THEN
    RAISE EXCEPTION 'As configurações do portal já têm registros. A migração 017 não pode ser desfeita sem perdê-los.';
  END IF;
END
$rollback$;

ALTER TABLE public.service_requests
  DROP COLUMN execucao_registro;

ALTER TABLE public.request_occurrences
  DROP CONSTRAINT request_occurrences_categoria_fkey,
  ADD CONSTRAINT request_occurrences_categoria_check CHECK (categoria IS NULL OR categoria IN (
    'atraso', 'veiculo', 'percurso', 'atendimento', 'impedimento', 'outra'
  )),
  DROP COLUMN justificativa,
  DROP COLUMN categoria_nome;

DROP TABLE public.driver_occurrence_types;

COMMIT;
