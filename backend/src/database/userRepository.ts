import type { Pool, PoolClient } from 'pg'
import { databaseRoleFor, isAuthRole } from '../auth/roles.js'
import type { AuthRole, AuthenticatedIdentity } from '../auth/roles.js'
import type { Permission } from '../auth/permissions.js'
import { normalizeLoginIdentifiers } from '../auth/identifiers.js'
import {
  AccessMigrationRequiredError,
  accessSql,
  isAccessSchemaMigrated,
  resolveAccess,
} from './accessSchema.js'
import type { AccessRow, ResolvedAccess } from './accessSchema.js'
import { accessHistoryActions, insertAuthAuditEvent } from './authAuditRepository.js'
import { getDatabasePool } from './pool.js'
import { DomainError, withTransaction } from './withTransaction.js'

export type CreatePendingUserInput = {
  name: string
  email: string
  sector: string
  passwordHash: string
}

export type UserAccessInput = {
  role: AuthRole
  slmMember: boolean
  grantedPermissions: readonly Permission[]
  deniedPermissions: readonly Permission[]
}

export type UserAccount = {
  id: string
  name: string
  email: string
  // O banco real identifica contas somente por e-mail.
  username: null
  role: AuthRole
  sector: string
  permissions: readonly Permission[]
  slmMember: boolean
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

export type ManagedUser = {
  id: string
  name: string
  email: string
  sector: string
  status: string
  role: AuthRole | null
  slmMember: boolean
  permissions: readonly Permission[]
  grantedPermissions: readonly Permission[]
  deniedPermissions: readonly Permission[]
  createdAt: Date
  updatedAt: Date
}

type UserRow = AccessRow & {
  id: string
  full_name: string
  email: string
  sector: string
  status: string
  created_at: Date
  updated_at: Date
}

function userColumns(sql: ReturnType<typeof accessSql>) {
  return `u.id::text AS id, u.full_name, u.email, u.sector, u.status,
          u.created_at, u.updated_at, ${sql.columns}`
}

const pageSize = 25
const manageableStatuses = ['approved', 'inactive', 'blocked']
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class AccountAuthorizationError extends DomainError {
  constructor(message = 'Ação administrativa não autorizada.') {
    super(message)
    this.name = 'AccountAuthorizationError'
  }
}

/** Regra de negócio com a resposta HTTP correspondente. */
export class UserManagementError extends DomainError {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message)
    this.name = 'UserManagementError'
  }
}

function normalizeName(name: unknown) {
  if (typeof name !== 'string') {
    throw new UserManagementError('Nome de usuário inválido.', 400)
  }
  const normalized = name.trim()
  if (normalized.length < 2 || normalized.length > 120) {
    throw new UserManagementError('Nome de usuário inválido.', 400)
  }
  return normalized
}

function normalizeSector(sector: unknown) {
  const normalized = typeof sector === 'string' ? sector.trim() : ''
  if (normalized.length < 2 || normalized.length > 120) {
    throw new UserManagementError('Setor inválido.', 400)
  }
  return normalized
}

function normalizeEmail(email: unknown) {
  try {
    const normalized = normalizeLoginIdentifiers({
      email: typeof email === 'string' ? email : null,
    }).email
    if (normalized) return normalized
  } catch {
    // Tratado abaixo, com a mesma mensagem.
  }
  throw new UserManagementError('E-mail inválido.', 400)
}

function assertPermission(actor: AuthenticatedIdentity, permission: Permission) {
  if (!actor?.userId?.trim() || !actor.permissions?.includes(permission)) {
    throw new AccountAuthorizationError()
  }
}

function assertUuid(value: string) {
  if (!uuidPattern.test(value)) {
    throw new UserManagementError('Identificador de usuário inválido.', 400)
  }
}

/**
 * Trava e confere quem está agindo, com os dados atuais do banco. A rota já
 * autorizou, mas o acesso pode ter mudado até a transação começar.
 */
async function lockActor(
  client: PoolClient,
  actorUserId: string,
  permission: Permission,
): Promise<ResolvedAccess> {
  const sql = accessSql(await isAccessSchemaMigrated(client))
  const result = await client.query<AccessRow>(
    `SELECT ${sql.columns}
       FROM public.auth_users u
       ${sql.join}
      WHERE u.id = $1
        AND u.status = 'approved'
      FOR UPDATE OF u`,
    [actorUserId],
  )
  const access = result.rows[0] ? resolveAccess(result.rows[0]) : null
  if (!access?.permissions.includes(permission)) {
    throw new AccountAuthorizationError()
  }
  return access
}

/**
 * Trava os administradores ativos sempre na mesma ordem, para que duas remoções
 * simultâneas não consigam, juntas, deixar o sistema sem administrador.
 */
async function lockActiveAdministrators(client: PoolClient) {
  const result = await client.query<{ id: string }>(
    `SELECT id::text AS id
       FROM public.auth_users
      WHERE role = 'admin'
        AND status = 'approved'
      ORDER BY id
      FOR UPDATE`,
  )
  return result.rows.map((row) => row.id)
}

async function lockTarget(client: PoolClient, userId: string) {
  const sql = accessSql(await isAccessSchemaMigrated(client))
  const result = await client.query<UserRow>(
    `SELECT ${userColumns(sql)}
       FROM public.auth_users u
       ${sql.join}
      WHERE u.id = $1
      FOR UPDATE OF u`,
    [userId],
  )
  const row = result.rows[0]
  if (!row) throw new UserManagementError('Usuário não encontrado.', 404)
  return row
}

function assertManageable(row: UserRow) {
  if (!manageableStatuses.includes(row.status)) {
    throw new UserManagementError(
      'Cadastros pendentes ou rejeitados são tratados em Cadastros pendentes.',
      409,
    )
  }
}

function assertLastAdministratorKept(
  activeAdministrators: readonly string[],
  targetId: string,
) {
  if (
    activeAdministrators.length <= 1 &&
    activeAdministrators.includes(targetId)
  ) {
    throw new UserManagementError(
      'Não é possível remover o último administrador ativo do sistema.',
      409,
    )
  }
}

function toUserAccount(row: UserRow): UserAccount {
  const access = resolveAccess(row)

  if (!access) {
    throw new Error('Papel de usuário persistido inválido.')
  }

  return {
    id: row.id,
    name: row.full_name,
    email: row.email,
    username: null,
    role: access.role,
    sector: row.sector,
    permissions: access.permissions,
    slmMember: access.slmMember,
    isActive: row.status === 'approved',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// Nunca inclui o hash da senha. Cadastros pendentes ainda não têm perfil.
function toManagedUser(row: UserRow): ManagedUser {
  const access = resolveAccess(row)

  return {
    id: row.id,
    name: row.full_name,
    email: row.email,
    sector: row.sector,
    status: row.status,
    role: access?.role ?? null,
    slmMember: access?.slmMember ?? false,
    permissions: access?.permissions ?? [],
    grantedPermissions: access?.grantedPermissions ?? [],
    deniedPermissions: access?.deniedPermissions ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function difference<T>(from: readonly T[], without: readonly T[]) {
  return from.filter((item) => !without.includes(item))
}

type AuditRow = {
  id: string
  occurred_at: Date
  action: string
  result: string
  actor_name: string | null
  target_name: string | null
  details: Record<string, unknown>
}

const auditSelect = `SELECT e.id::text AS id, e.occurred_at, e.action, e.result,
                            actor.full_name AS actor_name,
                            target.full_name AS target_name,
                            e.details
                       FROM public.auth_audit_events e
                       LEFT JOIN public.auth_users actor ON actor.id = e.actor_user_id
                       LEFT JOIN public.auth_users target ON target.id = e.target_user_id`

// IP e impressão digital do e-mail servem à investigação e não são exibidos.
function toAuditEntry(row: AuditRow) {
  const { ip: _ip, identifier: _identifier, ...details } = row.details ?? {}

  return {
    id: row.id,
    occurredAt: row.occurred_at,
    action: row.action,
    result: row.result,
    actorName: row.actor_name,
    targetName: row.target_name,
    details,
  }
}

export class UserRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async findActiveById(id: string): Promise<UserAccount | null> {
    const pool = this.poolProvider()
    const sql = accessSql(await isAccessSchemaMigrated(pool))
    const result = await pool.query<UserRow>(
      `SELECT ${userColumns(sql)}
         FROM public.auth_users u
         ${sql.join}
        WHERE u.id = $1
          AND u.status = 'approved'
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

    const pool = this.poolProvider()
    const sql = accessSql(await isAccessSchemaMigrated(pool))
    const result = await pool.query<UserRow & { password_hash: string }>(
      `SELECT ${userColumns(sql)}, u.password_hash
         FROM public.auth_users u
         ${sql.join}
        WHERE lower(u.email) = $1
          AND u.status = 'approved'
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

  /**
   * Registra uma solicitação de acesso. Um e-mail rejeitado pode pedir de novo:
   * a mesma conta volta a ficar pendente, sem senha ou perfil anteriores, e o
   * histórico da rejeição continua nos eventos de auditoria dessa conta.
   */
  async createPendingUser(
    input: CreatePendingUserInput,
  ): Promise<{ id: string; outcome: 'created' | 'resubmitted' | 'duplicate' }> {
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
      const existing = await client.query<{
        id: string
        status: string
        decided_by: string | null
        decided_at: Date | null
      }>(
        `SELECT id::text AS id, status, decided_by::text AS decided_by, decided_at
           FROM public.auth_users
          WHERE lower(email) = $1
          LIMIT 1
          FOR UPDATE`,
        [email],
      )
      const current = existing.rows[0]

      if (!current) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO public.auth_users
            (full_name, email, password_hash, status, sector)
           VALUES ($1, $2, $3, 'pending', $4)
           RETURNING id::text AS id`,
          [name, email, input.passwordHash, sector],
        )
        const { id } = inserted.rows[0]

        await insertAuthAuditEvent(client, {
          actorUserId: null,
          actorKind: 'system',
          subjectUserId: id,
          sessionId: null,
          eventType: 'registration_submitted',
        })

        return { id, outcome: 'created' }
      }

      if (current.status !== 'rejected') {
        await insertAuthAuditEvent(client, {
          actorUserId: null,
          actorKind: 'system',
          subjectUserId: current.id,
          sessionId: null,
          eventType: 'registration_duplicate',
          result: 'denied',
        })

        return { id: current.id, outcome: 'duplicate' }
      }

      await client.query(
        `UPDATE public.auth_users
            SET full_name = $2,
                password_hash = $3,
                sector = $4,
                status = 'pending',
                role = NULL,
                permissions = '{}',
                decided_by = NULL,
                decided_at = NULL,
                updated_at = now()
          WHERE id = $1`,
        [current.id, name, input.passwordHash, sector],
      )

      await insertAuthAuditEvent(client, {
        actorUserId: null,
        actorKind: 'system',
        subjectUserId: current.id,
        sessionId: null,
        eventType: 'registration_resubmitted',
        details: {
          ...(current.decided_by ? { previousDecidedBy: current.decided_by } : {}),
          ...(current.decided_at
            ? { previousDecidedAt: current.decided_at.toISOString() }
            : {}),
        },
      })

      return { id: current.id, outcome: 'resubmitted' }
    })
  }

  async listUsers(
    actor: AuthenticatedIdentity,
    filters: {
      search?: string
      role?: AuthRole
      status?: string
      slmMember?: boolean
      page?: number
    },
  ): Promise<{ users: ManagedUser[]; total: number; page: number; pageSize: number }> {
    assertPermission(actor, 'users:read')

    const pool = this.poolProvider()
    const sql = accessSql(await isAccessSchemaMigrated(pool))
    const conditions: string[] = []
    const values: unknown[] = []
    const bind = (value: unknown) => `$${values.push(value)}`

    if (filters.search) {
      // Os curingas digitados são tratados como texto comum.
      const term = `%${filters.search.replace(/[\\%_]/g, '\\$&')}%`
      const placeholder = bind(term)
      conditions.push(
        `(u.full_name ILIKE ${placeholder} OR u.email ILIKE ${placeholder})`,
      )
    }
    conditions.push(
      filters.status
        ? `u.status = ${bind(filters.status)}`
        : `u.status = ANY(${bind(manageableStatuses)})`,
    )
    if (filters.role) conditions.push(`${sql.profile} = ${bind(filters.role)}`)
    if (filters.slmMember !== undefined) {
      conditions.push(`${sql.slmMember} = ${bind(filters.slmMember)}`)
    }

    const where = conditions.join(' AND ')
    const page = Math.max(1, Math.floor(filters.page ?? 1))
    const total = await pool.query<{ total: number }>(
      `SELECT count(*)::int AS total
         FROM public.auth_users u
         ${sql.join}
        WHERE ${where}`,
      values,
    )
    const rows = await pool.query<UserRow>(
      `SELECT ${userColumns(sql)}
         FROM public.auth_users u
         ${sql.join}
        WHERE ${where}
        ORDER BY lower(u.full_name), u.id
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      values,
    )

    return {
      users: rows.rows.map(toManagedUser),
      total: total.rows[0]?.total ?? 0,
      page,
      pageSize,
    }
  }

  async getUser(actor: AuthenticatedIdentity, userId: string): Promise<ManagedUser> {
    assertPermission(actor, 'users:read')
    assertUuid(userId)

    const pool = this.poolProvider()
    const sql = accessSql(await isAccessSchemaMigrated(pool))
    const result = await pool.query<UserRow>(
      `SELECT ${userColumns(sql)}
         FROM public.auth_users u
         ${sql.join}
        WHERE u.id = $1`,
      [userId],
    )
    if (!result.rows[0]) {
      throw new UserManagementError('Usuário não encontrado.', 404)
    }
    return toManagedUser(result.rows[0])
  }

  /** Dados cadastrais. Não altera perfil, permissões nem situação. */
  async updateUserData(
    actor: AuthenticatedIdentity,
    userId: string,
    input: { name: unknown; email: unknown; sector: unknown },
  ): Promise<ManagedUser> {
    assertPermission(actor, 'users:manage')
    assertUuid(userId)
    const name = normalizeName(input.name)
    const email = normalizeEmail(input.email)
    const sector = normalizeSector(input.sector)

    return withTransaction(this.poolProvider(), async (client) => {
      const actorAccess = await lockActor(client, actor.userId, 'users:manage')
      const target = await lockTarget(client, userId)
      assertManageable(target)

      if (
        resolveAccess(target)?.role === 'administrator' &&
        actorAccess.role !== 'administrator'
      ) {
        throw new AccountAuthorizationError()
      }

      // O e-mail recebe o código de recuperação de senha: trocá-lo permitiria tomar a
      // conta de outra pessoa, com permissões maiores. Só um administrador pode.
      if (
        target.email.toLowerCase() !== email &&
        actorAccess.role !== 'administrator'
      ) {
        throw new AccountAuthorizationError(
          'Somente um administrador pode alterar o e-mail de uma conta.',
        )
      }

      const changedFields = [
        ...(target.full_name !== name ? ['name'] : []),
        ...(target.email.toLowerCase() !== email ? ['email'] : []),
        ...(target.sector !== sector ? ['sector'] : []),
      ]

      await client.query(
        `UPDATE public.auth_users
            SET full_name = $2, email = $3, sector = $4, updated_at = now()
          WHERE id = $1`,
        [userId, name, email, sector],
      )

      if (changedFields.length > 0) {
        // Registra quais campos mudaram, sem copiar dados pessoais para a auditoria.
        await insertAuthAuditEvent(client, {
          actorUserId: actor.userId,
          actorKind: 'user',
          subjectUserId: userId,
          sessionId: null,
          eventType: 'user_updated',
          details: { fields: changedFields },
        })
      }

      return toManagedUser({
        ...target,
        full_name: name,
        email,
        sector,
      })
    })
  }

  /**
   * Perfil, equipe SLM e permissões individuais: só um administrador altera, e
   * nunca o próprio acesso. O CPF só é concedido se vier na lista, de forma
   * explícita, e a mudança de perfil não o concede nem o retira.
   */
  async updateUserAccess(
    actor: AuthenticatedIdentity,
    userId: string,
    input: UserAccessInput,
  ): Promise<ManagedUser> {
    assertPermission(actor, 'users:manage')
    assertUuid(userId)

    if (actor.userId === userId) {
      throw new AccountAuthorizationError(
        'Você não pode alterar o próprio perfil ou as próprias permissões.',
      )
    }
    if (actor.role !== 'administrator') {
      throw new AccountAuthorizationError()
    }
    if (
      input.grantedPermissions.some((permission) =>
        input.deniedPermissions.includes(permission),
      )
    ) {
      throw new UserManagementError(
        'A mesma permissão não pode ser concedida e retirada.',
        400,
      )
    }
    if (input.role === 'slm_operator' && !input.slmMember) {
      throw new UserManagementError(
        'O perfil Operador SLM exige que o usuário integre a equipe SLM.',
        400,
      )
    }
    if (
      input.role === 'administrator' &&
      input.deniedPermissions.some((permission) =>
        permission === 'users:manage' || permission === 'users:read',
      )
    ) {
      throw new UserManagementError(
        'Um administrador não pode perder o gerenciamento de usuários.',
        400,
      )
    }

    return withTransaction(this.poolProvider(), async (client) => {
      if (!(await isAccessSchemaMigrated(client))) {
        throw new AccessMigrationRequiredError()
      }

      const activeAdministrators = await lockActiveAdministrators(client)
      const actorAccess = await lockActor(client, actor.userId, 'users:manage')
      if (actorAccess.role !== 'administrator') {
        throw new AccountAuthorizationError()
      }

      const target = await lockTarget(client, userId)
      assertManageable(target)
      const previous = resolveAccess(target)
      if (!previous) {
        throw new UserManagementError('Usuário sem perfil definido.', 409)
      }

      if (previous.role === 'administrator' && input.role !== 'administrator') {
        assertLastAdministratorKept(activeAdministrators, userId)
      }

      const legacy = databaseRoleFor(input.role)
      await client.query(
        `INSERT INTO public.auth_user_access
          (user_id, profile, slm_member, granted_permissions, denied_permissions,
           updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (user_id) DO UPDATE
           SET profile = EXCLUDED.profile,
               slm_member = EXCLUDED.slm_member,
               granted_permissions = EXCLUDED.granted_permissions,
               denied_permissions = EXCLUDED.denied_permissions,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
        [
          userId,
          input.role,
          input.slmMember,
          input.grantedPermissions,
          input.deniedPermissions,
          actor.userId,
        ],
      )
      // As colunas antigas continuam coerentes, caso a migração precise ser desfeita.
      await client.query(
        `UPDATE public.auth_users
            SET role = $2, permissions = $3, updated_at = now()
          WHERE id = $1`,
        [userId, legacy.role, legacy.permissions],
      )

      const audit = (
        eventType: Parameters<typeof insertAuthAuditEvent>[1]['eventType'],
        details?: Record<string, string | readonly string[]>,
      ) =>
        insertAuthAuditEvent(client, {
          actorUserId: actor.userId,
          actorKind: 'user',
          subjectUserId: userId,
          sessionId: null,
          eventType,
          details,
        })

      if (previous.role !== input.role) {
        await audit('role_changed', { from: previous.role, to: input.role })
      }
      if (previous.slmMember !== input.slmMember) {
        await audit(input.slmMember ? 'slm_member_added' : 'slm_member_removed')
      }

      const grantedAdded = difference(input.grantedPermissions, previous.grantedPermissions)
      const grantedRemoved = difference(previous.grantedPermissions, input.grantedPermissions)
      const deniedAdded = difference(input.deniedPermissions, previous.deniedPermissions)
      const deniedRemoved = difference(previous.deniedPermissions, input.deniedPermissions)

      if (
        grantedAdded.length + grantedRemoved.length +
        deniedAdded.length + deniedRemoved.length > 0
      ) {
        await audit('permissions_changed', {
          grantedAdded,
          grantedRemoved,
          deniedAdded,
          deniedRemoved,
        })
      }

      const couldReadCpf = previous.permissions.includes('flights:cpf:read')
      const canReadCpf =
        input.grantedPermissions.includes('flights:cpf:read') &&
        !input.deniedPermissions.includes('flights:cpf:read')
      if (couldReadCpf !== canReadCpf) {
        await audit(canReadCpf ? 'cpf_access_granted' : 'cpf_access_revoked')
      }

      return toManagedUser({
        ...target,
        role: legacy.role,
        permissions: legacy.permissions,
        access_profile: input.role,
        access_slm_member: input.slmMember,
        access_granted: [...input.grantedPermissions],
        access_denied: [...input.deniedPermissions],
      })
    })
  }

  async setUserActive(
    actor: AuthenticatedIdentity,
    userId: string,
    isActive: boolean,
  ): Promise<ManagedUser> {
    assertPermission(actor, 'users:manage')
    assertUuid(userId)

    if (actor.userId === userId) {
      throw new AccountAuthorizationError(
        'Você não pode ativar ou desativar a própria conta.',
      )
    }

    return withTransaction(this.poolProvider(), async (client) => {
      const activeAdministrators = await lockActiveAdministrators(client)
      const actorAccess = await lockActor(client, actor.userId, 'users:manage')
      const target = await lockTarget(client, userId)
      assertManageable(target)

      const targetAccess = resolveAccess(target)
      if (
        targetAccess?.role === 'administrator' &&
        actorAccess.role !== 'administrator'
      ) {
        throw new AccountAuthorizationError()
      }
      if (!isActive) assertLastAdministratorKept(activeAdministrators, userId)

      const nextStatus = isActive ? 'approved' : 'inactive'
      const wasActive = target.status === 'approved'

      if (wasActive !== isActive) {
        await client.query(
          `UPDATE public.auth_users
              SET status = $2, updated_at = now()
            WHERE id = $1`,
          [userId, nextStatus],
        )

        await insertAuthAuditEvent(client, {
          actorUserId: actor.userId,
          actorKind: 'user',
          subjectUserId: userId,
          sessionId: null,
          eventType: isActive ? 'account_activated' : 'account_deactivated',
        })
      }

      // Sessões abertas não continuam valendo depois da desativação.
      if (!isActive) {
        const revoked = await client.query<{ id: string }>(
          `DELETE FROM public.auth_sessions
            WHERE user_id = $1
            RETURNING id::text AS id`,
          [userId],
        )
        for (const session of revoked.rows) {
          await insertAuthAuditEvent(client, {
            actorUserId: actor.userId,
            actorKind: 'user',
            subjectUserId: userId,
            sessionId: session.id,
            eventType: 'session_revoked',
            details: { reason: 'account_deactivated' },
          })
        }
      }

      return toManagedUser({ ...target, status: nextStatus })
    })
  }

  async getPermissionHistory(actor: AuthenticatedIdentity, userId: string) {
    assertPermission(actor, 'users:read')
    assertUuid(userId)

    const result = await this.poolProvider().query<AuditRow>(
      `${auditSelect}
        WHERE e.target_user_id = $1
          AND e.action = ANY($2)
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT 100`,
      [userId, accessHistoryActions],
    )
    return result.rows.map(toAuditEntry)
  }

  async listAuditEvents(actor: AuthenticatedIdentity, filters: { page?: number }) {
    assertPermission(actor, 'audit:read')

    const page = Math.max(1, Math.floor(filters.page ?? 1))
    const result = await this.poolProvider().query<AuditRow>(
      `${auditSelect}
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT ${pageSize + 1} OFFSET ${(page - 1) * pageSize}`,
    )
    return {
      events: result.rows.slice(0, pageSize).map(toAuditEntry),
      page,
      hasMore: result.rows.length > pageSize,
    }
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
    assertPermission(actor, 'users:approve')

    return withTransaction(this.poolProvider(), async (client) => {
      await lockActor(client, actor.userId, 'users:approve')

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
      role: AuthRole
    } | {
      action: 'reject'
    },
  ): Promise<{ id: string; status: 'approved' | 'rejected'; role: AuthRole | null }> {
    assertPermission(actor, 'users:approve')

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      throw new DomainError('Identificador de usuário inválido.')
    }

    if (decision.action === 'approve' && !isAuthRole(decision.role)) {
      throw new DomainError('Perfil de aprovação inválido.')
    }

    // Quem só tem users:approve aprova solicitantes: perfis superiores exigiriam
    // conceder um acesso maior do que o de quem aprova.
    if (
      decision.action === 'approve' &&
      decision.role !== 'requester' &&
      actor.role !== 'administrator'
    ) {
      throw new AccountAuthorizationError()
    }

    return withTransaction(this.poolProvider(), async (client) => {
      const actorAccess = await lockActor(client, actor.userId, 'users:approve')
      if (
        decision.action === 'approve' &&
        decision.role !== 'requester' &&
        actorAccess.role !== 'administrator'
      ) {
        throw new AccountAuthorizationError()
      }

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

        if (await isAccessSchemaMigrated(client)) {
          await client.query(
            `INSERT INTO public.auth_user_access
              (user_id, profile, slm_member, updated_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id) DO UPDATE
               SET profile = EXCLUDED.profile,
                   slm_member = EXCLUDED.slm_member,
                   granted_permissions = '{}',
                   denied_permissions = '{}',
                   updated_by = EXCLUDED.updated_by,
                   updated_at = now()`,
            [userId, decision.role, decision.role === 'slm_operator', actor.userId],
          )
        }

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
