import type { AuthenticatedUser } from '../auth/auth'
import type { IconName } from '../components/ui/Icon'

type NavigationGroup = 'general' | 'services' | 'management' | 'administration' | 'account'

type NavigationItem = {
  name: string
  path: string
  icon: IconName
  group: NavigationGroup
  // Basta uma das permissões. Sem lista, o item aparece para qualquer usuário.
  anyOf?: readonly string[]
  // Depende de integrar um setor ou de ser gestor, e não de uma permissão só: vem do contexto do módulo.
  demandsOnly?: boolean
  // Aparece também para quem configura o Controle de Demandas sem ter a permissão: o Diretor.
  demandsConfiguration?: boolean
}

export const navigationGroups: { key: NavigationGroup; label?: string }[] = [
  { key: 'general' },
  { key: 'services', label: 'Serviços' },
  { key: 'management', label: 'Acompanhamento' },
  { key: 'administration', label: 'Administração' },
  { key: 'account', label: 'Conta' },
]

export const navigationItems: NavigationItem[] = [
  { name: 'Início', path: '/', icon: 'home', group: 'general' },
  { name: 'Dashboard', path: '/dashboard', icon: 'dashboard', group: 'general' },
  { name: 'Manutenção', path: '/manutencao', icon: 'maintenance', group: 'services', anyOf: ['maintenance:read'] },
  { name: 'Frota', path: '/frota', icon: 'fleet', group: 'services', anyOf: ['fleet:read'] },
  { name: 'Passagens Aéreas', path: '/passagens-aereas', icon: 'flights', group: 'services', anyOf: ['flights:read'] },
  { name: 'Almoxarifado', path: '/almoxarifado', icon: 'warehouse', group: 'services', anyOf: ['warehouse:read'] },
  { name: 'Controle de Demandas', path: '/demandas', icon: 'demands', group: 'services', demandsOnly: true },
  { name: 'Central SLM', path: '/central-slm', icon: 'central', group: 'management', anyOf: ['slm_central:read'] },
  { name: 'Notificações', path: '/notificacoes', icon: 'notifications', group: 'management' },
  { name: 'Calendário', path: '/calendario', icon: 'calendar', group: 'management', anyOf: ['calendar:read'] },
  { name: 'Relatórios', path: '/relatorios', icon: 'reports', group: 'management', anyOf: ['reports:read'] },
  { name: 'Configurações', path: '/configuracoes', icon: 'settings', group: 'administration', anyOf: ['settings:read', 'settings:manage', 'demands:configure'], demandsConfiguration: true },
  { name: 'Cadastros pendentes', path: '/cadastros-pendentes', icon: 'registrations', group: 'administration', anyOf: ['users:approve'] },
  { name: 'Usuários', path: '/usuarios', icon: 'users', group: 'administration', anyOf: ['users:read'] },
  { name: 'Auditoria', path: '/auditoria', icon: 'audit', group: 'administration', anyOf: ['audit:read'] },
  { name: 'Integrações', path: '/integracoes', icon: 'integrations', group: 'administration', anyOf: ['integrations:read'] },
  { name: 'Monitoramento', path: '/monitoramento', icon: 'monitoring', group: 'administration', anyOf: ['monitoring:read'] },
  { name: 'Minha conta', path: '/minha-conta', icon: 'account', group: 'account' },
]

export type { NavigationItem }
export type ModulePath = Exclude<NavigationItem['path'], '/'>

export function getNavigationForUser(user: AuthenticatedUser, hasDemandAccess = false, canConfigureDemands = false) {
  return navigationItems.filter(
    (item) =>
      (!item.demandsOnly || hasDemandAccess) &&
      (!item.anyOf ||
        item.anyOf.some((permission) => user.permissions.includes(permission)) ||
        (item.demandsConfiguration && canConfigureDemands)),
  )
}
