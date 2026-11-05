import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  composeFromTemplate,
  emailStatusLabels,
  getCommunications,
  previewEmail,
  resendEmail,
  sendEmail,
  ticketStatusLabels,
} from '../api/communicationsApi'
import type { CommunicationOverview, ManualEmail } from '../api/communicationsApi'
import { errorMessage, formatDateTime } from '../api/modulesApi'
import { attachmentCategoryLabels, listAttachments, uploadAttachment } from '../api/operationsApi'
import type { Attachment, AttachmentResource } from '../api/operationsApi'
import { useHasPermission } from '../auth/UserContext'
import { Alert, Loading } from './ui/Feedback'
import Modal from './ui/Modal'
import StatusBadge from './ui/StatusBadge'

const sizeLabel = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

const splitAddresses = (text: string) => text.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean)

const statusTone: Record<string, string> = {
  sent: 'concluida',
  failed: 'rejeitado',
  pending: 'pendente',
  sending: 'em_analise',
  not_configured: 'denied',
}

const ticketTone: Record<string, string> = {
  enviado: 'concluida',
  falha: 'rejeitado',
  pendente: 'pendente',
  nao_enviado: 'neutral',
}

function Composer({
  type,
  id,
  ticket,
  data,
  categories,
  onClose,
  onDone,
}: {
  type: AttachmentResource
  id: string
  ticket: boolean
  data: CommunicationOverview
  categories: string[]
  onClose: () => void
  onDone: (message: string) => Promise<void>
}) {
  const defaultTemplate = ticket ? 'flight_ticket_delivery' : ''
  const [template, setTemplate] = useState(defaultTemplate)
  const [passengerId, setPassengerId] = useState('')
  const [locator, setLocator] = useState('')
  const [recipients, setRecipients] = useState(ticket ? '' : (data.recipients[0]?.email ?? ''))
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [category, setCategory] = useState(ticket ? 'bilhete' : (categories[0] ?? 'outro'))
  const [uploading, setUploading] = useState(false)
  const [storageReady, setStorageReady] = useState(true)
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // A mesma chave até confirmar: clicar duas vezes não cria duas mensagens.
  const key = useRef(crypto.randomUUID())

  const loadFiles = useCallback(async () => {
    const result = await listAttachments(type, id)
    setFiles(result.attachments.filter((item) => !item.removedAt))
    setStorageReady(result.storageConfigured)
  }, [type, id])

  useEffect(() => {
    let active = true
    listAttachments(type, id)
      .then((result) => {
        if (!active) return
        setFiles(result.attachments.filter((item) => !item.removedAt))
        setStorageReady(result.storageConfigured)
      })
      .catch((err: unknown) => {
        if (active) setStorageReady(false)
        if (active) setError(errorMessage(err, 'Não foi possível carregar os anexos.'))
      })
    return () => {
      active = false
    }
  }, [type, id])

  const chosen = useMemo(() => files.filter((item) => selected.includes(item.id)), [files, selected])
  const totalBytes = chosen.reduce((sum, item) => sum + item.sizeBytes, 0)
  const overLimit = totalBytes > data.limits.maxEmailMb * 1048576

  async function apply(templateKey: string) {
    setError('')
    try {
      const result = await composeFromTemplate(type, id, { modelo: templateKey, passageiroId: passengerId || undefined, localizador: locator })
      setSubject(result.assunto)
      setBody(result.mensagem)
      if (ticket && result.destinatarioSugerido && !recipients) setRecipients(result.destinatarioSugerido)
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível aplicar o modelo.'))
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return
    setError('')
    if (file.size > data.attachmentLimits.maxFileMb * 1048576) {
      setError(`O arquivo ${file.name} ultrapassa o limite de ${data.attachmentLimits.maxFileMb} MB.`)
      return
    }
    setUploading(true)
    try {
      // O servidor confere o conteúdo do arquivo, e não só o nome. Documento de viagem fica restrito.
      const created = await uploadAttachment(type, id, file, { category, restricted: ticket ? true : undefined })
      await loadFiles()
      setSelected((current) => [...current, created.id])
    } catch (err) {
      setError(errorMessage(err, 'O arquivo não foi aceito.'))
    } finally {
      setUploading(false)
    }
  }

  async function review(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (ticket && selected.length === 0) {
      setError('Anexe o bilhete eletrônico antes de continuar.')
      return
    }
    if (overLimit) {
      setError(`Os anexos ultrapassam o limite de ${data.limits.maxEmailMb} MB por mensagem.`)
      return
    }
    try {
      const result = await previewEmail(type, id, { assunto: subject, mensagem: body })
      setPreview({ subject: result.subject, html: result.html })
    } catch (err) {
      setError(errorMessage(err, 'Revise a mensagem.'))
    }
  }

  async function confirm() {
    setBusy(true)
    setError('')
    try {
      const result = await sendEmail(type, id, {
        confirmado: true,
        chave: key.current,
        tipo: ticket ? 'passagem' : 'geral',
        modelo: template || undefined,
        passageiroId: passengerId || undefined,
        destinatarios: splitAddresses(recipients),
        copias: splitAddresses(cc),
        assunto: subject,
        mensagem: body,
        anexos: selected,
      })
      await onDone(emailStatusLabels[result.status] ?? 'Mensagem registrada.')
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível registrar o envio.'))
      setBusy(false)
    }
  }

  const passenger = data.passengers?.find((item) => item.id === passengerId)

  return (
    <Modal title={ticket ? 'Enviar passagem por e-mail' : 'Enviar e-mail'} onClose={onClose}>
      {data.service === 'nao_configurado' && (
        <Alert tone="warning">
          O serviço de e-mail não está configurado neste ambiente. A mensagem fica registrada como não enviada, e nada sai do sistema.
        </Alert>
      )}
      {!preview ? (
        <form className="ui-stacked" onSubmit={(event) => void review(event)} data-testid="email-composer">
          {ticket && (
            <>
              <label className="maintenance-form-field">
                <span>Passageiro *</span>
                <select required value={passengerId} onChange={(event) => setPassengerId(event.target.value)}>
                  <option value="">Selecione</option>
                  {data.passengers?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.cpfMasked})
                    </option>
                  ))}
                </select>
              </label>
              <label className="maintenance-form-field">
                <span>Localizador da reserva</span>
                <input maxLength={40} value={locator} onChange={(event) => setLocator(event.target.value)} />
              </label>
            </>
          )}
          <div className="action-row">
            <label className="maintenance-form-field">
              <span>Modelo (opcional)</span>
              <select value={template} onChange={(event) => setTemplate(event.target.value)}>
                <option value="">Sem modelo</option>
                {data.templates
                  .filter((item) => (ticket ? item.event === 'flight_ticket_delivery' : item.event !== 'flight_ticket_delivery'))
                  .map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <button type="button" className="maintenance-secondary-button" disabled={!template} onClick={() => void apply(template)}>
              Preencher com o modelo
            </button>
          </div>
          <label className="maintenance-form-field">
            <span>{ticket ? 'E-mail do passageiro *' : 'Destinatários *'}</span>
            <input required value={recipients} onChange={(event) => setRecipients(event.target.value)} aria-describedby="composer-to-hint" />
            <small id="composer-to-hint">
              {ticket ? 'Confira o endereço: fica só no registro deste envio.' : 'Separe os endereços por vírgula.'}
            </small>
          </label>
          {!ticket && data.recipients.length > 0 && (
            <div className="action-row">
              {data.recipients.map((item) => (
                <button type="button" key={item.email} onClick={() => setRecipients(item.email)}>
                  {item.label}
                </button>
              ))}
            </div>
          )}
          <label className="maintenance-form-field">
            <span>Cópias</span>
            <input value={cc} onChange={(event) => setCc(event.target.value)} />
          </label>
          <label className="maintenance-form-field">
            <span>Assunto *</span>
            <input required maxLength={200} value={subject} onChange={(event) => setSubject(event.target.value)} />
          </label>
          <label className="maintenance-form-field">
            <span>Mensagem *</span>
            <textarea required rows={8} maxLength={20000} value={body} onChange={(event) => setBody(event.target.value)} />
            <small>Não inclua CPF: se houver, ele será mascarado antes do envio.</small>
          </label>

          <fieldset className="check-list">
            <legend>Anexos{ticket ? ' *' : ''}</legend>
            {files.length === 0 && <p>Nenhum documento nesta solicitação.</p>}
            {files.map((file) => (
              <label key={file.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(file.id)}
                  onChange={(event) =>
                    setSelected((current) => (event.target.checked ? [...current, file.id] : current.filter((item) => item !== file.id)))
                  }
                />
                {file.name} ({sizeLabel(file.sizeBytes)}, {attachmentCategoryLabels[file.category] ?? file.category})
              </label>
            ))}
            <small>
              Selecionados: {chosen.length}, {sizeLabel(totalBytes)} de {data.limits.maxEmailMb} MB. Formatos aceitos:{' '}
              {data.attachmentLimits.allowedKinds.join(', ')}. Até {data.attachmentLimits.maxFileMb} MB por arquivo.
            </small>
            {overLimit && <Alert tone="error">Os anexos selecionados ultrapassam o limite por mensagem.</Alert>}
            {storageReady ? (
              <div className="action-row">
                <label className="maintenance-form-field">
                  <span>Tipo do novo documento</span>
                  <select value={category} onChange={(event) => setCategory(event.target.value)}>
                    {categories.map((item) => (
                      <option key={item} value={item}>
                        {attachmentCategoryLabels[item] ?? item}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="maintenance-form-field">
                  <span>Incluir arquivo</span>
                  <input
                    type="file"
                    disabled={uploading}
                    data-testid="composer-file"
                    onChange={(event) => {
                      void upload(event.target.files?.[0])
                      event.target.value = ''
                    }}
                  />
                </label>
              </div>
            ) : (
              <Alert tone="info">O armazenamento de anexos ainda não foi configurado pela TI: dá para enviar só a mensagem.</Alert>
            )}
          </fieldset>

          {error && <Alert tone="error">{error}</Alert>}
          <div className="action-row">
            <button type="submit" className="maintenance-primary-button">Conferir antes de enviar</button>
            <button type="button" className="maintenance-secondary-button" onClick={onClose}>Cancelar</button>
          </div>
        </form>
      ) : (
        <div className="ui-stacked" data-testid="email-review">
          <Alert tone="info">Confira tudo. Nada foi enviado ainda.</Alert>
          <dl className="detail-grid">
            {passenger && (
              <div className="detail-info">
                <dt>Passageiro</dt>
                <dd>{passenger.name}</dd>
              </div>
            )}
            <div className="detail-info">
              <dt>Destinatários</dt>
              <dd>{splitAddresses(recipients).join(', ')}</dd>
            </div>
            {cc && (
              <div className="detail-info">
                <dt>Cópias</dt>
                <dd>{splitAddresses(cc).join(', ')}</dd>
              </div>
            )}
            <div className="detail-info">
              <dt>Assunto</dt>
              <dd>{preview.subject}</dd>
            </div>
            <div className="detail-info">
              <dt>Anexos</dt>
              <dd>{chosen.length ? chosen.map((item) => `${item.name} (${sizeLabel(item.sizeBytes)})`).join(', ') : 'Nenhum'}</dd>
            </div>
          </dl>
          <iframe title="Mensagem que será enviada" sandbox="" srcDoc={preview.html} style={{ width: '100%', minHeight: 320, border: '1px solid #dedfda' }} />
          {error && <Alert tone="error">{error}</Alert>}
          <div className="action-row">
            <button type="button" className="maintenance-primary-button" disabled={busy} onClick={() => void confirm()}>
              Confirmar envio
            </button>
            <button type="button" className="maintenance-secondary-button" disabled={busy} onClick={() => setPreview(null)}>
              Voltar e corrigir
            </button>
            <button type="button" className="maintenance-secondary-button" disabled={busy} onClick={onClose}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function HistoryItem({ email, canSend, onResend }: { email: ManualEmail; canSend: boolean; onResend: (email: ManualEmail) => void }) {
  return (
    <li>
      <strong>{email.subject}</strong>
      <StatusBadge status={statusTone[email.status] ?? 'neutral'} label={emailStatusLabels[email.status] ?? email.status} />
      <span>Para: {email.recipients.join(', ')}{email.cc.length ? ` · Cópia: ${email.cc.join(', ')}` : ''}</span>
      {email.attachments.length > 0 && (
        <span>Anexos: {email.attachments.map((item) => `${item.name} (${sizeLabel(item.sizeBytes)})`).join(', ')}</span>
      )}
      <small>
        {email.operator ?? 'Sistema'} · {formatDateTime(email.sentAt ?? email.createdAt)}
        {email.simulated ? ' · simulado, nada saiu da máquina' : ''}
        {email.resentFrom ? ' · reenvio' : ''}
      </small>
      <details>
        <summary>Ver detalhes do envio</summary>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{email.text}</pre>
        <small>
          Modelo: {email.template ?? 'sem modelo'} · Serviço: {email.provider ?? '—'} · Identificador: {email.providerMessageId ?? '—'}
          {email.errorCode ? ` · Código do erro: ${email.errorCode}` : ''} · Tentativas: {email.attempts}
        </small>
      </details>
      {canSend && (
        <div className="action-row">
          <button type="button" onClick={() => onResend(email)}>Reenviar</button>
        </div>
      )}
    </li>
  )
}

/** Envio e histórico de e-mails da solicitação. A API confere a permissão e o acesso ao módulo. */
function CommunicationsPanel({
  type,
  id,
  categories,
  allowTicket = false,
}: {
  type: AttachmentResource
  id: string
  categories: string[]
  allowTicket?: boolean
}) {
  const canRead = useHasPermission('communications:read')
  const [data, setData] = useState<CommunicationOverview | null>(null)
  const [composer, setComposer] = useState<'geral' | 'passagem' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [resending, setResending] = useState<ManualEmail | null>(null)
  const resendKey = useRef('')

  const load = useCallback(async () => {
    setData(await getCommunications(type, id))
  }, [type, id])

  useEffect(() => {
    if (!canRead) return
    let active = true
    getCommunications(type, id)
      .then((result) => {
        if (active) setData(result)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar as comunicações.'))
      })
    return () => {
      active = false
    }
  }, [canRead, type, id])

  if (!canRead) return null

  async function confirmResend() {
    if (!resending) return
    setError('')
    setNotice('')
    try {
      const result = await resendEmail(resending.id, resendKey.current)
      setResending(null)
      setNotice(`Nova mensagem registrada: ${emailStatusLabels[result.status] ?? result.status}. O registro anterior foi mantido.`)
      await load()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível reenviar.'))
      setResending(null)
    }
  }

  return (
    <section className="admin-data-card detail-card" aria-labelledby="communications-title" data-testid="communications">
      <h2 id="communications-title">Comunicações</h2>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="info">{notice}</Alert>}
      {!data && !error && <Loading label="Carregando comunicações..." />}
      {data && (
        <>
          {data.ticketStatus && (
            <p data-testid="ticket-status">
              <StatusBadge status={ticketTone[data.ticketStatus]} label={ticketStatusLabels[data.ticketStatus]} />
            </p>
          )}
          {data.canSend && (
            <div className="action-row no-print">
              {allowTicket && (
                <button type="button" className="maintenance-primary-button" onClick={() => setComposer('passagem')}>
                  Enviar passagem por e-mail
                </button>
              )}
              <button type="button" className="maintenance-secondary-button" onClick={() => setComposer('geral')}>
                Enviar e-mail
              </button>
            </div>
          )}
          {data.history.length === 0 ? (
            <p>Nenhuma mensagem enviada por aqui.</p>
          ) : (
            <ul className="detail-history">
              {data.history.map((email) => (
                <HistoryItem
                  key={email.id}
                  email={email}
                  canSend={data.canSend}
                  onResend={(item) => {
                    resendKey.current = crypto.randomUUID()
                    setResending(item)
                  }}
                />
              ))}
            </ul>
          )}
          {composer && (
            <Composer
              type={type}
              id={id}
              ticket={composer === 'passagem'}
              data={data}
              categories={categories}
              onClose={() => setComposer(null)}
              onDone={async (message) => {
                setComposer(null)
                setNotice(message)
                await load()
              }}
            />
          )}
          {resending && (
            <Modal title="Reenviar mensagem" onClose={() => setResending(null)}>
              <div className="ui-stacked">
                <p>
                  Uma nova mensagem igual será enviada para {resending.recipients.join(', ')}. O registro anterior continua no histórico.
                </p>
                <div className="action-row">
                  <button type="button" className="maintenance-primary-button" onClick={() => void confirmResend()}>Confirmar reenvio</button>
                  <button type="button" className="maintenance-secondary-button" onClick={() => setResending(null)}>Cancelar</button>
                </div>
              </div>
            </Modal>
          )}
        </>
      )}
    </section>
  )
}

export default CommunicationsPanel
