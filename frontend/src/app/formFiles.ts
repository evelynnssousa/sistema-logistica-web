import { uploadAttachment } from '../api/operationsApi'
import type { AttachmentResource } from '../api/operationsApi'
import { errorMessage } from '../api/modulesApi'

/**
 * Arquivos escolhidos nos campos do tipo "Anexo". O formulário guarda só o nome no valor do campo;
 * o arquivo fica aqui até a solicitação existir e vai para a lista de anexos dela, com as mesmas
 * permissões, limites e conferências de qualquer anexo. Nada é enviado antes de a solicitação ser criada.
 */
const pending = new Map<string, File>()

export function setPendingFile(fieldId: string, file: File | null) {
  if (file) pending.set(fieldId, file)
  else pending.delete(fieldId)
}

/** Ao abrir um formulário: arquivos de um preenchimento anterior não seguem para o próximo. */
export function clearPendingFiles() {
  pending.clear()
}

/**
 * Envia, para a solicitação recém-criada, os arquivos dos campos preenchidos. Devolve as falhas,
 * em texto, para a tela avisar: a solicitação já existe e o arquivo pode ser anexado depois.
 */
export async function uploadPendingFiles(
  type: AttachmentResource,
  id: string,
  filled: Record<string, string>,
  labels: Record<string, string> = {},
): Promise<string[]> {
  const failures: string[] = []
  try {
    for (const [fieldId, file] of pending) {
      if (!filled[fieldId]) continue
      try {
        await uploadAttachment(type, id, file, { category: 'outro' })
      } catch (error) {
        failures.push(`${labels[fieldId] ?? 'Anexo'} (${file.name}): ${errorMessage(error, 'não foi enviado.')}`)
      }
    }
  } finally {
    pending.clear()
  }
  return failures
}

/** Aviso único, antes de abrir a solicitação criada. */
export function warnFailedUploads(failures: string[]) {
  if (failures.length === 0) return
  window.alert(
    `A solicitação foi criada, mas ${failures.length === 1 ? 'um arquivo não foi enviado' : 'alguns arquivos não foram enviados'}:\n\n${failures.join('\n')}\n\nAnexe de novo na parte "Documentos e anexos" da solicitação.`,
  )
}
