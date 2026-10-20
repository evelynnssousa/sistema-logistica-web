export const navigationItems = [
  { name: 'Visão geral', path: '/', icon: '▦' },
  { name: 'Manutenção', path: '/manutencao', icon: '⚙' },
  { name: 'Frota', path: '/frota', icon: '▣' },
  { name: 'Passagens Aéreas', path: '/passagens-aereas', icon: '✈' },
  { name: 'Almoxarifado', path: '/almoxarifado', icon: '▤' },
  { name: 'Calendário', path: '/calendario', icon: '▦' },
  { name: 'Relatórios', path: '/relatorios', icon: '▥' },
  { name: 'Configurações', path: '/configuracoes', icon: '⚙' },
] as const

export type NavigationItem = (typeof navigationItems)[number]
export type ModulePath = Exclude<NavigationItem['path'], '/'>
