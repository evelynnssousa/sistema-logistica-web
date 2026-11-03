import { createContext, useContext } from 'react'
import type { AuthenticatedUser } from './auth'

export const UserContext = createContext<AuthenticatedUser | null>(null)

export function useAuthenticatedUser() {
  return useContext(UserContext)
}
