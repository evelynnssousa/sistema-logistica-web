import { ModuleError } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { readSystemSettings } from './settingsRepository.js'
import type { SystemModule } from '../requests/adminSettingsRules.js'

/**
 * Módulo desligado em Configurações não recebe pedidos novos. O que já existe continua consultável
 * e pode ser atendido até o fim: desligar não apaga nem esconde registros de quem tem acesso.
 */
export async function assertModuleEnabled(module: SystemModule) {
  const settings = await readSystemSettings(getDatabasePool())
  if (settings.modules[module] === false) {
    throw new ModuleError('Este módulo está desligado em Configurações e não recebe novos pedidos.', 409, 'MODULE_DISABLED')
  }
}
