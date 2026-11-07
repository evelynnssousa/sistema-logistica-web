import { randomBytes } from 'node:crypto'

/**
 * Microsoft Graph simulado, só para testes: nenhuma conexão sai da máquina. Imita o token do
 * Entra ID, a sessão de upload, o redirecionamento do download e a biblioteca de documentos,
 * e permite programar falhas (429, 503, rede, credencial recusada, token vencido).
 */

export const fakeTenant = '11111111-2222-3333-4444-555555555555'
export const fakeClient = '66666666-7777-8888-9999-000000000000'
export const fakeSecret = 'segredo-ficticio-do-aplicativo-nao-real'
export const fakeDrive = 'b!bibliotecaFicticiaDoSlm_0123456789'

export const fakeSettings = {
  credentials: { kind: 'secret' as const, tenantId: fakeTenant, clientId: fakeClient, clientSecret: fakeSecret },
  driveId: fakeDrive,
  rootFolder: 'SLM-Anexos',
}

export type RecordedRequest = {
  method: string
  url: string
  authorization: string | null
  contentRange: string | null
  body: Buffer | null
}

type Fault = {
  match: RegExp
  times: number
  respond: () => Response | 'network' | 'hang'
}

type Session = { path: string; total: number | null; chunks: Buffer[]; next: number }

const graph = 'https://graph.microsoft.com/v1.0'
const sharepoint = 'https://slm-ficticio.sharepoint.com'

export class FakeGraph {
  readonly files = new Map<string, Buffer>()
  readonly requests: RecordedRequest[] = []
  readonly issuedTokens: string[] = []
  private readonly tokens = new Map<string, number>()
  private readonly sessions = new Map<string, Session>()
  private readonly downloads = new Map<string, string>()
  private faults: Fault[] = []

  clock = 1_800_000_000_000
  tokenSeconds = 3600
  rejectCredentials = false
  /** O Graph informa, ao concluir, um tamanho diferente do enviado. */
  reportWrongSize = false

  readonly now = () => this.clock
  readonly sleeps: number[] = []
  readonly sleep = async (ms: number) => {
    this.sleeps.push(ms)
    this.clock += ms
  }

  /** As próximas `times` chamadas que casarem com `match` ("MÉTODO url") recebem a falha. */
  fail(match: RegExp, respond: Fault['respond'], times = 1) {
    this.faults.push({ match, respond, times })
  }

  /** Revoga os tokens já emitidos, como se tivessem vencido antes do previsto. */
  revokeTokens() {
    this.tokens.clear()
  }

  pathOf(key: string) {
    return `SLM-Anexos/${key.slice(0, 2)}/${key}`
  }

  /** Tudo o que o SLM enviou ou recebeu, para procurar segredo fora do lugar. */
  graphCalls() {
    return this.requests.filter((request) => !request.url.includes('login.microsoftonline.com'))
  }

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    const body = await bodyOf(init.body)
    this.requests.push({
      method,
      url: input,
      authorization: headers.get('authorization'),
      contentRange: headers.get('content-range'),
      body,
    })
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException('Aborted', 'AbortError')

    const signature = `${method} ${input.split('?')[0]}`
    const fault = this.faults.find((item) => item.times > 0 && item.match.test(signature))
    if (fault) {
      fault.times -= 1
      const outcome = fault.respond()
      if (outcome === 'network') throw new TypeError('fetch failed')
      if (outcome === 'hang') {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
      }
      return outcome
    }
    return this.route(method, input, headers, body)
  }

  private route(method: string, input: string, headers: Headers, body: Buffer | null): Response {
    const url = new URL(input)

    if (url.hostname === 'login.microsoftonline.com') {
      const form = new URLSearchParams(body?.toString('utf8') ?? '')
      const valid =
        url.pathname === `/${fakeTenant}/oauth2/v2.0/token` &&
        form.get('client_id') === fakeClient &&
        form.get('grant_type') === 'client_credentials' &&
        form.get('scope') === 'https://graph.microsoft.com/.default' &&
        (form.get('client_secret') === fakeSecret || form.has('client_assertion'))
      if (this.rejectCredentials || !valid) return json(401, { error: 'invalid_client', error_description: 'AADSTS7000215' })
      const token = `token-ficticio-${randomBytes(12).toString('hex')}`
      this.tokens.set(token, this.clock + this.tokenSeconds * 1000)
      this.issuedTokens.push(token)
      return json(200, { token_type: 'Bearer', expires_in: this.tokenSeconds, access_token: token })
    }

    if (url.hostname === 'slm-ficticio.sharepoint.com') {
      // URLs pré-autenticadas: com token junto, o SharePoint recusa.
      if (headers.get('authorization')) return json(401, { error: { code: 'unauthenticated' } })
      return this.preAuthenticated(method, url, headers, body)
    }

    if (!input.startsWith(`${graph}/drives/${encodeURIComponent(fakeDrive)}`)) return json(404, { error: { code: 'itemNotFound' } })
    const bearer = headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    const expiresAt = this.tokens.get(bearer)
    if (!expiresAt || expiresAt <= this.clock) return json(401, { error: { code: 'InvalidAuthenticationToken' } })

    const rest = input.slice(`${graph}/drives/${encodeURIComponent(fakeDrive)}`.length)
    if (method === 'GET' && rest.startsWith('?')) return json(200, { id: fakeDrive })

    const match = /^\/root:\/(.+?)(:\/createUploadSession|:\/content)?$/.exec(rest)
    if (!match) return json(400, { error: { code: 'invalidRequest' } })
    const path = match[1].split('/').map(decodeURIComponent).join('/')
    const action = match[2]

    if (method === 'POST' && action === ':/createUploadSession') {
      const request = JSON.parse(body?.toString('utf8') ?? '{}')
      if (request.item?.['@microsoft.graph.conflictBehavior'] !== 'fail') return json(400, { error: { code: 'conflictBehaviorRequired' } })
      if (this.files.has(path)) return json(409, { error: { code: 'nameAlreadyExists' } })
      const id = randomBytes(8).toString('hex')
      this.sessions.set(id, { path, total: null, chunks: [], next: 0 })
      return json(200, {
        uploadUrl: `${sharepoint}/upload/${id}?tempauth=temporaria-${randomBytes(8).toString('hex')}`,
        expirationDateTime: new Date(this.clock + 3_600_000).toISOString(),
      })
    }
    if (method === 'GET' && action === ':/content') {
      if (!this.files.has(path)) return json(404, { error: { code: 'itemNotFound' } })
      const id = randomBytes(8).toString('hex')
      this.downloads.set(id, path)
      return new Response(null, {
        status: 302,
        headers: { location: `${sharepoint}/download/${id}?tempauth=temporaria-${randomBytes(8).toString('hex')}` },
      })
    }
    if (method === 'DELETE' && !action) {
      return this.files.delete(path) ? new Response(null, { status: 204 }) : json(404, { error: { code: 'itemNotFound' } })
    }
    return json(400, { error: { code: 'invalidRequest' } })
  }

  private preAuthenticated(method: string, url: URL, headers: Headers, body: Buffer | null): Response {
    const [, kind, id] = url.pathname.split('/')
    if (kind === 'download' && method === 'GET') {
      const path = this.downloads.get(id)
      const content = path ? this.files.get(path) : undefined
      if (!content) return json(404, { error: { code: 'itemNotFound' } })
      return new Response(new Uint8Array(content), { status: 200, headers: { 'content-length': String(content.length) } })
    }
    const session = kind === 'upload' ? this.sessions.get(id) : undefined
    if (!session) return json(404, { error: { code: 'itemNotFound' } })
    if (method === 'DELETE') {
      this.sessions.delete(id)
      return new Response(null, { status: 204 })
    }
    if (method === 'GET') return json(200, { nextExpectedRanges: [`${session.next}-`] })
    if (method !== 'PUT' || !body) return json(400, { error: { code: 'invalidRequest' } })

    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers.get('content-range') ?? '')
    if (!range) return json(400, { error: { code: 'invalidRange' } })
    const [start, end, total] = range.slice(1).map(Number)
    if (start !== session.next || end - start + 1 !== body.length) return json(416, { error: { code: 'invalidRange' } })
    const last = end === total - 1
    if (!last && body.length % (320 * 1024) !== 0) return json(400, { error: { code: 'invalidRange' } })
    session.total = total
    session.chunks.push(body)
    session.next = end + 1
    if (!last) return json(202, { nextExpectedRanges: [`${session.next}-`] })

    this.sessions.delete(id)
    if (this.files.has(session.path)) return json(409, { error: { code: 'nameAlreadyExists' } })
    const content = Buffer.concat(session.chunks)
    this.files.set(session.path, content)
    return json(201, {
      id: randomBytes(8).toString('hex'),
      name: session.path.split('/').pop(),
      size: this.reportWrongSize ? content.length - 1 : content.length,
      file: { mimeType: 'application/octet-stream' },
    })
  }

  openSessions() {
    return this.sessions.size
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

async function bodyOf(body: RequestInit['body']): Promise<Buffer | null> {
  if (body === undefined || body === null) return null
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof URLSearchParams) return Buffer.from(body.toString())
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  return Buffer.from(await new Response(body as BodyInit).arrayBuffer())
}
