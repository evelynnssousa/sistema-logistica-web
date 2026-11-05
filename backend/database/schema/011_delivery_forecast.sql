-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Previsão e controle de entrega dos pedidos de materiais. Depende da migração 005.
-- Só acrescenta: nenhum registro é reescrito, e a entrega efetiva continua em entregue_em.
-- Enquanto não for aplicada, os pedidos continuam funcionando, e informar a previsão responde 503.
-- Para desfazer: 011_delivery_forecast.rollback.sql.
BEGIN;

ALTER TABLE public.material_requests
  -- Só o dia: a previsão não tem horário e não depende de fuso.
  ADD COLUMN previsao_entrega date,
  -- Quantas vezes a previsão foi definida. Identifica cada comunicação e impede repeti-la.
  ADD COLUMN previsao_revisao integer NOT NULL DEFAULT 0 CHECK (previsao_revisao >= 0),
  -- Pedido digitado do sistema governamental: a pessoa só é localizada por este endereço.
  ADD COLUMN solicitante_email text,
  ADD CONSTRAINT material_requests_requester_email_only_external
    CHECK (
      solicitante_email IS NULL
      OR (origem = 'governamental' AND length(solicitante_email) BETWEEN 3 AND 254)
    ),
  ADD CONSTRAINT material_requests_forecast_has_revision
    CHECK (previsao_entrega IS NULL OR previsao_revisao >= 1);

-- Histórico interno, separado do histórico do pedido porque aquele é exibido ao solicitante.
CREATE TABLE public.material_delivery_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_request_id uuid NOT NULL REFERENCES public.material_requests(id) ON DELETE RESTRICT,
  acao text NOT NULL
    CHECK (acao IN ('previsao_informada', 'previsao_alterada', 'entrega_registrada')),
  previsao_anterior date,
  previsao_nova date,
  entrega_efetiva date,
  -- Justificativa da alteração ou observação sobre a entrega.
  comentario text CHECK (comentario IS NULL OR length(trim(comentario)) BETWEEN 1 AND 2000),
  usuario_id uuid NOT NULL REFERENCES public.auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT material_delivery_history_consistent CHECK (
    CASE acao
      WHEN 'previsao_informada' THEN previsao_anterior IS NULL AND previsao_nova IS NOT NULL
      WHEN 'previsao_alterada' THEN
        previsao_anterior IS NOT NULL AND previsao_nova IS NOT NULL AND comentario IS NOT NULL
      ELSE entrega_efetiva IS NOT NULL
    END
  )
);

CREATE INDEX idx_material_delivery_history_request
  ON public.material_delivery_history (material_request_id, created_at);

CREATE TRIGGER material_delivery_history_immutable
  BEFORE UPDATE OR DELETE ON public.material_delivery_history
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

ALTER TABLE public.material_delivery_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.material_delivery_history FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.material_delivery_history FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
