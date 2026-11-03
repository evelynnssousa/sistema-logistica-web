
import './loadEnvironment.js'
import app from './app.js'
import { isPasswordRecoveryConfigured } from './auth/passwordRecoveryService.js'
import { isRemoteDatabaseConfigured } from './auth/reservedTestEmails.js'
import { shouldRunSessionCleanup } from './auth/sessionCleanupPolicy.js'
import { startSessionCleanup } from './auth/sessionRuntime.js'
import { logSecurityEvent } from './security/logger.js'

const PORT = Number(process.env.PORT) || 3000

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API iniciada na porta ${PORT}`)
  console.log(
    isRemoteDatabaseConfigured()
      ? 'Banco de dados: REMOTO. As ações feitas nesta API gravam em dados reais.'
      : 'Banco de dados: local.',
  )

  if (!isPasswordRecoveryConfigured()) {
    logSecurityEvent('password_recovery_unconfigured')
  }
  if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) {
    logSecurityEvent('frontend_url_missing')
  }

  if (shouldRunSessionCleanup()) {
    startSessionCleanup()
  }
})
