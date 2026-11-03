import type { AuthenticatedUser } from '../auth/auth'

export const roleLabels: Record<AuthenticatedUser['role'], string> = {
  administrator: 'Administrador',
  slm_operator: 'Operador SLM',
  requester: 'Solicitante',
}
