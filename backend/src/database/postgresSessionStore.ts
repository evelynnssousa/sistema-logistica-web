import type { Pool } from 'pg'
import { isAuthRole } from '../auth/roles.js'
import type { SessionStore, StoredSession } from '../auth/session.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'

type SessionRow = {
  id: string
  token_hash: string
  user_id: string
  role: string
  issued_at: Date
  expires_at: Date
}

type RevokedSessionRow = {
  id: string
  user_id: string
}

function toStoredSession(row: SessionRow): StoredSession | null {
  if (!isAuthRole(row.role)) return null
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    role: row.role,
    issuedAt: row.issued_at.getTime(),
    expiresAt: row.expires_at.getTime(),
  }
}

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async save(session: StoredSession): Promise<void> {
    if (
      !/^[0-9a-f]{64}$/.test(session.tokenHash) ||
      !isAuthRole(session.role) ||
      !session.userId.trim() ||
      !Number.isFinite(session.issuedAt) ||
      !Number.isFinite(session.expiresAt)
    ) {
      throw new Error('Sessão inválida.')
    }

    await withTransaction(this.poolProvider(), async (client) => {
      const inserted = await client.query<{ id: string; user_id: string }>(
          `INSERT INTO app_private.auth_sessions (token_hash, user_id, created_at, expires_at)
         SELECT $1, u.id, $4, $5
            FROM app_private.users u
          WHERE u.id = $2
            AND u.role = $3
            AND u.is_active = true
          FOR UPDATE
         RETURNING id::text AS id, user_id::text AS user_id`,
        [
          session.tokenHash,
          session.userId,
          session.role,
          new Date(session.issuedAt),
          new Date(session.expiresAt),
        ],
      )
      const row = inserted.rows[0]
      if (!row) throw new Error('Usuário inativo ou identidade desatualizada.')
      await insertAuthAuditEvent(client, {
        actorUserId: row.user_id,
        actorKind: 'user',
        subjectUserId: row.user_id,
        sessionId: row.id,
        eventType: 'session_created',
      })
    })
  }

  async findByTokenHash(tokenHash: string): Promise<StoredSession | null> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null

    try {
      const result = await this.poolProvider().query<SessionRow>(
        `SELECT s.id::text AS id,
                s.token_hash,
                u.id::text AS user_id,
                u.role,
                s.created_at AS issued_at,
                s.expires_at
           FROM app_private.auth_sessions s
           JOIN app_private.users u ON u.id = s.user_id
          WHERE s.token_hash = $1
            AND s.revoked_at IS NULL
            AND s.expires_at > now()
            AND u.is_active = true
          LIMIT 1`,
        [tokenHash],
      )
      const row = result.rows[0]
      return row ? toStoredSession(row) : null
    } catch {
      throw new Error('Não foi possível validar a sessão.')
    }
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) return

    await withTransaction(this.poolProvider(), async (client) => {
      const result = await client.query<RevokedSessionRow>(
        `UPDATE app_private.auth_sessions
            SET revoked_at = COALESCE(revoked_at, now()),
                revoked_by_user_id = COALESCE(revoked_by_user_id, user_id)
          WHERE token_hash = $1
            AND revoked_at IS NULL
          RETURNING id::text AS id, user_id::text AS user_id`,
        [tokenHash],
      )
      const revoked = result.rows[0]
      if (!revoked) return

      await insertAuthAuditEvent(client, {
        actorUserId: revoked.user_id,
        actorKind: 'user',
        subjectUserId: revoked.user_id,
        sessionId: revoked.id,
        eventType: 'session_revoked',
      })
    })
  }
}