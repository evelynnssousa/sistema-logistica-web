import type { Pool } from 'pg'
import { verifyPasswordRecoveryCode } from '../auth/passwordRecovery.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'

type RecoveryAccount = {
  id: string
  email: string
}

type RecoveryCodeRow = {
  id: string
  code_hash: string
  expires_at: Date
  attempts: number
}

export class PasswordRecoveryRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async createCode(
    email: string,
    codeHash: string,
  ): Promise<RecoveryAccount | null> {
    return withTransaction(this.poolProvider(), async (client) => {
      const found = await client.query<RecoveryAccount>(
        `SELECT id::text AS id, email
           FROM app_private.users
          WHERE lower(email) = $1
            AND is_active = true
            AND account_status = 'approved'
          LIMIT 1
          FOR UPDATE`,
        [email],
      )

      const account = found.rows[0]
      if (!account) return null

      await client.query(
        `UPDATE app_private.password_recovery_codes
            SET consumed_at = COALESCE(consumed_at, now())
          WHERE user_id = $1
            AND consumed_at IS NULL`,
        [account.id],
      )

      await client.query(
        `INSERT INTO app_private.password_recovery_codes
          (user_id, code_hash, expires_at)
         VALUES ($1, $2, now() + interval '10 minutes')`,
        [account.id, codeHash],
      )

      await insertAuthAuditEvent(client, {
        actorUserId: null,
        actorKind: 'system',
        subjectUserId: account.id,
        sessionId: null,
        eventType: 'password_recovery_requested',
      })

      return account
    })
  }

  async invalidateCodes(userId: string): Promise<void> {
    await this.poolProvider().query(
      `UPDATE app_private.password_recovery_codes
          SET consumed_at = COALESCE(consumed_at, now())
        WHERE user_id = $1
          AND consumed_at IS NULL`,
      [userId],
    )
  }

  async resetPassword(input: {
    email: string
    code: string
    passwordHash: string
  }): Promise<boolean> {
    return withTransaction(this.poolProvider(), async (client) => {
      const found = await client.query<RecoveryAccount>(
        `SELECT id::text AS id, email
           FROM app_private.users
          WHERE lower(email) = $1
            AND is_active = true
            AND account_status = 'approved'
          LIMIT 1
          FOR UPDATE`,
        [input.email],
      )

      const account = found.rows[0]
      if (!account) return false

      const foundCode = await client.query<RecoveryCodeRow>(
        `SELECT id::text AS id, code_hash, expires_at, attempts
           FROM app_private.password_recovery_codes
          WHERE user_id = $1
            AND consumed_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [account.id],
      )

      const recovery = foundCode.rows[0]
      if (!recovery) return false

      if (
        recovery.expires_at.getTime() <= Date.now() ||
        recovery.attempts >= 5
      ) {
        await client.query(
          `UPDATE app_private.password_recovery_codes
              SET consumed_at = now()
            WHERE id = $1`,
          [recovery.id],
        )
        return false
      }

      if (!verifyPasswordRecoveryCode(input.code, recovery.code_hash)) {
        await client.query(
          `UPDATE app_private.password_recovery_codes
              SET attempts = LEAST(attempts + 1, 5),
                  consumed_at = CASE
                    WHEN attempts + 1 >= 5 THEN now()
                    ELSE consumed_at
                  END
            WHERE id = $1`,
          [recovery.id],
        )
        return false
      }

      await client.query(
        `UPDATE app_private.password_recovery_codes
            SET consumed_at = now()
          WHERE id = $1`,
        [recovery.id],
      )

      await client.query(
        `UPDATE app_private.users
            SET password_hash = $2,
                updated_at = now(),
                updated_by_user_id = NULL
          WHERE id = $1`,
        [account.id, input.passwordHash],
      )

      const revoked = await client.query<{ id: string }>(
        `UPDATE app_private.auth_sessions
            SET revoked_at = COALESCE(revoked_at, now()),
                revoked_by_user_id = COALESCE(revoked_by_user_id, user_id)
          WHERE user_id = $1
            AND revoked_at IS NULL
          RETURNING id::text AS id`,
        [account.id],
      )

      for (const session of revoked.rows) {
        await insertAuthAuditEvent(client, {
          actorUserId: null,
          actorKind: 'system',
          subjectUserId: account.id,
          sessionId: session.id,
          eventType: 'session_revoked',
        })
      }

      await insertAuthAuditEvent(client, {
        actorUserId: null,
        actorKind: 'system',
        subjectUserId: account.id,
        sessionId: null,
        eventType: 'password_changed',
      })

      await insertAuthAuditEvent(client, {
        actorUserId: null,
        actorKind: 'system',
        subjectUserId: account.id,
        sessionId: null,
        eventType: 'password_recovery_completed',
      })

      return true
    })
  }
}
