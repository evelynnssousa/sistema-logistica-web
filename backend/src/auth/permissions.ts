import { modulePermissions, type ModulePermission, type UserRole } from './types'

const permissionSet = new Set<string>(modulePermissions)

export function isModulePermission(value: unknown): value is ModulePermission {
  return typeof value === 'string' && permissionSet.has(value)
}

export function normalizePermissions(value: unknown): ModulePermission[] | null {
  if (!Array.isArray(value) || !value.every(isModulePermission)) return null
  return [...new Set(value)]
}

export function canAccess(
  role: UserRole,
  permissions: readonly ModulePermission[],
  permission: ModulePermission,
): boolean {
  if (permission === 'flights:cpf:read') return permissions.includes(permission)
  return role === 'admin' || permissions.includes(permission)
}