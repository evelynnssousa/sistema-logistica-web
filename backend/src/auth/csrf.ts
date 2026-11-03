import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const csrfHeaderName = 'x-csrf-token'

/**
 * O token é derivado do token de sessão, que fica em cookie HttpOnly. Assim ele
 * pode ser devolvido de novo ao recarregar a página, vale em várias abas ao mesmo
 * tempo e o banco guarda apenas o hash, como já faz com o token de sessão.
 */
export function deriveCsrfToken(sessionToken: string): string {
  return createHmac('sha256', sessionToken)
    .update('slm:csrf:v1')
    .digest('base64url')
}

export function hashCsrfToken(csrfToken: string): string {
  return createHash('sha256').update(csrfToken).digest('hex')
}

export function csrfTokenMatches(
  presentedToken: unknown,
  expectedHash: unknown,
): boolean {
  if (
    typeof presentedToken !== 'string' ||
    !presentedToken ||
    typeof expectedHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(expectedHash)
  ) {
    return false
  }

  return timingSafeEqual(
    Buffer.from(hashCsrfToken(presentedToken), 'hex'),
    Buffer.from(expectedHash, 'hex'),
  )
}
