type LogValue = string | number | boolean | null | undefined

/**
 * Registra um evento de segurança. Só aceita valores simples e escolhidos por
 * quem chama: nunca passe senhas, tokens, códigos, CPFs ou corpos de requisição.
 */
export function logSecurityEvent(
  event: string,
  fields: Record<string, LogValue> = {},
) {
  console.warn(
    JSON.stringify({
      level: 'security',
      event,
      at: new Date().toISOString(),
      ...fields,
    }),
  )
}

const safeCodePattern = /^[A-Za-z0-9_.-]{1,40}$/

function readCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const { code, type } = error as { code?: unknown; type?: unknown }
  const candidate = typeof code === 'string' ? code : type
  return typeof candidate === 'string' && safeCodePattern.test(candidate)
    ? candidate
    : undefined
}

/**
 * Resume um erro apenas por nome e código. Mensagens ficam de fora porque podem
 * trazer trechos de SQL, parâmetros ou corpos de requisição.
 */
export function describeError(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined

  return {
    errorName: error instanceof Error ? error.name : 'UnknownError',
    errorCode: readCode(error) ?? readCode(cause) ?? null,
  }
}
