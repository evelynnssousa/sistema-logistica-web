BEGIN;

CREATE TABLE app_private.password_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
    REFERENCES app_private.users(id) ON DELETE RESTRICT,
  code_hash char(64) NOT NULL
    CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0
    CHECK (attempts BETWEEN 0 AND 5),
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX password_recovery_user_created_idx
  ON app_private.password_recovery_codes (user_id, created_at DESC);

CREATE INDEX password_recovery_expiration_idx
  ON app_private.password_recovery_codes (expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE app_private.password_recovery_codes
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE app_private.password_recovery_codes
  FORCE ROW LEVEL SECURITY;

CREATE POLICY password_recovery_backend_access
  ON app_private.password_recovery_codes
  FOR ALL
  TO app_backend
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE
  ON app_private.password_recovery_codes
  TO app_backend;

ALTER TABLE app_private.auth_audit_events
  DROP CONSTRAINT IF EXISTS auth_audit_events_event_type_check;

ALTER TABLE app_private.auth_audit_events
  ADD CONSTRAINT auth_audit_events_event_type_check
  CHECK (event_type IN (
    'user_created',
    'user_updated',
    'account_activated',
    'account_deactivated',
    'role_changed',
    'password_changed',
    'session_created',
    'session_revoked',
    'administrator_recovered',
    'initial_administrator_created',
    'registration_submitted',
    'registration_approved',
    'registration_rejected',
    'account_blocked',
    'permissions_changed',
    'password_recovery_requested',
    'password_recovery_completed'
  ));

COMMIT;
