import type { Permission } from './permissions.js'

export const authRoles = ['administrator', 'slm_operator', 'requester'] as const

export type AuthRole = (typeof authRoles)[number]

export type SessionIdentity = {
  userId: string
  role: AuthRole
}

/** Resolvida no servidor a cada requisição, para que alterações valham na hora. */
export type AuthenticatedIdentity = SessionIdentity & {
  permissions: readonly Permission[]
  slmMember: boolean
  sector: string
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

  // Uma permissão isolada, como a de CPF ou configurações, não torna ninguém operador.
  return permissions.some((permission) => moduleWritePermissions.includes(permission))
    ? 'slm_operator'
    : 'requester'
}
