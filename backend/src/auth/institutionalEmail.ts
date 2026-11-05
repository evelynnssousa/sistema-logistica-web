/**
 * Domínios aceitos no cadastro, definidos pela instituição em INSTITUTIONAL_EMAIL_DOMAINS.
 * Sem configuração, não há restrição: a lista oficial ainda não foi informada.
 */
export function isInstitutionalEmailAllowed(
  email: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const domains = (environment.INSTITUTIONAL_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
  if (domains.length === 0) return true

  const domain = email.trim().toLowerCase().split('@').pop() ?? ''
  return domains.includes(domain)
}
