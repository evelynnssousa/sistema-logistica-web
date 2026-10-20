BEGIN;

CREATE TABLE public.auth_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL CHECK (length(trim(full_name)) BETWEEN 2 AND 120),
  email text NOT NULL,
  sector text NOT NULL CHECK (length(trim(sector)) BETWEEN 2 AND 120),
  password_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'blocked', 'inactive')),
  role text CHECK (role IN ('admin', 'operator')),
  permissions text[] NOT NULL DEFAULT '{}',
  decided_by uuid REFERENCES public.auth_users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'pending' AND role IS NULL AND decided_at IS NULL)
    OR (status = 'rejected' AND role IS NULL AND decided_at IS NOT NULL)
    OR (status IN ('approved', 'blocked', 'inactive') AND role IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CHECK (permissions <@ ARRAY[
    'maintenance:read', 'maintenance:write',
    'fleet:read', 'fleet:write',
    'flights:read', 'flights:write', 'flights:cpf:read',
    'warehouse:read', 'warehouse:write',
    'settings:read', 'settings:write'
  ]::text[])
);

CREATE UNIQUE INDEX auth_users_email_unique ON public.auth_users (lower(email));
CREATE INDEX auth_users_pending_created ON public.auth_users (created_at) WHERE status = 'pending';

CREATE TABLE public.auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.auth_users(id) ON DELETE CASCADE,
  session_token_hash char(64) NOT NULL UNIQUE,
  csrf_token_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX auth_sessions_expiry ON public.auth_sessions (expires_at);

CREATE TABLE public.auth_audit_events (
  id bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES public.auth_users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_user_id uuid REFERENCES public.auth_users(id) ON DELETE SET NULL,
  target_resource_id text,
  result text NOT NULL CHECK (result IN ('success', 'denied', 'failure')),
  details jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX auth_audit_target_time ON public.auth_audit_events (target_user_id, occurred_at DESC);

ALTER TABLE public.auth_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_audit_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.auth_users,
  public.auth_sessions,
  public.auth_audit_events
FROM PUBLIC;

REVOKE ALL PRIVILEGES ON SEQUENCE public.auth_audit_events_id_seq FROM PUBLIC;

DO $migration$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.auth_users, public.auth_sessions, public.auth_audit_events FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON SEQUENCE public.auth_audit_events_id_seq FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$migration$;

COMMIT;