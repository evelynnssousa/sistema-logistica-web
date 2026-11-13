import { createHash } from 'node:crypto'
import { PassThrough, pipeline, Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { FetchLike } from './graphAuth.js'
import { StorageProviderError } from './providerError.js'
import type { AttachmentStorage } from './storage.js'

/**
 * Anexos em um bucket PRIVADO do Supabase Storage, pela API REST, com a chave secreta do projeto.
 *
 * - O envio nunca substitui: "x-upsert: false"; arquivo existente é erro EEXIST.
 * - A leitura passa sempre pelo servidor do SLM: nenhuma URL assinada ou pública é criada, e o
 *   navegador só recebe o conteúdo depois de o SLM conferir a permissão.
 * - Bucket público é recusado: a conferência e o primeiro envio verificam que ele é privado.
 * - 429 e 5xx são repetidos com espera crescente; a chave nunca aparece em erro ou registro.
 */

export class SupabaseStorageError extends StorageProviderError {
  constructor(code: string, retryable: boolean, status: number | null = null) {
    super(code, retryable, status, `Falha no armazenamento Supabase (${code}).`)
    this.name = 'SupabaseStorageError'
  }
}

export type SupabaseStorageSettings = {
  /** Endereço do projeto, como https://abcdefgh.supabase.co, sem barra no fim. */
  projectUrl: string
  /** Chave secreta (sb_secret_...) ou a antiga service_role (JWT). Nunca a publicável/anon. */
  secretKey: string
  bucket: string
}

export type SupabaseStorageOptions = {
  fetcher?: FetchLike
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  /** Limite de cada chamada até a resposta; na leitura, também o intervalo máximo sem dados. */
  timeoutMs?: number
  maxAttempts?: number
}

type SettingsProblem = { variable: string; message: string }

const keyPattern = /^[0-9a-f-]{36}$/
const bucketPattern = /^[a-z0-9][a-z0-9_-]{1,62}$/
export const defaultBucket = 'slm-anexos'

const read = (environment: NodeJS.ProcessEnv, name: string) => environment[name]?.trim() ?? ''

/** Papel gravado na chave antiga (JWT), sem conferir a assinatura: só para recusar a "anon". */
function legacyKeyRole(key: string): string | null {
  const payload = key.split('.')[1]
  if (!payload) return null
  try {
    const role = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { role?: unknown }).role
    return typeof role === 'string' ? role : null
  } catch {
    return null
  }
}

function projectUrlOf(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
    if (url.pathname !== '/' && url.pathname !== '') return null
    return url.origin
  } catch {
    return null
  }
}

/** Lê a configuração do Supabase Storage. Os problemas trazem só o nome da variável. */
export function supabaseStorageSettings(
  environment: NodeJS.ProcessEnv,
): { ok: true; value: SupabaseStorageSettings } | { ok: false; problems: SettingsProblem[] } {
  const problems: SettingsProblem[] = []
  const rawUrl = read(environment, 'SUPABASE_URL')
  const secretKey = read(environment, 'SUPABASE_SECRET_KEY')
  const bucket = read(environment, 'SUPABASE_STORAGE_BUCKET') || defaultBucket

  const projectUrl = rawUrl ? projectUrlOf(rawUrl) : null
  if (!rawUrl) problems.push({ variable: 'SUPABASE_URL', message: 'Ausente.' })
  else if (!projectUrl) {
    problems.push({ variable: 'SUPABASE_URL', message: 'Use o endereço do projeto, como https://abcdefgh.supabase.co, sem caminho.' })
  }

  if (!secretKey) problems.push({ variable: 'SUPABASE_SECRET_KEY', message: 'Ausente.' })
  else if (secretKey.startsWith('sb_publishable_')) {
    problems.push({ variable: 'SUPABASE_SECRET_KEY', message: 'É a chave publicável: use a chave secreta (sb_secret_...).' })
  } else if (secretKey.startsWith('eyJ')) {
    const role = legacyKeyRole(secretKey)
    if (role !== 'service_role') {
      problems.push({ variable: 'SUPABASE_SECRET_KEY', message: 'A chave antiga precisa ser a "service_role", não a "anon".' })
    }
  } else if (!/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(secretKey)) {
    problems.push({ variable: 'SUPABASE_SECRET_KEY', message: 'Formato inesperado: use a chave secreta (sb_secret_...).' })
  }

  if (!bucketPattern.test(bucket)) {
    problems.push({ variable: 'SUPABASE_STORAGE_BUCKET', message: 'Use só letras minúsculas, números, hífen e sublinhado.' })
  }

  if (problems.length > 0 || !projectUrl) return { ok: false, problems }
  return { ok: true, value: { projectUrl, secretKey, bucket } }
}

const retryableStatuses = new Set([429, 500, 502, 503, 504])

/**
 * O Supabase Storage às vezes responde 400 com o status verdadeiro no corpo
 * ({"statusCode":"404","error":"not_found"}). Devolve o status efetivo.
 */
async function effectiveStatus(response: Response): Promise<number> {
  if (response.status !== 400) return response.status
  try {
    const body = (await response.clone().json()) as { statusCode?: unknown; error?: unknown }
    const inner = Number(body.statusCode)
    if (inner === 404 || inner === 409) return inner
    if (typeof body.error === 'string' && /duplicate|already exists/i.test(body.error)) return 409
    if (typeof body.error === 'string' && /not.?found/i.test(body.error)) return 404
  } catch {
    // Corpo não é JSON: fica o 400.
  }
  return 400
}

function failureOf(status: number) {
  if (status === 401) return new SupabaseStorageError('SUPABASE_AUTH_REJECTED', false, status)
  if (status === 403) return new SupabaseStorageError('SUPABASE_FORBIDDEN', false, status)
  if (status === 404) return new SupabaseStorageError('ENOENT', false, status)
  if (status === 409) return new SupabaseStorageError('EEXIST', false, status)
  // Arquivo acima do limite do projeto (50 MB no plano gratuito) ou cota esgotada.
  if (status === 413) return new SupabaseStorageError('ENOSPC', false, status)
  if (status === 429) return new SupabaseStorageError('SUPABASE_THROTTLED', true, status)
  if (status === 503) return new SupabaseStorageError('SUPABASE_UNAVAILABLE', true, status)
  return new SupabaseStorageError(`SUPABASE_HTTP_${status}`, retryableStatuses.has(status), status)
}

async function discard(response: Response) {
  await response.body?.cancel().catch(() => undefined)
}

type Sent = { response: Response; controller: AbortController; attempt: number }

export class SupabaseStorage implements AttachmentStorage {
  private readonly fetcher: FetchLike
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private privateConfirmed = false

  constructor(
    private readonly settings: SupabaseStorageSettings,
    options: SupabaseStorageOptions = {},
  ) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init))
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)))
    this.random = options.random ?? Math.random
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3)
  }

  // -------------------------------------------------------------------------
  // Endereços
  // -------------------------------------------------------------------------

  /** Mesma divisão do disco local: dois primeiros caracteres da chave, depois a chave. */
  private objectPath(key: string) {
    if (!keyPattern.test(key)) throw new Error('Chave de anexo inválida.')
    return `${encodeURIComponent(this.settings.bucket)}/${key.slice(0, 2)}/${key}`
  }

  private url(path: string) {
    return `${this.settings.projectUrl}/storage/v1/${path}`
  }

  private headers(extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { apikey: this.settings.secretKey, ...extra }
    // A chave antiga é um JWT e vai também no Authorization; a nova (sb_secret_) só no apikey.
    if (this.settings.secretKey.startsWith('eyJ')) headers.authorization = `Bearer ${this.settings.secretKey}`
    return headers
  }

  // -------------------------------------------------------------------------
  // Chamada com limite de tempo e novas tentativas
  // -------------------------------------------------------------------------

  private backoff(attempt: number) {
    return Math.min(500 * 2 ** (attempt - 1), 4000) + Math.floor(this.random() * 250)
  }

  private async send(url: string, init: RequestInit, streaming = false): Promise<Sent> {
    for (let attempt = 1; ; attempt += 1) {
      const last = attempt >= this.maxAttempts
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new SupabaseStorageError('SUPABASE_TIMEOUT', true)), this.timeoutMs)
      let response: Response
      try {
        response = await this.fetcher(url, { ...init, signal: controller.signal, redirect: 'error' })
      } catch (error) {
        clearTimeout(timer)
        const timedOut = controller.signal.aborted || (error as Error)?.name === 'TimeoutError'
        if (!last) {
          await this.sleep(this.backoff(attempt))
          continue
        }
        throw new SupabaseStorageError(timedOut ? 'SUPABASE_TIMEOUT' : 'SUPABASE_NETWORK', true)
      }
      if (retryableStatuses.has(response.status)) {
        clearTimeout(timer)
        await discard(response)
        if (last) throw failureOf(response.status)
        await this.sleep(this.backoff(attempt))
        continue
      }
      if (!streaming) {
        // Corpo pequeno (JSON): o limite vale até a leitura terminar.
        const body = await response
          .arrayBuffer()
          .catch(() => {
            throw new SupabaseStorageError(controller.signal.aborted ? 'SUPABASE_TIMEOUT' : 'SUPABASE_NETWORK', true)
          })
          .finally(() => clearTimeout(timer))
        return {
          response: new Response(response.status === 204 ? null : body, { status: response.status, headers: response.headers }),
          controller,
          attempt,
        }
      }
      clearTimeout(timer)
      return { response, controller, attempt }
    }
  }

  // -------------------------------------------------------------------------
  // AttachmentStorage
  // -------------------------------------------------------------------------

  async save(key: string, content: Buffer) {
    const path = this.objectPath(key)
    if (content.length === 0) throw new SupabaseStorageError('SUPABASE_EMPTY_FILE', false)
    if (!this.privateConfirmed) await this.check()

    const { response, attempt } = await this.send(this.url(`object/${path}`), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/octet-stream', 'x-upsert': 'false', 'cache-control': 'no-store' }),
      body: new Uint8Array(content),
    })
    if (response.ok) return
    const status = await effectiveStatus(response)
    // "Já existe" depois de uma tentativa que caiu: pode ser o próprio envio anterior. Só é
    // aceito se o conteúdo guardado for idêntico ao enviado; caso contrário, é conflito real.
    if (status === 409 && attempt > 1 && (await this.storedMatches(key, content))) return
    throw failureOf(status)
  }

  private async storedMatches(key: string, content: Buffer) {
    try {
      const stream = await this.open(key)
      const hash = createHash('sha256')
      let size = 0
      for await (const chunk of stream) {
        size += (chunk as Buffer).length
        if (size > content.length) return false
        hash.update(chunk as Buffer)
      }
      return size === content.length && hash.digest('hex') === createHash('sha256').update(content).digest('hex')
    } catch {
      return false
    }
  }

  async open(key: string): Promise<Readable> {
    const path = this.objectPath(key)
    const sent = await this.send(this.url(`object/authenticated/${path}`), { method: 'GET', headers: this.headers() }, true)
    if (!sent.response.ok || !sent.response.body) {
      const status = await effectiveStatus(sent.response)
      await discard(sent.response)
      throw failureOf(status)
    }
    return this.guardedStream(sent)
  }

  /** Interrompe a leitura parada por mais que o limite; o erro não traz URL nem chave. */
  private guardedStream({ response, controller }: Sent): Readable {
    const source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>)
    const output = new PassThrough()
    let timer: NodeJS.Timeout | undefined
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => source.destroy(new SupabaseStorageError('SUPABASE_TIMEOUT', true)), this.timeoutMs)
    }
    arm()
    source.on('data', arm)
    pipeline(source, output, (error) => {
      clearTimeout(timer)
      controller.abort()
      if (error && !output.destroyed) {
        output.destroy(error instanceof SupabaseStorageError ? error : new SupabaseStorageError('SUPABASE_DOWNLOAD_INTERRUPTED', true))
      }
    })
    return output
  }

  /** Remoção física: só para desfazer um envio que o banco recusou, ou na limpeza dos testes. */
  async remove(key: string) {
    const { response } = await this.send(this.url(`object/${this.objectPath(key)}`), { method: 'DELETE', headers: this.headers() })
    if (response.ok) return
    const status = await effectiveStatus(response)
    if (status === 404) return
    throw failureOf(status)
  }

  /** Confere a chave e o acesso ao bucket, e recusa bucket público. Não grava nada. */
  async check() {
    const { response } = await this.send(this.url(`bucket/${encodeURIComponent(this.settings.bucket)}`), {
      method: 'GET',
      headers: this.headers(),
    })
    if (!response.ok) {
      const status = await effectiveStatus(response)
      throw status === 404 ? new SupabaseStorageError('SUPABASE_BUCKET_MISSING', false, 404) : failureOf(status)
    }
    let bucket: { public?: unknown }
    try {
      bucket = (await response.json()) as { public?: unknown }
    } catch {
      throw new SupabaseStorageError('SUPABASE_INVALID_RESPONSE', true, response.status)
    }
    if (bucket.public !== false) {
      this.privateConfirmed = false
      throw new SupabaseStorageError('SUPABASE_BUCKET_PUBLIC', false)
    }
    this.privateConfirmed = true
  }
}
