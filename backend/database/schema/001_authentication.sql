CREATE SCHEMA IF NOT EXISTS app_private;

CREATE TABLE app_private.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name = btrim(name) AND name <> ''),
  email text,
  username text,
  password_hash text NOT NULL
    CHECK (password_hash LIKE '$argon2id$%'),
  role text NOT NULL
    CHECK (role IN ('administrator', 'slm_operator')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES app_private.users(id) ON DELETE RESTRICT,
  updated_by_user_id uuid REFERENCES app_private.users(id) ON DELETE RESTRICT,
  CONSTRAINT users_login_identifier_required
    CHECK (email IS NOT NULL OR username IS NOT NULL),
  CONSTRAINT users_email_normalized
    CHECK (
      email IS NULL OR
      (email = lower(btrim(email)) AND length(email) <= 254 AND email <> '')
    ),
  CONSTRAINT users_username_normalized
    CHECK (
      username IS NULL OR
      username ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    )
);

CREATE UNIQUE INDEX users_email_lower_uq
  ON app_private.users (lower(email)) WHERE email IS NOT NULL;

CREATE UNIQUE INDEX users_username_lower_uq
  ON app_private.users (lower(username)) WHERE username IS NOT NULL;

CREATE UNIQUE INDEX users_one_active_administrator_uq
  ON app_private.users (role)
  WHERE role = 'administrator' AND is_active;

CREATE TABLE app_private.auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash char(64) NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES app_private.users(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES app_private.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_sessions_expiration_after_creation
    CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_active_user_idx
  ON app_private.auth_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX auth_sessions_expiration_idx
  ON app_private.auth_sessions (expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE app_private.auth_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES app_private.users(id) ON DELETE RESTRICT,
  actor_kind text NOT NULL
    CHECK (actor_kind IN ('user', 'system', 'emergency_operator')),
  actor_reference text,
  subject_user_id uuid REFERENCES app_private.users(id) ON DELETE RESTRICT,
  session_id uuid REFERENCES app_private.auth_sessions(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN (
    'user_created',
    'user_updated',
    'account_activated',
    'account_deactivated',
    'role_changed',
    'password_changed',
    'session_created',
    'session_revoked',
    'administrator_recovered'
  )),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid,
  CONSTRAINT auth_audit_actor_reference_valid
    CHECK (
      (actor_kind = 'user' AND actor_user_id IS NOT NULL) OR
      (actor_kind = 'system' AND actor_user_id IS NULL) OR
      (
        actor_kind = 'emergency_operator' AND
        actor_user_id IS NULL AND
        actor_reference IS NOT NULL AND
        btrim(actor_reference) <> ''
      )
    )
);

CREATE INDEX auth_audit_subject_time_idx
  ON app_private.auth_audit_events (subject_user_id, occurred_at DESC);

CREATE INDEX auth_audit_actor_time_idx
  ON app_private.auth_audit_events (actor_user_id, occurred_at DESC);

CREATE INDEX auth_audit_retention_idx
  ON app_private.auth_audit_events (occurred_at);