-- Cópia somente da estrutura do schema public do banco real, gerada com pg_dump
-- em 2026-11-03. Referência: não aplique no banco real.

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11 (Debian 17.11-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: apply_stock_movement(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_stock_movement() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.tipo = 'entrada' then
    update materials set estoque_atual = estoque_atual + new.quantidade
     where id = new.material_id;
  else
    update materials set estoque_atual = estoque_atual - new.quantidade
     where id = new.material_id;
  end if;
  return new;
end;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: auth_audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_audit_events (
    id bigint NOT NULL,
    actor_user_id uuid,
    action text NOT NULL,
    target_user_id uuid,
    target_resource_id text,
    result text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT auth_audit_events_result_check CHECK ((result = ANY (ARRAY['success'::text, 'denied'::text, 'failure'::text])))
);


--
-- Name: auth_audit_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auth_audit_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_audit_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auth_audit_events_id_seq OWNED BY public.auth_audit_events.id;


--
-- Name: auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    session_token_hash character(64) NOT NULL,
    csrf_token_hash character(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    full_name text NOT NULL,
    email text NOT NULL,
    sector text NOT NULL,
    password_hash text NOT NULL,
    status text NOT NULL,
    role text,
    permissions text[] DEFAULT '{}'::text[] NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    setor_id uuid,
    CONSTRAINT auth_users_check CHECK ((((status = 'pending'::text) AND (role IS NULL) AND (decided_at IS NULL)) OR ((status = 'rejected'::text) AND (role IS NULL) AND (decided_at IS NOT NULL)) OR ((status = ANY (ARRAY['approved'::text, 'blocked'::text, 'inactive'::text])) AND (role IS NOT NULL) AND (decided_at IS NOT NULL)))),
    CONSTRAINT auth_users_full_name_check CHECK (((length(TRIM(BOTH FROM full_name)) >= 2) AND (length(TRIM(BOTH FROM full_name)) <= 120))),
    CONSTRAINT auth_users_permissions_check CHECK ((permissions <@ ARRAY['maintenance:read'::text, 'maintenance:write'::text, 'fleet:read'::text, 'fleet:write'::text, 'flights:read'::text, 'flights:write'::text, 'flights:cpf:read'::text, 'warehouse:read'::text, 'warehouse:write'::text, 'settings:read'::text, 'settings:write'::text])),
    CONSTRAINT auth_users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'operator'::text]))),
    CONSTRAINT auth_users_sector_check CHECK (((length(TRIM(BOTH FROM sector)) >= 2) AND (length(TRIM(BOTH FROM sector)) <= 120))),
    CONSTRAINT auth_users_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'blocked'::text, 'inactive'::text])))
);


--
-- Name: material_request_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.material_request_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    material_request_id uuid NOT NULL,
    material_id uuid NOT NULL,
    quantidade_solicitada numeric(12,2) NOT NULL,
    quantidade_atendida numeric(12,2) DEFAULT 0 NOT NULL,
    CONSTRAINT material_request_items_quantidade_atendida_check CHECK ((quantidade_atendida >= (0)::numeric)),
    CONSTRAINT material_request_items_quantidade_solicitada_check CHECK ((quantidade_solicitada > (0)::numeric))
);


--
-- Name: material_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.material_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    protocolo bigint NOT NULL,
    status text DEFAULT 'pendente'::text NOT NULL,
    solicitante_id uuid NOT NULL,
    setor_id uuid,
    observacao text,
    atendido_por uuid,
    atendido_em timestamp with time zone,
    lgpd_aceite boolean DEFAULT false NOT NULL,
    lgpd_aceite_em timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT material_requests_status_check CHECK ((status = ANY (ARRAY['pendente'::text, 'em_analise'::text, 'atendido'::text, 'rejeitado'::text, 'cancelado'::text])))
);


--
-- Name: material_requests_protocolo_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.material_requests ALTER COLUMN protocolo ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.material_requests_protocolo_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: materials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.materials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    codigo text,
    nome text NOT NULL,
    descricao text,
    unidade text DEFAULT 'un'::text NOT NULL,
    estoque_atual numeric(12,2) DEFAULT 0 NOT NULL,
    estoque_minimo numeric(12,2) DEFAULT 0 NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT materials_estoque_atual_check CHECK ((estoque_atual >= (0)::numeric))
);


--
-- Name: request_forms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_forms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tipo text NOT NULL,
    campo_chave text NOT NULL,
    rotulo text NOT NULL,
    tipo_campo text DEFAULT 'texto'::text NOT NULL,
    obrigatorio boolean DEFAULT false NOT NULL,
    opcoes jsonb,
    ordem integer DEFAULT 0 NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT request_forms_tipo_campo_check CHECK ((tipo_campo = ANY (ARRAY['texto'::text, 'texto_longo'::text, 'numero'::text, 'data'::text, 'data_hora'::text, 'selecao'::text, 'sim_nao'::text]))),
    CONSTRAINT request_forms_tipo_check CHECK ((tipo = ANY (ARRAY['manutencao'::text, 'frota'::text, 'passagem'::text, 'material'::text])))
);


--
-- Name: request_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    usuario_id uuid,
    acao text NOT NULL,
    status_anterior text,
    status_novo text,
    comentario text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: service_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    protocolo bigint NOT NULL,
    tipo text NOT NULL,
    status text DEFAULT 'pendente'::text NOT NULL,
    solicitante_id uuid NOT NULL,
    setor_id uuid,
    titulo text NOT NULL,
    descricao text,
    prioridade text DEFAULT 'normal'::text NOT NULL,
    dados jsonb DEFAULT '{}'::jsonb NOT NULL,
    data_agendada timestamp with time zone,
    responsavel_id uuid,
    observacao_operador text,
    lgpd_aceite boolean DEFAULT false NOT NULL,
    lgpd_aceite_em timestamp with time zone,
    concluida_em timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT service_requests_prioridade_check CHECK ((prioridade = ANY (ARRAY['baixa'::text, 'normal'::text, 'alta'::text, 'urgente'::text]))),
    CONSTRAINT service_requests_status_check CHECK ((status = ANY (ARRAY['pendente'::text, 'em_analise'::text, 'agendada'::text, 'concluida'::text, 'cancelada'::text, 'rejeitada'::text]))),
    CONSTRAINT service_requests_tipo_check CHECK ((tipo = ANY (ARRAY['manutencao'::text, 'frota'::text, 'passagem'::text])))
);


--
-- Name: service_requests_protocolo_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.service_requests ALTER COLUMN protocolo ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.service_requests_protocolo_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: setores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.setores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nome text NOT NULL,
    sigla text,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stock_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    material_id uuid NOT NULL,
    tipo text NOT NULL,
    quantidade numeric(12,2) NOT NULL,
    motivo text,
    material_request_id uuid,
    usuario_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stock_movements_quantidade_check CHECK ((quantidade > (0)::numeric)),
    CONSTRAINT stock_movements_tipo_check CHECK ((tipo = ANY (ARRAY['entrada'::text, 'saida'::text])))
);


--
-- Name: auth_audit_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_audit_events ALTER COLUMN id SET DEFAULT nextval('public.auth_audit_events_id_seq'::regclass);


--
-- Name: auth_audit_events auth_audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_audit_events
    ADD CONSTRAINT auth_audit_events_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_session_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_session_token_hash_key UNIQUE (session_token_hash);


--
-- Name: auth_users auth_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_users
    ADD CONSTRAINT auth_users_pkey PRIMARY KEY (id);


--
-- Name: material_request_items material_request_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_request_items
    ADD CONSTRAINT material_request_items_pkey PRIMARY KEY (id);


--
-- Name: material_requests material_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_requests
    ADD CONSTRAINT material_requests_pkey PRIMARY KEY (id);


--
-- Name: materials materials_codigo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.materials
    ADD CONSTRAINT materials_codigo_key UNIQUE (codigo);


--
-- Name: materials materials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.materials
    ADD CONSTRAINT materials_pkey PRIMARY KEY (id);


--
-- Name: request_forms request_forms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_forms
    ADD CONSTRAINT request_forms_pkey PRIMARY KEY (id);


--
-- Name: request_forms request_forms_tipo_campo_chave_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_forms
    ADD CONSTRAINT request_forms_tipo_campo_chave_key UNIQUE (tipo, campo_chave);


--
-- Name: request_history request_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_history
    ADD CONSTRAINT request_history_pkey PRIMARY KEY (id);


--
-- Name: service_requests service_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_requests
    ADD CONSTRAINT service_requests_pkey PRIMARY KEY (id);


--
-- Name: setores setores_nome_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setores
    ADD CONSTRAINT setores_nome_key UNIQUE (nome);


--
-- Name: setores setores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setores
    ADD CONSTRAINT setores_pkey PRIMARY KEY (id);


--
-- Name: stock_movements stock_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_pkey PRIMARY KEY (id);


--
-- Name: auth_audit_target_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_audit_target_time ON public.auth_audit_events USING btree (target_user_id, occurred_at DESC);


--
-- Name: auth_sessions_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_sessions_expiry ON public.auth_sessions USING btree (expires_at);


--
-- Name: auth_users_email_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_users_email_unique ON public.auth_users USING btree (lower(email));


--
-- Name: auth_users_pending_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_users_pending_created ON public.auth_users USING btree (created_at) WHERE (status = 'pending'::text);


--
-- Name: idx_auth_users_setor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_users_setor ON public.auth_users USING btree (setor_id);


--
-- Name: idx_materials_nome; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_materials_nome ON public.materials USING btree (nome);


--
-- Name: idx_mr_setor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mr_setor ON public.material_requests USING btree (setor_id);


--
-- Name: idx_mr_solicitante; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mr_solicitante ON public.material_requests USING btree (solicitante_id);


--
-- Name: idx_mr_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mr_status ON public.material_requests USING btree (status);


--
-- Name: idx_mri_material; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mri_material ON public.material_request_items USING btree (material_id);


--
-- Name: idx_mri_pedido; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mri_pedido ON public.material_request_items USING btree (material_request_id);


--
-- Name: idx_rh_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rh_request ON public.request_history USING btree (request_id);


--
-- Name: idx_sm_material; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sm_material ON public.stock_movements USING btree (material_id);


--
-- Name: idx_sm_pedido; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sm_pedido ON public.stock_movements USING btree (material_request_id);


--
-- Name: idx_sr_setor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sr_setor ON public.service_requests USING btree (setor_id);


--
-- Name: idx_sr_solicitante; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sr_solicitante ON public.service_requests USING btree (solicitante_id);


--
-- Name: idx_sr_tipo_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sr_tipo_status ON public.service_requests USING btree (tipo, status);


--
-- Name: stock_movements trg_apply_stock_movement; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_apply_stock_movement AFTER INSERT ON public.stock_movements FOR EACH ROW EXECUTE FUNCTION public.apply_stock_movement();


--
-- Name: materials trg_materials_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_materials_updated_at BEFORE UPDATE ON public.materials FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: material_requests trg_mr_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_mr_updated_at BEFORE UPDATE ON public.material_requests FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: request_forms trg_rf_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_rf_updated_at BEFORE UPDATE ON public.request_forms FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: service_requests trg_sr_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sr_updated_at BEFORE UPDATE ON public.service_requests FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: auth_audit_events auth_audit_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_audit_events
    ADD CONSTRAINT auth_audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.auth_users(id) ON DELETE SET NULL;


--
-- Name: auth_audit_events auth_audit_events_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_audit_events
    ADD CONSTRAINT auth_audit_events_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.auth_users(id) ON DELETE SET NULL;


--
-- Name: auth_sessions auth_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_users(id) ON DELETE CASCADE;


--
-- Name: auth_users auth_users_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_users
    ADD CONSTRAINT auth_users_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.auth_users(id);


--
-- Name: auth_users auth_users_setor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_users
    ADD CONSTRAINT auth_users_setor_id_fkey FOREIGN KEY (setor_id) REFERENCES public.setores(id);


--
-- Name: material_request_items material_request_items_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_request_items
    ADD CONSTRAINT material_request_items_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.materials(id);


--
-- Name: material_request_items material_request_items_material_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_request_items
    ADD CONSTRAINT material_request_items_material_request_id_fkey FOREIGN KEY (material_request_id) REFERENCES public.material_requests(id) ON DELETE CASCADE;


--
-- Name: material_requests material_requests_atendido_por_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_requests
    ADD CONSTRAINT material_requests_atendido_por_fkey FOREIGN KEY (atendido_por) REFERENCES public.auth_users(id);


--
-- Name: material_requests material_requests_setor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_requests
    ADD CONSTRAINT material_requests_setor_id_fkey FOREIGN KEY (setor_id) REFERENCES public.setores(id);


--
-- Name: material_requests material_requests_solicitante_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_requests
    ADD CONSTRAINT material_requests_solicitante_id_fkey FOREIGN KEY (solicitante_id) REFERENCES public.auth_users(id);


--
-- Name: request_history request_history_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_history
    ADD CONSTRAINT request_history_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.service_requests(id) ON DELETE CASCADE;


--
-- Name: request_history request_history_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_history
    ADD CONSTRAINT request_history_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.auth_users(id);


--
-- Name: service_requests service_requests_responsavel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_requests
    ADD CONSTRAINT service_requests_responsavel_id_fkey FOREIGN KEY (responsavel_id) REFERENCES public.auth_users(id);


--
-- Name: service_requests service_requests_setor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_requests
    ADD CONSTRAINT service_requests_setor_id_fkey FOREIGN KEY (setor_id) REFERENCES public.setores(id);


--
-- Name: service_requests service_requests_solicitante_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_requests
    ADD CONSTRAINT service_requests_solicitante_id_fkey FOREIGN KEY (solicitante_id) REFERENCES public.auth_users(id);


--
-- Name: stock_movements stock_movements_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.materials(id);


--
-- Name: stock_movements stock_movements_material_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_material_request_id_fkey FOREIGN KEY (material_request_id) REFERENCES public.material_requests(id);


--
-- Name: stock_movements stock_movements_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.auth_users(id);


--
-- Name: auth_audit_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_audit_events ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_users ENABLE ROW LEVEL SECURITY;

--
-- Name: material_request_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.material_request_items ENABLE ROW LEVEL SECURITY;

--
-- Name: material_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.material_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: materials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.materials ENABLE ROW LEVEL SECURITY;

--
-- Name: request_forms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.request_forms ENABLE ROW LEVEL SECURITY;

--
-- Name: request_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.request_history ENABLE ROW LEVEL SECURITY;

--
-- Name: service_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.service_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: setores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.setores ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


