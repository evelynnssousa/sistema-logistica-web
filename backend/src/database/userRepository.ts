import type { Pool, PoolClient } from 'pg'
import {
  databaseRoleFor,
  isAuthRole,
  resolveDatabaseAuthRole,
} from '../auth/roles.js'
import type { AuthRole, AuthenticatedIdentity } from '../auth/roles.js'
import { normalizeLoginIdentifiers } from '../auth/identifiers.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { getDatabasePool } from './pool.js'
import { DomainError, withTransaction } from './withTransaction.js'

export type CreatePendingUserInput = {
  name: string
  email: string
  sector: string
  passwordHash: string
}

export type CreateUserInput = {
  name: string
  email: string
  sector: string
  passwordHash: string
  role: AuthRole
}

export type UpdateUserInput = {
  name: string
  email: string
  role: AuthRole
  isActive: boolean
}

export type UserAccount = {
  id: string
  name: string
  email: string
  // O banco real identifica contas somente por e-mail.
  username: null
  role: AuthRole
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

type UserRow = {
  id: string
  full_name: string
  email: string
  role: string | null
  permissions: string[]
  status: string
  created_at: Date
  updated_at: Date
}

const userColumns = `id::text AS id, full_name, email, role, permissions, status,
                     created_at, updated_at`

export class AccountAuthorizationError extends DomainError {
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
  if (normalized.length < 2 || normalized.length > 120) {
    throw new Error('Nome de usuário inválido.')
  }
  return normalized
}

function normalizeSector(sector: unknown) {
  const normalized = typeof sector === 'string' ? sector.trim() : ''
  if (normalized.length < 2 || normalized.length > 120) {
    throw new Error('Setor inválido.')
  }
  return normalized
}

function normalizeEmail(email: unknown) {
  const normalized = normalizeLoginIdentifiers({
    email: typeof email === 'string' ? email : null,
  }).email
  if (!normalized) throw new Error('E-mail inválido.')
  return normalized
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
       FROM public.auth_users
      WHERE id = $1
        AND role = 'admin'
        AND status = 'approved'
      FOR UPDATE`,
    [actorUserId],
  )
  if (result.rowCount !== 1) throw new AccountAuthorizationError()
}

function toUserAccount(row: UserRow): UserAccount {
  const role = resolveDatabaseAuthRole(row.role, row.permissions)

  if (!role) {
    throw new Error('Papel de usuário persistido inválido.')
  }

  return {
    id: row.id,
    name: row.full_name,
    email: row.email,
    username: null,
    role,
    isActive: row.status === 'approved',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class UserRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async findActiveById(id: string): Promise<UserAccount | null> {
    const result = await this.poolProvider().query<UserRow>(
      `SELECT ${userColumns}
         FROM public.auth_users
        WHERE id = $1
          AND status = 'approved'
        LIMIT 1`,
      [id],
    )

    return result.rows[0] ? toUserAccount(result.rows[0]) : null
  }

  async findActiveForAuthentication(
    identifier: string,
  ): Promise<(UserAccount & { passwordHash: string }) | null> {
    const email = identifier.trim().toLowerCase()
    if (!email.includes('@')) return null

    const result = await this.poolProvider().query<
      UserRow & { password_hash: string }
    >(
      `SELECT ${userColumns}, password_hash
         FROM public.auth_users
        WHERE lower(email) = $1
          AND status = 'approved'
        LIMIT 1`,
      [email],
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
    const email = normalizeEmail(input.email)
    const sector = normalizeSector(input.sector)

    if (
      typeof input.passwordHash !== 'string' ||
      !input.passwordHash.startsWith('$argon2id$')
    ) {
      throw new Error('Dados de cadastro inválidos.')
    }

    return withTransaction(this.poolProvider(), async (client) => {
      const result = await client.query<{
        id: string
        full_name: string
        email: string
        sector: string
        created_at: Date
      }>(
        `INSERT INTO public.auth_users
          (full_name, email, password_hash, status, sector)
         VALUES ($1, $2, $3, 'pending', $4)
         RETURNING id::text AS id, full_name, email, sector, created_at`,
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
        name: account.full_name,
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
    const email = normalizeEmail(input.email)
    const sector = normalizeSector(input.sector)
    if (
      typeof input.passwordHash !== 'string' ||
      !input.passwordHash.startsWith('$argon2id$') ||
      !isAuthRole(input.role)
    ) {
      throw new Error('Dados de conta inválidos.')
    }
    const databaseRole = databaseRoleFor(input.role)

    return withTransaction(this.poolProvider(), async (client) => {
      await lockActiveAdministrator(client, actor.userId)
      const result = await client.query<UserRow>(
        `INSERT INTO public.auth_users
          (full_name, email, sector, password_hash, status, role, permissions,
           decided_by, decided_at)
         VALUES ($1, $2, $3, $4, 'approved', $5, $6, $7, now())
         RETURNING ${userColumns}`,
        [
          name,
          email,
          sector,
          input.passwordHash,
          databaseRole.role,
          databaseRole.permissions,
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
        details: { role: account.role },
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
    const email = normalizeEmail(input.email)
    if (!isAuthRole(input.role) || typeof input.isActive !== 'boolean') {
      throw new Error('Dados de conta inválidos.')
    }
    const databaseRole = databaseRoleFor(input.role)

    return withTransaction(this.poolProvider(), async (client) => {
      await lockActiveAdministrator(client, actor.userId)
      const locked = await client.query<UserRow>(
        `SELECT ${userColumns}
           FROM public.auth_users
          WHERE id = $1
          FOR UPDATE`,
        [userId],
      )
      const previous = locked.rows[0]
      if (!previous) throw new DomainError('Conta não encontrada.')
      if (previous.status === 'pending' || previous.status === 'rejected') {
        throw new DomainError(
          'Cadastros pendentes só podem ser alterados pela aprovação ou rejeição administrativa.',
        )
      }
      // Um administrador não remove o próprio acesso. Como quem altera precisa ser
      // administrador ativo, isso também garante que sempre reste ao menos um.
      if (
        previous.id === actor.userId &&
        (input.role !== 'administrator' || !input.isActive)
      ) {
        throw new AccountAuthorizationError()
      }

      const wasActive = previous.status === 'approved'
      const previousRole = resolveDatabaseAuthRole(
        previous.role,
        previous.permissions,
      )

      const result = await client.query<UserRow>(
        `UPDATE public.auth_users
            SET full_name = $2,
                email = $3,
                role = $4,
                permissions = $5,
                status = $6,
                updated_at = now()
          WHERE id = $1
          RETURNING ${userColumns}`,
        [
          userId,
          name,
          email,
          databaseRole.role,
          databaseRole.permissions,
          input.isActive ? 'approved' : 'inactive',
        ],
      )
      const account = toUserAccount(result.rows[0])

      if (wasActive && !input.isActive) {
        const revokedSessions = await client.query<{ id: string }>(
          `DELETE FROM public.auth_sessions
            WHERE user_id = $1
            RETURNING id::text AS id`,
          [userId],
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
      if (previousRole !== input.role) {
        await insertAuthAuditEvent(client, {
          actorUserId: actor.userId,
          actorKind: 'user',
          subjectUserId: userId,
          sessionId: null,
          eventType: 'role_changed',
          details: { role: input.role },
        })
      }
      if (wasActive !== input.isActive) {
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
        full_name: string
        email: string
        sector: string
        created_at: Date
      }>(
        `SELECT id::text AS id, full_name, email, sector, created_at
           FROM public.auth_users
          WHERE status = 'pending'
          ORDER BY created_at ASC`,
      )

      return result.rows.map((row) => ({
        id: row.id,
        name: row.full_name,
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
  ): Promise<{ id: string; status: 'approved' | 'rejected'; role: AuthRole | null }> {
    assertAdministrator(actor)

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      throw new DomainError('Identificador de usuário inválido.')
    }

    if (
      decision.action === 'approve' &&
      decision.role !== 'requester' &&
      decision.role !== 'slm_operator'
    ) {
      throw new DomainError('Perfil de aprovação inválido.')
    }

    return withTransaction(this.poolProvider(), async (client) => {
      await lockActiveAdministrator(client, actor.userId)

      const locked = await client.query<{ id: string; status: string }>(
        `SELECT id::text AS id, status
           FROM public.auth_users
          WHERE id = $1
          FOR UPDATE`,
        [userId],
      )

      const pending = locked.rows[0]

      if (!pending) {
        throw new DomainError('Solicitação não encontrada.')
      }

      if (pending.status !== 'pending') {
        throw new DomainError('Esta solicitação já foi decidida.')
      }

      if (decision.action === 'approve') {
        const databaseRole = databaseRoleFor(decision.role)

        await client.query(
          `UPDATE public.auth_users
              SET status = 'approved',
                  role = $2,
                  permissions = $3,
                  decided_by = $4,
                  decided_at = now(),
                  updated_at = now()
            WHERE id = $1`,
          [userId, databaseRole.role, databaseRole.permissions, actor.userId],
        )

        await insertAuthAuditEvent(client, {
          actorUserId: actor.userId,
          actorKind: 'user',
          subjectUserId: userId,
          sessionId: null,
          eventType: 'registration_approved',
          details: { role: decision.role },
        })

        return { id: userId, status: 'approved', role: decision.role }
      }

      await client.query(
        `UPDATE public.auth_users
            SET status = 'rejected',
                role = NULL,
                permissions = '{}',
                decided_by = $2,
                decided_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [userId, actor.userId],
      )

      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: userId,
        sessionId: null,
        eventType: 'registration_rejected',
      })

      return { id: userId, status: 'rejected', role: null }
    })
  }
}
