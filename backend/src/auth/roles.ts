export const authRoles = ['administrator', 'slm_operator', 'requester'] as const

export type AuthRole = (typeof authRoles)[number]

export type AuthenticatedIdentity = {
  userId: string
  role: AuthRole
}

const moduleReadPermissions = [
  'maintenance:read',
  'fleet:read',
  'flights:read',
  'warehouse:read',
]

const moduleWritePermissions = [
  'maintenance:write',
  'fleet:write',
  'flights:write',
  'warehouse:write',
]

/**
 * Valores gravados no banco para cada perfil interno. O banco só conhece os
 * papéis "admin" e "operator"; solicitante e operador SLM se distinguem pelas
 * permissões. O CPF completo não é concedido por padrão.
 */
export function databaseRoleFor(role: AuthRole): {
  role: 'admin' | 'operator'
  permissions: string[]
} {
  if (role === 'administrator') return { role: 'admin', permissions: [] }
  if (role === 'slm_operator') {
    return {
      role: 'operator',
      permissions: [...moduleReadPermissions, ...moduleWritePermissions],
    }
  }
  return { role: 'operator', permissions: [...moduleReadPermissions] }
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
