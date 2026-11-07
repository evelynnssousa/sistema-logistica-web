import type { Pool, PoolClient } from 'pg'
import { databaseRoleFor, isAuthRole } from '../auth/roles.js'
import type { AuthRole, AuthenticatedIdentity } from '../auth/roles.js'
import {
  computeEffectivePermissions,
  holdsPermission,
  isEligibleForRestrictedPermission,
  isEssentialAdministratorPermission,
  isRestrictedPermission,
} from '../auth/permissions.js'
import type { Permission } from '../auth/permissions.js'
import { normalizeLoginIdentifiers } from '../auth/identifiers.js'
import {
  AccessMigrationRequiredError,
  accessSql,
  isAccessSchemaMigrated,
  resolveAccess,
} from './accessSchema.js'
import type { AccessRow, ResolvedAccess } from './accessSchema.js'
import { accessHistoryActions, insertAuthAuditEvent, recordAuthAuditEvent } from './authAuditRepository.js'
import { applyInstitutionalLinks } from './institutionalLinkRepository.js'
import type { InstitutionalInput } from './institutionalLinkRepository.js'
import { getDatabasePool } from './pool.js'
import { DomainError, withTransaction } from './withTransaction.js'

export type CreatePendingUserInput = {
  name: string
  email: string
  sector: string
  passwordHash: string
  /** Campos próprios do formulário de conta, com a versão e os nomes usados. */
  registrationForm?: { version: number; values: Record<string, string>; labels: Record<string, string> } | null
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
  // Permissões especiais retiradas pelo servidor nesta operação.
  revokedPermissions?: readonly Permission[]
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

/** O perfil Motorista é exclusivo: sem equipe SLM, concessões ou retiradas individuais. */
function assertDriverProfileRules(
  role: AuthRole,
  slmMember: boolean,
  granted: readonly Permission[],
  denied: readonly Permission[],
) {
  if (role !== 'driver') return
  if (slmMember) throw new UserManagementError('O perfil Motorista não pode integrar a equipe SLM.', 400)
  if (granted.length > 0 || denied.length > 0) {
    throw new UserManagementError('O perfil Motorista não aceita permissões individuais.', 400)
  }
}

/** Sem a migração 016, o banco recusaria o perfil: a mensagem aqui diz o motivo. */
async function assertDriverSchema(client: PoolClient) {
  const found = await client.query<{ present: boolean }>(`SELECT to_regclass('public.fleet_drivers') IS NOT NULL AS present`)
  if (!found.rows[0]?.present) throw new AccessMigrationRequiredError()
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

/**
 * Único ponto de gravação do acesso. Mantém auth_user_access e as colunas de
 * auth_users coerentes; os gatilhos da migração 003 recusam qualquer divergência.
 */
async function persistUserAccess(
  client: PoolClient,
  access: {
    userId: string
    role: AuthRole
    slmMember: boolean
    grantedPermissions: readonly Permission[]
    deniedPermissions: readonly Permission[]
    updatedBy: string
  },
) {
  const legacy = databaseRoleFor(access.role)

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
      access.userId,
      access.role,
      access.slmMember,
      access.grantedPermissions,
      access.deniedPermissions,
      access.updatedBy,
    ],
  )
  await client.query(
    `UPDATE public.auth_users
        SET role = $2, permissions = $3, updated_at = now()
      WHERE id = $1`,
    [access.userId, legacy.role, legacy.permissions],
  )

  return legacy
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

/** Ações de auditoria que revelam informações internas do estoque. */
export const stockAuditActions = [
  'warehouse.stock_movement',
  'warehouse.reserve_changed',
  'warehouse.control_recorded',
  'warehouse.inventory_created',
  'warehouse.inventory_item_updated',
  'warehouse.inventory_closed',
]

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

/** Só havendo formulário publicado, o que já pressupõe a migração 012. */
async function saveRegistrationForm(
  client: Pick<PoolClient, 'query'>,
  id: string,
  form: CreatePendingUserInput['registrationForm'],
) {
  if (!form) return
  await client.query(
    `UPDATE public.auth_users SET dados_cadastrais = $2::jsonb, formulario_versao = $3 WHERE id = $1`,
    [id, JSON.stringify({ valores: form.values, nomes: form.labels }), form.version],
  )
}

export class UserRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  /**
   * A concessão recusada fica na auditoria, fora da transação que será desfeita: quem tentou,
   * para quem, o perfil e as permissões recusadas. Uma falha ao auditar não muda a resposta.
   */
  private async auditRefusedGrant(
    actor: AuthenticatedIdentity,
    userId: string,
    role: AuthRole,
    refused: readonly Permission[],
  ) {
    await recordAuthAuditEvent(
      {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: userId,
        sessionId: null,
        eventType: 'sensitive_operation_denied',
        result: 'denied',
        details: { operation: 'user.permission_grant', role, refused },
      },
      this.poolProvider,
    )
  }

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
        await saveRegistrationForm(client, id, input.registrationForm)

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
      await saveRegistrationForm(client, current.id, input.registrationForm)

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
   * nunca o próprio acesso. Permissões especiais só são concedidas de forma explícita
   * a quem é elegível, e o servidor as retira de quem deixa de ser.
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
    if (input.role === 'requester' && input.slmMember) {
      throw new UserManagementError(
        'O perfil Solicitante não pode integrar a equipe SLM.',
        400,
      )
    }
    assertDriverProfileRules(input.role, input.slmMember, input.grantedPermissions, input.deniedPermissions)
    if (
      input.role === 'administrator' &&
      input.deniedPermissions.some(isEssentialAdministratorPermission)
    ) {
      throw new UserManagementError(
        'Um administrador não pode perder as permissões essenciais.',
        400,
      )
    }

    // A recusa é auditada depois que a transação é desfeita: dentro dela, a conta-alvo está
    // bloqueada e a gravação da auditoria, por outra conexão, esperaria por ela.
    let refusedForAudit: Permission[] = []
    try {
      return await this.applyUserAccess(actor, userId, input, (refused) => {
        refusedForAudit = refused
      })
    } catch (error) {
      if (refusedForAudit.length > 0) await this.auditRefusedGrant(actor, userId, input.role, refusedForAudit)
      throw error
    }
  }

  private async applyUserAccess(
    actor: AuthenticatedIdentity,
    userId: string,
    input: UserAccessInput,
    onRefused: (refused: Permission[]) => void,
  ): Promise<ManagedUser> {
    return withTransaction(this.poolProvider(), async (client) => {
      if (!(await isAccessSchemaMigrated(client))) {
        throw new AccessMigrationRequiredError()
      }
      if (input.role === 'driver') await assertDriverSchema(client)

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

      // Nova concessão incompatível é recusada; a que já existia é retirada pelo servidor,
      // mesmo que o navegador a reenvie.
      const ineligible = (permission: Permission) =>
        isRestrictedPermission(permission) &&
        !isEligibleForRestrictedPermission(permission, input.role, input.slmMember)
      const revokedPermissions = input.grantedPermissions.filter(
        (permission) =>
          ineligible(permission) && previous.grantedPermissions.includes(permission),
      )
      const refusedGrants = input.grantedPermissions.filter(
        (permission) => ineligible(permission) && !revokedPermissions.includes(permission),
      )
      if (refusedGrants.length > 0) {
        onRefused(refusedGrants)
        throw new UserManagementError(
          'Esta concessão exige um perfil elegível e, para Operador SLM, a equipe SLM.',
          400,
        )
      }
      const grantedPermissions = input.grantedPermissions.filter(
        (permission) => !revokedPermissions.includes(permission),
      )
      const revocationReason = previous.slmMember && !input.slmMember
        ? 'slm_removed'
        : previous.role !== input.role
          ? 'profile_changed'
          : 'ineligible'

      const legacy = await persistUserAccess(client, {
        userId,
        role: input.role,
        slmMember: input.slmMember,
        grantedPermissions,
        deniedPermissions: input.deniedPermissions,
        updatedBy: actor.userId,
      })

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

      const grantedAdded = difference(grantedPermissions, previous.grantedPermissions)
      const grantedRemoved = difference(previous.grantedPermissions, grantedPermissions)
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
          ...(revokedPermissions.length > 0
            ? { automaticallyRevoked: revokedPermissions, reason: revocationReason }
            : {}),
        })
      }

      // A auditoria compara o acesso efetivo, e não o que o navegador enviou.
      const couldReadCpf = previous.permissions.includes('flights:cpf:read')
      const canReadCpf = computeEffectivePermissions(
        input.role,
        grantedPermissions,
        input.deniedPermissions,
        input.slmMember,
      ).includes('flights:cpf:read')
      if (couldReadCpf !== canReadCpf) {
        await audit(
          canReadCpf ? 'cpf_access_granted' : 'cpf_access_revoked',
          revokedPermissions.includes('flights:cpf:read')
            ? { reason: revocationReason }
            : undefined,
        )
      }

      return {
        ...toManagedUser({
          ...target,
          role: legacy.role,
          permissions: legacy.permissions,
          access_profile: input.role,
          access_slm_member: input.slmMember,
          access_granted: grantedPermissions,
          access_denied: [...input.deniedPermissions],
        }),
        revokedPermissions,
      }
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

      // A reativação não devolve as permissões especiais: só nova concessão individual.
      const revokedPermissions = !isActive && target.access_profile !== null
        ? (targetAccess?.grantedPermissions ?? []).filter(isRestrictedPermission)
        : []
      const grantedPermissions = difference(
        targetAccess?.grantedPermissions ?? [],
        revokedPermissions,
      )

      if (revokedPermissions.length > 0) {
        await client.query(
          `UPDATE public.auth_user_access
              SET granted_permissions = $2, updated_by = $3, updated_at = now()
            WHERE user_id = $1`,
          [userId, grantedPermissions, actor.userId],
        )
        await insertAuthAuditEvent(client, {
          actorUserId: actor.userId,
          actorKind: 'user',
          subjectUserId: userId,
          sessionId: null,
          eventType: 'permissions_changed',
          details: {
            grantedAdded: [],
            grantedRemoved: revokedPermissions,
            deniedAdded: [],
            deniedRemoved: [],
            automaticallyRevoked: revokedPermissions,
            reason: 'account_deactivated',
          },
        })
        if (targetAccess?.permissions.includes('flights:cpf:read')) {
          await insertAuthAuditEvent(client, {
            actorUserId: actor.userId,
            actorKind: 'user',
            subjectUserId: userId,
            sessionId: null,
            eventType: 'cpf_access_revoked',
            details: { reason: 'account_deactivated' },
          })
        }
      }

      return {
        ...toManagedUser({
          ...target,
          status: nextStatus,
          ...(revokedPermissions.length > 0
            ? { access_granted: grantedPermissions }
            : {}),
        }),
        revokedPermissions,
      }
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

  async listAuditEvents(
    actor: AuthenticatedIdentity,
    filters: {
      page?: number
      action?: string
      result?: string
      from?: Date | null
      to?: Date | null
      person?: string
    },
  ) {
    assertPermission(actor, 'audit:read')

    const page = Math.max(1, Math.floor(filters.page ?? 1))
    const parameters: unknown[] = []
    const conditions: string[] = []
    const bind = (value: unknown) => {
      parameters.push(value)
      return `$${parameters.length}`
    }
    // Prefixo: "request" alcança request.created, request.cancelled etc.
    if (filters.action) {
      conditions.push(`e.action LIKE ${bind(`${filters.action.replace(/[\\%_]/g, '\\$&')}%`)}`)
    }
    if (filters.result) conditions.push(`e.result = ${bind(filters.result)}`)
    // Os eventos do estoque trazem saldo, reserva, contagens e movimentações. Quem não administra
    // o Almoxarifado não os vê, nem pela existência do registro.
    if (!holdsPermission(actor, 'warehouse:manage')) {
      conditions.push(`NOT (e.action = ANY(${bind(stockAuditActions)}))`)
    }
    if (filters.from) conditions.push(`e.occurred_at >= ${bind(filters.from)}`)
    if (filters.to) conditions.push(`e.occurred_at <= ${bind(filters.to)}`)
    if (filters.person) {
      const pattern = bind(`%${filters.person.replace(/[\\%_]/g, '\\$&')}%`)
      conditions.push(`(actor.full_name ILIKE ${pattern} OR target.full_name ILIKE ${pattern})`)
    }

    const result = await this.poolProvider().query<AuditRow>(
      `${auditSelect}
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT ${pageSize + 1} OFFSET ${(page - 1) * pageSize}`,
      parameters,
    )
    return {
      events: result.rows.slice(0, pageSize).map(toAuditEntry),
      page,
      hasMore: result.rows.length > pageSize,
    }
  }

  /** Encerra todas as sessões de outra conta, com as mesmas barreiras da desativação. */
  async revokeUserSessions(actor: AuthenticatedIdentity, userId: string) {
    assertPermission(actor, 'users:manage')
    assertUuid(userId)

    if (actor.userId === userId) {
      throw new AccountAuthorizationError(
        'Para encerrar as próprias sessões, use a opção em Minha conta.',
      )
    }

    return withTransaction(this.poolProvider(), async (client) => {
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

      const removed = await client.query<{ id: string }>(
        `DELETE FROM public.auth_sessions WHERE user_id = $1 RETURNING id::text AS id`,
        [userId],
      )
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: userId,
        sessionId: null,
        eventType: 'sessions_revoked',
        details: { total: String(removed.rows.length) },
      })
      return removed.rows.length
    })
  }

  /** Sessões ativas da própria conta. Nenhum token sai daqui. */
  async listOwnSessions(userId: string) {
    const result = await this.poolProvider().query<{
      id: string
      created_at: Date
      last_seen_at: Date
      expires_at: Date
    }>(
      `SELECT id::text AS id, created_at, last_seen_at, expires_at
         FROM public.auth_sessions
        WHERE user_id = $1 AND expires_at > now()
        ORDER BY last_seen_at DESC`,
      [userId],
    )
    return result.rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
    }))
  }

  async sessionIdByTokenHash(tokenHash: string) {
    const result = await this.poolProvider().query<{ id: string }>(
      `SELECT id::text AS id FROM public.auth_sessions WHERE session_token_hash = $1`,
      [tokenHash],
    )
    return result.rows[0]?.id ?? null
  }

  /** "Sair dos outros dispositivos": mantém apenas a sessão em uso. */
  async revokeOwnOtherSessions(userId: string, currentTokenHash: string) {
    return withTransaction(this.poolProvider(), async (client) => {
      const removed = await client.query<{ id: string }>(
        `DELETE FROM public.auth_sessions
          WHERE user_id = $1 AND session_token_hash <> $2
          RETURNING id::text AS id`,
        [userId, currentTokenHash],
      )
      await insertAuthAuditEvent(client, {
        actorUserId: userId,
        actorKind: 'user',
        subjectUserId: userId,
        sessionId: null,
        eventType: 'sessions_revoked',
        details: { total: String(removed.rows.length), scope: 'others' },
      })
      return removed.rows.length
    })
  }

  /** Encerra uma sessão da própria conta. A atual sai por "Sair", que também limpa o cookie. */
  async revokeOwnSession(userId: string, sessionId: string, currentTokenHash: string) {
    return withTransaction(this.poolProvider(), async (client) => {
      const removed = await client.query<{ id: string }>(
        `DELETE FROM public.auth_sessions
          WHERE id = $1 AND user_id = $2 AND session_token_hash <> $3
          RETURNING id::text AS id`,
        [sessionId, userId, currentTokenHash],
      )
      if (removed.rows.length === 0) return false
      await insertAuthAuditEvent(client, {
        actorUserId: userId,
        actorKind: 'user',
        subjectUserId: userId,
        sessionId,
        eventType: 'session_revoked_individually',
        details: { scope: 'own' },
      })
      return true
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
    additional: { label: string; value: string }[]
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
        dados: { valores?: Record<string, string>; nomes?: Record<string, string> } | null
      }>(
        `SELECT id::text AS id, full_name, email, sector, created_at,
                to_jsonb(auth_users)->'dados_cadastrais' AS dados
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
        // Com o nome que o campo tinha no cadastro, mesmo que o formulário mude depois.
        additional: Object.entries(row.dados?.valores ?? {}).map(([id, value]) => ({
          label: row.dados?.nomes?.[id] ?? id,
          value,
        })),
      }))
    })
  }

  async decidePendingRegistration(
    actor: AuthenticatedIdentity,
    userId: string,
    decision: {
      action: 'approve'
      role: AuthRole
      // Opcionais, e só para administradores: a aprovação simples continua sem nenhum vínculo.
      slmMember?: boolean
      grantedPermissions?: Permission[]
      lotation?: string | null
      links?: InstitutionalInput
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

    const extras = decision.action === 'approve' ? decision : null
    const hasExtras = Boolean(
      extras && (extras.slmMember !== undefined || extras.grantedPermissions?.length || extras.lotation || extras.links),
    )
    if (hasExtras && actor.role !== 'administrator') throw new AccountAuthorizationError()
    if (extras) {
      const slm = extras.slmMember ?? extras.role === 'slm_operator'
      if (extras.role === 'requester' && slm) {
        throw new UserManagementError('O perfil Solicitante não pode integrar a equipe SLM.', 400)
      }
      if (extras.role === 'slm_operator' && !slm) {
        throw new UserManagementError('O perfil Operador SLM exige que o usuário integre a equipe SLM.', 400)
      }
      assertDriverProfileRules(extras.role, slm, extras.grantedPermissions ?? [], [])
      const ineligible = (extras.grantedPermissions ?? []).filter(
        (permission) => isRestrictedPermission(permission) && !isEligibleForRestrictedPermission(permission, extras.role, slm),
      )
      if (ineligible.length > 0) {
        await this.auditRefusedGrant(actor, userId, extras.role, ineligible)
        throw new UserManagementError('Esta concessão exige um perfil elegível e, para Operador SLM, a equipe SLM.', 400)
      }
    }

    return withTransaction(this.poolProvider(), async (client) => {
      const actorAccess = await lockActor(client, actor.userId, 'users:approve')
      if (hasExtras && actorAccess.role !== 'administrator') throw new AccountAuthorizationError()
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
        if (decision.role === 'driver') await assertDriverSchema(client)
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

        // A equipe SLM acompanha o perfil operacional, e no administrador é uma escolha expressa.
        // Só há concessões quando um administrador as pede, e elas ficam na auditoria.
        const slmMember = decision.slmMember ?? decision.role === 'slm_operator'
        const grantedPermissions = decision.grantedPermissions ?? []
        if (await isAccessSchemaMigrated(client)) {
          await persistUserAccess(client, {
            userId,
            role: decision.role,
            slmMember,
            grantedPermissions,
            deniedPermissions: [],
            updatedBy: actor.userId,
          })
        } else if (grantedPermissions.length > 0 || (decision.slmMember === true && decision.role !== 'slm_operator')) {
          // Só o que foi pedido de forma expressa depende da 003: a aprovação simples segue igual.
          throw new AccessMigrationRequiredError()
        }

        await insertAuthAuditEvent(client, {
          actorUserId: actor.userId,
          actorKind: 'user',
          subjectUserId: userId,
          sessionId: null,
          eventType: 'registration_approved',
          details: { role: decision.role },
        })

        if (decision.lotation) {
          await client.query(
            `UPDATE public.auth_users
                SET sector = $2,
                    setor_id = (SELECT s.id FROM public.setores s WHERE lower(trim(s.nome)) = lower(trim($2)) LIMIT 1)
              WHERE id = $1`,
            [userId, decision.lotation],
          )
          await insertAuthAuditEvent(client, {
            actorUserId: actor.userId,
            actorKind: 'user',
            subjectUserId: userId,
            sessionId: null,
            eventType: 'user_updated',
            details: { fields: ['sector'] },
          })
        }
        if (grantedPermissions.length > 0) {
          await insertAuthAuditEvent(client, {
            actorUserId: actor.userId,
            actorKind: 'user',
            subjectUserId: userId,
            sessionId: null,
            eventType: 'permissions_changed',
            details: { grantedAdded: grantedPermissions },
          })
        }
        if (decision.links) await applyInstitutionalLinks(client, actor.userId, userId, decision.links)

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
