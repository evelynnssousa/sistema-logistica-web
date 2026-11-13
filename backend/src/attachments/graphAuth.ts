import { createPrivateKey, createSign, randomUUID } from 'node:crypto'
import { StorageProviderError } from './providerError.js'

/**
 * Autenticação do SLM no Microsoft Graph como aplicativo (fluxo client credentials), sem conta
 * de pessoa. A permissão esperada é "Sites.Selected", concedida pela TI só ao site da
 * biblioteca dos anexos.
 *
 * O token vive só na memória deste objeto: nunca é gravado em arquivo, banco ou registro, e
 * nenhuma mensagem de erro traz o token, o segredo ou o corpo da resposta.
 */

export const graphScope = 'https://graph.microsoft.com/.default'
export const authorityHost = 'https://login.microsoftonline.com'

export type GraphCredentials =
  | { kind: 'secret'; tenantId: string; clientId: string; clientSecret: string }
  | {
      kind: 'certificate'
      tenantId: string
      clientId: string
      /** Chave privada PEM do certificado cadastrado no aplicativo. */
      privateKey: string
      /** Impressão digital SHA-1 do certificado, em hexadecimal, como mostra o portal. */
      thumbprint: string
    }

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Erro do armazenamento no SharePoint. A mensagem e o código nunca carregam segredo nem URL. */
export class GraphStorageError extends StorageProviderError {
  constructor(code: string, retryable: boolean, status: number | null = null) {
    super(code, retryable, status, `Falha no armazenamento SharePoint (${code}).`)
    this.name = 'GraphStorageError'
  }
}

export function tokenEndpoint(tenantId: string) {
  return `${authorityHost}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString('base64url')

/** Asserção do cliente assinada com o certificado (RFC 7523), válida por 10 minutos. */
export function buildClientAssertion(
  credentials: Extract<GraphCredentials, { kind: 'certificate' }>,
  nowSeconds: number,
) {
  const x5t = base64url(Buffer.from(credentials.thumbprint.replace(/[^0-9a-f]/gi, ''), 'hex'))
  const audience = tokenEndpoint(credentials.tenantId)
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', x5t }))}.${base64url(
    JSON.stringify({
      aud: audience,
      iss: credentials.clientId,
      sub: credentials.clientId,
      jti: randomUUID(),
      nbf: nowSeconds,
      iat: nowSeconds,
      exp: nowSeconds + 600,
    }),
  )}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(createPrivateKey(credentials.privateKey))
  return `${unsigned}.${base64url(signature)}`
}

export type TokenSource = {
  /** Token válido por pelo menos a margem de renovação. */
  token(): Promise<string>
  /** Descarta o token em memória, depois de um 401 do Graph. */
  invalidate(): void
}

/** Renova com cinco minutos de folga; pedidos simultâneos aguardam a mesma renovação. */
const renewalMarginMs = 5 * 60_000

export function createTokenSource(
  credentials: GraphCredentials,
  options: { fetcher: FetchLike; now: () => number; timeoutMs: number },
): TokenSource {
  let current: { value: string; expiresAt: number } | null = null
  let inFlight: Promise<string> | null = null

  async function request(): Promise<string> {
    const form = new URLSearchParams({
      client_id: credentials.clientId,
      scope: graphScope,
      grant_type: 'client_credentials',
    })
    if (credentials.kind === 'secret') {
      form.set('client_secret', credentials.clientSecret)
    } else {
      let assertion: string
      try {
        assertion = buildClientAssertion(credentials, Math.floor(options.now() / 1000))
      } catch {
        throw new GraphStorageError('GRAPH_INVALID_CERTIFICATE', false)
      }
      form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
      form.set('client_assertion', assertion)
    }

    let response: Response
    try {
      response = await options.fetcher(tokenEndpoint(credentials.tenantId), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(options.timeoutMs),
        redirect: 'error',
      })
    } catch (error) {
      const timeout = (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError'
      throw new GraphStorageError(timeout ? 'GRAPH_AUTH_TIMEOUT' : 'GRAPH_AUTH_NETWORK', true)
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      const retryable = response.status === 429 || response.status >= 500
      throw new GraphStorageError(retryable ? 'GRAPH_AUTH_UNAVAILABLE' : 'GRAPH_AUTH_FAILED', retryable, response.status)
    }
    let body: { access_token?: unknown; expires_in?: unknown }
    try {
      body = (await response.json()) as typeof body
    } catch {
      throw new GraphStorageError('GRAPH_AUTH_INVALID_RESPONSE', true)
    }
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new GraphStorageError('GRAPH_AUTH_INVALID_RESPONSE', true)
    }
    const seconds = Number(body.expires_in)
    current = {
      value: body.access_token,
      expiresAt: options.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000,
    }
    return current.value
  }

  return {
    async token() {
      if (current && current.expiresAt - renewalMarginMs > options.now()) return current.value
      if (!inFlight) {
        inFlight = request().finally(() => {
          inFlight = null
        })
      }
      return inFlight
    },
    invalidate() {
      current = null
    },
  }
}
