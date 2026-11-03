BEGIN;

-- Status e dados adicionais dos usuários.
-- Usuários existentes permanecem aprovados, exceto os já inativos.
ALTER TABLE app_private.users
  ADD COLUMN account_status text NOT NULL DEFAULT 'approved'
    CHECK (
      account_status IN (
        'pending',
        'approved',
        'rejected',
        'blocked',
        'inactive'
      )
    ),
  ADD COLUMN sector text
    CHECK (
      sector IS NULL OR
      length(btrim(sector)) BETWEEN 2 AND 120
    ),
  ADD COLUMN decided_by_user_id uuid
    REFERENCES app_private.users(id) ON DELETE RESTRICT,
  ADD COLUMN decided_at timestamptz;

UPDATE app_private.users
SET account_status = 'inactive'
WHERE is_active = false;

-- Permissões individuais por módulo.
CREATE TABLE app_private.user_permissions (
  user_id uuid NOT NULL
    REFERENCES app_private.users(id) ON DELETE RESTRICT,
  permission text NOT NULL CHECK (
    permission IN (
      'maintenance:read',
      'maintenance:write',
      'fleet:read',
      'fleet:write',
      'flights:read',
      'flights:write',
      'flights:cpf:read',
      'warehouse:read',
      'warehouse:write',
      'settings:read',
      'settings:write',
      'users:read',
      'users:manage'
    )
  ),
  granted_by_user_id uuid
    REFERENCES app_private.users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission)
);

CREATE INDEX user_permissions_user_idx
  ON app_private.user_permissions (user_id);

-- Auditoria das solicitações de acesso e das alterações de permissões.
ALTER TABLE app_private.auth_audit_events
  DROP CONSTRAINT auth_audit_events_event_type_check;

ALTER TABLE app_private.auth_audit_events
  ADD CONSTRAINT auth_audit_events_event_type_check
  CHECK (
    event_type IN (
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
      'permissions_changed'
    )
  );

COMMIT;
