import { isEmailConfigured } from '../auth/email.js'
import { emailProviderLabels, emailProviderName } from './emailProvider.js'
import { restrictionSummary } from './recipientAllowlist.js'
import { logSecurityEvent } from '../security/logger.js'
import type { IntegrationModule } from './catalog.js'

/**
 * Leitura da configuração das integrações. Nenhuma função devolve credenciais, e nada aqui
 * afirma que uma integração está ativa: "configurado" só diz que os valores existem.
 *
 * "simulated" não sai da máquina e nunca vale em produção. Serve aos testes.
 */

export type ChannelMode = 'none' | 'simulated' | 'provider'

type Environment = NodeJS.ProcessEnv

const isProduction = (environment: Environment) => environment.NODE_ENV === 'production'
const isTest = (environment: Environment) => environment.NODE_ENV === 'test'

/**
 * O envio automático exige NOTIFICATION_EMAILS_ENABLED, além das credenciais: o Resend pode
 * já estar configurado só para a recuperação de senha, e isso não autoriza outros envios.
 */
export function emailMode(environment: Environment = process.env): ChannelMode {
  if (environment.EMAIL_TRANSPORT?.trim() === 'simulated' && !isProduction(environment)) {
    return 'simulated'
  }
  if (isTest(environment)) return 'none'
  return environment.NOTIFICATION_EMAILS_ENABLED?.trim() === 'true' && isEmailConfigured(environment)
    ? 'provider'
    : 'none'
}

/** Grava no banco e envia para fora: só roda sozinho em produção, como a limpeza de sessões. */
export function shouldRunIntegrationWorker(environment: Environment = process.env) {
  const configured = environment.INTEGRATIONS_WORKER_ENABLED?.trim()
  if (configured === 'false') return false
  if (configured === 'true') return true
  return isProduction(environment)
}

const addressPattern = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/

function readAddresses(value: string | undefined, variable: string) {
  const addresses = (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  const valid = addresses.filter((item) => addressPattern.test(item))
  if (valid.length !== addresses.length) {
    // O endereço não vai para o log: só a variável a corrigir.
    logSecurityEvent('integration_invalid_address_ignored', { variable })
  }
  return [...new Set(valid)]
}

const suffix = (module: IntegrationModule) => module.toUpperCase()

/** Equipe que recebe os avisos internos do módulo. Sem configuração, ninguém recebe e-mail. */
export function internalRecipients(
  module: IntegrationModule,
  environment: Environment = process.env,
) {
  const variable = `EMAIL_INTERNAL_TO_${suffix(module)}`
  return readAddresses(environment[variable], variable)
}

/** Cópias das mensagens enviadas ao solicitante. Só existem se a instituição as definir. */
export function carbonCopies(module: IntegrationModule, environment: Environment = process.env) {
  const variable = `EMAIL_CC_${suffix(module)}`
  return readAddresses(environment[variable], variable)
}

/** Sem o endereço público, as mensagens saem sem link. Nada é presumido. */
export function publicLink(path: string, environment: Environment = process.env) {
  const base = environment.APP_PUBLIC_URL?.trim().replace(/\/+$/, '')
  return base && /^https:\/\//.test(base) ? `${base}${path}` : null
}

/** Dias sem andamento para gerar o lembrete. Sem valor definido, não há lembrete. */
export function pendingReminderDays(environment: Environment = process.env) {
  const days = Number(environment.NOTIFICATION_PENDING_DAYS)
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : null
}

const reportedModules: IntegrationModule[] = ['maintenance', 'fleet', 'flights', 'warehouse', 'system']

/** Situação para a tela de administração: só indica se cada item existe, nunca o valor. */
export function integrationStatus(environment: Environment = process.env) {
  return {
    email: {
      mode: emailMode(environment),
      provider: emailProviderLabels[emailProviderName(environment)],
      flagEnabled: environment.NOTIFICATION_EMAILS_ENABLED?.trim() === 'true',
      credentialsPresent: isEmailConfigured(environment),
      publicUrlPresent: Boolean(publicLink('/', environment)),
      internalRecipients: Object.fromEntries(
        reportedModules.map((module) => [module, internalRecipients(module, environment).length]),
      ),
      // Lista de destinatários de teste: só o modo e as contagens, nunca os endereços.
      restriction: restrictionSummary(environment),
    },
    worker: {
      enabled: shouldRunIntegrationWorker(environment),
    },
    pendingReminderDays: pendingReminderDays(environment),
  }
}
