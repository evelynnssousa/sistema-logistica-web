-- Desfaz a migração 010. Perde os registros técnicos, os períodos de disponibilidade e as revisões
-- de acesso. As revisões também constam na auditoria, que não é afetada.
BEGIN;

DROP TABLE public.access_reviews;
DROP TABLE public.availability_periods;
DROP TABLE public.technical_events;

COMMIT;
