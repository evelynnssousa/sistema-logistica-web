import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'
import { checkEnvironment } from '../config/environmentCheck.js'
import { StorageProviderError } from './providerError.js'
import { isStorageFailure, resolveAttachmentStorage } from './storage.js'
import { SupabaseStorage, SupabaseStorageError, supabaseStorageSettings } from './supabaseStorage.js'
import type { SupabaseStorageSettings } from './supabaseStorage.js'

// Supabase Storage simulado: nenhuma conta real, nenhuma conexão para fora.

const projectUrl = 'https://abcdefghijkl.supabase.co'
const secretKey = 'sb_secret_testeTesteTeste1234567890'
const settings: SupabaseStorageSettings = { projectUrl, secretKey, bucket: 'slm-anexos' }
const jwt = (role: string) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.assinatura`

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Call = { method: string; path: string; headers: Headers }

class FakeSupabase {
  readonly objects = new Map<string, Buffer>()
  readonly calls: Call[] = []
  bucketPublic = false
  bucketExists = true
  /** Respostas forçadas, consumidas em ordem, antes da lógica normal. */
  readonly queued: Array<(call: Call, body: Buffer | null) => Response | Promise<Response> | 'network'> = []
  /** Formato antigo: 400 com o status verdadeiro no corpo. */
  legacyErrors = false

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input)
    assert.equal(url.origin, projectUrl)
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    assert.equal(headers.get('apikey'), secretKey, 'chave sempre no apikey')
    const call = { method, path: url.pathname, headers }
    this.calls.push(call)
    const body = init.body ? Buffer.from(init.body as Uint8Array) : null
    const forced = this.queued.shift()
    if (forced) {
      const result = await forced(call, body)
      if (result === 'network') throw new TypeError('fetch failed')
      return result
    }
    return this.handle(call, body)
  }

  private error(status: number, error: string) {
    return this.legacyErrors ? json(400, { statusCode: String(status), error, message: error }) : json(status, { error })
  }

  handle(call: Call, body: Buffer | null): Response {
    const prefix = '/storage/v1/'
    assert.ok(call.path.startsWith(prefix))
    const rest = call.path.slice(prefix.length)
    if (call.method === 'GET' && rest === 'bucket/slm-anexos') {
      return this.bucketExists ? json(200, { id: 'slm-anexos', public: this.bucketPublic }) : this.error(404, 'Bucket not found')
    }
    const read = /^object\/authenticated\/slm-anexos\/(.+)$/.exec(rest)
    if (call.method === 'GET' && read) {
      const stored = this.objects.get(read[1])
      return stored ? new Response(new Uint8Array(stored), { status: 200 }) : this.error(404, 'not_found')
    }
    const object = /^object\/slm-anexos\/(.+)$/.exec(rest)
    if (object && call.method === 'POST') {
      assert.equal(call.headers.get('x-upsert'), 'false', 'nunca substitui')
      if (this.objects.has(object[1])) return this.error(409, 'Duplicate')
      this.objects.set(object[1], body ?? Buffer.alloc(0))
      return json(200, { Key: `slm-anexos/${object[1]}` })
    }
    if (object && call.method === 'DELETE') {
      if (!this.objects.delete(object[1])) return this.error(404, 'not_found')
      return json(200, { message: 'Successfully deleted' })
    }
    return json(400, { error: 'rota inesperada' })
  }
}

const storageWith = (fake: FakeSupabase, extra: Partial<SupabaseStorageSettings> = {}) =>
  new SupabaseStorage({ ...settings, ...extra }, { fetcher: fake.fetch, sleep: async () => undefined, random: () => 0 })

async function readAll(stream: Readable) {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected

test('envio, leitura e remoção no bucket privado, na mesma divisão de pastas do disco', async () => {
  const fake = new FakeSupabase()
  const storage = storageWith(fake)
  const key = randomUUID()
  const file = randomBytes(5000)

  await storage.save(key, file)
  assert.deepEqual(fake.objects.get(`${key.slice(0, 2)}/${key}`), file)
  assert.deepEqual(await readAll(await storage.open(key)), file)
  assert.equal(fake.calls.filter((call) => call.path.endsWith('bucket/slm-anexos')).length, 1, 'privacidade conferida uma vez')

  await assert.rejects(storage.save(key, randomBytes(10)), code('EEXIST'))
  assert.deepEqual(fake.objects.get(`${key.slice(0, 2)}/${key}`), file, 'existente nunca é substituído')

  await storage.remove(key)
  await storage.remove(key) // ausente: não é erro
  await assert.rejects(storage.open(key), code('ENOENT'))
  assert.equal(fake.calls.some((call) => call.headers.has('authorization')), false, 'chave nova só no apikey')
})

test('formato antigo de erro (400 com o status no corpo) tem o mesmo sentido', async () => {
  const fake = new FakeSupabase()
  fake.legacyErrors = true
  const storage = storageWith(fake)
  const key = randomUUID()
  await storage.save(key, randomBytes(10))
  await assert.rejects(storage.save(key, randomBytes(10)), code('EEXIST'))
  await assert.rejects(storage.open(randomUUID()), code('ENOENT'))
  await storage.remove(randomUUID())
})

test('bucket público ou ausente: recusado, e nada é gravado', async () => {
  const fake = new FakeSupabase()
  fake.bucketPublic = true
  const storage = storageWith(fake)
  await assert.rejects(storage.check(), code('SUPABASE_BUCKET_PUBLIC'))
  await assert.rejects(storage.save(randomUUID(), randomBytes(10)), code('SUPABASE_BUCKET_PUBLIC'))
  assert.equal(fake.objects.size, 0)

  const missing = new FakeSupabase()
  missing.bucketExists = false
  await assert.rejects(storageWith(missing).check(), code('SUPABASE_BUCKET_MISSING'))
})

test('falhas temporárias são repetidas; chave recusada não', async () => {
  const fake = new FakeSupabase()
  const storage = storageWith(fake)
  await storage.check()
  fake.queued.push(() => json(503, {}), () => 'network')
  const key = randomUUID()
  await storage.save(key, randomBytes(100))
  assert.ok(fake.objects.has(`${key.slice(0, 2)}/${key}`))

  fake.queued.push(() => json(503, {}), () => json(503, {}), () => json(503, {}))
  await assert.rejects(storage.open(key), (error: unknown) => error instanceof SupabaseStorageError && error.retryable)

  fake.queued.push(() => json(401, {}))
  const before = fake.calls.length
  await assert.rejects(storage.open(key), code('SUPABASE_AUTH_REJECTED'))
  assert.equal(fake.calls.length, before + 1, 'sem nova tentativa')
})

test('resposta perdida depois do envio: aceita só se o conteúdo guardado for idêntico', async () => {
  const fake = new FakeSupabase()
  const storage = storageWith(fake)
  await storage.check()
  const key = randomUUID()
  const file = randomBytes(2000)
  // A primeira tentativa grava, mas a resposta não chega.
  fake.queued.push((call, body) => {
    fake.handle(call, body)
    return 'network'
  })
  await storage.save(key, file)
  assert.deepEqual(fake.objects.get(`${key.slice(0, 2)}/${key}`), file)

  const other = randomUUID()
  fake.objects.set(`${other.slice(0, 2)}/${other}`, randomBytes(2000))
  fake.queued.push(() => 'network')
  await assert.rejects(storage.save(other, file), code('EEXIST'), 'conteúdo diferente é conflito')
})

test('chave antiga (JWT): vai também no Authorization; a "anon" é recusada', async () => {
  const legacy = jwt('service_role')
  assert.equal(supabaseStorageSettings({ SUPABASE_URL: projectUrl, SUPABASE_SECRET_KEY: legacy }).ok, true)
  const calls: Headers[] = []
  const storage = new SupabaseStorage(
    { ...settings, secretKey: legacy },
    {
      fetcher: async (_input, init) => {
        calls.push(new Headers(init?.headers))
        return json(200, { public: false })
      },
    },
  )
  await storage.check()
  assert.equal(calls[0].get('authorization'), `Bearer ${legacy}`)
})

test('configuração validada, sem cair para o disco local e sem expor a chave', () => {
  const environment = { ATTACHMENTS_STORAGE: 'supabase', SUPABASE_URL: projectUrl, SUPABASE_SECRET_KEY: secretKey }
  assert.ok(resolveAttachmentStorage(environment) instanceof SupabaseStorage)
  assert.equal(resolveAttachmentStorage(environment), resolveAttachmentStorage(environment), 'mesma instância')
  assert.equal(resolveAttachmentStorage({ ATTACHMENTS_STORAGE: 'supabase', ATTACHMENTS_DIR: '/var/lib/slm/anexos' }), null)

  const problems = (extra: Record<string, string>) => {
    const result = supabaseStorageSettings({ ...environment, ...extra })
    return result.ok ? [] : result.problems.map((problem) => problem.variable)
  }
  assert.deepEqual(problems({}), [])
  assert.deepEqual(problems({ SUPABASE_URL: 'http://abcdefghijkl.supabase.co' }), ['SUPABASE_URL'])
  assert.deepEqual(problems({ SUPABASE_URL: `${projectUrl}/rest/v1` }), ['SUPABASE_URL'])
  assert.deepEqual(problems({ SUPABASE_SECRET_KEY: 'sb_publishable_abcdefghijklmnop' }), ['SUPABASE_SECRET_KEY'])
  assert.deepEqual(problems({ SUPABASE_SECRET_KEY: jwt('anon') }), ['SUPABASE_SECRET_KEY'])
  assert.deepEqual(problems({ SUPABASE_SECRET_KEY: 'qualquer' }), ['SUPABASE_SECRET_KEY'])
  assert.deepEqual(problems({ SUPABASE_STORAGE_BUCKET: '../outro' }), ['SUPABASE_STORAGE_BUCKET'])
  assert.deepEqual(problems({ SUPABASE_STORAGE_BUCKET: 'anexos-homolog' }), [])

  const ok = checkEnvironment({ ...environment, ATTACHMENTS_DIR: '/var/lib/slm/anexos', RENDER: 'true', NODE_ENV: 'production' })
  assert.equal(ok.find((item) => item.variable === 'ATTACHMENTS_STORAGE')?.level, 'ok')
  assert.equal(ok.find((item) => item.variable === 'ATTACHMENTS_DIR')?.level, 'aviso')
  assert.equal(JSON.stringify(ok).includes(secretKey), false)

  const missing = checkEnvironment({ ATTACHMENTS_STORAGE: 'supabase' })
  for (const variable of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY']) {
    assert.equal(missing.find((item) => item.variable === variable)?.level, 'erro', variable)
  }
})

test('erros do Supabase contam como falha de armazenamento e não trazem a chave', () => {
  const error = new SupabaseStorageError('SUPABASE_AUTH_REJECTED', false, 401)
  assert.ok(error instanceof StorageProviderError)
  assert.equal(isStorageFailure(error), true)
  assert.equal(error.message.includes(secretKey), false)
})
