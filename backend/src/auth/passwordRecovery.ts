import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto'

export const PASSWORD_RECOVERY_TTL_MS = 10 * 60 * 1000
export const PASSWORD_RECOVERY_MAX_ATTEMPTS = 5

export function generatePasswordRecoveryCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

export function hashPasswordRecoveryCode(
  code: string,
  pepper = process.env.PASSWORD_RESET_PEPPER,
): string {
  if (!/^\d{6}$/.test(code)) {
    throw new Error('Código de recuperação inválido.')
  }

  if (!pepper?.trim()) {
    throw new Error('Segredo de recuperação não configurado.')
  }

  return createHmac('sha256', pepper)
    .update(code, 'utf8')
    .digest('hex')
}

export function verifyPasswordRecoveryCode(
  code: string,
  expectedHash: string,
  pepper = process.env.PASSWORD_RESET_PEPPER,
): boolean {
  if (!/^\d{6}$/.test(code) || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    return false
  }

  try {
    const actualHash = hashPasswordRecoveryCode(code, pepper)

    return timingSafeEqual(
      Buffer.from(actualHash, 'hex'),
      Buffer.from(expectedHash, 'hex'),
    )
  } catch {
    return false
  }
}

// Link temporário: 256 bits aleatórios, sem limite de tentativas a controlar. O prazo e o
// uso único são os mesmos do código.
const recoveryTokenPattern = /^[A-Za-z0-9_-]{43}$/

export function generatePasswordRecoveryToken(): string {
  return randomBytes(32).toString('base64url')
}

export function isPasswordRecoveryToken(value: unknown): value is string {
  return typeof value === 'string' && recoveryTokenPattern.test(value)
}

export function hashPasswordRecoveryToken(
  token: string,
  pepper = process.env.PASSWORD_RESET_PEPPER,
): string {
  if (!isPasswordRecoveryToken(token)) {
    throw new Error('Link de recuperação inválido.')
  }
  if (!pepper?.trim()) {
    throw new Error('Segredo de recuperação não configurado.')
  }
  return createHmac('sha256', pepper).update(`link:${token}`, 'utf8').digest('hex')
}

/**
 * Endereço público usado no link. Sem endereço válido, a recuperação segue por código.
 * O token vai depois de "#": não aparece em logs de servidor nem no cabeçalho Referer.
 */
export function passwordRecoveryLink(
  token: string,
  baseUrl: string | undefined = process.env.APP_PUBLIC_URL,
): string | null {
  const url = readPublicBaseUrl(baseUrl)
  return url ? `${url}/#recuperar-senha=${token}` : null
}

function readPublicBaseUrl(value: string | undefined) {
  if (!value?.trim()) return null
  try {
    const url = new URL(value.trim())
    const isLocal = ['localhost', '127.0.0.1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) return null
    return url.origin
  } catch {
    return null
  }
}
