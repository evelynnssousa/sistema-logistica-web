-- Desfaz a migração 014. Para com erro se já houver demandas ou setores cadastrados, para não
-- apagá-los sem querer. Os demais módulos não são afetados.
BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.demands) OR EXISTS (SELECT 1 FROM public.demand_sectors) THEN
    RAISE EXCEPTION 'Reversão da 014 interrompida: já há demandas ou setores cadastrados.';
  END IF;
END
$guard$;

DROP TABLE public.demand_notification_preferences;
DROP TABLE public.demand_agenda_events;
DROP TABLE public.demand_links;
DROP TABLE public.demand_attachments;
DROP TABLE public.demand_history;
DROP TABLE public.demand_comments;
DROP TABLE public.demand_subtasks;
DROP TABLE public.demand_sector_links;
DROP TABLE public.demand_participants;
DROP TABLE public.demand_series_occurrences;
DROP TABLE public.demands;
DROP TABLE public.demand_series;
DROP TABLE public.demand_categories;
DROP TABLE public.demand_sector_members;
DROP TABLE public.demand_sectors;

DELETE FROM public.protocol_counters WHERE prefixo = 'DEM';
ALTER TABLE public.protocol_counters DROP CONSTRAINT protocol_counters_prefixo_check;
ALTER TABLE public.protocol_counters ADD CONSTRAINT protocol_counters_prefixo_check
  CHECK (prefixo IN ('MAN', 'FRO', 'PAS', 'ALM'));

ALTER TABLE public.integration_events DROP CONSTRAINT integration_events_module_check;
ALTER TABLE public.integration_events ADD CONSTRAINT integration_events_module_check
  CHECK (module IN ('maintenance', 'fleet', 'flights', 'warehouse', 'system'));

COMMIT;
