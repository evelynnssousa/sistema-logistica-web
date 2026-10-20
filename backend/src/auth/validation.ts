import { AuthError } from './errors'
import type { RegistrationInput } from './types'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AuthError('Informe um e-mail institucional válido.', 400, 'INVALID_EMAIL')
  }
  const email = value.trim().normalize('NFKC').toLowerCase()
  const [localPart, domain] = email.split('@')
  if (
    email.length > 254 ||
    !emailPattern.test(email) ||
    !localPart || localPart.length > 64 ||
    !domain || domain.length > 253
  ) {
    throw new AuthError('Informe um e-mail institucional válido.', 400, 'INVALID_EMAIL')
  }
  return email
}

export function normalizeDomainAllowlist(value: string | string[] | undefined): string[] {
  const domains = Array.isArray(value) ? value : (value ?? '').split(',')
  return domains
    .map((domain) => domain.trim().normalize('NFKC').toLowerCase().replace(/^@/, ''))
    .filter(Boolean)
}

export function parseRegistration(
  body: unknown,
  allowedDomains: readonly string[],
): RegistrationInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AuthError('Dados de cadastro inválidos.', 400, 'INVALID_REGISTRATION')
  }

  const input = body as Record<string, unknown>
  if ('role' in input || 'permissions' in input || 'status' in input) {
    throw new AuthError('O perfil é definido durante a aprovação administrativa.', 400, 'ROLE_NOT_ALLOWED')
  }

  const fullName = typeof input.fullName === 'string' ? input.fullName.trim() : ''
  const sector = typeof input.sector === 'string' ? input.sector.trim() : ''
  const email = normalizeEmail(input.email)

  if (fullName.length < 2 || fullName.length > 120) {
    throw new AuthError('Informe o nome completo (2 a 120 caracteres).', 400, 'INVALID_NAME')
  }
  if (sector.length < 2 || sector.length > 120) {
    throw new AuthError('Informe o setor (2 a 120 caracteres).', 400, 'INVALID_SECTOR')
  }
  if (allowedDomains.length === 0) {
    throw new AuthError('O cadastro institucional ainda não está configurado.', 503, 'REGISTRATION_NOT_CONFIGURED')
  }
  if (!allowedDomains.includes(email.split('@')[1])) {
    throw new AuthError('Use um e-mail de domínio institucional autorizado.', 400, 'EMAIL_DOMAIN_NOT_ALLOWED')
  }

  const password = input.password
  const confirmation = input.passwordConfirmation
  if (
    typeof password !== 'string' ||
    password.length < 12 ||
    Buffer.byteLength(password, 'utf8') > 512
  ) {
    throw new AuthError('A senha deve ter ao menos 12 caracteres.', 400, 'INVALID_PASSWORD')
  }
  if (typeof confirmation !== 'string' || password !== confirmation) {
    throw new AuthError('A confirmação de senha não corresponde.', 400, 'PASSWORD_MISMATCH')
  }

  return { fullName, email, sector, password }
}

export function validateLogin(body: unknown): { email: string; password: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AuthError('Informe e-mail e senha.', 400, 'INVALID_CREDENTIALS')
  }
  const input = body as Record<string, unknown>
  const email = normalizeEmail(input.email)
  if (typeof input.password !== 'string' || input.password.length === 0 || input.password.length > 512) {
    throw new AuthError('Informe e-mail e senha.', 400, 'INVALID_CREDENTIALS')
  }
  return { email, password: input.password }
}