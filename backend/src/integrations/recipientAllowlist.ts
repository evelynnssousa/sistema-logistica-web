/**
 * Lista de destinatários permitidos para os testes reais de e-mail na homologação.
 *
 * - EMAIL_RECIPIENT_ALLOWLIST: endereços EXATOS, separados por vírgula. Não há liberação por domínio:
 *   "@jucesp.sp.gov.br", "*@..." ou qualquer entrada sem a parte local são recusados e ignorados.
 * - EMAIL_RECIPIENT_RESTRICTION: "test" (padrão, inclusive ausente ou com valor desconhecido) ou "off".
 *   Só "off" desliga a restrição; a remoção é um passo controlado, com autorização.
 *
 * Com a restrição em "test", todo envio real (provedor Resend, recuperação de senha incluída) só sai se
 * TODOS os endereços da mensagem (destinatário, outros destinatários e cópias) estiverem na lista. Sem a
 * lista, nenhum envio real sai. Provedores falsos e o modo simulado só são conferidos quando a lista está
 * definida, para que os testes automatizados possam exercitar a regra.
 *
 * A conferência acontece antes da reserva da cota (mensagem bloqueada não consome cota) e de novo no
 * transporte do Resend e no envio da recuperação, como última barreira.
 */

type Environment = NodeJS.ProcessEnv

export const RECIPIENT_OUTSIDE_TEST_LIST = 'RECIPIENT_OUTSIDE_TEST_LIST'

const exactAddress = /^[^\s@,;<>*"']+@[^\s@,;<>*"']+\.[^\s@,;<>*"']+$/

export type RecipientRestriction = {
  mode: 'test' | 'off'
  allowed: ReadonlySet<string>
  /** Entradas recusadas (domínio inteiro, curinga, formato inválido). Só a quantidade é mostrada. */
  rejectedEntries: number
}

export function recipientRestriction(environment: Environment = process.env): RecipientRestriction {
  const mode = environment.EMAIL_RECIPIENT_RESTRICTION?.trim().toLowerCase() === 'off' ? 'off' : 'test'
  const entries = (environment.EMAIL_RECIPIENT_ALLOWLIST ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  const allowed = new Set(entries.filter((item) => exactAddress.test(item)))
  return { mode, allowed, rejectedEntries: entries.length - allowed.size }
}

/** A lista foi definida (mesmo que vazia de endereços válidos). */
function allowlistDefined(environment: Environment) {
  return (environment.EMAIL_RECIPIENT_ALLOWLIST ?? '').trim() !== ''
}

/**
 * Se a restrição vale para este provedor: sempre para o Resend (envio real) e, para os demais, só
 * quando a lista estiver definida. Com EMAIL_RECIPIENT_RESTRICTION=off, nunca.
 */
export function restrictionEnforcedFor(provider: string, environment: Environment = process.env) {
  if (recipientRestriction(environment).mode === 'off') return false
  return provider === 'resend' || allowlistDefined(environment)
}

/** Endereços da mensagem fora da lista. Vazio: todos autorizados. */
export function recipientsOutsideList(addresses: readonly string[], environment: Environment = process.env) {
  const { allowed } = recipientRestriction(environment)
  return [...new Set(addresses.map((item) => item.trim().toLowerCase()).filter(Boolean))].filter(
    (address) => !allowed.has(address),
  )
}

/** Só os domínios, para auditoria e log: o endereço completo nunca é registrado. */
export function recipientDomains(addresses: readonly string[]) {
  return [...new Set(addresses.map((item) => item.trim().toLowerCase().split('@')[1] ?? '(sem domínio)'))].sort()
}

/**
 * Guarda usada no transporte do Resend e no envio da recuperação: devolve os endereços bloqueados
 * (vazio quando pode sair). A mesma regra da conferência anterior à cota.
 */
export function realSendGuard(environment: Environment = process.env) {
  return (addresses: readonly string[]) =>
    restrictionEnforcedFor('resend', environment) ? recipientsOutsideList(addresses, environment) : []
}

/** Para a tela e o config:check: só contagens e o modo, nunca os endereços. */
export function restrictionSummary(environment: Environment = process.env) {
  const restriction = recipientRestriction(environment)
  return {
    mode: restriction.mode,
    allowedRecipients: restriction.allowed.size,
    rejectedEntries: restriction.rejectedEntries,
  }
}

export function restrictionProblems(environment: Environment = process.env): string[] {
  const problems: string[] = []
  const raw = environment.EMAIL_RECIPIENT_RESTRICTION?.trim().toLowerCase()
  if (raw && raw !== 'test' && raw !== 'off') {
    problems.push('EMAIL_RECIPIENT_RESTRICTION aceita só "test" ou "off". Valor desconhecido mantém a restrição.')
  }
  const { rejectedEntries } = recipientRestriction(environment)
  if (rejectedEntries > 0) {
    problems.push(`EMAIL_RECIPIENT_ALLOWLIST tem ${rejectedEntries} entrada(s) recusada(s): só endereços exatos, sem domínio inteiro nem curinga.`)
  }
  return problems
}
