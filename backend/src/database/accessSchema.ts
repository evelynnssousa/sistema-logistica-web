import type { Pool, PoolClient } from 'pg'
import {
  computeEffectivePermissions,
  grantsFromLegacyPermissions,
  onlyKnownPermissions,
} from '../auth/permissions.js'
import type { Permission } from '../auth/permissions.js'
import { isAuthRole, resolveDatabaseAuthRole } from '../auth/roles.js'
import type { AuthRole } from '../auth/roles.js'
import { DomainError } from './withTransaction.js'

/**
 * A migração 003 cria a tabela auth_user_access sem alterar auth_users. Até ela
 * ser aplicada, o acesso vem das colunas antigas: login e aprovação continuam
 * funcionando, e somente a edição de perfis e permissões fica indisponível.
 */

const recheckIntervalMs = 30_000

let migrated = false
let checkedAt = 0

export async function isAccessSchemaMigrated(
  queryable: Pick<Pool | PoolClient, 'query'>,
): Promise<boolean> {
  if (migrated) return true
  if (Date.now() - checkedAt < recheckIntervalMs) return false

  const result = await queryable.query<{ present: boolean }>(
    `SELECT to_regclass('public.auth_user_access') IS NOT NULL AS present`,
  )
  migrated = result.rows[0]?.present === true
  checkedAt = Date.now()
  return migrated
}

// Somente para testes que aplicam a migração durante a execução.
export function resetAccessSchemaCacheForTests() {
  migrated = false
  checkedAt = 0
}

export class AccessMigrationRequiredError extends DomainError {
  constructor() {
    super('Esta função depende de uma atualização do banco de dados ainda não aplicada.')
    this.name = 'AccessMigrationRequiredError'
  }
}

export type AccessRow = {
  role: string | null
  permissions: string[]
  access_profile: string | null
  access_slm_member: boolean | null
  access_granted: string[] | null
  access_denied: string[] | null
}

const legacyProfileSql = `CASE
    WHEN u.role = 'admin' THEN 'administrator'
    WHEN u.role = 'operator' AND u.permissions && ARRAY[
      'maintenance:write', 'fleet:write', 'flights:write', 'warehouse:write'
    ]::text[] THEN 'slm_operator'
    WHEN u.role = 'operator' THEN 'requester'
  END`

/** Trechos de SQL para ler o acesso de "public.auth_users u". */
export function accessSql(isMigrated: boolean) {
  return isMigrated
    ? {
        columns: `u.role, u.permissions,
                  a.profile AS access_profile,
                  a.slm_member AS access_slm_member,
                  a.granted_permissions AS access_granted,
                  a.denied_permissions AS access_denied`,
        join: 'LEFT JOIN public.auth_user_access a ON a.user_id = u.id',
        profile: `COALESCE(a.profile, ${legacyProfileSql})`,
        slmMember: `COALESCE(a.slm_member, ${legacyProfileSql} = 'slm_operator')`,
      }
    : {
        columns: `u.role, u.permissions,
                  NULL::text AS access_profile,
                  NULL::boolean AS access_slm_member,
                  NULL::text[] AS access_granted,
                  NULL::text[] AS access_denied`,
        join: '',
        profile: legacyProfileSql,
        slmMember: `COALESCE(${legacyProfileSql} = 'slm_operator', false)`,
      }
}

export type ResolvedAccess = {
  role: AuthRole
  permissions: Permission[]
  slmMember: boolean
  grantedPermissions: Permission[]
  deniedPermissions: Permission[]
}

/**
 * Sem linha em auth_user_access (conta criada pelo CLI ou banco ainda sem a
 * migração), usa as colunas antigas. Devolve null quando não há perfil válido.
 */
export function resolveAccess(row: AccessRow): ResolvedAccess | null {
  const role = row.access_profile !== null
    ? (isAuthRole(row.access_profile) ? row.access_profile : null)
    : resolveDatabaseAuthRole(row.role, row.permissions)

  if (!role) return null

  const hasAccessRow = row.access_profile !== null
  const grantedPermissions = hasAccessRow
    ? onlyKnownPermissions(row.access_granted)
    : grantsFromLegacyPermissions(row.permissions)
  const deniedPermissions = hasAccessRow
    ? onlyKnownPermissions(row.access_denied)
    : []

  return {
    role,
    permissions: computeEffectivePermissions(
      role,
      grantedPermissions,
      deniedPermissions,
    ),
    slmMember: hasAccessRow
      ? row.access_slm_member === true
      : role === 'slm_operator',
    grantedPermissions,
    deniedPermissions,
  }
}
