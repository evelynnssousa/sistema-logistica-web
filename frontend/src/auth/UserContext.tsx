import { createContext, useContext } from 'react'
import type { AuthenticatedUser } from './auth'

export const UserContext = createContext<AuthenticatedUser | null>(null)
export const LogoutContext = createContext<() => Promise<void>>(async () => {})

export function useAuthenticatedUser() {
  return useContext(UserContext)
}

/**
 * Só controla o que a tela mostra. Quem decide é o backend, em cada requisição.
 */
export function useHasPermission(...permissions: string[]) {
  const user = useAuthenticatedUser()
  return permissions.some((permission) => user?.permissions.includes(permission))
}

export function useLogout() {
  return useContext(LogoutContext)
}
