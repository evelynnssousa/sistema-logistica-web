import type { Pool } from 'pg'
import { setProfileAdjustments } from '../auth/permissions.js'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'
import { readSystemSettings } from './settingsRepository.js'
import { getDatabasePool } from './pool.js'

/**
 * Permissões padrão dos perfis ajustadas em Configurações: o cálculo de acesso é síncrono, então o
 * ajuste fica em memória. Recarregado na partida, a cada gravação e a cada 5 minutos.
 */
export async function refreshAdminSettings(poolProvider: () => Pool = getDatabasePool) {
  const settings = await readSystemSettings(poolProvider())
  setProfileAdjustments(settings.profileDefaults)
  return settings
}

export function startAdminSettingsRefresh(intervalMs = 5 * 60_000) {
  const run = () =>
    refreshAdminSettings().catch((error: unknown) => recordTechnicalEvent('worker', 'admin_settings_refresh_failed', error))
  void run()
  const timer = setInterval(() => void run(), intervalMs)
  timer.unref()
  return timer
}
