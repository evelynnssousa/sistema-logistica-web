
export const authRoles = ['administrator', 'slm_operator', 'requester'] as const

export type AuthRole = (typeof authRoles)[number]

export type AuthenticatedIdentity = {
  userId: string
  role: AuthRole
}

/**
 * Converte os perfis persistidos no banco para os perfis internos.
 * O perfil "admin" do banco existente corresponde a "administrator".
 */
export function normalizeAuthRole(value: unknown): AuthRole | null {
  if (value === 'admin' || value === 'administrator') {
    return 'administrator'
  }

  if (value === 'operator' || value === 'slm_operator') {
    return 'slm_operator'
  }

  if (value === 'requester') {
    return 'requester'
  }

  return null
}

export function isAuthRole(value: unknown): value is AuthRole {
  return (
    typeof value === 'string' &&
    authRoles.includes(value as AuthRole)
  )
}

const validDatabasePermissions = new Set([
  'maintenance:read',
  'maintenance:write',
  'fleet:read',
  'fleet:write',
  'flights:read',
  'flights:write',
  'flights:cpf:read',
  'warehouse:read',
  'warehouse:write',
  'settings:read',
  'settings:write',
])

export function resolveDatabaseAuthRole(
  role: unknown,
  permissions: unknown,
): AuthRole | null {
  if (role === 'admin') {
    return 'administrator'
  }

  if (role !== 'operator') {
    return null
  }

  if (
    !Array.isArray(permissions) ||
    !permissions.every(
      (permission) =>
        typeof permission === 'string' &&
        validDatabasePermissions.has(permission),
    )
  ) {
    return null
  }

  const hasPrivilegedPermission = permissions.some(
    (permission) =>
      permission.endsWith(':write') ||
      permission === 'flights:cpf:read',
  )

  return hasPrivilegedPermission
    ? 'slm_operator'
    : 'requester'
}
