import { PassThrough, pipeline, Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { AttachmentStorage } from './storage.js'
import { createTokenSource, GraphStorageError } from './graphAuth.js'
import type { FetchLike, GraphCredentials, TokenSource } from './graphAuth.js'

/**
 * Anexos em uma biblioteca de documentos do SharePoint institucional, pelo Microsoft Graph.
 *
 * - Envio sempre por sessão de upload (createUploadSession), em partes múltiplas de 320 KiB, com
 *   "conflictBehavior: fail": um arquivo existente nunca é substituído.
 * - Leitura sempre pelo servidor do SLM: a URL temporária de download e o token nunca saem
 *   daqui, e o navegador só recebe o conteúdo depois de o SLM conferir a permissão.
 * - Nenhum link de compartilhamento, convite ou permissão é criado.
 * - 429 e 503 respeitam Retry-After; sem o cabeçalho, espera crescente com variação aleatória.
 */

export const graphBaseUrl = 'https://graph.microsoft.com/v1.0'

/** O Graph exige partes múltiplas de 320 KiB e no máximo 60 MiB; 5 MiB é o tamanho sugerido. */
export const uploadFragmentUnit = 320 * 1024
export const maxFragmentBytes = 60 * 1024 * 1024
const defaultFragmentBytes = 16 * uploadFragmentUnit

export type GraphStorageSettings = {
  credentials: GraphCredentials
  driveId: string
  /** Pasta da biblioteca, como "SLM/Anexos". Criada pelo próprio envio, se ainda não existir. */
  rootFolder: string
}

export type GraphStorageOptions = {
  fetcher?: FetchLike
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  /** Limite de cada chamada até a resposta; na leitura, também o intervalo máximo sem dados. */
  timeoutMs?: number
  maxAttempts?: number
  /** Retry-After acima disto não é aguardado: o pedido falha logo, e pode ser repetido depois. */
  maxRetryAfterMs?: number
  fragmentBytes?: number
}

type SettingsProblem = { variable: string; message: string }

const keyPattern = /^[0-9a-f-]{36}$/
const guidOrDomain = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const driveIdPattern = /^[A-Za-z0-9!_-]{10,200}$/
const folderSegment = /^[A-Za-z0-9 _.-]{1,80}$/
const thumbprintPattern = /^[0-9a-f]{40}$/i
export const defaultRootFolder = 'SLM-Anexos'

const read = (environment: NodeJS.ProcessEnv, name: string) => environment[name]?.trim() ?? ''

/** Pasta raiz sem "..", barra inicial ou caractere que o SharePoint recusa. */
export function rootFolderProblem(raw: string): string | null {
  const segments = raw.split('/')
  if (segments.some((segment) => !folderSegment.test(segment) || /^\.+$/.test(segment) || segment !== segment.trim())) {
    return 'use só letras, números, espaço, ponto, hífen e sublinhado, separados por "/"'
  }
  return null
}

/**
 * Lê a configuração do SharePoint. Nunca devolve os valores nos problemas, só o nome da variável.
 * O segredo e o certificado são alternativos: com os dois, a escolha seria ambígua.
 */
export function graphStorageSettings(
  environment: NodeJS.ProcessEnv,
): { ok: true; value: GraphStorageSettings } | { ok: false; problems: SettingsProblem[] } {
  const problems: SettingsProblem[] = []
  const tenantId = read(environment, 'GRAPH_TENANT_ID')
  const clientId = read(environment, 'GRAPH_CLIENT_ID')
  const clientSecret = read(environment, 'GRAPH_CLIENT_SECRET')
  const privateKey = read(environment, 'GRAPH_CERTIFICATE_PRIVATE_KEY').replace(/\\n/g, '\n')
  const thumbprint = read(environment, 'GRAPH_CERTIFICATE_THUMBPRINT').replace(/[\s:]/g, '')
  const driveId = read(environment, 'SHAREPOINT_DRIVE_ID')
  const rootFolder = read(environment, 'SHAREPOINT_ROOT_FOLDER') || defaultRootFolder

  if (!tenantId) problems.push({ variable: 'GRAPH_TENANT_ID', message: 'Ausente.' })
  else if (!guidOrDomain.test(tenantId)) problems.push({ variable: 'GRAPH_TENANT_ID', message: 'Use o ID do locatário (GUID) ou o domínio.' })
  if (!clientId) problems.push({ variable: 'GRAPH_CLIENT_ID', message: 'Ausente.' })
  else if (!guid.test(clientId)) problems.push({ variable: 'GRAPH_CLIENT_ID', message: 'Precisa ser o ID do aplicativo (GUID).' })

  const certificate = Boolean(privateKey || thumbprint)
  if (clientSecret && certificate) {
    problems.push({ variable: 'GRAPH_CLIENT_SECRET / GRAPH_CERTIFICATE_*', message: 'Use segredo ou certificado, não os dois.' })
  } else if (!clientSecret && !certificate) {
    problems.push({ variable: 'GRAPH_CLIENT_SECRET / GRAPH_CERTIFICATE_*', message: 'Ausentes: informe o segredo ou o certificado do aplicativo.' })
  } else if (certificate) {
    if (!privateKey.includes('PRIVATE KEY')) {
      problems.push({ variable: 'GRAPH_CERTIFICATE_PRIVATE_KEY', message: 'Não parece uma chave privada PEM.' })
    }
    if (!thumbprintPattern.test(thumbprint)) {
      problems.push({ variable: 'GRAPH_CERTIFICATE_THUMBPRINT', message: 'Precisa ser a impressão digital SHA-1 (40 hexadecimais).' })
    }
  }

  if (!driveId) problems.push({ variable: 'SHAREPOINT_DRIVE_ID', message: 'Ausente.' })
  else if (!driveIdPattern.test(driveId)) problems.push({ variable: 'SHAREPOINT_DRIVE_ID', message: 'Formato inesperado para o ID da biblioteca.' })
  const folder = rootFolderProblem(rootFolder)
  if (folder) problems.push({ variable: 'SHAREPOINT_ROOT_FOLDER', message: `Inválida: ${folder}.` })

  if (problems.length > 0) return { ok: false, problems }
  const credentials: GraphCredentials = clientSecret
    ? { kind: 'secret', tenantId, clientId, clientSecret }
    : { kind: 'certificate', tenantId, clientId, privateKey, thumbprint: thumbprint.toLowerCase() }
  return { ok: true, value: { credentials, driveId, rootFolder } }
}

const retryableStatuses = new Set([429, 500, 502, 503, 504])

/** Retry-After em segundos ou como data HTTP. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const date = Date.parse(trimmed)
  return Number.isNaN(date) ? null : Math.max(0, date - now)
}

function failureOf(status: number) {
  if (status === 429) return new GraphStorageError('GRAPH_THROTTLED', true, status)
  if (status === 503) return new GraphStorageError('GRAPH_UNAVAILABLE', true, status)
  if (status === 401) return new GraphStorageError('GRAPH_AUTH_REJECTED', false, status)
  // Sem a concessão do site (Sites.Selected), o Graph responde 403.
  if (status === 403) return new GraphStorageError('GRAPH_FORBIDDEN', false, status)
  if (status === 404) return new GraphStorageError('ENOENT', false, status)
  if (status === 409) return new GraphStorageError('EEXIST', false, status)
  if (status === 507) return new GraphStorageError('ENOSPC', false, status)
  return new GraphStorageError(`GRAPH_HTTP_${status}`, retryableStatuses.has(status), status)
}

type SendOptions = {
  /** Envia o token. As URLs pré-autenticadas do upload e do download nunca recebem o token. */
  auth: boolean
  /** Para a leitura: o limite vale só até a resposta, e o corpo segue sob o controle de open(). */
  streaming?: boolean
}

type Sent = { response: Response; controller: AbortController }

const isHttps = (raw: string) => {
  try {
    return new URL(raw).protocol === 'https:'
  } catch {
    return false
  }
}

async function discard(response: Response) {
  await response.body?.cancel().catch(() => undefined)
}

export class GraphDriveStorage implements AttachmentStorage {
  private readonly fetcher: FetchLike
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly maxRetryAfterMs: number
  private readonly fragmentBytes: number
  private readonly tokens: TokenSource

  constructor(
    private readonly settings: GraphStorageSettings,
    options: GraphStorageOptions = {},
  ) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init))
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)))
    this.random = options.random ?? Math.random
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 4)
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 30_000
    const fragment = options.fragmentBytes ?? defaultFragmentBytes
    if (fragment % uploadFragmentUnit !== 0 || fragment <= 0 || fragment > maxFragmentBytes) {
      throw new Error('O tamanho das partes precisa ser múltiplo de 320 KiB, até 60 MiB.')
    }
    this.fragmentBytes = fragment
    this.tokens = createTokenSource(settings.credentials, {
      fetcher: this.fetcher,
      now: this.now,
      timeoutMs: this.timeoutMs,
    })
  }

  // -------------------------------------------------------------------------
  // Endereços
  // -------------------------------------------------------------------------

  private driveUrl() {
    return `${graphBaseUrl}/drives/${encodeURIComponent(this.settings.driveId)}`
  }

  /** Mesma divisão do disco local: dois primeiros caracteres da chave, depois a chave. */
  private itemUrl(key: string) {
    if (!keyPattern.test(key)) throw new Error('Chave de anexo inválida.')
    const segments = [...this.settings.rootFolder.split('/'), key.slice(0, 2), key].map(encodeURIComponent)
    return `${this.driveUrl()}/root:/${segments.join('/')}`
  }

  // -------------------------------------------------------------------------
  // Chamada com limite de tempo, renovação de token e novas tentativas
  // -------------------------------------------------------------------------

  private backoff(attempt: number) {
    return Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.floor(this.random() * 250)
  }

  private async send(build: () => { url: string; init: RequestInit }, options: SendOptions): Promise<Sent> {
    let renewed = false
    for (let attempt = 1; ; attempt += 1) {
      const last = attempt >= this.maxAttempts
      const { url, init } = build()
      const headers = new Headers(init.headers)
      if (options.auth) {
        try {
          headers.set('authorization', `Bearer ${await this.tokens.token()}`)
        } catch (error) {
          if (error instanceof GraphStorageError && error.retryable && !last) {
            await this.sleep(this.backoff(attempt))
            continue
          }
          throw error
        }
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new GraphStorageError('GRAPH_TIMEOUT', true)), this.timeoutMs)
      let response: Response
      try {
        // "manual": o download redireciona para uma URL temporária, seguida sem o token.
        response = await this.fetcher(url, { ...init, headers, signal: controller.signal, redirect: 'manual' })
      } catch (error) {
        clearTimeout(timer)
        const timedOut = controller.signal.aborted || (error as Error)?.name === 'TimeoutError'
        if (!last) {
          await this.sleep(this.backoff(attempt))
          continue
        }
        throw new GraphStorageError(timedOut ? 'GRAPH_TIMEOUT' : 'GRAPH_NETWORK', true)
      }
      if (options.streaming) clearTimeout(timer)

      // Token vencido ou revogado antes do previsto: um novo, uma única vez.
      if (response.status === 401 && options.auth && !renewed) {
        clearTimeout(timer)
        await discard(response)
        this.tokens.invalidate()
        renewed = true
        continue
      }

      if (retryableStatuses.has(response.status)) {
        clearTimeout(timer)
        await discard(response)
        const failure = failureOf(response.status)
        const wait = retryAfterMs(response.headers.get('retry-after'), this.now()) ?? this.backoff(attempt)
        if (last || wait > this.maxRetryAfterMs) throw failure
        await this.sleep(wait)
        continue
      }

      if (!options.streaming) {
        // Corpo pequeno (JSON): o mesmo limite vale até a leitura terminar.
        const body = await response.arrayBuffer().catch(() => {
          throw new GraphStorageError(controller.signal.aborted ? 'GRAPH_TIMEOUT' : 'GRAPH_NETWORK', true)
        }).finally(() => clearTimeout(timer))
        return {
          response: new Response(response.status === 204 || response.status === 304 ? null : body, {
            status: response.status,
            headers: response.headers,
          }),
          controller,
        }
      }
      return { response, controller }
    }
  }

  private async json<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T
    } catch {
      throw new GraphStorageError('GRAPH_INVALID_RESPONSE', true, response.status)
    }
  }

  // -------------------------------------------------------------------------
  // AttachmentStorage
  // -------------------------------------------------------------------------

  async save(key: string, content: Buffer) {
    const item = this.itemUrl(key)
    if (content.length === 0) throw new GraphStorageError('GRAPH_EMPTY_FILE', false)

    const created = await this.send(
      () => ({
        url: `${item}:/createUploadSession`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // "fail": se já existir um arquivo neste caminho, o Graph recusa em vez de substituir.
          body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'fail' } }),
        },
      }),
      { auth: true },
    )
    if (!created.response.ok) throw failureOf(created.response.status)
    const session = await this.json<{ uploadUrl?: unknown }>(created.response)
    const uploadUrl = typeof session.uploadUrl === 'string' && isHttps(session.uploadUrl) ? session.uploadUrl : null
    if (!uploadUrl) throw new GraphStorageError('GRAPH_INVALID_RESPONSE', true)

    let completed = false
    try {
      await this.uploadFragments(uploadUrl, item, content)
      completed = true
    } finally {
      // Envio interrompido: a sessão é cancelada, sem deixar parte do arquivo na biblioteca.
      if (!completed) {
        await this.send(() => ({ url: uploadUrl, init: { method: 'DELETE' } }), { auth: false }).catch(() => undefined)
      }
    }
  }

  private async uploadFragments(uploadUrl: string, item: string, content: Buffer) {
    const total = content.length
    let offset = 0
    let stalled = 0
    for (;;) {
      const end = Math.min(offset + this.fragmentBytes, total) - 1
      const start = offset
      const { response } = await this.send(
        () => ({
          url: uploadUrl,
          init: {
            method: 'PUT',
            // A URL da sessão já é autorizada; o token não vai junto, como pede a documentação.
            headers: { 'content-range': `bytes ${start}-${end}/${total}` },
            body: new Uint8Array(content.subarray(start, end + 1)),
          },
        }),
        { auth: false },
      )

      if (response.status === 200 || response.status === 201) {
        const stored = await this.json<{ size?: unknown; file?: unknown }>(response)
        if (stored.size !== total || !stored.file) {
          // Chegou diferente do enviado: o arquivo é retirado e o envio, recusado.
          await this.deleteItem(item).catch(() => undefined)
          throw new GraphStorageError('GRAPH_INTEGRITY', false)
        }
        return
      }
      if (response.status === 202) {
        const next = this.nextOffset(await this.json<{ nextExpectedRanges?: unknown }>(response))
        if (next === null || next >= total) throw new GraphStorageError('GRAPH_UPLOAD_STALLED', true)
        stalled = next > offset ? 0 : stalled + 1
        if (stalled > 2) throw new GraphStorageError('GRAPH_UPLOAD_STALLED', true)
        offset = next
        continue
      }
      // Parte já recebida em uma tentativa anterior: pergunta à sessão de onde continuar.
      if (response.status === 416) {
        const status = await this.send(() => ({ url: uploadUrl, init: { method: 'GET' } }), { auth: false })
        if (!status.response.ok) throw new GraphStorageError('GRAPH_UPLOAD_SESSION_LOST', true, status.response.status)
        const next = this.nextOffset(await this.json<{ nextExpectedRanges?: unknown }>(status.response))
        stalled += 1
        if (next === null || stalled > 2) throw new GraphStorageError('GRAPH_UPLOAD_STALLED', true)
        offset = next
        continue
      }
      if (response.status === 404) throw new GraphStorageError('GRAPH_UPLOAD_SESSION_EXPIRED', true, 404)
      throw failureOf(response.status)
    }
  }

  private nextOffset(body: { nextExpectedRanges?: unknown }) {
    const ranges = body.nextExpectedRanges
    if (!Array.isArray(ranges) || typeof ranges[0] !== 'string') return null
    const match = /^(\d+)-/.exec(ranges[0])
    return match ? Number(match[1]) : null
  }

  async open(key: string): Promise<Readable> {
    const item = this.itemUrl(key)
    const first = await this.send(() => ({ url: `${item}:/content`, init: { method: 'GET' } }), {
      auth: true,
      streaming: true,
    })
    let sent = first
    if ([301, 302, 303, 307, 308].includes(first.response.status)) {
      const location = first.response.headers.get('location')
      await discard(first.response)
      if (!location || !isHttps(location)) throw new GraphStorageError('GRAPH_INVALID_RESPONSE', true)
      // URL temporária e pré-autenticada: usada só aqui, sem o token, e nunca registrada.
      sent = await this.send(() => ({ url: location, init: { method: 'GET' } }), { auth: false, streaming: true })
    }
    if (!sent.response.ok || !sent.response.body) {
      await discard(sent.response)
      throw failureOf(sent.response.status)
    }
    return this.guardedStream(sent)
  }

  /** Interrompe a leitura parada por mais que o limite; o erro não traz URL nem token. */
  private guardedStream({ response, controller }: Sent): Readable {
    const source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>)
    const output = new PassThrough()
    let timer: NodeJS.Timeout | undefined
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => source.destroy(new GraphStorageError('GRAPH_TIMEOUT', true)), this.timeoutMs)
    }
    arm()
    source.on('data', arm)
    pipeline(source, output, (error) => {
      clearTimeout(timer)
      controller.abort()
      if (error && !output.destroyed) {
        output.destroy(error instanceof GraphStorageError ? error : new GraphStorageError('GRAPH_DOWNLOAD_INTERRUPTED', true))
      }
    })
    return output
  }

  /** Remoção física: só para desfazer um envio que o banco recusou. A lixeira do site guarda uma cópia. */
  async remove(key: string) {
    await this.deleteItem(this.itemUrl(key))
  }

  private async deleteItem(item: string) {
    const { response } = await this.send(() => ({ url: item, init: { method: 'DELETE' } }), { auth: true })
    if (response.ok || response.status === 404) return
    throw failureOf(response.status)
  }

  /** Confere credencial, permissão no site e acesso à biblioteca, sem gravar nada. */
  async check() {
    const { response } = await this.send(
      () => ({ url: `${this.driveUrl()}?$select=id`, init: { method: 'GET' } }),
      { auth: true },
    )
    if (!response.ok) throw failureOf(response.status)
  }
}
