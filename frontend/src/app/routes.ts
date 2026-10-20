export const appRoutes = [
  { id: 'overview', path: '/', label: 'Visão geral', icon: '▦' },
  { id: 'manutencao', path: '/manutencao', label: 'Manutenção', icon: '⚙' },
  { id: 'frota', path: '/frota', label: 'Frota', icon: '▣' },
  {
    id: 'passagens-aereas',
    path: '/passagens-aereas',
    label: 'Passagens aéreas',
    icon: '✈',
  },
] as const

export type AppRouteId = (typeof appRoutes)[number]['id']
export type ModuleRouteId = Exclude<AppRouteId, 'overview'>
export type AppScreenId = AppRouteId | 'login' | 'register' | 'admin'

const utilityRoutes: Record<'login' | 'register' | 'admin', string> = {
  login: '/login',
  register: '/cadastro',
  admin: '/administracao',
}

export function routeFromPath(pathname: string): AppScreenId {
  const moduleRoute = appRoutes.find((route) => route.path === pathname)
  if (moduleRoute) return moduleRoute.id
  const utilityRoute = Object.entries(utilityRoutes).find(([, path]) => path === pathname)
  return (utilityRoute?.[0] as keyof typeof utilityRoutes | undefined) ?? 'overview'
}

export function pathForRoute(route: AppScreenId): string {
  if (route in utilityRoutes) return utilityRoutes[route as keyof typeof utilityRoutes]
  return appRoutes.find((item) => item.id === route)?.path ?? '/'
}