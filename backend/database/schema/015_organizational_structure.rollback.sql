-- Desfaz a migração 015. Para com erro se os dados novos já estiverem em uso, para não apagá-los
-- sem querer. Setores, integrantes e demandas continuam existindo.
BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.user_directorate_links)
     OR EXISTS (SELECT 1 FROM public.demand_sectors WHERE e_slm)
     OR EXISTS (SELECT 1 FROM public.demand_sector_members WHERE chefia OR funcao IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.demands WHERE gestor_acompanhamento_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Reversão da 015 interrompida: já há vínculos cadastrados.';
  END IF;
END
$guard$;

DROP TABLE public.user_directorate_links;
ALTER TABLE public.demands DROP COLUMN gestor_acompanhamento_id;
ALTER TABLE public.demand_sector_members
  DROP CONSTRAINT demand_members_chefia_is_responsible,
  DROP COLUMN chefia,
  DROP COLUMN funcao;
ALTER TABLE public.demand_sectors DROP COLUMN e_slm;

COMMIT;
