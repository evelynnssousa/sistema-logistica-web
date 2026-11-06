import { createReadStream } from 'node:fs'
import type { ReadStream } from 'node:fs'
import { access, constants, mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'

/**
 * Armazenamento dos anexos. Trocar o disco local por um serviço aprovado pela TI significa
 * implementar esta interface, sem mudar rotas nem regras de acesso.
 */
export interface AttachmentStorage {
  save(key: string, content: Buffer): Promise<void>
  open(key: string): ReadStream
  remove(key: string): Promise<void>
  check(): Promise<void>
}

export class AttachmentStorageUnavailableError extends Error {
  constructor() {
    super('O armazenamento de anexos não está configurado.')
    this.name = 'AttachmentStorageUnavailableError'
  }
}

const keyPattern = /^[0-9a-f-]{36}$/

export class LocalDiskStorage implements AttachmentStorage {
  constructor(private readonly directory: string) {}

  private pathOf(key: string) {
    // A chave é gerada pelo servidor; a conferência impede sair da pasta em qualquer hipótese.
    if (!keyPattern.test(key)) throw new Error('Chave de anexo inválida.')
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

  open(key: string) {
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

/**
 * Sem ATTACHMENTS_DIR não há armazenamento: nada é gravado em uma pasta improvisada, nem no
 * banco. A pasta precisa ser absoluta e ficar fora do código publicado.
 */
export function resolveAttachmentStorage(environment: NodeJS.ProcessEnv = process.env): AttachmentStorage | null {
  const directory = environment.ATTACHMENTS_DIR?.trim()
  if (!directory || attachmentDirectoryProblem(directory) !== null) return null
  return new LocalDiskStorage(directory)
}
