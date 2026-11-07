import type { Response } from 'express'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'
import { verifyContent } from './storage.js'
import type { AttachmentStorage } from './storage.js'

/**
 * Transmite um anexo pelo próprio servidor, depois de a rota conferir a permissão e definir os
 * cabeçalhos. O navegador nunca recebe endereço do armazenamento. Tamanho e SHA-256 são
 * conferidos no caminho: conteúdo alterado ou corrompido interrompe a resposta.
 */
export async function transmitAttachment(
  response: Response,
  storage: AttachmentStorage,
  attachment: { storageKey: string; sha256: string; sizeBytes: number },
  event: string,
) {
  let stream
  try {
    stream = await storage.open(attachment.storageKey)
  } catch (error) {
    recordTechnicalEvent('storage', event, error)
    unavailable(response)
    return
  }
  const source = stream
  const verifier = verifyContent(attachment)
  let failed = false
  const fail = (error: unknown) => {
    if (failed) return
    failed = true
    source.destroy()
    verifier.destroy()
    recordTechnicalEvent('storage', event, error)
    if (response.headersSent) response.destroy()
    else unavailable(response)
  }
  source.on('error', fail)
  verifier.on('error', fail)
  // Quem baixava desistiu: a leitura do armazenamento para junto.
  response.on('close', () => {
    if (!source.destroyed) source.destroy()
  })
  source.pipe(verifier).pipe(response)
}

function unavailable(response: Response) {
  response.removeHeader('Content-Disposition')
  response.removeHeader('Content-Length')
  response.set('Content-Type', 'application/json')
  response.status(503).json({ success: false, message: 'O arquivo não está disponível neste momento.' })
}
