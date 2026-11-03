import {
  createHmac,
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
