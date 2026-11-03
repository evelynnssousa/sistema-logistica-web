import type { Pool } from 'pg'
import { isAuthRole } from '../auth/roles.js'
import type {
  SessionEndReason,
  SessionStore,
  StoredSession,
} from '../auth/session.js'
import { accessSql, isAccessSchemaMigrated, resolveAccess } from './accessSchema.js'
import type { AccessRow } from './accessSchema.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'

type SessionRow = AccessRow & {
  token_hash: string
  csrf_token_hash: string
  user_id: string
  sector: string
  issued_at: Date
  expires_at: Date
  last_seen_at: Date
}

function toStoredSession(row: SessionRow): StoredSession | null {
  const access = resolveAccess(row)
  if (!access) return null
  return {
    tokenHash: row.token_hash,
    csrfTokenHash: row.csrf_token_hash,
    userId: row.user_id,
    role: access.role,
    permissions: access.permissions,
    slmMember: access.slmMember,
    sector: row.sector,
    issuedAt: row.issued_at.getTime(),
    expiresAt: row.expires_at.getTime(),
    lastSeenAt: row.last_seen_at.getTime(),
  }
}

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async save(session: StoredSession): Promise<void> {
    if (
      !/^[0-9a-f]{64}$/.test(session.tokenHash) ||
      !/^[0-9a-f]{64}$/.test(session.csrfTokenHash) ||
      !isAuthRole(session.role) ||
      !session.userId.trim() ||
      !Number.isFinite(session.issuedAt) ||
      !Number.isFinite(session.expiresAt) ||
      !Number.isFinite(session.lastSeenAt)
    ) {
      throw new Error('Sessão inválida.')
    }

    await withTransaction(this.poolProvider(), async (client) => {
      const sql = accessSql(await isAccessSchemaMigrated(client))
      const account = await client.query<AccessRow>(
        `SELECT ${sql.columns}
           FROM public.auth_users u
           ${sql.join}
          WHERE u.id = $1
            AND u.status = 'approved'
          FOR UPDATE OF u`,
        [session.userId],
      )
      const user = account.rows[0]
      if (!user || resolveAccess(user)?.role !== session.role) {
        throw new Error('Usuário inativo ou identidade desatualizada.')
      }

      const inserted = await client.query<{ id: string; user_id: string }>(
        `INSERT INTO public.auth_sessions
          (session_token_hash, csrf_token_hash, user_id, created_at, expires_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id::text AS id, user_id::text AS user_id`,
        [
          session.tokenHash,
          session.csrfTokenHash,
          session.userId,
          new Date(session.issuedAt),
          new Date(session.expiresAt),
          new Date(session.lastSeenAt),
        ],
      )
      const row = inserted.rows[0]
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
      const pool = this.poolProvider()
      const sql = accessSql(await isAccessSchemaMigrated(pool))
      const result = await pool.query<SessionRow>(
        `SELECT s.session_token_hash AS token_hash,
                s.csrf_token_hash,
                u.id::text AS user_id,
                u.sector,
                ${sql.columns},
                s.created_at AS issued_at,
                s.expires_at,
                s.last_seen_at
           FROM public.auth_sessions s
           JOIN public.auth_users u ON u.id = s.user_id
           ${sql.join}
          WHERE s.session_token_hash = $1
            AND s.expires_at > now()
            AND u.status = 'approved'
          LIMIT 1`,
        [tokenHash],
      )
      const row = result.rows[0]
      return row ? toStoredSession(row) : null
    } catch {
      throw new Error('Não foi possível validar a sessão.')
    }
  }

  async deleteByTokenHash(
    tokenHash: string,
    reason: SessionEndReason = 'logout',
  ): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) return

    await withTransaction(this.poolProvider(), async (client) => {
      const result = await client.query<{ id: string; user_id: string }>(
        `DELETE FROM public.auth_sessions
          WHERE session_token_hash = $1
          RETURNING id::text AS id, user_id::text AS user_id`,
        [tokenHash],
      )
      const revoked = result.rows[0]
      if (!revoked) return

      await insertAuthAuditEvent(client, {
        actorUserId: reason === 'logout' ? revoked.user_id : null,
        actorKind: reason === 'logout' ? 'user' : 'system',
        subjectUserId: revoked.user_id,
        sessionId: revoked.id,
        eventType: 'session_revoked',
        details: { reason },
      })
    })
  }

  async touch(tokenHash: string, lastSeenAt: number): Promise<void> {
    await this.poolProvider().query(
      `UPDATE public.auth_sessions
          SET last_seen_at = $2
        WHERE session_token_hash = $1`,
      [tokenHash, new Date(lastSeenAt)],
    )
  }

  // Remove apenas sessões. Os eventos de auditoria não dependem delas e permanecem.
  async deleteExpired(idleCutoff: number): Promise<number> {
    const result = await this.poolProvider().query(
      `DELETE FROM public.auth_sessions
        WHERE expires_at <= now()
           OR last_seen_at <= $1`,
      [new Date(idleCutoff)],
    )
    return result.rowCount ?? 0
  }
}
