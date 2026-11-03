import helmet from 'helmet'

const hstsMaxAgeSeconds = 180 * 24 * 60 * 60

// A API só devolve JSON, então nenhum recurso precisa ser carregado a partir dela.
export function securityHeaders(environment: NodeJS.ProcessEnv = process.env) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity:
      environment.NODE_ENV === 'production'
        ? { maxAge: hstsMaxAgeSeconds, includeSubDomains: false }
        : false,
  })
}

/**
 * Quantidade de proxies confiáveis à frente da API. Sem configuração, o cabeçalho
 * X-Forwarded-For é ignorado, para que o cliente não possa forjar outro IP.
 */
export function parseTrustProxy(value: string | undefined): number | false {
  const trimmed = value?.trim()
  if (!trimmed || trimmed === '0') return false
  if (!/^[1-9]\d?$/.test(trimmed)) {
    throw new Error('TRUST_PROXY deve ser o número de proxies confiáveis.')
  }
  return Number(trimmed)
}
