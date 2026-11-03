import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import { isAuthRole, resolveDatabaseAuthRole } from '../auth/roles.js'
import type { SessionStore, StoredSession } from '../auth/session.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'

type SessionRow = {
  token_hash: string
  user_id: string
  role: string
  permissions: string[]
  issued_at: Date
  expires_at: Date
}

function toStoredSession(row: SessionRow): StoredSession | null {
  const role = resolveDatabaseAuthRole(row.role, row.permissions)
  if (!role) return null
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    role,
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
      const account = await client.query<{ role: string; permissions: string[] }>(
        `SELECT role, permissions
           FROM public.auth_users
          WHERE id = $1
            AND status = 'approved'
          FOR UPDATE`,
        [session.userId],
      )
      const user = account.rows[0]
      if (
        !user ||
        resolveDatabaseAuthRole(user.role, user.permissions) !== session.role
      ) {
        throw new Error('Usuário inativo ou identidade desatualizada.')
      }

      // A coluna é obrigatória no banco; a validação de CSRF ainda não está ativa.
      const csrfTokenHash = createHash('sha256')
        .update(randomBytes(32))
        .digest('hex')
      const inserted = await client.query<{ id: string; user_id: string }>(
        `INSERT INTO public.auth_sessions
          (session_token_hash, csrf_token_hash, user_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id::text AS id, user_id::text AS user_id`,
        [
          session.tokenHash,
          csrfTokenHash,
          session.userId,
          new Date(session.issuedAt),
          new Date(session.expiresAt),
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
      const result = await this.poolProvider().query<SessionRow>(
        `SELECT s.session_token_hash AS token_hash,
                u.id::text AS user_id,
                u.role,
                u.permissions,
                s.created_at AS issued_at,
                s.expires_at
           FROM public.auth_sessions s
           JOIN public.auth_users u ON u.id = s.user_id
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

  async deleteByTokenHash(tokenHash: string): Promise<void> {
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
        actorUserId: revoked.user_id,
        actorKind: 'user',
        subjectUserId: revoked.user_id,
        sessionId: revoked.id,
        eventType: 'session_revoked',
      })
    })
  }
}
