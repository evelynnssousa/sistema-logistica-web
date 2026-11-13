
import './loadEnvironment.js'
import app from './app.js'
import { isPasswordRecoveryConfigured } from './auth/passwordRecoveryService.js'
import { assertPasswordResetPepperForStartup } from './auth/passwordRecovery.js'
import { isRemoteDatabaseConfigured } from './auth/reservedTestEmails.js'
import { shouldRunSessionCleanup } from './auth/sessionCleanupPolicy.js'
import { startSessionCleanup } from './auth/sessionRuntime.js'
import { shouldRunDemandWorker, startDemandWorker } from './demands/worker.js'
import { shouldRunIntegrationWorker } from './integrations/config.js'
import { startIntegrationWorker } from './integrations/worker.js'
import { shouldRunMonitoring, startMonitoring } from './monitoring/healthChecks.js'
import { logSecurityEvent } from './security/logger.js'
import { checkEnvironment } from './config/environmentCheck.js'
import { startAdminSettingsRefresh } from './database/adminSettingsRuntime.js'

// Em produção, PASSWORD_RESET_PEPPER definido e curto impede o início (ausente só desliga a recuperação).
assertPasswordResetPepperForStartup()

const PORT = Number(process.env.PORT) || 3000

app.listen(PORT, '0.0.0.0', () => {
  // Permissões padrão ajustadas em Configurações. Sem banco ou sem gravação, valem as do código.
  startAdminSettingsRefresh()
  console.log(`API iniciada na porta ${PORT}`)
  console.log(
    isRemoteDatabaseConfigured()
      ? 'Banco de dados: REMOTO. As ações feitas nesta API gravam em dados reais.'
      : 'Banco de dados: local.',
  )

  // Só nomes e situação, nunca valores. Não impede o início: cada função já recusa sem a sua configuração.
  for (const finding of checkEnvironment()) {
    if (finding.level !== 'ok') {
      logSecurityEvent('environment_check', { variable: finding.variable, level: finding.level })
    }
  }

  if (!isPasswordRecoveryConfigured()) {
    logSecurityEvent('password_recovery_unconfigured')
  }
  if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) {
    logSecurityEvent('frontend_url_missing')
  }

  if (shouldRunSessionCleanup()) {
    startSessionCleanup()
  }
  if (shouldRunIntegrationWorker()) {
    startIntegrationWorker()
  }
  if (shouldRunMonitoring()) {
    startMonitoring()
  }
  if (shouldRunDemandWorker()) {
    startDemandWorker()
  }
})
