-- Pendente: esta migração ainda não foi aplicada no banco real.
--
-- Central de Operações da SLM: protocolo único, prazo, complexidade, observações internas e
-- parâmetros administráveis. Depende das migrações 005 e 006.
--
-- O que muda em registros existentes: só recebem o novo código de protocolo, em uma coluna nova.
-- O número antigo (protocolo), o status e updated_at continuam iguais.
-- Para desfazer: 007_operations_center.rollback.sql.
BEGIN;

-- ---------------------------------------------------------------------------
-- Protocolo único. A atualização da linha do contador bloqueia até o fim da transação: duas
-- solicitações simultâneas nunca recebem o mesmo número, e uma transação desfeita devolve o seu.
-- O contador não diminui ao excluir um registro, então um código nunca se repete.
-- ---------------------------------------------------------------------------
CREATE TABLE public.protocol_counters (
  prefixo text NOT NULL CHECK (prefixo IN ('MAN', 'FRO', 'PAS', 'ALM')),
  ano integer NOT NULL CHECK (ano BETWEEN 2000 AND 2200),
  ultimo integer NOT NULL CHECK (ultimo > 0),
  PRIMARY KEY (prefixo, ano)
);

CREATE FUNCTION public.next_protocol_code(p_prefixo text, p_ano integer)
  RETURNS text
  LANGUAGE plpgsql
  SET search_path = ''
AS $function$
DECLARE
  numero integer;
BEGIN
  INSERT INTO public.protocol_counters AS c (prefixo, ano, ultimo)
  VALUES (p_prefixo, p_ano, 1)
  ON CONFLICT (prefixo, ano) DO UPDATE SET ultimo = c.ultimo + 1
  RETURNING c.ultimo INTO numero;

  RETURN p_prefixo || '-' || p_ano || '-' || lpad(numero::text, greatest(5, length(numero::text)), '0');
END
$function$;

CREATE FUNCTION public.protocol_year(p_momento timestamptz)
  RETURNS integer
  LANGUAGE sql
  IMMUTABLE
  SET search_path = ''
AS $function$
  SELECT extract(year FROM p_momento AT TIME ZONE 'America/Sao_Paulo')::integer
$function$;

-- O prefixo vem do argumento do gatilho ou, nas solicitações, do módulo. Valor enviado é ignorado.
CREATE FUNCTION public.assign_protocol_code()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $function$
DECLARE
  prefixo text := TG_ARGV[0];
BEGIN
  IF prefixo IS NULL THEN
    prefixo := CASE NEW.tipo
      WHEN 'manutencao' THEN 'MAN'
      WHEN 'frota' THEN 'FRO'
      WHEN 'passagem' THEN 'PAS'
    END;
  END IF;
  NEW.protocolo_codigo := public.next_protocol_code(prefixo, public.protocol_year(NEW.created_at));
  RETURN NEW;
END
$function$;

CREATE FUNCTION public.reject_protocol_code_change()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'O código de protocolo é permanente.'
    USING ERRCODE = 'integrity_constraint_violation';
END
$function$;

ALTER TABLE public.service_requests ADD COLUMN protocolo_codigo text;
ALTER TABLE public.material_requests ADD COLUMN protocolo_codigo text;
ALTER TABLE public.inventory_checks ADD COLUMN protocolo_codigo text;

-- Registros existentes: gatilhos de updated_at desligados, para não parecer movimentação.
ALTER TABLE public.service_requests DISABLE TRIGGER trg_sr_updated_at;
ALTER TABLE public.material_requests DISABLE TRIGGER trg_mr_updated_at;
ALTER TABLE public.inventory_checks DISABLE TRIGGER trg_inventory_checks_updated_at;

DO $backfill$
DECLARE
  registro record;
BEGIN
  FOR registro IN
    SELECT id, created_at, tipo FROM public.service_requests ORDER BY created_at, protocolo
  LOOP
    UPDATE public.service_requests
       SET protocolo_codigo = public.next_protocol_code(
             CASE registro.tipo WHEN 'manutencao' THEN 'MAN' WHEN 'frota' THEN 'FRO' ELSE 'PAS' END,
             public.protocol_year(registro.created_at))
     WHERE id = registro.id;
  END LOOP;

  -- Pedidos e conferências dividem a mesma sequência do Almoxarifado, em ordem de criação.
  FOR registro IN
    SELECT id, created_at, 'material_requests' AS tabela FROM public.material_requests
    UNION ALL
    SELECT id, created_at, 'inventory_checks' FROM public.inventory_checks
    ORDER BY created_at, id
  LOOP
    EXECUTE format('UPDATE public.%I SET protocolo_codigo = $1 WHERE id = $2', registro.tabela)
      USING public.next_protocol_code('ALM', public.protocol_year(registro.created_at)), registro.id;
  END LOOP;
END
$backfill$;

ALTER TABLE public.service_requests ENABLE TRIGGER trg_sr_updated_at;
ALTER TABLE public.material_requests ENABLE TRIGGER trg_mr_updated_at;
ALTER TABLE public.inventory_checks ENABLE TRIGGER trg_inventory_checks_updated_at;

ALTER TABLE public.service_requests
  ALTER COLUMN protocolo_codigo SET NOT NULL,
  ADD CONSTRAINT service_requests_protocolo_codigo_key UNIQUE (protocolo_codigo);
ALTER TABLE public.material_requests
  ALTER COLUMN protocolo_codigo SET NOT NULL,
  ADD CONSTRAINT material_requests_protocolo_codigo_key UNIQUE (protocolo_codigo);
ALTER TABLE public.inventory_checks
  ALTER COLUMN protocolo_codigo SET NOT NULL,
  ADD CONSTRAINT inventory_checks_protocolo_codigo_key UNIQUE (protocolo_codigo);

CREATE TRIGGER trg_sr_protocol_code
  BEFORE INSERT ON public.service_requests
  FOR EACH ROW EXECUTE FUNCTION public.assign_protocol_code();
CREATE TRIGGER trg_mr_protocol_code
  BEFORE INSERT ON public.material_requests
  FOR EACH ROW EXECUTE FUNCTION public.assign_protocol_code('ALM');
CREATE TRIGGER trg_ic_protocol_code
  BEFORE INSERT ON public.inventory_checks
  FOR EACH ROW EXECUTE FUNCTION public.assign_protocol_code('ALM');

CREATE TRIGGER trg_sr_protocol_permanent
  BEFORE UPDATE ON public.service_requests
  FOR EACH ROW WHEN (OLD.protocolo_codigo IS DISTINCT FROM NEW.protocolo_codigo)
  EXECUTE FUNCTION public.reject_protocol_code_change();
CREATE TRIGGER trg_mr_protocol_permanent
  BEFORE UPDATE ON public.material_requests
  FOR EACH ROW WHEN (OLD.protocolo_codigo IS DISTINCT FROM NEW.protocolo_codigo)
  EXECUTE FUNCTION public.reject_protocol_code_change();
CREATE TRIGGER trg_ic_protocol_permanent
  BEFORE UPDATE ON public.inventory_checks
  FOR EACH ROW WHEN (OLD.protocolo_codigo IS DISTINCT FROM NEW.protocolo_codigo)
  EXECUTE FUNCTION public.reject_protocol_code_change();

-- ---------------------------------------------------------------------------
-- Acompanhamento: prazo e complexidade. Complexidade é informação de gestão: serve para não
-- avaliar a equipe só pelo volume de atendimentos.
-- ---------------------------------------------------------------------------
ALTER TABLE public.service_requests
  ADD COLUMN prazo_em timestamptz,
  ADD COLUMN complexidade text CHECK (complexidade IN ('simples', 'media', 'complexa')),
  ADD COLUMN atribuida_em timestamptz;

CREATE INDEX idx_sr_responsavel ON public.service_requests (responsavel_id)
  WHERE responsavel_id IS NOT NULL;
CREATE INDEX idx_sr_prazo ON public.service_requests (prazo_em)
  WHERE prazo_em IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Corrige a mensagem do gatilho da 005: a recusa já funcionava em toda tabela, mas, fora da
-- auditoria, a condição lia um campo inexistente e o erro saía em termos técnicos.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_history_change()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'auth_audit_events' THEN
    IF NEW.id = OLD.id
       AND NEW.action = OLD.action
       AND NEW.result = OLD.result
       AND NEW.details = OLD.details
       AND NEW.occurred_at = OLD.occurred_at
       AND NEW.target_resource_id IS NOT DISTINCT FROM OLD.target_resource_id
       AND (NEW.actor_user_id IS NULL OR NEW.actor_user_id = OLD.actor_user_id)
       AND (NEW.target_user_id IS NULL OR NEW.target_user_id = OLD.target_user_id) THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'Registros de histórico e auditoria não podem ser alterados.'
    USING ERRCODE = 'integrity_constraint_violation';
END
$function$;

-- ---------------------------------------------------------------------------
-- Observações internas: fora do alcance de quem só solicita, e sem alteração depois de gravadas.
-- ---------------------------------------------------------------------------
CREATE TABLE public.request_internal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.service_requests(id) ON DELETE RESTRICT,
  autor_id uuid NOT NULL REFERENCES public.auth_users(id),
  texto text NOT NULL CHECK (length(trim(texto)) BETWEEN 3 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_request_notes_request ON public.request_internal_notes (request_id, created_at);

CREATE TRIGGER request_internal_notes_immutable
  BEFORE UPDATE OR DELETE ON public.request_internal_notes
  FOR EACH ROW EXECUTE FUNCTION public.reject_history_change();

-- ---------------------------------------------------------------------------
-- Parâmetros administráveis pela tela. Sem linha, vale o padrão definido na aplicação.
-- ---------------------------------------------------------------------------
CREATE TABLE public.system_settings (
  secao text PRIMARY KEY CHECK (length(secao) BETWEEN 1 AND 60),
  valor jsonb NOT NULL,
  atualizado_por uuid REFERENCES public.auth_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_system_settings_updated_at
  BEFORE UPDATE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Mesmo tratamento das demais tabelas: fora do alcance da API pública do Supabase.
-- ---------------------------------------------------------------------------
ALTER TABLE public.protocol_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_internal_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.protocol_counters,
  public.request_internal_notes,
  public.system_settings
FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.next_protocol_code(text, integer) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.protocol_year(timestamptz) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.assign_protocol_code() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.reject_protocol_code_change() FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.protocol_counters, public.request_internal_notes, public.system_settings FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.next_protocol_code(text, integer), public.protocol_year(timestamptz), public.assign_protocol_code(), public.reject_protocol_code_change() FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
