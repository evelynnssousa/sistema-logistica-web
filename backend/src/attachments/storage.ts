import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, constants, mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import type { Readable } from 'node:stream'
import { GraphDriveStorage, graphStorageSettings } from './graphDriveStorage.js'
import { StorageProviderError } from './providerError.js'
import { SupabaseStorage, supabaseStorageSettings } from './supabaseStorage.js'

/**
 * Armazenamento dos anexos. Trocar o disco local por um serviço aprovado pela TI significa
 * implementar esta interface, sem mudar rotas nem regras de acesso. Quem chama já conferiu a
 * permissão: o armazenamento nunca decide quem pode ler.
 */
export interface AttachmentStorage {
  /** Grava um arquivo novo. Nunca sobrescreve: chave existente é erro com código EEXIST. */
  save(key: string, content: Buffer): Promise<void>
  /** Abre o conteúdo para transmissão pelo próprio servidor. Ausente: erro com código ENOENT. */
  open(key: string): Promise<Readable>
  /** Remoção física. Só serve para desfazer um envio cujo registro o banco recusou. */
  remove(key: string): Promise<void>
  check(): Promise<void>
}

export class AttachmentStorageUnavailableError extends Error {
  constructor() {
    super('O armazenamento de anexos não está configurado.')
    this.name = 'AttachmentStorageUnavailableError'
  }
}

export const attachmentKeyPattern = /^[0-9a-f-]{36}$/

export class LocalDiskStorage implements AttachmentStorage {
  constructor(private readonly directory: string) {}

  private pathOf(key: string) {
    // A chave é gerada pelo servidor; a conferência impede sair da pasta em qualquer hipótese.
    if (!attachmentKeyPattern.test(key)) throw new Error('Chave de anexo inválida.')
    const path = resolve(this.directory, key.slice(0, 2), key)
    if (!path.startsWith(`${resolve(this.directory)}${sep}`)) throw new Error('Chave de anexo inválida.')
    return path
  }

  async save(key: string, content: Buffer) {
    const path = this.pathOf(key)
    await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
    // flag "wx": nunca sobrescreve um arquivo existente.
    await writeFile(path, content, { mode: 0o600, flag: 'wx' })
  }

  async open(key: string): Promise<Readable> {
    return createReadStream(this.pathOf(key))
  }

  async remove(key: string) {
    await rm(this.pathOf(key), { force: true })
  }

  async check() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await access(this.directory, constants.R_OK | constants.W_OK)
  }
}

/** Raiz do repositório, tanto em backend/src/attachments quanto em backend/dist/attachments. */
export const projectRoot = resolve(__dirname, '..', '..', '..')

/**
 * Por que a pasta de anexos não serve, ou null se serve. Dentro do projeto, os documentos
 * poderiam ir para o Git, para um pacote publicado ou para uma pasta servida pelo Vite.
 */
export function attachmentDirectoryProblem(directory: string | undefined, root = projectRoot): string | null {
  const value = directory?.trim()
  if (!value) return 'ausente'
  if (!isAbsolute(value)) return 'precisa ser um caminho absoluto'
  const normalized = resolve(value)
  const base = resolve(root)
  if (normalized === base || normalized.startsWith(`${base}${sep}`)) {
    return 'não pode ficar dentro da pasta do projeto'
  }
  return null
}

export type StorageDriver = 'local' | 'sharepoint' | 'supabase'

/**
 * ATTACHMENTS_STORAGE: "local" (padrão, desenvolvimento), "supabase" (bucket privado do Supabase
 * Storage, para o Render) ou "sharepoint" (biblioteca institucional, depois da autorização da TI).
 */
export function storageDriver(environment: NodeJS.ProcessEnv = process.env): StorageDriver | null {
  const raw = environment.ATTACHMENTS_STORAGE?.trim().toLowerCase()
  if (!raw || raw === 'local') return 'local'
  if (raw === 'sharepoint') return 'sharepoint'
  if (raw === 'supabase') return 'supabase'
  return null
}

let testStorage: AttachmentStorage | null | undefined
let cachedGraph: { fingerprint: string; storage: GraphDriveStorage } | null = null
let cachedSupabase: { fingerprint: string; storage: SupabaseStorage } | null = null

/** Só para testes: substitui o armazenamento escolhido pelo ambiente. undefined restaura. */
export function setAttachmentStorageForTests(storage: AttachmentStorage | null | undefined) {
  testStorage = storage
}

/**
 * Sem configuração válida não há armazenamento: nada é gravado em uma pasta improvisada, nem
 * no banco, e o SharePoint ou o Supabase mal configurados nunca caem para o disco local. A pasta local precisa
 * ser absoluta e ficar fora do código publicado.
 */
export function resolveAttachmentStorage(environment: NodeJS.ProcessEnv = process.env): AttachmentStorage | null {
  if (testStorage !== undefined) return testStorage
  const driver = storageDriver(environment)
  if (driver === 'sharepoint') {
    const settings = graphStorageSettings(environment)
    if (!settings.ok) return null
    // Uma instância por configuração: o token fica só na memória dela e é reaproveitado.
    const fingerprint = createHash('sha256').update(JSON.stringify(settings.value)).digest('hex')
    if (cachedGraph?.fingerprint !== fingerprint) {
      cachedGraph = { fingerprint, storage: new GraphDriveStorage(settings.value) }
    }
    return cachedGraph.storage
  }
  if (driver === 'supabase') {
    const settings = supabaseStorageSettings(environment)
    if (!settings.ok) return null
    // Uma instância por configuração: a conferência de bucket privado é reaproveitada.
    const fingerprint = createHash('sha256').update(JSON.stringify(settings.value)).digest('hex')
    if (cachedSupabase?.fingerprint !== fingerprint) {
      cachedSupabase = { fingerprint, storage: new SupabaseStorage(settings.value) }
    }
    return cachedSupabase.storage
  }
  if (driver !== 'local') return null
  const directory = environment.ATTACHMENTS_DIR?.trim()
  if (!directory || attachmentDirectoryProblem(directory) !== null) return null
  return new LocalDiskStorage(directory)
}

/** Falha do armazenamento (disco, SharePoint ou Supabase) que a equipe técnica precisa ver. */
export function isStorageFailure(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'EACCES' || code === 'ENOSPC' || error instanceof StorageProviderError
}

export class AttachmentIntegrityError extends Error {
  readonly code = 'ATTACHMENT_INTEGRITY'
  constructor() {
    super('O conteúdo do anexo não confere com o registrado.')
    this.name = 'AttachmentIntegrityError'
  }
}

/**
 * Confere tamanho e SHA-256 durante a transmissão. O último pedaço só sai depois da conferência:
 * conteúdo divergente nunca chega inteiro ao navegador.
 */
export function verifyContent(expected: { sha256: string; sizeBytes: number }) {
  const hash = createHash('sha256')
  let received = 0
  let pending: Buffer | null = null
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length
      if (received > expected.sizeBytes) {
        done(new AttachmentIntegrityError())
        return
      }
      hash.update(chunk)
      const previous = pending
      pending = chunk
      done(null, previous ?? undefined)
    },
    flush(done) {
      if (received !== expected.sizeBytes || hash.digest('hex') !== expected.sha256) {
        done(new AttachmentIntegrityError())
        return
      }
      done(null, pending ?? undefined)
    },
  })
}
