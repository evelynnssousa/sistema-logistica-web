import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { errorMessage, formatDateTime, fromLocalInput, listAssignees, toLocalInput } from '../api/modulesApi'
import type { RequestDetail } from '../api/modulesApi'
import {
  addRequestNote,
  assignRequest,
  complexityLabels,
  priorityLabels,
  setRequestComplexity,
  setRequestDeadline,
  setRequestPriority,
} from '../api/operationsApi'
import { useHasPermission } from '../auth/UserContext'
import { Alert } from './ui/Feedback'

function ManagementForm({
  title,
  submitLabel,
  onSubmit,
  children,
}: {
  title: string
  submitLabel: string
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
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível salvar.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="management-form" onSubmit={(event) => void submit(event)}>
      <h3>{title}</h3>
      {children}
      {error && <Alert tone="error">{error}</Alert>}
      <button type="submit" className="maintenance-secondary-button" disabled={busy}>
        {submitLabel}
      </button>
    </form>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="maintenance-form-field">
      <span>{label}</span>
      {children}
    </label>
  )
}

/**
 * Gestão pela Central da SLM: responsável, prioridade, prazo e observações. Só aparece com a
 * permissão da Central; a mesma permissão é exigida pela API em cada ação.
 */
function RequestManagement({ detail, onDone }: { detail: RequestDetail; onDone: () => Promise<void> }) {
  const canRead = useHasPermission('slm_central:read')
  const canManage = useHasPermission('slm_central:manage')
  const { request, notes } = detail
  const closed = ['concluido', 'cancelado', 'emitida', 'cancelada'].includes(request.status)

  const [assignees, setAssignees] = useState<{ id: string; name: string }[]>([])
  const [responsibleId, setResponsibleId] = useState(request.responsibleId ?? '')
  const [assignReason, setAssignReason] = useState('')
  const [priority, setPriority] = useState(request.priority)
  const [priorityReason, setPriorityReason] = useState('')
  const [deadline, setDeadline] = useState(toLocalInput(request.deadline))
  const [deadlineReason, setDeadlineReason] = useState('')
  const [complexity, setComplexity] = useState(request.complexity ?? '')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!canManage) return
    let active = true
    listAssignees()
      .then((data) => {
        if (active) setAssignees(data.assignees)
      })
      .catch(() => {
        // Sem a lista, o responsável atual continua visível no resumo.
      })
    return () => {
      active = false
    }
  }, [canManage])

  if (!canRead) return null

  return (
    <section className="admin-data-card detail-card" aria-labelledby="management-title">
      <h2 id="management-title">Gestão da solicitação</h2>
      <dl className="detail-grid">
        <div className="detail-info">
          <dt>Responsável</dt>
          <dd>{request.responsible ?? 'Sem responsável'}</dd>
        </div>
        <div className="detail-info">
          <dt>Prioridade</dt>
          <dd>{priorityLabels[request.priority] ?? request.priority}</dd>
        </div>
        <div className="detail-info">
          <dt>Prazo</dt>
          <dd>{formatDateTime(request.deadline)}</dd>
        </div>
        <div className="detail-info">
          <dt>Complexidade</dt>
          <dd>{request.complexity ? complexityLabels[request.complexity] : 'Não classificada'}</dd>
        </div>
      </dl>

      {canManage && !closed && (
        <details className="management-details">
          <summary>Alterar responsável, prioridade, prazo ou complexidade</summary>
        <div className="management-grid">
          <ManagementForm
            title="Responsável"
            submitLabel="Salvar responsável"
            onSubmit={async () => {
              await assignRequest(request.id, responsibleId || null, assignReason)
              setAssignReason('')
              await onDone()
            }}
          >
            <Field label="Integrante">
              <select value={responsibleId} onChange={(event) => setResponsibleId(event.target.value)}>
                <option value="">Sem responsável</option>
                {assignees.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={request.responsibleId ? 'Justificativa *' : 'Justificativa'}>
              <textarea
                rows={2}
                required={Boolean(request.responsibleId)}
                value={assignReason}
                onChange={(event) => setAssignReason(event.target.value)}
              />
            </Field>
          </ManagementForm>

          <ManagementForm
            title="Prioridade"
            submitLabel="Salvar prioridade"
            onSubmit={async () => {
              await setRequestPriority(request.id, priority, priorityReason)
              setPriorityReason('')
              await onDone()
            }}
          >
            <Field label="Prioridade">
              <select value={priority} onChange={(event) => setPriority(event.target.value)}>
                {Object.entries(priorityLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Justificativa *">
              <textarea required rows={2} value={priorityReason} onChange={(event) => setPriorityReason(event.target.value)} />
            </Field>
          </ManagementForm>

          <ManagementForm
            title="Prazo"
            submitLabel="Salvar prazo"
            onSubmit={async () => {
              await setRequestDeadline(request.id, fromLocalInput(deadline) ?? null, deadlineReason)
              setDeadlineReason('')
              await onDone()
            }}
          >
            <Field label="Prazo">
              <input type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
            </Field>
            <Field label={request.deadline ? 'Justificativa *' : 'Justificativa'}>
              <textarea
                rows={2}
                required={Boolean(request.deadline)}
                value={deadlineReason}
                onChange={(event) => setDeadlineReason(event.target.value)}
              />
            </Field>
          </ManagementForm>

          <ManagementForm
            title="Complexidade"
            submitLabel="Salvar complexidade"
            onSubmit={async () => {
              await setRequestComplexity(request.id, complexity || null)
              await onDone()
            }}
          >
            <Field label="Complexidade">
              <select value={complexity} onChange={(event) => setComplexity(event.target.value)}>
                <option value="">Não classificada</option>
                {Object.entries(complexityLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </ManagementForm>
        </div>
        </details>
      )}

      <h3 className="management-notes-title">Observações internas</h3>
      <p className="management-hint">Visíveis só para a equipe. Não podem ser alteradas depois de registradas.</p>
      {notes.length === 0 ? (
        <p>Nenhuma observação registrada.</p>
      ) : (
        <ul className="detail-history">
          {notes.map((item) => (
            <li key={item.id}>
              <span>{item.text}</span>
              <small>
                {item.author} · {formatDateTime(item.at)}
              </small>
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <ManagementForm
          title="Nova observação"
          submitLabel="Registrar observação"
          onSubmit={async () => {
            await addRequestNote(request.id, note)
            setNote('')
            await onDone()
          }}
        >
          <Field label="Observação *">
            <textarea required rows={2} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </ManagementForm>
      )}
    </section>
  )
}

export default RequestManagement
