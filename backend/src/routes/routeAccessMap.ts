import type { Permission } from '../auth/permissions.js'

/**
 * Todas as rotas da API e o acesso exigido por cada uma. Serve aos testes:
 * routeInventory.test.ts falha se existir rota fora desta lista, e a integração
 * percorre a lista para comprovar cada permissão contra a API real.
 */
export type RouteAccess = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
} & (
  | { access: 'public'; reason: string }
  | { access: 'session' }
  | {
      access: 'permission'
      requires: readonly Permission[]
      // Além das permissões, o perfil precisa ser Administrador.
      administratorOnly?: boolean
    }
)

export const routeAccessMap: readonly RouteAccess[] = [
  { method: 'GET', path: '/health', access: 'public', reason: 'Saúde da API' },
  { method: 'POST', path: '/auth/register', access: 'public', reason: 'Pedido de acesso, limitado por IP' },
  { method: 'POST', path: '/auth/login', access: 'public', reason: 'Entrada, com limite de tentativas' },
  { method: 'POST', path: '/auth/logout', access: 'public', reason: 'Sem sessão só limpa o cookie; com sessão exige CSRF' },
  { method: 'POST', path: '/auth/password-recovery/request', access: 'public', reason: 'Recuperação de senha, limitada' },
  { method: 'POST', path: '/auth/password-recovery/reset', access: 'public', reason: 'Recuperação de senha, limitada' },

  { method: 'GET', path: '/auth/me', access: 'session' },

  { method: 'GET', path: '/admin/registrations/pending', access: 'permission', requires: ['users:approve'] },
  { method: 'POST', path: '/admin/registrations/:userId/approve', access: 'permission', requires: ['users:approve'] },
  { method: 'POST', path: '/admin/registrations/:userId/reject', access: 'permission', requires: ['users:approve'] },

  { method: 'GET', path: '/admin/permissions', access: 'permission', requires: ['users:read'] },
  { method: 'GET', path: '/admin/audit', access: 'permission', requires: ['audit:read'] },

  { method: 'GET', path: '/admin/users', access: 'permission', requires: ['users:read'] },
  { method: 'GET', path: '/admin/users/:userId', access: 'permission', requires: ['users:read'] },
  { method: 'GET', path: '/admin/users/:userId/history', access: 'permission', requires: ['users:read'] },
  { method: 'PATCH', path: '/admin/users/:userId', access: 'permission', requires: ['users:manage'] },
  { method: 'PUT', path: '/admin/users/:userId/access', access: 'permission', requires: ['users:manage'], administratorOnly: true },
  { method: 'POST', path: '/admin/users/:userId/activate', access: 'permission', requires: ['users:manage'] },
  { method: 'POST', path: '/admin/users/:userId/deactivate', access: 'permission', requires: ['users:manage'] },

  { method: 'GET', path: '/flights/requests/:requestId/passengers', access: 'permission', requires: ['flights:read'] },
  { method: 'GET', path: '/flights/passengers/:passengerId/cpf', access: 'permission', requires: ['flights:read', 'flights:cpf:read'] },
]
