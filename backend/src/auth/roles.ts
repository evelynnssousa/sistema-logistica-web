export const authRoles = ['administrator', 'slm_operator'] as const

export type AuthRole = (typeof authRoles)[number]

export type AuthenticatedIdentity = {
  userId: string
  role: AuthRole
}

export function isAuthRole(value: unknown): value is AuthRole {
  return typeof value === 'string' && authRoles.includes(value as AuthRole)
}