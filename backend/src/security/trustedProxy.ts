import { createHash, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { NextFunction, Request, Response } from 'express'

/**
 * Proxy do Cloudflare Pages à frente da API (functions/api/[[path]].ts).
 *
 * Com PROXY_SHARED_SECRET definida, só passa quem traz o segredo: quem chama a API direto pelo
 * endereço do Render recebe 403, exceto em /api/health, usado pela verificação do Render.
 * Nesses pedidos autenticados, o IP do cliente vem de X-SLM-Client-IP, que o proxy preenche com
 * CF-Connecting-IP. Esse cabeçalho é ignorado em qualquer outro pedido, e X-Forwarded-For
 * continua valendo só conforme TRUST_PROXY.
 *
 * Sem PROXY_SHARED_SECRET (desenvolvimento, testes e homologação), nada muda.
 */

export const clientIpHeader = 'x-slm-client-ip'
export const proxySecretHeader = 'x-slm-proxy-secret'
const minimumSecretLength = 32

export function proxySecretProblem(raw: string | undefined): string | null {
  const value = raw?.trim()
  if (!value) return 'ausente'
  if (value.length < minimumSecretLength) return `curto demais: use ao menos ${minimumSecretLength} caracteres aleatórios`
  return null
}

const digest = (value: string) => createHash('sha256').update(value).digest()

export function trustedProxy(environment: NodeJS.ProcessEnv = process.env) {
  const secret = environment.PROXY_SHARED_SECRET?.trim()
  if (!secret) return (_request: Request, _response: Response, next: NextFunction) => next()
  // Configurada e fraca: a API não inicia, em vez de ficar aberta sem aviso.
  if (proxySecretProblem(secret)) throw new Error('PROXY_SHARED_SECRET precisa ter ao menos 32 caracteres.')
  const expected = digest(secret)

  return (request: Request, response: Response, next: NextFunction) => {
    const presented = request.get(proxySecretHeader)
    // Comparação em tempo constante, sobre resumos de tamanho fixo.
    const valid = typeof presented === 'string' && timingSafeEqual(digest(presented), expected)
    if (!valid) {
      if (request.path === '/api/health') return next()
      response.status(403).json({ success: false, message: 'Acesso permitido somente pelo endereço oficial do sistema.' })
      return
    }
    const clientIp = request.get(clientIpHeader)?.trim()
    if (clientIp && isIP(clientIp)) {
      Object.defineProperty(request, 'ip', { value: clientIp, configurable: true, enumerable: true })
    }
    next()
  }
}
