/**
 * Cloudflare Pages Function: encaminha /api/* da tela para a API hospedada à parte (Render).
 *
 * - O destino vem só de BACKEND_ORIGIN, configurada no painel do Cloudflare. O cliente escolhe
 *   apenas o caminho dentro de /api, nunca o host, a porta ou o protocolo.
 * - Método, caminho, consulta, corpo e cabeçalhos da aplicação (cookie, x-csrf-token,
 *   content-type, x-file-name) seguem iguais. Set-Cookie volta intacto: a tela e a API
 *   ficam na mesma origem, e o cookie da sessão continua host-only, HttpOnly e SameSite=Strict.
 * - Cabeçalhos de encaminhamento vindos do cliente são descartados. O IP real vem de
 *   CF-Connecting-IP, que só o Cloudflare define. Ele vai em X-SLM-Client-IP, junto com o
 *   segredo compartilhado BACKEND_PROXY_SECRET, que a API confere (PROXY_SHARED_SECRET).
 * - Falha ou demora da API: resposta genérica, sem endereço, mensagem ou pilha interna.
 */

export type ProxyEnv = {
  BACKEND_ORIGIN?: string
  BACKEND_PROXY_SECRET?: string
  /** Opcional: limite de espera pela API, em milissegundos. Padrão: 100 s (o Render Free hiberna). */
  BACKEND_TIMEOUT_MS?: string
}

type PagesContext = { request: Request; env: ProxyEnv }

export const clientIpHeader = 'x-slm-client-ip'
export const proxySecretHeader = 'x-slm-proxy-secret'
const defaultTimeoutMs = 100_000

// Hop-by-hop (RFC 9110) e cabeçalhos que só o proxy pode definir.
const droppedRequestHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'true-client-ip',
  clientIpHeader,
  proxySecretHeader,
])

const droppedResponseHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Só a origem: https, sem usuário, senha, caminho, consulta ou fragmento. http é aceito apenas
 * para a própria máquina, nos testes. Inválida: null, e nada é encaminhado.
 */
export function parseBackendOrigin(raw: string | undefined): URL | null {
  const value = raw?.trim()
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && loopbackHosts.has(url.hostname))
  if (!secure || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
  return new URL(url.origin)
}

/** Monta o destino. O host é sempre o de BACKEND_ORIGIN; o resultado é conferido de novo. */
export function targetUrl(origin: URL, incoming: URL): URL | null {
  const path = incoming.pathname
  if (path !== '/api' && !path.startsWith('/api/')) return null
  // Barras invertidas e "//" no início poderiam ser lidas como outro host por algum servidor.
  if (path.includes('\\') || path.startsWith('//')) return null
  const target = new URL(origin.href)
  target.pathname = path
  target.search = incoming.search
  return target.origin === origin.origin ? target : null
}

function failure(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ success: false, code, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

const unavailable = () =>
  failure(503, 'API_UNAVAILABLE', 'O sistema está temporariamente indisponível. Tente novamente em instantes.')

export async function proxyRequest(request: Request, env: ProxyEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  const origin = parseBackendOrigin(env.BACKEND_ORIGIN)
  // Sem configuração válida, nada é encaminhado, e o motivo não é revelado ao navegador.
  if (!origin) return failure(503, 'API_NOT_CONFIGURED', 'O sistema está temporariamente indisponível.')

  const target = targetUrl(origin, new URL(request.url))
  if (!target) return failure(404, 'NOT_FOUND', 'Recurso não encontrado.')

  const headers = new Headers()
  request.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (droppedRequestHeaders.has(lower) || lower.startsWith('cf-')) return
    headers.set(name, value)
  })
  const clientIp = request.headers.get('cf-connecting-ip')?.trim()
  if (clientIp) {
    headers.set(clientIpHeader, clientIp)
    headers.set('x-forwarded-for', clientIp)
  }
  headers.set('x-forwarded-proto', new URL(request.url).protocol.replace(':', ''))
  headers.set('x-forwarded-host', new URL(request.url).host)
  const secret = env.BACKEND_PROXY_SECRET?.trim()
  if (secret) headers.set(proxySecretHeader, secret)

  const timeout = Number(env.BACKEND_TIMEOUT_MS)
  const hasBody = !['GET', 'HEAD'].includes(request.method.toUpperCase())

  let response: Response
  try {
    response = await fetcher(target.href, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      // Redirecionamento da API volta ao navegador como está, sem o proxy segui-lo.
      redirect: 'manual',
      signal: AbortSignal.timeout(Number.isFinite(timeout) && timeout > 0 ? timeout : defaultTimeoutMs),
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit)
  } catch {
    return unavailable()
  }

  // Erro de infraestrutura entre o Cloudflare e a API: sem expor a página de erro de terceiros.
  if ([502, 503, 504, 520, 521, 522, 523, 524].includes(response.status) && !isApiJson(response)) {
    await response.body?.cancel().catch(() => undefined)
    return unavailable()
  }

  const outgoing = new Headers()
  response.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (droppedResponseHeaders.has(lower) || lower === 'set-cookie') return
    outgoing.set(name, value)
  })
  // Cada Set-Cookie separado: juntá-los com vírgula corromperia a data de Expires.
  for (const cookie of setCookiesOf(response.headers)) outgoing.append('set-cookie', cookie)

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing })
}

function isApiJson(response: Response) {
  return (response.headers.get('content-type') ?? '').includes('application/json')
}

function setCookiesOf(headers: Headers): string[] {
  const all = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
  if (all) return all
  const single = headers.get('set-cookie')
  return single ? [single] : []
}

export const onRequest = ({ request, env }: PagesContext) => proxyRequest(request, env)
