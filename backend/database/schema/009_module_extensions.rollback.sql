-- Desfaz a migração 009. Para com erro se já houver registros, para não apagá-los sem querer.
BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.vehicles)
     OR EXISTS (SELECT 1 FROM public.equipments)
     OR EXISTS (SELECT 1 FROM public.maintenance_executions)
     OR EXISTS (SELECT 1 FROM public.flight_quotes) THEN
    RAISE EXCEPTION 'Reversão da 009 interrompida: já há registros nas tabelas desta migração.';
  END IF;
END
$guard$;

DROP TRIGGER stock_movements_immutable ON public.stock_movements;
DROP TABLE public.flight_quotes;
DROP FUNCTION public.protect_flight_quote();
DROP TABLE public.maintenance_executions;
DROP TABLE public.equipments;
DROP TABLE public.vehicle_logs;
DROP TABLE public.vehicles;

COMMIT;
