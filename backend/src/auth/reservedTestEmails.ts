import { isLoopbackHost } from '../database/databaseSafety.js'

const reservedDomain =
  /@([a-z0-9-]+\.)*(example\.gov\.br|example\.com|example\.org|example\.net|example|test|invalid|localhost)$/i

/** Endereços que só existem em testes: domínios reservados, que não recebem e-mail. */
export function isReservedTestEmail(email: string) {
  return reservedDomain.test(email.trim())
}

/** Sem certeza de que o banco é local, considera remoto. */
export function isRemoteDatabaseConfigured(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const url = environment.DATABASE_URL?.trim()
  if (!url) return false

  try {
    return !isLoopbackHost(new URL(url).hostname)
  } catch {
    return true
  }
}

/**
 * Em um banco remoto, contas de teste não se cadastram nem entram. Última barreira
 * caso um teste alcance a API do desenvolvimento, e neutraliza contas já criadas.
 */
export function isTestAccountBlocked(
  email: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return isReservedTestEmail(email) && isRemoteDatabaseConfigured(environment)
}
