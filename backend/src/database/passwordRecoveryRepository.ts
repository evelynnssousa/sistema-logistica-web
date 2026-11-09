import type { Pool, PoolClient } from 'pg'
import {
  PASSWORD_RECOVERY_MAX_ATTEMPTS,
  PASSWORD_RECOVERY_TTL_MS,
  verifyPasswordRecoveryCode,
} from '../auth/passwordRecovery.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { getDatabasePool } from './pool.js'
import { publishAccountEvent } from '../integrations/accountNotices.js'
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
           FROM public.auth_users
          WHERE lower(email) = $1
            AND status = 'approved'
          LIMIT 1
          FOR UPDATE`,
        [email],
      )

      const account = found.rows[0]
      if (!account) return null

      await client.query(
        `UPDATE public.password_recovery_codes
            SET consumed_at = COALESCE(consumed_at, now())
          WHERE user_id = $1
            AND consumed_at IS NULL`,
        [account.id],
      )

      await client.query(
        `INSERT INTO public.password_recovery_codes
          (user_id, code_hash, expires_at)
         VALUES ($1, $2, now() + ($3::double precision * interval '1 millisecond'))`,
        [account.id, codeHash, PASSWORD_RECOVERY_TTL_MS],
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
      `UPDATE public.password_recovery_codes
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
           FROM public.auth_users
          WHERE lower(email) = $1
            AND status = 'approved'
          LIMIT 1
          FOR UPDATE`,
        [input.email],
      )

      const account = found.rows[0]
      if (!account) return false

      const foundCode = await client.query<RecoveryCodeRow>(
        `SELECT id::text AS id, code_hash, expires_at, attempts
           FROM public.password_recovery_codes
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
        recovery.attempts >= PASSWORD_RECOVERY_MAX_ATTEMPTS
      ) {
        await client.query(
          `UPDATE public.password_recovery_codes
              SET consumed_at = now()
            WHERE id = $1`,
          [recovery.id],
        )
        return false
      }

      if (!verifyPasswordRecoveryCode(input.code, recovery.code_hash)) {
        await client.query(
          `UPDATE public.password_recovery_codes
              SET attempts = LEAST(attempts + 1, $2),
                  consumed_at = CASE
                    WHEN attempts + 1 >= $2 THEN now()
                    ELSE consumed_at
                  END
            WHERE id = $1`,
          [recovery.id, PASSWORD_RECOVERY_MAX_ATTEMPTS],
        )
        await insertAuthAuditEvent(client, {
          actorUserId: null,
          actorKind: 'system',
          subjectUserId: account.id,
          sessionId: null,
          eventType: 'password_recovery_failed',
          result: 'failure',
        })
        return false
      }

      await completeRecovery(client, account.id, recovery.id, input.passwordHash)
      return true
    })
  }

  /** Link temporário: o próprio token identifica a conta. Vale uma vez, dentro do prazo. */
  async resetPasswordByToken(input: {
    tokenHash: string
    passwordHash: string
  }): Promise<string | null> {
    return withTransaction(this.poolProvider(), async (client) => {
      const found = await client.query<{ id: string; user_id: string; email: string }>(
        `SELECT c.id::text AS id, c.user_id::text AS user_id, u.email
           FROM public.password_recovery_codes c
           JOIN public.auth_users u ON u.id = c.user_id
          WHERE c.code_hash = $1
            AND c.consumed_at IS NULL
            AND c.expires_at > now()
            AND u.status = 'approved'
          FOR UPDATE OF c, u`,
        [input.tokenHash],
      )
      const recovery = found.rows[0]
      if (!recovery) return null

      await completeRecovery(client, recovery.user_id, recovery.id, input.passwordHash)
      return recovery.email.toLowerCase()
    })
  }
}

async function completeRecovery(
  client: PoolClient,
  accountId: string,
  recoveryId: string,
  passwordHash: string,
) {
  await client.query(
    `UPDATE public.password_recovery_codes
        SET consumed_at = now()
      WHERE id = $1`,
    [recoveryId],
  )

  const updated = await client.query<{ email: string | null }>(
    `UPDATE public.auth_users
        SET password_hash = $2,
            updated_at = now()
      WHERE id = $1
      RETURNING email`,
    [accountId, passwordHash],
  )

  const revoked = await client.query<{ id: string }>(
    `DELETE FROM public.auth_sessions
      WHERE user_id = $1
      RETURNING id::text AS id`,
    [accountId],
  )

  for (const session of revoked.rows) {
    await insertAuthAuditEvent(client, {
      actorUserId: null,
      actorKind: 'system',
      subjectUserId: accountId,
      sessionId: session.id,
      eventType: 'session_revoked',
    })
  }

  await insertAuthAuditEvent(client, {
    actorUserId: null,
    actorKind: 'system',
    subjectUserId: accountId,
    sessionId: null,
    eventType: 'password_changed',
  })

  await insertAuthAuditEvent(client, {
    actorUserId: null,
    actorKind: 'system',
    subjectUserId: accountId,
    sessionId: null,
    eventType: 'password_recovery_completed',
  })

  // Confirmação ao titular, sem código, link ou senha: avisa a troca a quem não a pediu.
  const now = new Date()
  await publishAccountEvent(client, {
    type: 'account_password_changed',
    key: `${accountId}:password:${recoveryId}`,
    userId: accountId,
    email: updated.rows[0]?.email ?? null,
    actorId: null,
    context: { occurredAt: now.toISOString() },
  })

}
