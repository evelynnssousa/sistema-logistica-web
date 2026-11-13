import { useEffect, useSyncExternalStore } from 'react'
import { apiRequest } from '../auth/apiClient'

/**
 * Informações administrativas definidas em Configurações (13/11/2026): módulos ligados, aviso geral,
 * mensagem da página inicial, feriados e padrões das atas. Carregadas uma vez por sessão e
 * recarregadas quando o administrador salva uma dessas seções.
 */

export type SystemModule = 'maintenance' | 'fleet' | 'flights' | 'warehouse' | 'demands'

export type SystemInfo = {
  modules: Record<SystemModule, boolean>
  announcement: { text: string; tone: 'info' | 'warning'; until: string | null } | null
  homeMessage: string
  holidays: { date: string; name: string }[]
  contracts: { defaultNoticeDays: number; lowBalancePercent: number }
}

export const defaultSystemInfo: SystemInfo = {
  modules: { maintenance: true, fleet: true, flights: true, warehouse: true, demands: true },
  announcement: null,
  homeMessage: '',
  holidays: [],
  contracts: { defaultNoticeDays: 90, lowBalancePercent: 20 },
}

/** Caminho de cada módulo no menu e nas rotas. */
export const modulePaths: Record<SystemModule, string> = {
  maintenance: '/manutencao',
  fleet: '/frota',
  flights: '/passagens-aereas',
  warehouse: '/almoxarifado',
  demands: '/demandas',
}

let snapshot: SystemInfo = defaultSystemInfo
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function refreshSystemInfo() {
  loading = apiRequest<SystemInfo & { success: boolean }>('/system/info')
    .then((result) => {
      snapshot = {
        modules: { ...defaultSystemInfo.modules, ...result.modules },
        announcement: result.announcement,
        homeMessage: result.homeMessage ?? '',
        holidays: result.holidays ?? [],
        contracts: { ...defaultSystemInfo.contracts, ...result.contracts },
      }
      listeners.forEach((listener) => listener())
    })
    // Sem resposta, vale o padrão: tudo ligado, sem aviso.
    .catch(() => undefined)
  return loading
}

export function useSystemInfo() {
  const info = useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
  useEffect(() => {
    if (!loading) void refreshSystemInfo()
  }, [])
  return info
}

/** Caminhos de módulos desligados, para o menu e a página inicial. */
export function disabledModulePaths(info: SystemInfo) {
  return (Object.keys(modulePaths) as SystemModule[]).filter((key) => info.modules[key] === false).map((key) => modulePaths[key])
}
