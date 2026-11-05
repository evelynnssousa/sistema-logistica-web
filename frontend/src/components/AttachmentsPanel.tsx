import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { errorMessage, formatDateTime } from '../api/modulesApi'
import {
  attachmentCategoryLabels,
  attachmentUrl,
  listAttachments,
  removeAttachment,
  uploadAttachment,
} from '../api/operationsApi'
import type { Attachment, AttachmentResource } from '../api/operationsApi'
import { Alert } from './ui/Feedback'
import Icon from './ui/Icon'
import Modal from './ui/Modal'

const extensionsByKind: Record<string, string> = {
  pdf: '.pdf',
  png: '.png',
  jpeg: '.jpg,.jpeg',
  webp: '.webp',
  docx: '.docx',
  xlsx: '.xlsx',
  txt: '.txt',
}

const viewable = new Set(['pdf', 'png', 'jpeg', 'webp'])

function sizeLabel(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

function RemoveDialog({
  attachment,
  onClose,
  onRemoved,
}: {
  attachment: Attachment
  onClose: () => void
  onRemoved: () => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await removeAttachment(attachment.id, reason)
      await onRemoved()
      onClose()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível remover o anexo.'))
      setBusy(false)
    }
  }

  return (
    <Modal title={`Remover ${attachment.name}`} onClose={onClose}>
      <form className="ui-stacked" onSubmit={(event) => void submit(event)}>
        <p>O arquivo deixa de ficar disponível, mas o registro continua no histórico da solicitação.</p>
        <label className="maintenance-form-field">
          <span>Justificativa *</span>
          <textarea required rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        {error && <Alert tone="error">{error}</Alert>}
        <button type="submit" className="ui-button-danger" disabled={busy}>
          Remover anexo
        </button>
      </form>
    </Modal>
  )
}

/** Documentos de uma solicitação ou pedido. A API decide o que cada pessoa vê e pode fazer. */
function AttachmentsPanel({
  resourceType,
  resourceId,
  canUpload,
  canRemove,
  canRestrict,
  restrictedByDefault = false,
  categories,
  onChanged,
}: {
  resourceType: AttachmentResource
  resourceId: string
  canUpload: boolean
  canRemove: boolean
  canRestrict: boolean
  restrictedByDefault?: boolean
  categories: readonly string[]
  onChanged?: () => Promise<void>
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof listAttachments>> | null>(null)
  const [unavailable, setUnavailable] = useState('')
  const [category, setCategory] = useState(categories[0] ?? 'outro')
  const [restricted, setRestricted] = useState(restrictedByDefault)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<Attachment | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      setData(await listAttachments(resourceType, resourceId))
      setUnavailable('')
    } catch (err) {
      setUnavailable(errorMessage(err, 'Não foi possível carregar os anexos.'))
    }
  }, [resourceType, resourceId])

  useEffect(() => {
    let active = true
    listAttachments(resourceType, resourceId)
      .then((result) => {
        if (active) setData(result)
      })
      .catch((err: unknown) => {
        if (active) setUnavailable(errorMessage(err, 'Não foi possível carregar os anexos.'))
      })
    return () => {
      active = false
    }
  }, [resourceType, resourceId])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const file = fileInput.current?.files?.[0]
    if (!file) {
      setError('Selecione um arquivo.')
      return
    }
    setBusy(true)
    setError('')
    setSuccess('')
    try {
      await uploadAttachment(resourceType, resourceId, file, {
        category,
        restricted: canRestrict ? restricted : undefined,
      })
      if (fileInput.current) fileInput.current.value = ''
      setSuccess('Anexo enviado.')
      await load()
      await onChanged?.()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível enviar o anexo.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="admin-data-card detail-card" aria-labelledby={`attachments-${resourceId}`}>
      <h2 id={`attachments-${resourceId}`}>Documentos e anexos</h2>
      {unavailable && <Alert tone="info">{unavailable}</Alert>}

      {data && data.attachments.length === 0 && <p>Nenhum documento anexado.</p>}
      {data && data.attachments.length > 0 && (
        <ul className="attachment-list">
          {data.attachments.map((attachment) => (
            <li key={attachment.id} className={`attachment-item${attachment.removedAt ? ' is-removed' : ''}`}>
              <div className="attachment-info">
                <strong>{attachment.name}</strong>
                <span>
                  {attachmentCategoryLabels[attachment.category] ?? attachment.category} · {sizeLabel(attachment.sizeBytes)}
                  {attachment.restricted ? ' · Restrito à equipe' : ''}
                </span>
                <small>
                  {attachment.uploadedBy} · {formatDateTime(attachment.uploadedAt)}
                </small>
                {attachment.removedAt && (
                  <small>
                    Removido por {attachment.removedBy} em {formatDateTime(attachment.removedAt)}: {attachment.removalReason}
                  </small>
                )}
              </div>
              {!attachment.removedAt && (
                <div className="attachment-actions">
                  {viewable.has(attachment.kind) && (
                    <a
                      className="maintenance-secondary-button"
                      href={attachmentUrl(attachment.id, true)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Icon name="view" size={16} />
                      Visualizar
                    </a>
                  )}
                  <a className="maintenance-secondary-button" href={attachmentUrl(attachment.id)}>
                    <Icon name="download" size={16} />
                    Baixar
                  </a>
                  {canRemove && (
                    <button type="button" className="maintenance-secondary-button" onClick={() => setRemoving(attachment)}>
                      Remover
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {data && canUpload && !data.storageConfigured && (
        <Alert tone="info">O envio de documentos depende da configuração do armazenamento pela TI.</Alert>
      )}
      {data && canUpload && data.storageConfigured && (
        <form className="attachment-upload" onSubmit={(event) => void submit(event)}>
          <label className="maintenance-form-field">
            <span>Arquivo (até {data.limits.maxFileMb} MB)</span>
            <input
              ref={fileInput}
              type="file"
              accept={data.limits.allowedKinds.map((kind) => extensionsByKind[kind]).join(',')}
            />
          </label>
          <label className="maintenance-form-field">
            <span>Categoria</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              {categories.map((value) => (
                <option key={value} value={value}>
                  {attachmentCategoryLabels[value]}
                </option>
              ))}
            </select>
          </label>
          {canRestrict && (
            <label className="attachment-restricted">
              <input type="checkbox" checked={restricted} onChange={(event) => setRestricted(event.target.checked)} />
              Restrito à equipe
            </label>
          )}
          <button type="submit" className="maintenance-primary-button" disabled={busy}>
            {busy ? 'Enviando...' : 'Enviar documento'}
          </button>
        </form>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="success">{success}</Alert>}

      {removing && (
        <RemoveDialog
          attachment={removing}
          onClose={() => setRemoving(null)}
          onRemoved={async () => {
            await load()
            await onChanged?.()
          }}
        />
      )}
    </section>
  )
}

export default AttachmentsPanel
