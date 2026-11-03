import type { ReactNode } from 'react'
import AccessDeniedPage from '../pages/AccessDeniedPage'
import { useHasPermission } from './UserContext'

type RequirePermissionProps = {
  anyOf: string[]
  children: ReactNode
}

/** Bloqueia o acesso direto pela URL. A proteção dos dados continua no backend. */
function RequirePermission({ anyOf, children }: RequirePermissionProps) {
  const allowed = useHasPermission(...anyOf)

  return allowed ? <>{children}</> : <AccessDeniedPage />
}

export default RequirePermission
