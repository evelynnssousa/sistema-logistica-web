import { ExtraFieldsView } from '../../components/ExtraFields'
import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  addDemandComment,
  addDemandLink,
  addDemandSubtask,
  assignDemand,
  cancelDemand,
  cancelSeries,
  changeDemandStatus,
  changeSeriesRule,
  commentKindLabels,
  completeDemand,
  demandAttachmentUrl,
  demandStatusLabels,
  discardDemand,
  fetchDemand,
  fetchDemandAttachmentLimits,
  followDemand,
  moduleLinkLabels,
  publishDemand,
  removeDemandAttachment,
  removeDemandLink,
  reopenDemand,
  resumeSeries,
  seriesStatusLabels,
  setDemandCollaboration,
  skipOccurrence,
  subtaskStatusLabels,
  suspendSeries,
  updateDemandSubtask,
  uploadDemandAttachment,
} from '../../api/demandsApi'
import type { DemandDetail as Detail, DemandStatus } from '../../api/demandsApi'
import { errorMessage, formatCalendarDate, formatDateTime } from '../../api/modulesApi'
import { historyLines, historyTitle } from './demandHistoryText'
import { Alert, EmptyState, Loading } from '../../components/ui/Feedback'
import Icon from '../../components/ui/Icon'
import Modal from '../../components/ui/Modal'
import PageHeader from '../../components/ui/PageHeader'
import { RecurrenceFields } from './DemandForm'
import { emptyRecurrence, recurrenceDraftFrom, recurrencePayload } from './demandRecurrence'
import type { RecurrenceDraft } from './demandRecurrence'
import { useDemands } from './useDemands'
import { DemandFlags, DemandStatusBadge, DueLabel, PriorityTag, ProgressBar } from './demandUi'

type Reload = () => Promise<void>

/** Formulário curto em janela: pergunta, envia e fecha. A regra fica no backend. */
function ActionDialog({
  title,
  submitLabel,
  danger,
  onClose,
  onSubmit,
  children,
}: {
  title: string
  submitLabel: string
  danger?: boolean
  onClose: () => void
  onSubmit: () => Promise<void>
  children: ReactNode
}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onSubmit()
      onClose()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível concluir a ação.'))
      setBusy(false)
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form className="demand-dialog-form" onSubmit={(event) => void submit(event)}>
        {error && <Alert tone="error">{error}</Alert>}
        {children}
        <div className="demand-dialog-actions">
          <button type="button" className="maintenance-secondary-button" onClick={onClose}>Voltar</button>
          <button type="submit" className={danger ? 'ui-button-danger' : 'maintenance-primary-button'} disabled={busy}>
            {busy ? 'Salvando...' : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function TextField({
  label,
  value,
  onChange,
  required = true,
  rows = 3,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
  rows?: number
}) {
  return (
    <label className="maintenance-form-field">
      <span>{label}</span>
      <textarea required={required} minLength={required ? 3 : undefined} rows={rows} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

function StatusDialog({ data, onClose, onDone }: { data: Detail; onClose: () => void; onDone: Reload }) {
  const { demand } = data
  const [status, setStatus] = useState<DemandStatus>(demand.status)
  const [waitingFor, setWaitingFor] = useState(demand.waitingFor ?? '')
  const [reason, setReason] = useState(demand.suspensionReason ?? '')
  const [resumeDate, setResumeDate] = useState(demand.resumeDate ?? '')
  const options: DemandStatus[] = ['nao_iniciada', 'em_andamento', 'aguardando_terceiros', 'aguardando_autorizacao', 'suspensa']

  return (
    <ActionDialog
      title="Alterar status"
      submitLabel="Salvar status"
      onClose={onClose}
      onSubmit={async () => {
        await changeDemandStatus(demand.id, {
          status,
          version: demand.version,
          waitingFor: status === 'aguardando_terceiros' ? waitingFor : undefined,
          suspensionReason: status === 'suspensa' ? reason : undefined,
          resumeDate: status === 'suspensa' ? resumeDate : undefined,
        })
        await onDone()
      }}
    >
      <label className="maintenance-form-field">
        <span>Novo status</span>
        <select value={status} onChange={(event) => setStatus(event.target.value as DemandStatus)}>
          {options.map((value) => (
            <option key={value} value={value}>{demandStatusLabels[value]}</option>
          ))}
        </select>
      </label>
      {status === 'aguardando_terceiros' && (
        <label className="maintenance-form-field">
          <span>Quem ou qual instituição está sendo aguardada</span>
          <input required maxLength={200} value={waitingFor} onChange={(event) => setWaitingFor(event.target.value)} />
        </label>
      )}
      {status === 'suspensa' && (
        <>
          <TextField label="Justificativa da suspensão" value={reason} onChange={setReason} />
          <label className="maintenance-form-field">
            <span>Previsão de retomada (opcional)</span>
            <input type="date" value={resumeDate} onChange={(event) => setResumeDate(event.target.value)} />
          </label>
        </>
      )}
    </ActionDialog>
  )
}

function CompleteDialog({ data, onClose, onDone }: { data: Detail; onClose: () => void; onDone: Reload }) {
  const [done, setDone] = useState('')
  const [result, setResult] = useState('')
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const openSteps = data.subtasks.filter((item) => item.status !== 'concluida' && item.status !== 'cancelada').length

  return (
    <ActionDialog
      title="Concluir demanda"
      submitLabel="Concluir"
      onClose={onClose}
      onSubmit={async () => {
        // O comprovante vem primeiro: se o envio falhar, a demanda continua aberta.
        if (file) await uploadDemandAttachment(data.demand.id, file, 'comprovante')
        await completeDemand(data.demand.id, { done, result, notes })
        await onDone()
      }}
    >
      {openSteps > 0 && <Alert tone="warning">Há {openSteps} etapa(s) em aberto. Conclua ou cancele antes de concluir a demanda.</Alert>}
      <TextField label="O que foi realizado" value={done} onChange={setDone} />
      <TextField label="Resultado obtido (opcional)" value={result} onChange={setResult} required={false} />
      <TextField label="Observações finais (opcional)" value={notes} onChange={setNotes} required={false} />
      <label className="maintenance-form-field">
        <span>Anexo comprobatório (opcional)</span>
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.txt" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      </label>
    </ActionDialog>
  )
}

function ReasonDialog({
  title,
  label,
  submitLabel,
  danger,
  onClose,
  onSubmit,
}: {
  title: string
  label: string
  submitLabel: string
  danger?: boolean
  onClose: () => void
  onSubmit: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  return (
    <ActionDialog title={title} submitLabel={submitLabel} danger={danger} onClose={onClose} onSubmit={() => onSubmit(reason)}>
      <TextField label={label} value={reason} onChange={setReason} />
    </ActionDialog>
  )
}

function AssignDialog({ data, onClose, onDone }: { data: Detail; onClose: () => void; onDone: Reload }) {
  const { options } = useDemands()
  const { demand } = data
  const [responsibleId, setResponsibleId] = useState(demand.responsibleId ?? '')
  const [reason, setReason] = useState('')
  const [future, setFuture] = useState(false)
  const people = options.people.filter((person) => person.sectorIds.includes(demand.responsibleSectorId ?? ''))

  return (
    <ActionDialog
      title="Distribuir demanda"
      submitLabel="Salvar responsável"
      onClose={onClose}
      onSubmit={async () => {
        await assignDemand(demand.id, {
          responsibleId: responsibleId || null,
          reason,
          scope: future ? 'future' : 'this',
          version: demand.version,
        })
        await onDone()
      }}
    >
      <label className="maintenance-form-field">
        <span>Responsável principal</span>
        <select value={responsibleId} onChange={(event) => setResponsibleId(event.target.value)}>
          <option value="">Sem responsável</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>{person.name}</option>
          ))}
        </select>
      </label>
      <TextField label="Motivo (opcional)" value={reason} onChange={setReason} required={false} rows={2} />
      {demand.recurring && (
        <label className="demand-check">
          <input type="checkbox" checked={future} onChange={(event) => setFuture(event.target.checked)} />
          Aplicar também às ocorrências futuras
        </label>
      )}
    </ActionDialog>
  )
}

function CollaborationDialog({ data, onClose, onDone }: { data: Detail; onClose: () => void; onDone: Reload }) {
  const { options } = useDemands()
  const { demand } = data
  const [rows, setRows] = useState(
    data.participants
      .filter((item) => item.kind === 'colaborador')
      .map((item) => ({ userId: item.userId, activity: item.activity ?? '', dueDate: item.dueDate ?? '' })),
  )
  const [sectors, setSectors] = useState(data.collaboratorSectors.map((item) => item.id))
  const [authorized, setAuthorized] = useState(data.participants.filter((item) => item.kind === 'autorizado').map((item) => item.userId))
  const [future, setFuture] = useState(false)

  return (
    <ActionDialog
      title="Colaboração"
      submitLabel="Salvar colaboração"
      onClose={onClose}
      onSubmit={async () => {
        await setDemandCollaboration(demand.id, {
          collaborators: rows.filter((item) => item.userId).map((item) => ({ ...item, dueDate: item.dueDate || null })),
          collaboratorSectorIds: sectors,
          authorizedUserIds: authorized,
          scope: future ? 'future' : 'this',
        })
        await onDone()
      }}
    >
      <fieldset className="demand-checks demand-checks-inline">
        <legend>Setores colaboradores</legend>
        {options.sectors
          .filter((item) => item.id !== demand.responsibleSectorId)
          .map((item) => (
            <label key={item.id}>
              <input
                type="checkbox"
                checked={sectors.includes(item.id)}
                onChange={(event) => setSectors((current) => (event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id)))}
              />
              {item.name}
            </label>
          ))}
      </fieldset>
      <h3>Colaboradores</h3>
      {rows.map((row, index) => (
        <div className="demand-collaborator-row" key={index}>
          <label className="maintenance-form-field">
            <span>Pessoa</span>
            <select required value={row.userId} onChange={(event) => setRows((current) => current.map((item, position) => (position === index ? { ...item, userId: event.target.value } : item)))}>
              <option value="">Selecione</option>
              {options.people.map((person) => (
                <option key={person.id} value={person.id}>{person.name}</option>
              ))}
            </select>
          </label>
          <label className="maintenance-form-field">
            <span>Atividade</span>
            <input maxLength={500} value={row.activity} onChange={(event) => setRows((current) => current.map((item, position) => (position === index ? { ...item, activity: event.target.value } : item)))} />
          </label>
          <label className="maintenance-form-field">
            <span>Prazo</span>
            <input type="date" value={row.dueDate} onChange={(event) => setRows((current) => current.map((item, position) => (position === index ? { ...item, dueDate: event.target.value } : item)))} />
          </label>
          <button type="button" className="maintenance-secondary-button" onClick={() => setRows((current) => current.filter((_, position) => position !== index))}>Remover</button>
        </div>
      ))}
      <button type="button" className="maintenance-secondary-button" onClick={() => setRows((current) => [...current, { userId: '', activity: '', dueDate: '' }])}>
        Adicionar colaborador
      </button>
      {demand.restricted && (
        <fieldset className="demand-checks demand-checks-inline">
          <legend>Autorizados a ver esta demanda restrita</legend>
          {options.people.map((person) => (
            <label key={person.id}>
              <input
                type="checkbox"
                checked={authorized.includes(person.id)}
                onChange={(event) => setAuthorized((current) => (event.target.checked ? [...current, person.id] : current.filter((id) => id !== person.id)))}
              />
              {person.name}
            </label>
          ))}
        </fieldset>
      )}
      {demand.recurring && (
        <label className="demand-check">
          <input type="checkbox" checked={future} onChange={(event) => setFuture(event.target.checked)} />
          Usar também nas próximas ocorrências que forem geradas
        </label>
      )}
    </ActionDialog>
  )
}

function SubtaskDialog({ data, onClose, onDone }: { data: Detail; onClose: () => void; onDone: Reload }) {
  const { options } = useDemands()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [responsibleId, setResponsibleId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')

  return (
    <ActionDialog
      title="Nova etapa"
      submitLabel="Criar etapa"
      onClose={onClose}
      onSubmit={async () => {
        await addDemandSubtask(data.demand.id, { title, description, responsibleId: responsibleId || null, dueDate: dueDate || null, notes })
        await onDone()
      }}
    >
      <label className="maintenance-form-field">
        <span>Título</span>
        <input required minLength={2} maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <TextField label="Descrição (opcional)" value={description} onChange={setDescription} required={false} rows={2} />
      <label className="maintenance-form-field">
        <span>Responsável</span>
        <select value={responsibleId} onChange={(event) => setResponsibleId(event.target.value)}>
          <option value="">Sem responsável</option>
          {options.people.map((person) => (
            <option key={person.id} value={person.id}>{person.name}</option>
          ))}
        </select>
      </label>
      <label className="maintenance-form-field">
        <span>Prazo</span>
        <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
      </label>
      <TextField label="Observações (opcional)" value={notes} onChange={setNotes} required={false} rows={2} />
    </ActionDialog>
  )
}

function SubtasksCard({ data, onReload, setError }: { data: Detail; onReload: Reload; setError: (text: string) => void }) {
  const [adding, setAdding] = useState(false)
  const closed = data.demand.status === 'concluida' || data.demand.status === 'cancelada'

  async function setStatus(id: string, status: string) {
    try {
      await updateDemandSubtask(data.demand.id, id, { status })
      setError('')
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível alterar a etapa.'))
    }
    await onReload()
  }

  return (
    <section className="ui-card demand-panel" aria-labelledby="demand-subtasks">
      <div className="demand-panel-heading">
        <h2 id="demand-subtasks">Etapas</h2>
        {data.access.subtasksManage && !closed && (
          <button type="button" className="maintenance-secondary-button" onClick={() => setAdding(true)}>
            <Icon name="add" size={18} />
            Nova etapa
          </button>
        )}
      </div>
      {data.demand.progress !== null && <ProgressBar value={data.demand.progress} label={`${data.demand.progress}% das etapas concluídas`} />}
      {data.subtasks.length === 0 ? (
        <p className="demand-muted">Nenhuma etapa. A demanda pode ser acompanhada sem dividi-la.</p>
      ) : (
        <ul className="demand-subtasks">
          {data.subtasks.map((item) => (
            <li key={item.id}>
              <div>
                <strong>{item.title}</strong>
                {item.description && <p>{item.description}</p>}
                <small className="demand-muted">
                  {item.responsible ?? 'Sem responsável'}
                  {item.dueDate && ` · prazo ${formatCalendarDate(item.dueDate)}`}
                  {item.overdue && ' · Atrasada'}
                  {item.notes && ` · ${item.notes}`}
                </small>
              </div>
              <label>
                <span className="visually-hidden">Status de {item.title}</span>
                <select
                  value={item.status}
                  disabled={!item.canUpdate || closed}
                  onChange={(event) => void setStatus(item.id, event.target.value)}
                >
                  {Object.entries(subtaskStatusLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
            </li>
          ))}
        </ul>
      )}
      {adding && <SubtaskDialog data={data} onClose={() => setAdding(false)} onDone={onReload} />}
    </section>
  )
}

function CommentsCard({ data, onReload }: { data: Detail; onReload: Reload }) {
  const { options } = useDemands()
  const [kind, setKind] = useState('comentario')
  const [text, setText] = useState('')
  const [mention, setMention] = useState('')
  const [mentions, setMentions] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await addDemandComment(data.demand.id, { kind, text, mentions })
      setText('')
      setMentions([])
      await onReload()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível registrar.'))
    } finally {
      setBusy(false)
    }
  }

  const nameOf = (id: string) => options.people.find((person) => person.id === id)?.name ?? id

  return (
    <section className="ui-card demand-panel" aria-labelledby="demand-comments">
      <div className="demand-panel-heading">
        <h2 id="demand-comments">Comentários e providências</h2>
      </div>
      {data.comments.length === 0 ? (
        <p className="demand-muted">Nenhum registro ainda.</p>
      ) : (
        <ul className="demand-comments">
          {data.comments.map((comment) => (
            <li key={comment.id}>
              <header>
                <strong>{comment.author}</strong>
                <span className="demand-flag">{commentKindLabels[comment.kind] ?? comment.kind}</span>
                <small className="demand-muted">{formatDateTime(comment.at)}</small>
              </header>
              <p>{comment.text}</p>
              {comment.mentions.length > 0 && <small className="demand-muted">Mencionou: {comment.mentions.join(', ')}</small>}
            </li>
          ))}
        </ul>
      )}
      {data.access.comment && (
        <form className="demand-comment-form" onSubmit={(event) => void submit(event)}>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="demand-form-grid">
            <label className="maintenance-form-field">
              <span>Tipo de registro</span>
              <select value={kind} onChange={(event) => setKind(event.target.value)}>
                {Object.entries(commentKindLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="maintenance-form-field">
              <span>Mencionar</span>
              <select
                value={mention}
                onChange={(event) => {
                  const value = event.target.value
                  if (value && !mentions.includes(value)) setMentions((current) => [...current, value])
                  setMention('')
                }}
              >
                <option value="">Selecione uma pessoa</option>
                {options.people.map((person) => (
                  <option key={person.id} value={person.id}>{person.name}</option>
                ))}
              </select>
            </label>
          </div>
          {mentions.length > 0 && (
            <p className="demand-mentions">
              {mentions.map((id) => (
                <button type="button" key={id} className="demand-flag" onClick={() => setMentions((current) => current.filter((item) => item !== id))}>
                  {nameOf(id)}
                  <Icon name="close" size={12} weight="bold" />
                </button>
              ))}
            </p>
          )}
          <label className="maintenance-form-field">
            <span>Texto</span>
            <textarea required maxLength={4000} rows={3} value={text} onChange={(event) => setText(event.target.value)} />
          </label>
          <div className="demand-dialog-actions">
            <button type="submit" className="maintenance-primary-button" disabled={busy || !text.trim()}>Registrar</button>
          </div>
        </form>
      )}
    </section>
  )
}

const viewableKinds = new Set(['pdf', 'png', 'jpeg', 'webp'])

function sizeLabel(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

function AttachmentsCard({ data, onReload }: { data: Detail; onReload: Reload }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [limits, setLimits] = useState<{ maxFileMb: number; storageConfigured: boolean } | null>(null)
  // Etapa opcional do anexo. Vazio: o anexo fica só na demanda.
  const [subtaskId, setSubtaskId] = useState('')
  const subtaskTitle = (id: string | null) => (id ? data.subtasks.find((item) => item.id === id)?.title ?? null : null)

  useEffect(() => {
    let active = true
    fetchDemandAttachmentLimits(data.demand.id)
      .then((result) => {
        if (active) setLimits({ maxFileMb: result.limits.maxFileMb, storageConfigured: result.storageConfigured })
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [data.demand.id])

  async function upload(files: FileList | null) {
    if (!files?.length) return
    setBusy(true)
    setError('')
    try {
      for (const file of files) await uploadDemandAttachment(data.demand.id, file, 'documento', subtaskId || undefined)
      await onReload()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível enviar o arquivo.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ui-card demand-panel" aria-labelledby="demand-attachments">
      <div className="demand-panel-heading">
        <h2 id="demand-attachments">Anexos</h2>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {limits && !limits.storageConfigured && (
        <Alert tone="warning">O armazenamento de anexos ainda não foi configurado no servidor.</Alert>
      )}
      {data.attachments.length === 0 ? (
        <p className="demand-muted">Nenhum anexo.</p>
      ) : (
        <ul className="demand-attachments">
          {data.attachments.map((item) => (
            <li key={item.id} className={item.removedAt ? 'is-removed' : ''}>
              <div>
                <strong>{item.name}</strong>
                <small className="demand-muted">
                  {item.category === 'comprovante' ? 'Comprovante · ' : ''}
                  {subtaskTitle(item.subtaskId) ? `Etapa: ${subtaskTitle(item.subtaskId)} · ` : ''}
                  {sizeLabel(item.sizeBytes)} · {item.uploadedBy} · {formatDateTime(item.uploadedAt)}
                </small>
                {item.removedAt && (
                  <small className="demand-muted">
                    Removido por {item.removedBy} em {formatDateTime(item.removedAt)}: {item.removalReason}
                  </small>
                )}
              </div>
              {!item.removedAt && (
                <span className="demand-actions">
                  {viewableKinds.has(item.kind) && (
                    <a className="maintenance-secondary-button" href={demandAttachmentUrl(item.id, true)} target="_blank" rel="noreferrer">
                      <Icon name="view" size={16} />
                      Abrir
                    </a>
                  )}
                  <a className="maintenance-secondary-button" href={demandAttachmentUrl(item.id)} download>
                    <Icon name="download" size={16} />
                    Baixar
                  </a>
                  {item.canRemove && (
                    <button type="button" className="ui-button-danger" onClick={() => setRemoving(item.id)}>Remover</button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {data.access.attach && data.subtasks.length > 0 && (
        <label className="maintenance-form-field">
          <span>Etapa do anexo (opcional)</span>
          <select value={subtaskId} disabled={busy} onChange={(event) => setSubtaskId(event.target.value)}>
            <option value="">Só a demanda</option>
            {data.subtasks.map((item) => (
              <option key={item.id} value={item.id}>{item.title}</option>
            ))}
          </select>
        </label>
      )}
      {data.access.attach && (
        <label className="maintenance-form-field">
          <span>Adicionar arquivos{limits ? ` (até ${limits.maxFileMb} MB cada)` : ''}</span>
          <input
            type="file"
            multiple
            disabled={busy}
            accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.txt"
            onChange={(event) => {
              void upload(event.target.files)
              event.target.value = ''
            }}
          />
        </label>
      )}
      {removing && (
        <ReasonDialog
          title="Remover anexo"
          label="Motivo da remoção"
          submitLabel="Remover"
          danger
          onClose={() => setRemoving(null)}
          onSubmit={async (reason) => {
            await removeDemandAttachment(removing, reason)
            await onReload()
          }}
        />
      )}
    </section>
  )
}

function LinksCard({ data, onReload }: { data: Detail; onReload: Reload }) {
  const [module, setModule] = useState('maintenance')
  const [protocol, setProtocol] = useState('')
  const [error, setError] = useState('')

  async function add(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await addDemandLink(data.demand.id, { module, protocol })
      setProtocol('')
      await onReload()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível vincular.'))
    }
  }

  async function remove(linkId: string) {
    setError('')
    try {
      await removeDemandLink(data.demand.id, linkId)
      await onReload()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível remover o vínculo.'))
    }
  }

  return (
    <section className="ui-card demand-panel" aria-labelledby="demand-links">
      <div className="demand-panel-heading">
        <h2 id="demand-links">Vínculos com outros módulos</h2>
      </div>
      <p className="demand-muted">O vínculo só referencia o registro: nada na solicitação original é alterado.</p>
      {error && <Alert tone="error">{error}</Alert>}
      {data.links.length > 0 && (
        <ul className="demand-attachments">
          {data.links.map((link) => (
            <li key={link.id}>
              <div>
                <strong>{moduleLinkLabels[link.module] ?? link.module}</strong>
                {link.path ? <Link to={link.path}>{link.protocol}</Link> : <span>{link.protocol}</span>}
              </div>
              {data.access.attach && (
                <button type="button" className="maintenance-secondary-button" onClick={() => void remove(link.id)}>Remover</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {data.access.attach && (
        <form className="demand-form-grid" onSubmit={(event) => void add(event)}>
          <label className="maintenance-form-field">
            <span>Módulo</span>
            <select value={module} onChange={(event) => setModule(event.target.value)}>
              {Object.entries(moduleLinkLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="maintenance-form-field">
            <span>Protocolo do registro</span>
            <input required maxLength={40} placeholder="MAN-2026-00001" value={protocol} onChange={(event) => setProtocol(event.target.value)} />
          </label>
          <button type="submit" className="maintenance-secondary-button">Vincular</button>
        </form>
      )}
    </section>
  )
}

function SeriesCard({ data, onReload }: { data: Detail; onReload: Reload }) {
  const { series, demand, access } = data
  const [dialog, setDialog] = useState<'suspend' | 'cancel' | 'skip' | 'skipDate' | 'rule' | null>(null)
  const [cancelFuture, setCancelFuture] = useState(false)
  const [skipDate, setSkipDate] = useState('')
  const [reason, setReason] = useState('')
  const [draft, setDraft] = useState<RecurrenceDraft>(() =>
    series
      ? recurrenceDraftFrom({
          frequency: series.frequency,
          interval: series.interval,
          unit: series.unit,
          weekdays: series.weekdays,
          monthDays: series.monthDays,
          startDate: series.startDate,
          end: series.end,
          leadDays: series.leadDays,
          startOffsetDays: series.startOffsetDays,
        })
      : emptyRecurrence(),
  )
  const [error, setError] = useState('')
  if (!series) return null
  const running = series.status === 'ativa' || series.status === 'suspensa'
  const open = demand.status !== 'concluida' && demand.status !== 'cancelada'

  async function resume() {
    setError('')
    try {
      await resumeSeries(demand.id)
      await onReload()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível retomar.'))
    }
  }

  return (
    <section className="ui-card demand-panel" aria-labelledby="demand-series">
      <div className="demand-panel-heading">
        <h2 id="demand-series">Recorrência</h2>
        <span className="demand-flag">{seriesStatusLabels[series.status] ?? series.status}</span>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <p>{series.description}</p>
      <dl className="demand-facts">
        <div>
          <dt>Esta ocorrência</dt>
          <dd>
            {formatCalendarDate(demand.occurrenceDate)}
            {demand.customOccurrence && ' · editada individualmente'}
          </dd>
        </div>
        <div>
          <dt>Próxima geração</dt>
          <dd>{series.nextExecution ? formatCalendarDate(series.nextExecution) : 'Nenhuma'}</dd>
        </div>
        <div>
          <dt>Ocorrências registradas</dt>
          <dd>{series.counted}</dd>
        </div>
      </dl>

      {series.upcoming.length > 0 && (
        <p className="demand-muted">
          Próximas datas previstas: {series.upcoming.map((date) => formatCalendarDate(date)).join(', ')}
        </p>
      )}

      {access.edit && running && (
        <div className="demand-actions">
          {series.status === 'ativa' && (
            <button type="button" className="maintenance-secondary-button" onClick={() => setDialog('suspend')}>Suspender</button>
          )}
          {series.status === 'suspensa' && (
            <button type="button" className="maintenance-secondary-button" onClick={() => void resume()}>Retomar</button>
          )}
          <button type="button" className="maintenance-secondary-button" onClick={() => setDialog('rule')}>Alterar repetição</button>
          <button type="button" className="maintenance-secondary-button" onClick={() => setDialog('skipDate')}>Pular uma data</button>
          {open && (
            <button type="button" className="maintenance-secondary-button" onClick={() => setDialog('skip')}>Pular esta ocorrência</button>
          )}
          <button type="button" className="ui-button-danger" onClick={() => setDialog('cancel')}>Cancelar recorrência</button>
        </div>
      )}

      <details className="demand-details">
        <summary>Ocorrências da série ({series.occurrences.length})</summary>
        <ul className="demand-mini-list">
          {series.occurrences.map((item) => (
            <li key={item.date}>
              {item.demandId ? (
                <Link to={`/demandas/${item.demandId}`}>
                  <strong>{item.number}</strong>
                  <span>{item.status ? demandStatusLabels[item.status as DemandStatus] : ''}</span>
                </Link>
              ) : (
                <div>
                  <strong>{item.situation === 'pulada' ? 'Pulada' : 'Sem acesso'}</strong>
                  {item.reason && <span>{item.reason}</span>}
                </div>
              )}
              <span className="demand-due">{formatCalendarDate(item.date)}</span>
            </li>
          ))}
        </ul>
      </details>

      {dialog === 'suspend' && (
        <ReasonDialog
          title="Suspender recorrência"
          label="Justificativa"
          submitLabel="Suspender"
          onClose={() => setDialog(null)}
          onSubmit={async (text) => {
            await suspendSeries(demand.id, text)
            await onReload()
          }}
        />
      )}
      {dialog === 'skip' && (
        <ReasonDialog
          title="Pular esta ocorrência"
          label="Motivo"
          submitLabel="Pular"
          onClose={() => setDialog(null)}
          onSubmit={async (text) => {
            await skipOccurrence(demand.id, { reason: text })
            await onReload()
          }}
        />
      )}
      {dialog === 'skipDate' && (
        <ActionDialog
          title="Pular uma data futura"
          submitLabel="Pular"
          onClose={() => setDialog(null)}
          onSubmit={async () => {
            await skipOccurrence(demand.id, { reason, date: skipDate })
            await onReload()
          }}
        >
          <label className="maintenance-form-field">
            <span>Data</span>
            <select required value={skipDate} onChange={(event) => setSkipDate(event.target.value)}>
              <option value="">Selecione</option>
              {series.upcoming.map((date) => (
                <option key={date} value={date}>{formatCalendarDate(date)}</option>
              ))}
            </select>
          </label>
          <TextField label="Motivo" value={reason} onChange={setReason} />
        </ActionDialog>
      )}
      {dialog === 'cancel' && (
        <ActionDialog
          title="Cancelar recorrência"
          submitLabel="Cancelar recorrência"
          danger
          onClose={() => setDialog(null)}
          onSubmit={async () => {
            await cancelSeries(demand.id, { reason, cancelFuture })
            await onReload()
          }}
        >
          <p>As ocorrências anteriores e seus históricos são preservados. Nenhuma nova ocorrência será gerada.</p>
          <TextField label="Motivo" value={reason} onChange={setReason} />
          <label className="demand-check">
            <input type="checkbox" checked={cancelFuture} onChange={(event) => setCancelFuture(event.target.checked)} />
            Cancelar também as ocorrências futuras já geradas e não iniciadas
          </label>
        </ActionDialog>
      )}
      {dialog === 'rule' && (
        <ActionDialog
          title="Alterar a repetição"
          submitLabel="Salvar repetição"
          onClose={() => setDialog(null)}
          onSubmit={async () => {
            await changeSeriesRule(demand.id, recurrencePayload(draft))
            await onReload()
          }}
        >
          <p className="demand-muted">Vale daqui em diante. As ocorrências já geradas não mudam.</p>
          <RecurrenceFields draft={draft} onChange={setDraft} />
        </ActionDialog>
      )}
    </section>
  )
}

function HistoryCard({ data }: { data: Detail }) {
  return (
    <section className="ui-card demand-panel" aria-labelledby="demand-history">
      <div className="demand-panel-heading">
        <h2 id="demand-history">Histórico</h2>
      </div>
      <ol className="demand-history">
        {data.history.map((item) => {
          const lines = historyLines(item.action, item.details)
          return (
            <li key={item.id}>
              <strong>{historyTitle(item.action, item.details)}</strong>
              {lines.length > 0 && (
                <dl className="demand-history-changes">
                  {lines.map((line, index) => (
                    <div key={index} className={line.long ? 'is-long' : undefined}>
                      <dt>{line.label}:</dt>
                      <dd>{line.text}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {item.comment && <span>Justificativa: {item.comment}</span>}
              <small className="demand-muted">
                Realizado por {item.user ?? 'Sistema'} · {formatDateTime(item.at)}
              </small>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function DemandDetail() {
  const { demandId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [data, setData] = useState<Detail | null>(null)
  const [error, setError] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [actionError, setActionError] = useState('')
  const [dialog, setDialog] = useState<'status' | 'complete' | 'reopen' | 'cancel' | 'assign' | 'collaboration' | 'discard' | null>(null)
  const uploadErrors = (location.state as { uploadErrors?: string[] } | null)?.uploadErrors

  const load = useCallback(async () => {
    try {
      setData(await fetchDemand(demandId as string))
      setError('')
    } catch (err) {
      if ((err as { status?: number }).status === 404) setNotFound(true)
      else setError(errorMessage(err, 'Não foi possível carregar a demanda.'))
    }
  }, [demandId])

  useEffect(() => {
    let active = true
    fetchDemand(demandId as string)
      .then((result) => {
        if (!active) return
        setData(result)
        setNotFound(false)
        setError('')
      })
      .catch((err: unknown) => {
        if (!active) return
        if ((err as { status?: number }).status === 404) setNotFound(true)
        else setError(errorMessage(err, 'Não foi possível carregar a demanda.'))
      })
    return () => {
      active = false
    }
  }, [demandId])

  if (notFound) {
    return (
      <section className="ui-card">
        <EmptyState icon="search" title="Demanda não encontrada">
          Ela pode não existir, ou você pode não ter acesso a ela.
        </EmptyState>
      </section>
    )
  }
  if (error) return <Alert tone="error">{error}</Alert>
  if (!data) return <Loading label="Carregando demanda..." />

  const { demand, access } = data
  const closed = demand.status === 'concluida' || demand.status === 'cancelada'

  async function publish() {
    setActionError('')
    try {
      await publishDemand(demand.id)
      await load()
    } catch (err) {
      setActionError(errorMessage(err, 'Não foi possível publicar.'))
    }
  }

  async function toggleFollow() {
    setActionError('')
    try {
      await followDemand(demand.id, !data?.following)
      await load()
    } catch (err) {
      setActionError(errorMessage(err, 'Não foi possível alterar o acompanhamento.'))
    }
  }

  const collaborators = data.participants.filter((item) => item.kind === 'colaborador')
  const authorized = data.participants.filter((item) => item.kind === 'autorizado')

  return (
    <div className="demand-stack demand-detail">
      <PageHeader
        eyebrow={demand.number}
        title={demand.title}
        actions={
          <div className="demand-actions">
            {demand.draft && access.edit && (
              <>
                <button type="button" className="maintenance-primary-button" onClick={() => void publish()}>Publicar</button>
                <button type="button" className="ui-button-danger" onClick={() => setDialog('discard')}>Descartar</button>
              </>
            )}
            {!closed && access.edit && (
              <Link className="maintenance-secondary-button" to={`/demandas/${demand.id}/editar`}>Editar</Link>
            )}
            {!demand.draft && !closed && access.edit && (
              <>
                <button type="button" className="maintenance-secondary-button" onClick={() => setDialog('status')}>Alterar status</button>
                <button type="button" className="maintenance-primary-button" onClick={() => setDialog('complete')}>Concluir</button>
                <button type="button" className="ui-button-danger" onClick={() => setDialog('cancel')}>Cancelar</button>
              </>
            )}
            {demand.status === 'concluida' && access.edit && (
              <button type="button" className="maintenance-primary-button" onClick={() => setDialog('reopen')}>Reabrir</button>
            )}
            {!closed && access.assign && !demand.draft && (
              <button type="button" className="maintenance-secondary-button" onClick={() => setDialog('assign')}>Distribuir</button>
            )}
            {!closed && access.edit && !demand.draft && (
              <button type="button" className="maintenance-secondary-button" onClick={() => setDialog('collaboration')}>Colaboração</button>
            )}
            {!demand.draft && access.follow && (
              <button type="button" className="maintenance-secondary-button" onClick={() => void toggleFollow()}>
                {data.following ? 'Deixar de acompanhar' : 'Acompanhar'}
              </button>
            )}
          </div>
        }
      />

      {uploadErrors && (
        <Alert tone="warning">A demanda foi salva, mas alguns anexos não foram enviados: {uploadErrors.join('; ')}</Alert>
      )}
      {actionError && <Alert tone="error">{actionError}</Alert>}
      {access.readOnly && (
        <Alert tone="info">
          Modo de consulta: você acompanha o andamento, os prazos, os responsáveis, o histórico e os anexos, sem alterar esta demanda.
        </Alert>
      )}
      {access.administrativeRead && (
        <Alert tone="warning">Demanda restrita, aberta pelo acesso administrativo. Esta consulta fica registrada na auditoria.</Alert>
      )}
      {demand.draft && <Alert tone="info">Rascunho: só você pode ver. Publique para distribuir a demanda.</Alert>}

      <section className="ui-card demand-summary">
        <div className="demand-summary-head">
          <DemandStatusBadge status={demand.status} />
          <PriorityTag priority={demand.priority} />
          <DueLabel demand={demand} />
          <DemandFlags demand={demand} />
        </div>
        {demand.description && <p className="demand-description">{demand.description}</p>}
        <dl className="demand-facts">
          <div><dt>Categoria</dt><dd>{demand.category ?? '—'}</dd></div>
          <div><dt>Setor solicitante</dt><dd>{demand.originSector ?? '—'}</dd></div>
          <div><dt>Setor responsável</dt><dd>{demand.responsibleSector ?? '—'}</dd></div>
          <div><dt>Responsável principal</dt><dd>{demand.responsible ?? 'Sem responsável'}</dd></div>
          <div><dt>Diretor do acompanhamento</dt><dd>{demand.followUpManager ?? '—'}</dd></div>
          <div><dt>Solicitante</dt><dd>{demand.requester ?? '—'}</dd></div>
          <div><dt>Cadastrada por</dt><dd>{demand.createdBy}</dd></div>
          <div><dt>Abertura</dt><dd>{formatDateTime(demand.openedAt)}</dd></div>
          <div><dt>Início previsto</dt><dd>{formatCalendarDate(demand.startDate)}</dd></div>
          <div><dt>Lembrete</dt><dd>{demand.reminderDays === null ? 'Preferência de cada pessoa' : `${demand.reminderDays} dia(s) antes`}</dd></div>
          {demand.waitingFor && <div><dt>Aguardando</dt><dd>{demand.waitingFor}</dd></div>}
          {demand.suspensionReason && <div><dt>Motivo da suspensão</dt><dd>{demand.suspensionReason}</dd></div>}
          {demand.resumeDate && <div><dt>Previsão de retomada</dt><dd>{formatCalendarDate(demand.resumeDate)}</dd></div>}
          {demand.reopenings > 0 && <div><dt>Reaberturas</dt><dd>{demand.reopenings}</dd></div>}
          {demand.notes && <div className="demand-fact-wide"><dt>Observações</dt><dd>{demand.notes}</dd></div>}
          {demand.references && <div className="demand-fact-wide"><dt>Referências</dt><dd>{demand.references}</dd></div>}
          <ExtraFieldsView items={data.customFields} />
          {data.instrument && (
            <div className="demand-fact-wide">
              <dt>Ata ou contrato</dt>
              <dd>
                <Link to={`/demandas/atas/${data.instrument.id}`}>
                  {data.instrument.type === 'ata' ? 'Ata' : 'Contrato'} {data.instrument.number}
                </Link>{' '}
                {data.instrument.subject}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {demand.completion && (
        <section className="ui-card demand-panel">
          <div className="demand-panel-heading"><h2>Conclusão</h2></div>
          <dl className="demand-facts">
            <div className="demand-fact-wide"><dt>O que foi realizado</dt><dd>{demand.completion.done}</dd></div>
            {demand.completion.result && <div className="demand-fact-wide"><dt>Resultado</dt><dd>{demand.completion.result}</dd></div>}
            {demand.completion.notes && <div className="demand-fact-wide"><dt>Observações finais</dt><dd>{demand.completion.notes}</dd></div>}
            <div><dt>Concluída por</dt><dd>{demand.completion.by}</dd></div>
            <div><dt>Em</dt><dd>{formatDateTime(demand.completion.at)}</dd></div>
          </dl>
        </section>
      )}
      {demand.cancellation && (
        <section className="ui-card demand-panel">
          <div className="demand-panel-heading"><h2>Cancelamento</h2></div>
          <p>{demand.cancellation.reason}</p>
          <small className="demand-muted">{demand.cancellation.by} · {formatDateTime(demand.cancellation.at)}</small>
        </section>
      )}

      {(collaborators.length > 0 || data.collaboratorSectors.length > 0 || authorized.length > 0) && (
        <section className="ui-card demand-panel">
          <div className="demand-panel-heading"><h2>Colaboração</h2></div>
          {data.collaboratorSectors.length > 0 && (
            <p><strong>Setores colaboradores:</strong> {data.collaboratorSectors.map((item) => item.name).join(', ')}</p>
          )}
          {collaborators.length > 0 && (
            <ul className="demand-mini-list">
              {collaborators.map((item) => (
                <li key={item.userId}>
                  <div>
                    <strong>{item.name}</strong>
                    <span>{item.activity ?? 'Sem atividade específica'}</span>
                  </div>
                  {item.dueDate && <span className="demand-due">{formatCalendarDate(item.dueDate)}</span>}
                </li>
              ))}
            </ul>
          )}
          {authorized.length > 0 && <p><strong>Autorizados:</strong> {authorized.map((item) => item.name).join(', ')}</p>}
        </section>
      )}

      <SeriesCard key={`${data.series?.id}-${data.series?.status}`} data={data} onReload={load} />
      <SubtasksCard data={data} onReload={load} setError={setActionError} />
      <CommentsCard data={data} onReload={load} />
      <AttachmentsCard data={data} onReload={load} />
      <LinksCard data={data} onReload={load} />
      <HistoryCard data={data} />

      {dialog === 'status' && <StatusDialog data={data} onClose={() => setDialog(null)} onDone={load} />}
      {dialog === 'complete' && <CompleteDialog data={data} onClose={() => setDialog(null)} onDone={load} />}
      {dialog === 'assign' && <AssignDialog data={data} onClose={() => setDialog(null)} onDone={load} />}
      {dialog === 'collaboration' && <CollaborationDialog data={data} onClose={() => setDialog(null)} onDone={load} />}
      {dialog === 'reopen' && (
        <ReasonDialog
          title="Reabrir demanda"
          label="Justificativa"
          submitLabel="Reabrir"
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            await reopenDemand(demand.id, reason)
            await load()
          }}
        />
      )}
      {dialog === 'cancel' && (
        <ReasonDialog
          title="Cancelar demanda"
          label="Motivo do cancelamento"
          submitLabel="Cancelar demanda"
          danger
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            await cancelDemand(demand.id, reason)
            await load()
          }}
        />
      )}
      {dialog === 'discard' && (
        <ReasonDialog
          title="Descartar rascunho"
          label="Motivo"
          submitLabel="Descartar"
          danger
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            await discardDemand(demand.id, reason)
            navigate('/demandas/todas')
          }}
        />
      )}
    </div>
  )
}

export default DemandDetail
