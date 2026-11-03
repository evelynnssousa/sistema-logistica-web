import type { AuthenticatedUser } from '../auth/auth'

type NavigationItem = {
  name: string
  path: string
  icon: string
  // Basta uma das permissões. Sem lista, o item aparece para qualquer usuário.
  anyOf?: readonly string[]
}

export const navigationItems: NavigationItem[] = [
  { name: 'Visão geral', path: '/', icon: '▦' },
  { name: 'Manutenção', path: '/manutencao', icon: '⚙', anyOf: ['maintenance:read'] },
  { name: 'Frota', path: '/frota', icon: '▣', anyOf: ['fleet:read'] },
  { name: 'Passagens Aéreas', path: '/passagens-aereas', icon: '✈', anyOf: ['flights:read'] },
  { name: 'Almoxarifado', path: '/portal/almoxarifado', icon: '▤', anyOf: ['warehouse:read'] },
  { name: 'Calendário', path: '/calendario', icon: '▦', anyOf: ['calendar:read'] },
  { name: 'Relatórios', path: '/relatorios', icon: '▥', anyOf: ['reports:read'] },
  { name: 'Configurações', path: '/configuracoes', icon: '⚙', anyOf: ['settings:read', 'settings:manage'] },
  { name: 'Cadastros pendentes', path: '/cadastros-pendentes', icon: '♙', anyOf: ['users:approve'] },
  { name: 'Usuários', path: '/usuarios', icon: '☰', anyOf: ['users:read'] },
  { name: 'Auditoria', path: '/auditoria', icon: '◷', anyOf: ['audit:read'] },
]

export type { NavigationItem }
export type ModulePath = Exclude<NavigationItem['path'], '/'>

export function getNavigationForUser(user: AuthenticatedUser) {
  return navigationItems.filter(
    (item) =>
      !item.anyOf ||
      item.anyOf.some((permission) => user.permissions.includes(permission)),
  )
}
