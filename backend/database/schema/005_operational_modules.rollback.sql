-- Desfaz a migração 005. Só funciona antes de os módulos receberem dados: com registros
-- operacionais, para com erro, porque reverter apagaria histórico e CPFs cifrados.
-- Depois, reinicie a API.
BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.service_requests WHERE aberto_por IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.material_requests WHERE registrado_por IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.inventory_checks)
     OR EXISTS (SELECT 1 FROM public.flight_request_passengers WHERE cpf_encrypted IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.materials WHERE categoria_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Reversão da 005 interrompida: já existem dados dos módulos operacionais.';
  END IF;
END
$guard$;

DROP TRIGGER auth_audit_events_immutable ON public.auth_audit_events;
DROP TRIGGER request_history_immutable ON public.request_history;
DROP TABLE public.material_request_history;
DROP FUNCTION public.reject_history_change();

DROP TABLE public.inventory_check_items;
DROP TABLE public.inventory_checks;

DROP INDEX public.material_request_items_unique_material;
ALTER TABLE public.material_request_items
  DROP COLUMN material_nome,
  DROP COLUMN unidade;

DROP INDEX public.idx_mr_origem;
ALTER TABLE public.material_requests
  DROP CONSTRAINT material_requests_reference_only_external,
  DROP CONSTRAINT material_requests_status_check,
  DROP COLUMN origem,
  DROP COLUMN referencia_externa,
  DROP COLUMN solicitante_externo,
  DROP COLUMN registrado_por,
  DROP COLUMN setor_nome,
  DROP COLUMN entregue_em,
  DROP COLUMN entregue_por,
  DROP COLUMN recebido_por,
  ADD CONSTRAINT material_requests_status_check CHECK (status = ANY (ARRAY[
    'pendente'::text, 'em_analise'::text, 'atendido'::text, 'rejeitado'::text, 'cancelado'::text
  ]));

DROP INDEX public.materials_unique_name;
ALTER TABLE public.materials
  DROP COLUMN categoria_id,
  DROP COLUMN categoria_nome;

ALTER TABLE public.flight_request_passengers
  DROP CONSTRAINT flight_request_passengers_cpf_present,
  DROP COLUMN cpf_encrypted,
  DROP COLUMN cpf_masked,
  ALTER COLUMN cpf SET NOT NULL;

DROP TABLE public.request_occurrences;

ALTER TABLE public.request_history DROP COLUMN detalhes;

DROP INDEX public.idx_sr_created;
DROP INDEX public.idx_sr_agenda;
ALTER TABLE public.service_requests
  DROP CONSTRAINT service_requests_schedule_order,
  DROP CONSTRAINT service_requests_execution_order,
  DROP CONSTRAINT service_requests_status_check,
  DROP COLUMN aberto_por,
  DROP COLUMN em_nome_de_outro_setor,
  DROP COLUMN setor_nome,
  DROP COLUMN andar_id,
  DROP COLUMN andar_nome,
  DROP COLUMN tipo_servico_id,
  DROP COLUMN tipo_servico_nome,
  DROP COLUMN agendamento_fim,
  DROP COLUMN agendado_por,
  DROP COLUMN execucao_inicio,
  DROP COLUMN execucao_fim,
  DROP COLUMN motivo_cancelamento,
  ADD CONSTRAINT service_requests_status_check CHECK (status = ANY (ARRAY[
    'pendente'::text, 'em_analise'::text, 'agendada'::text, 'concluida'::text,
    'cancelada'::text, 'rejeitada'::text
  ]));

DROP INDEX public.setores_unique_name;
DROP TABLE public.catalog_options;

COMMIT;
