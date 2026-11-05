import { attachmentKinds } from '../requests/settingsRules.js'
import type { AttachmentKind } from '../requests/settingsRules.js'

/**
 * Validação do conteúdo real do arquivo. O tipo informado pelo navegador é ignorado, e o nome
 * só serve para conferir se bate com o conteúdo. Isto reduz o risco, mas não substitui um
 * antivírus: essa camada depende da infraestrutura aprovada pela TI.
 */

export class AttachmentRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentRejectedError'
  }
}

const extensionsByKind: Record<AttachmentKind, readonly string[]> = {
  pdf: ['pdf'],
  png: ['png'],
  jpeg: ['jpg', 'jpeg'],
  webp: ['webp'],
  docx: ['docx'],
  xlsx: ['xlsx'],
  txt: ['txt'],
}

export const contentTypes: Record<AttachmentKind, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain; charset=utf-8',
}

/** Tipos que o navegador abre com segurança, em uma resposta com sandbox. */
export const inlineKinds: readonly AttachmentKind[] = ['pdf', 'png', 'jpeg', 'webp']

const dangerousExtensions = new Set([
  'exe', 'dll', 'bat', 'cmd', 'com', 'msi', 'scr', 'pif', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'jar',
  'sh', 'php', 'py', 'rb', 'pl', 'html', 'htm', 'svg', 'xml', 'xhtml', 'hta', 'lnk', 'reg',
  'docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'iso', 'img',
])

/** Só o nome, sem caminho nem controle. Nunca é usado para montar o caminho no disco. */
export function sanitizeFileName(raw: string) {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const clean = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  if (!clean) throw new AttachmentRejectedError('Informe um nome de arquivo válido.')
  if (clean.length <= 180) return clean

  const dot = clean.lastIndexOf('.')
  const extension = dot > 0 ? clean.slice(dot) : ''
  return `${clean.slice(0, 180 - extension.length)}${extension}`
}

function startsWith(buffer: Buffer, bytes: readonly number[], offset = 0) {
  return bytes.every((byte, index) => buffer[offset + index] === byte)
}

function zipEntryNames(buffer: Buffer): string[] | null {
  // O diretório central fica no fim do arquivo: o conteúdo nem chega a ser descompactado.
  const minimum = Math.max(0, buffer.length - 65_557)
  let end = -1
  for (let position = buffer.length - 22; position >= minimum; position -= 1) {
    if (buffer.readUInt32LE(position) === 0x06054b50) {
      end = position
      break
    }
  }
  if (end < 0) return null

  const total = buffer.readUInt16LE(end + 10)
  let cursor = buffer.readUInt32LE(end + 16)
  const names: string[] = []
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) return null
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    names.push(buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return names
}

function officeKind(buffer: Buffer): AttachmentKind | null {
  const names = zipEntryNames(buffer)
  if (!names || !names.includes('[Content_Types].xml')) return null
  if (names.some((name) => /vbaProject\.bin$|\/embeddings\/|\.(exe|dll|bat|cmd|js|vbs)$/i.test(name))) {
    throw new AttachmentRejectedError('Documentos com macros ou arquivos embutidos não são aceitos.')
  }
  if (names.some((name) => name.startsWith('word/'))) return 'docx'
  if (names.some((name) => name.startsWith('xl/'))) return 'xlsx'
  return null
}

function isPlainText(buffer: Buffer) {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return false
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) return false
  return !/<\s*(script|html|svg|iframe|object|embed)\b/i.test(text.slice(0, 4096))
}

const pdfActivePattern = /\/(JavaScript|JS|Launch|EmbeddedFile|XFA|OpenAction)\b/

export function detectKind(buffer: Buffer): AttachmentKind | null {
  if (buffer.length === 0) return null
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    if (pdfActivePattern.test(buffer.toString('latin1'))) {
      throw new AttachmentRejectedError('PDFs com scripts, ações automáticas ou arquivos embutidos não são aceitos.')
    }
    return 'pdf'
  }
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'webp'
  }
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) return officeKind(buffer)
  return isPlainText(buffer) ? 'txt' : null
}

/** Recusa o que não for permitido. Devolve o tipo real e o nome limpo. */
export function validateAttachment(
  buffer: Buffer,
  rawName: string,
  rules: { maxFileMb: number; allowedKinds: readonly string[] },
) {
  if (buffer.length === 0) throw new AttachmentRejectedError('O arquivo está vazio.')
  if (buffer.length > rules.maxFileMb * 1024 * 1024) {
    throw new AttachmentRejectedError(`O arquivo excede o limite de ${rules.maxFileMb} MB.`)
  }

  const name = sanitizeFileName(rawName)
  const parts = name.toLowerCase().split('.')
  const extension = parts.length > 1 ? parts[parts.length - 1] : ''
  // relatorio.exe.pdf esconde a extensão real em sistemas que omitem a última.
  if (parts.slice(1).some((part) => dangerousExtensions.has(part))) {
    throw new AttachmentRejectedError('Este tipo de arquivo não é permitido.')
  }

  const kind = detectKind(buffer)
  if (!kind || !(attachmentKinds as readonly string[]).includes(kind) || !rules.allowedKinds.includes(kind)) {
    throw new AttachmentRejectedError('Este tipo de arquivo não é permitido.')
  }
  if (!extensionsByKind[kind].includes(extension)) {
    throw new AttachmentRejectedError('A extensão do arquivo não corresponde ao seu conteúdo.')
  }
  return { kind, name }
}
