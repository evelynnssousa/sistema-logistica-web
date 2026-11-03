import type { AuthenticatedUser } from '../auth/auth'

type Role = AuthenticatedUser['role']

type NavigationItem = {
  name: string
  path: string
  icon: string
  access: readonly Role[]
}

export const navigationItems: NavigationItem[] = [
  {
    name: 'Visão geral',
    path: '/',
    icon: '▦',
    access: ['administrator', 'slm_operator', 'requester'],
  },
  {
    name: 'Manutenção',
    path: '/manutencao',
    icon: '⚙',
    access: ['administrator', 'slm_operator', 'requester'],
  },
  {
    name: 'Frota',
    path: '/frota',
    icon: '▣',
    access: ['administrator', 'slm_operator', 'requester'],
  },
  {
    name: 'Passagens Aéreas',
    path: '/passagens-aereas',
    icon: '✈',
    access: ['administrator', 'slm_operator', 'requester'],
  },
  {
    name: 'Almoxarifado',
    path: '/portal/almoxarifado',
    icon: '▤',
    access: ['administrator', 'slm_operator', 'requester'],
  },
  {
    name: 'Calendário',
    path: '/calendario',
    icon: '▦',
    access: ['administrator', 'slm_operator'],
  },
  {
    name: 'Relatórios',
    path: '/relatorios',
    icon: '▥',
    access: ['administrator', 'slm_operator'],
  },
  {
    name: 'Configurações',
    path: '/configuracoes',
    icon: '⚙',
    access: ['administrator'],
  },
  {
  name: 'Cadastros pendentes',
  path: '/cadastros-pendentes',
  icon: '♙',
  access: ['administrator'],
},
]

export type { NavigationItem }
export type ModulePath = Exclude<NavigationItem['path'], '/'>

export function getNavigationForUser(user: AuthenticatedUser) {
  return navigationItems.filter((item) => item.access.includes(user.role))
}
