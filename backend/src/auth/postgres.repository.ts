import { Pool, type PoolClient, type QueryResultRow } from 'pg'
import { pool } from '../database/pool'
import type {
  AccountStatus,
  AuditEvent,
  AuthRepository,
  ModulePermission,
  PendingUser,
  RegistrationDecision,
  RegistrationInput,
  SessionRecord,
  UserRecord,
  UserRole,
} from './types'

interface UserRow extends QueryResultRow {
  id: string
  full_name: string
  email: string
  sector: string
  password_hash: string
  status: AccountStatus
  role: UserRole | null
  permissions: ModulePermission[]
  created_at: Date
}

export class InitialAdministratorBootstrapError extends Error {
  constructor(readonly stage: 'database_access' | 'administrator_creation') {
    super('Initial administrator bootstrap failed.')
    this.name = 'InitialAdministratorBootstrapError'
  }
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    sector: row.sector,
    passwordHash: row.password_hash,
    status: row.status,
    role: row.role,
    permissions: row.permissions,
    createdAt: row.created_at,
  }
}

async function writeAudit(client: PoolClient, event: AuditEvent): Promise<void> {
  await client.query(
    `INSERT INTO auth_audit_events
      (actor_user_id, action, target_user_id, target_resource_id, result, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      event.actorUserId,
      event.action,
      event.targetUserId,
      event.targetResourceId ?? null,
      event.result,
      JSON.stringify(event.details ?? {}),
    ],
  )
}

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly pool: Pool) {}

  async createPendingUser(input: RegistrationInput & { passwordHash: string }): Promise<UserRecord> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<UserRow>(
        `INSERT INTO auth_users (full_name, email, sector, password_hash, status)
         VALUES ($1, $2, $3, $4, 'pending')
         RETURNING *`,
        [input.fullName, input.email, input.sector, input.passwordHash],
      )
      const user = mapUser(result.rows[0])
      await writeAudit(client, {
        actorUserId: user.id,
        action: 'registration.requested',
        targetUserId: user.id,
        result: 'success',
      })
      await client.query('COMMIT')
      return user
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM auth_users WHERE email = $1 LIMIT 1',
      [email],
    )
    return result.rows[0] ? mapUser(result.rows[0]) : null
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM auth_users WHERE id = $1 LIMIT 1',
      [id],
    )
    return result.rows[0] ? mapUser(result.rows[0]) : null
  }

  async createSession(input: Omit<SessionRecord, 'id'>): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO auth_sessions (user_id, session_token_hash, csrf_token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [input.userId, input.sessionTokenHash, input.csrfTokenHash, input.expiresAt],
      )
      await writeAudit(client, {
        actorUserId: input.userId,
        action: 'auth.login',
        targetUserId: input.userId,
        result: 'success',
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const result = await this.pool.query(
      `SELECT id, user_id, session_token_hash, csrf_token_hash, expires_at
       FROM auth_sessions WHERE session_token_hash = $1 AND expires_at > NOW() LIMIT 1`,
      [tokenHash],
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      id: row.id,
      userId: row.user_id,
      sessionTokenHash: row.session_token_hash,
      csrfTokenHash: row.csrf_token_hash,
      expiresAt: row.expires_at,
    }
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM auth_sessions WHERE session_token_hash = $1', [tokenHash])
  }

  async endSession(tokenHash: string, actorUserId: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM auth_sessions WHERE session_token_hash = $1', [tokenHash])
      await writeAudit(client, {
        actorUserId,
        action: 'auth.logout',
        targetUserId: actorUserId,
        result: 'success',
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async listPendingUsers(): Promise<PendingUser[]> {
    const result = await this.pool.query(
      `SELECT id, full_name, email, sector, status, role, permissions, created_at
       FROM auth_users WHERE status = 'pending' ORDER BY created_at ASC`,
    )
    return result.rows.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      email: row.email,
      sector: row.sector,
      status: row.status,
      role: row.role,
      permissions: row.permissions,
      createdAt: row.created_at,
    }))
  }

  async decideRegistration(
    userId: string,
    actorUserId: string,
    decision: RegistrationDecision,
  ): Promise<UserRecord | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<UserRow>(
        `UPDATE auth_users
         SET status = $2, role = $3, permissions = $4, decided_by = $5,
             decided_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [
          userId,
          decision.action === 'approve' ? 'approved' : 'rejected',
          decision.action === 'approve' ? decision.role : null,
          decision.action === 'approve' ? decision.permissions : [],
          actorUserId,
        ],
      )
      const user = result.rows[0] ? mapUser(result.rows[0]) : null
      if (user && decision.action === 'reject') {
        await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId])
      }
      await writeAudit(client, {
        actorUserId,
        action: `registration.${decision.action}`,
        targetUserId: userId,
        result: user ? 'success' : 'failure',
        details: user
          ? { role: user.role, permissions: user.permissions.join(',') }
          : { reason: 'not_pending_or_not_found' },
      })
      await client.query('COMMIT')
      return user
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async setUserStatus(
    userId: string,
    actorUserId: string,
    status: 'blocked' | 'inactive',
  ): Promise<UserRecord | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('LOCK TABLE auth_users IN SHARE ROW EXCLUSIVE MODE')
      const currentResult = await client.query<UserRow>(
        'SELECT * FROM auth_users WHERE id = $1 AND status = \'approved\' FOR UPDATE',
        [userId],
      )
      const current = currentResult.rows[0]
      if (!current) {
        await client.query('COMMIT')
        return null
      }
      if (current.role === 'admin') {
        const administratorCount = await client.query(
          `SELECT COUNT(*)::int AS count FROM auth_users
           WHERE role = 'admin' AND status = 'approved'`,
        )
        if ((administratorCount.rows[0]?.count ?? 0) <= 1) {
          await writeAudit(client, {
            actorUserId,
            action: `account.${status}`,
            targetUserId: userId,
            result: 'denied',
            details: { reason: 'last_administrator' },
          })
          await client.query('COMMIT')
          return null
        }
      }
      const result = await client.query<UserRow>(
        `UPDATE auth_users SET status = $2, decided_at = COALESCE(decided_at, NOW()), updated_at = NOW()
         WHERE id = $1 AND status = 'approved' RETURNING *`,
        [userId, status],
      )
      const user = result.rows[0] ? mapUser(result.rows[0]) : null
      if (user) {
        await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId])
      }
      await writeAudit(client, {
        actorUserId,
        action: `account.${status}`,
        targetUserId: userId,
        result: user ? 'success' : 'failure',
        details: user ? {} : { reason: 'not_approved_or_not_found' },
      })
      await client.query('COMMIT')
      return user
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async hasAdministrator(): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM auth_users WHERE role = 'admin' AND status = 'approved' LIMIT 1`,
    )
    return (result.rowCount ?? 0) > 0
  }

  async hasOtherAdministrator(userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM auth_users
       WHERE role = 'admin' AND status = 'approved' AND id <> $1 LIMIT 1`,
      [userId],
    )
    return (result.rowCount ?? 0) > 0
  }

  async createAuditEvent(event: AuditEvent): Promise<void> {
    const client = await this.pool.connect()
    try {
      await writeAudit(client, event)
    } finally {
      client.release()
    }
  }

  async createInitialAdministrator(
    input: RegistrationInput & { passwordHash: string },
  ): Promise<UserRecord> {
    let client: PoolClient
    try {
      client = await this.pool.connect()
    } catch {
      throw new InitialAdministratorBootstrapError('database_access')
    }

    let stage: 'database_access' | 'administrator_creation' = 'database_access'
    try {
      await client.query('BEGIN')
      await client.query('LOCK TABLE auth_users IN EXCLUSIVE MODE')
      const existing = await client.query(
        `SELECT 1 FROM auth_users WHERE role = 'admin' AND status = 'approved' LIMIT 1`,
      )
      stage = 'administrator_creation'
      if (existing.rowCount) throw new Error('ADMINISTRATOR_ALREADY_EXISTS')

      const result = await client.query<UserRow>(
        `INSERT INTO auth_users
          (full_name, email, sector, password_hash, status, role, permissions, decided_by, decided_at)
         VALUES ($1, $2, $3, $4, 'approved', 'admin', $5, NULL, NOW())
         RETURNING *`,
        [input.fullName, input.email, input.sector, input.passwordHash, []],
      )
      const user = mapUser(result.rows[0])
      await writeAudit(client, {
        actorUserId: null,
        action: 'administrator.bootstrap',
        targetUserId: user.id,
        result: 'success',
      })
      await client.query('COMMIT')
      return user
    } catch {
      try {
        await client.query('ROLLBACK')
      } catch {
        throw new InitialAdministratorBootstrapError(stage)
      }
      throw new InitialAdministratorBootstrapError(stage)
    } finally {
      client.release()
    }
  }
}

export function createPostgresAuthRepository(): PostgresAuthRepository | null {
  if (!pool) return null
  return new PostgresAuthRepository(pool)
}