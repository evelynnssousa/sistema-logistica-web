import type { Pool, PoolClient } from 'pg'
import { isAuthRole } from '../auth/roles.js'
import type { AuthRole, AuthenticatedIdentity } from '../auth/roles.js'
import { normalizeLoginIdentifiers } from '../auth/identifiers.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'

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
  if (!isAuthRole(row.role)) {
    throw new Error('Papel de usuário persistido inválido.')
  }
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    username: row.username,
    role: row.role,
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
        `SELECT id::text AS id, role, is_active
           FROM app_private.users
          WHERE id = $1
          FOR UPDATE`,
        [userId],
      )
      const previous = locked.rows[0]
      if (!previous) throw new Error('Conta não encontrada.')
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
}