import type { Pool, PoolClient } from 'pg'
import { isAuthRole, normalizeAuthRole } from '../auth/roles.js'
import type { AuthRole, AuthenticatedIdentity } from '../auth/roles.js'
import { normalizeLoginIdentifiers } from '../auth/identifiers.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'

export type CreatePendingUserInput = {
  name: string
  email: string
  sector: string
  passwordHash: string
}

export type CreateUserInput = {
  name: string
  email?: string | null
  username?: string | null
  passwordHash: string
  role: AuthRole
}

export type UpdateUserInput = {
  name: string
  email?: string | null
  username?: string | null
  role: AuthRole
  isActive: boolean
}

export type UserAccount = {
  id: string
  name: string
  email: string | null
  username: string | null
  role: AuthRole
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

type UserRow = {
  id: string
  name: string
  email: string | null
  username: string | null
  role: string
  is_active: boolean
  created_at: Date
  updated_at: Date
}

type LockedUserRow = {
  id: string
  role: string
  is_active: boolean
  account_status: string
}


export class AccountAuthorizationError extends Error {
  constructor() {
    super('Ação administrativa não autorizada.')
    this.name = 'AccountAuthorizationError'
  }
}

function normalizeName(name: unknown) {
  if (typeof name !== 'string') {
    throw new Error('Nome de usuário inválido.')
  }
  const normalized = name.trim()
  if (!normalized || normalized.length > 160) {
    throw new Error('Nome de usuário inválido.')
  }
  return normalized
}

function normalizeAccountIdentifiers(input: {
  email?: string | null
  username?: string | null
}) {
  return normalizeLoginIdentifiers(input)
}

function assertAdministrator(actor: AuthenticatedIdentity) {
  if (!actor || actor.role !== 'administrator' || !actor.userId.trim()) {
    throw new AccountAuthorizationError()
  }
}

async function lockActiveAdministrator(
  client: PoolClient,
  actorUserId: string,
) {
  const result = await client.query<{ id: string }>(
    `SELECT id::text AS id
      FROM app_private.users
      WHERE id = $1
        AND role = 'administrator'
        AND is_active = true
      FOR UPDATE`,
    [actorUserId],
  )
  if (result.rowCount !== 1) throw new AccountAuthorizationError()
}


function toUserAccount(row: UserRow): UserAccount {
  const role = normalizeAuthRole(row.role)

  if (!role) {
    throw new Error('Papel de usuário persistido inválido.')
  }

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    username: row.username,
    role,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}


export class UserRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async findActiveById(id: string): Promise<UserAccount | null> {
    const result = await this.poolProvider().query<UserRow>(
      `SELECT id::text AS id, name, email, username, role, is_active,
              created_at, updated_at
         FROM app_private.users
        WHERE id = $1
          AND is_active = true
        LIMIT 1`,
      [id],
    )

    return result.rows[0] ? toUserAccount(result.rows[0]) : null
  }

  async findActiveByLoginIdentifier(identifier: string): Promise<UserAccount | null> {
 const normalized = normalizeLoginIdentifiers(
      identifier.includes('@')
        ? { email: identifier }
        : { username: identifier },
    )
    const result = await this.poolProvider().query<UserRow>(
      `SELECT id::text AS id, name, email, username, role, is_active,
              created_at, updated_at
        FROM app_private.users
        WHERE is_active = true
          AND (($1::text IS NOT NULL AND lower(email) = $1)
            OR ($2::text IS NOT NULL AND lower(username) = $2))
        LIMIT 1`,
      [normalized.email, normalized.username],
    )

    return result.rows[0] ? toUserAccount(result.rows[0]) : null
  }

  async findActiveForAuthentication(
    identifier: string,
  ): Promise<(UserAccount & { passwordHash: string }) | null> {
    const normalized = normalizeLoginIdentifiers(
      identifier.includes('@')
        ? { email: identifier }
        : { username: identifier },
    )

    const result = await this.poolProvider().query<
      UserRow & { password_hash: string }
    >(
      `SELECT id::text AS id, name, email, username, role, is_active,
              created_at, updated_at, password_hash
         FROM app_private.users
        WHERE is_active = true
          AND (($1::text IS NOT NULL AND lower(email) = $1)
            OR ($2::text IS NOT NULL AND lower(username) = $2))
        LIMIT 1`,
      [normalized.email, normalized.username],
    )

    const row = result.rows[0]
    if (!row) return null

    return {
      ...toUserAccount(row),
      passwordHash: row.password_hash,
    }
  }

  async createPendingUser(
    input: CreatePendingUserInput,
  ): Promise<{ id: string; name: string; email: string; sector: string; status: 'pending'; createdAt: Date }> {
    const name = normalizeName(input.name)
    const email = typeof input.email === 'string'
      ? input.email.trim().toLowerCase()
      : ''
    const sector = typeof input.sector === 'string'
      ? input.sector.trim()
      : ''

    if (
      name.length > 120 ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      sector.length < 2 ||
      sector.length > 120 ||
      typeof input.passwordHash !== 'string' ||
      !input.passwordHash.startsWith('$argon2id$')
    ) {
      throw new Error('Dados de cadastro inválidos.')
    }

    return withTransaction(this.poolProvider(), async (client) => {
      const result = await client.query<{
        id: string
        name: string
        email: string
        sector: string
        account_status: string
        created_at: Date
      }>(
        `INSERT INTO app_private.users
          (name, email, username, password_hash, role, is_active,
           account_status, sector)
         VALUES ($1, $2, NULL, $3, 'requester', false, 'pending', $4)
         RETURNING id::text AS id, name, email, sector,
                   account_status, created_at`,
        [name, email, input.passwordHash, sector],
      )

      const account = result.rows[0]

      await insertAuthAuditEvent(client, {
        actorUserId: null,
        actorKind: 'system',
        subjectUserId: account.id,
        sessionId: null,
        eventType: 'registration_submitted',
      })

      return {
        id: account.id,
        name: account.name,
        email: account.email,
        sector: account.sector,
        status: 'pending',
        createdAt: account.created_at,
      }
    })
  }

  async createUser(
    actor: AuthenticatedIdentity,
    input: CreateUserInput,
  ): Promise<UserAccount> {
    assertAdministrator(actor)
    const name = normalizeName(input.name)
    const identifiers = normalizeAccountIdentifiers(input)
    if (
      typeof input.passwordHash !== 'string' ||
      !input.passwordHash.startsWith('$argon2id$') ||
      !isAuthRole(input.role)
    ) {
      throw new Error('Dados de conta inválidos.')
    }

    return withTransaction(this.poolProvider(), async (client) => {
      await lockActiveAdministrator(client, actor.userId)
      const result = await client.query<UserRow>(
        `INSERT INTO app_private.users
          (name, email, username, password_hash, role, created_by_user_id,
           updated_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         RETURNING id::text AS id, name, email, username, role, is_active,
                   created_at, updated_at`,
        [
          name,
          identifiers.email,
          identifiers.username,
          input.passwordHash,
          input.role,
          actor.userId,
        ],
      )
      const account = toUserAccount(result.rows[0])
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: account.id,
        sessionId: null,
        eventType: 'user_created',
      })
      return account
    })
  }

  async updateUser(
    actor: AuthenticatedIdentity,
    userId: string,
    input: UpdateUserInput,
  ): Promise<UserAccount> {
    assertAdministrator(actor)
    const name = normalizeName(input.name)
    const identifiers = normalizeAccountIdentifiers(input)
    if (!isAuthRole(input.role) || typeof input.isActive !== 'boolean') {
      throw new Error('Dados de conta inválidos.')
    }

    return withTransaction(this.poolProvider(), async (client) => {
      await lockActiveAdministrator(client, actor.userId)
      const locked = await client.query<LockedUserRow>(
        `SELECT id::text AS id, role, is_active, account_status
  FROM app_private.users
 WHERE id = $1
 FOR UPDATE`,
        [userId],
      )
      const previous = locked.rows[0]
      if (!previous) throw new Error('Conta não encontrada.')
      if (previous.account_status === 'pending') {
  throw new Error(
    'Cadastros pendentes só podem ser alterados pela aprovação ou rejeição administrativa.',
  )
}
        if (
        previous.id === actor.userId &&
        (input.role !== 'administrator' || !input.isActive)
      ) {
        throw new AccountAuthorizationError()
      }

      const result = await client.query<UserRow>(
        `UPDATE app_private.users
            SET name = $2,
                email = $3,
                username = $4,
                role = $5,
                is_active = $6,
                updated_at = now(),
                updated_by_user_id = $7
          WHERE id = $1
          RETURNING id::text AS id, name, email, username, role, is_active,
                    created_at, updated_at`,
        [
          userId,
          name,
          identifiers.email,
          identifiers.username,
          input.role,
          input.isActive,
          actor.userId,
        ],
      )
      const account = toUserAccount(result.rows[0])

      if (previous.is_active !== input.isActive) {
        const revokedSessions = await client.query<{ id: string }>(
          `UPDATE app_private.auth_sessions
              SET revoked_at = COALESCE(revoked_at, now()),
                  revoked_by_user_id = COALESCE(revoked_by_user_id, $2)
            WHERE user_id = $1
              AND revoked_at IS NULL
            RETURNING id::text AS id`,
          [userId, actor.userId],
        )
        for (const session of revokedSessions.rows) {
          await insertAuthAuditEvent(client, {
            actorUserId: actor.userId,
            actorKind: 'user',
            subjectUserId: userId,
            sessionId: session.id,
            eventType: 'session_revoked',
          })
        }
      }

      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: userId,
        sessionId: null,
        eventType: 'user_updated',
      })
      if (previous.role !== input.role) {
        await insertAuthAuditEvent(client, {
          actorUserId: actor.userId,
          actorKind: 'user',
          subjectUserId: userId,
          sessionId: null,
          eventType: 'role_changed',
        })
      }
      if (previous.is_active !== input.isActive) {
        await insertAuthAuditEvent(client, {
          actorUserId: actor.userId,
          actorKind: 'user',
          subjectUserId: userId,
          sessionId: null,
          eventType: input.isActive ? 'account_activated' : 'account_deactivated',
        })
      }
      return account
    })
  }
   async listPendingRegistrations(
    actor: AuthenticatedIdentity,
  ): Promise<Array<{
    id: string
    name: string
    email: string
    sector: string
    createdAt: Date
  }>> {
    assertAdministrator(actor)

    return withTransaction(this.poolProvider(), async (client) => {
      await lockActiveAdministrator(client, actor.userId)

      const result = await client.query<{
        id: string
        name: string
        email: string
        sector: string
        created_at: Date
      }>(
        `SELECT id::text AS id, name, email, sector, created_at
           FROM app_private.users
          WHERE account_status = 'pending'
          ORDER BY created_at ASC`,
      )

      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        sector: row.sector,
        createdAt: row.created_at,
      }))
    })
  }
    async decidePendingRegistration(
    actor: AuthenticatedIdentity,
    userId: string,
    decision: {
      action: 'approve'
      role: 'requester' | 'slm_operator'
    } | {
      action: 'reject'
    },
  ): Promise<{ id: string; status: 'approved' | 'rejected'; role: AuthRole }> {
    assertAdministrator(actor)

    if (!userId.trim()) {
      throw new Error('Identificador de usuário inválido.')
    }

    if (
      decision.action === 'approve' &&
      decision.role !== 'requester' &&
      decision.role !== 'slm_operator'
    ) {
      throw new Error('Perfil de aprovação inválido.')
    }

    return withTransaction(this.poolProvider(), async (client) => {
      await lockActiveAdministrator(client, actor.userId)

      const locked = await client.query<{
        id: string
        role: string
        account_status: string
      }>(
        `SELECT id::text AS id, role, account_status
           FROM app_private.users
          WHERE id = $1
          FOR UPDATE`,
        [userId],
      )

      const pending = locked.rows[0]

      if (!pending) {
        throw new Error('Solicitação não encontrada.')
      }

      if (pending.account_status !== 'pending') {
        throw new Error('Esta solicitação já foi decidida.')
      }

      if (decision.action === 'approve') {
        const updated = await client.query<{ id: string; role: string }>(
          `UPDATE app_private.users
              SET role = $2,
                  is_active = true,
                  account_status = 'approved',
                  decided_by_user_id = $3,
                  decided_at = now(),
                  updated_by_user_id = $3,
                  updated_at = now()
            WHERE id = $1
              AND account_status = 'pending'
          RETURNING id::text AS id, role`,
          [userId, decision.role, actor.userId],
        )

        if (updated.rowCount !== 1) {
          throw new Error('Não foi possível aprovar esta solicitação.')
        }

        await insertAuthAuditEvent(client, {
          actorUserId: actor.userId,
          actorKind: 'user',
          subjectUserId: userId,
          sessionId: null,
          eventType: 'registration_approved',
        })

        if (pending.role !== decision.role) {
          await insertAuthAuditEvent(client, {
            actorUserId: actor.userId,
            actorKind: 'user',
            subjectUserId: userId,
            sessionId: null,
            eventType: 'role_changed',
          })
        }

        return {
          id: updated.rows[0].id,
          status: 'approved',
          role: decision.role,
        }
      }

      const rejected = await client.query<{ id: string; role: string }>(
        `UPDATE app_private.users
            SET is_active = false,
                account_status = 'rejected',
                decided_by_user_id = $2,
                decided_at = now(),
                updated_by_user_id = $2,
                updated_at = now()
          WHERE id = $1
            AND account_status = 'pending'
        RETURNING id::text AS id, role`,
        [userId, actor.userId],
      )

      if (rejected.rowCount !== 1) {
        throw new Error('Não foi possível rejeitar esta solicitação.')
      }

      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: userId,
        sessionId: null,
        eventType: 'registration_rejected',
      })

      return {
        id: rejected.rows[0].id,
        status: 'rejected',
        role: pending.role as AuthRole,
      }
    })
  }
}