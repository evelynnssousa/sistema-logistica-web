import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  protocolLabel,
  errorMessage,
  formatDateTime,
  moduleLabels,
  fromLocalInput,
  getCapabilities,
  getRequest,
  listAssignees,
  readFullCpf,
  replacePassengers,
  requestAction,
  statusLabels,
  toLocalInput,
  updateRequest,
} from '../api/modulesApi'
import type { ReasonOption, RequestDetail, RequestModule, ScheduleConflict } from '../api/modulesApi'
import { ApiError } from '../auth/apiClient'
import { useHasPermission } from '../auth/UserContext'
import { Alert, Loading } from '../components/ui/Feedback'
import Icon from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'
import DeleteRecordButton from '../components/DeleteRecordButton'
import StatusBadge from '../components/ui/StatusBadge'
import RequestTimeline from '../components/RequestTimeline'
import RequestManagement from '../components/RequestManagement'
import ReportExport from '../components/ReportExport'
import ReturnPanel from '../components/ReturnPanel'
import CommunicationsPanel from '../components/CommunicationsPanel'
import AttachmentsPanel from '../components/AttachmentsPanel'
import TripExecutionPanel from '../components/TripExecutionPanel'
import { ExecutionPanel, QuotesPanel } from '../components/ModulePanels'
import { attachmentCategoriesFor } from '../api/operationsApi'

const titles: Record<RequestModule, string> = {
  maintenance: 'Solicitação de manutenção',
  fleet: 'Solicitação de frota',
  flights: 'Solicitação de passagens aéreas',
}

const paths: Record<RequestModule, string> = {
  maintenance: '/manutencao',
  fleet: '/frota',
  flights: '/passagens-aereas',
}

const tripLabels: Record<string, string> = {
  ida_volta: 'Ida e volta',
  somente_ida: 'Somente ida',
  somente_volta: 'Somente volta',
}

function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="detail-info">
      <dt>{label}</dt>
      <dd>{value || '—'}</dd>
    </div>
  )
}

function ActionForm({
  title,
  submitLabel,
  onSubmit,
  children,
  danger = false,
}: {
  title: string
  submitLabel: string
  onSubmit: () => Promise<void>
  children?: ReactNode
  danger?: boolean
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
      setError(errorMessage(err, 'Não foi possível concluir a ação.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="detail-action" onSubmit={(event) => void submit(event)}>
      <h3>{title}</h3>
      {children}
      {error && <Alert tone="error">{error}</Alert>}
      <button
        type="submit"
        className={danger ? 'maintenance-secondary-button' : 'maintenance-primary-button'}
        disabled={busy}
      >
        {submitLabel}
      </button>
    </form>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <label className="maintenance-form-field">
      <span>{label}</span>
      {children}
    </label>
  )
}

/** Motivo padronizado com complemento livre. A API confere de novo ao gravar. */
function ReasonFields({
  options,
  code,
  text,
  required,
  label,
  onCode,
  onText,
}: {
  options: ReasonOption[]
  code: string
  text: string
  required: boolean
  label: string
  onCode: (value: string) => void
  onText: (value: string) => void
}) {
  return (
    <>
      <Field label={`${label}${required ? ' *' : ''}`}>
        <select required={required} value={code} onChange={(event) => onCode(event.target.value)}>
          <option value="">Selecione</option>
          {options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label={`Complemento${code === 'outro' ? ' *' : ''}`}>
        <textarea required={code === 'outro'} rows={2} maxLength={1000} value={text} onChange={(event) => onText(event.target.value)} />
      </Field>
    </>
  )
}

function requestedPeriod(detail: RequestDetail) {
  const data = detail.request.details
  const original = data.solicitacaoOriginal as { inicio?: string | null; fim?: string | null } | undefined
  return {
    start: original?.inicio ?? ((data.dataHora ?? data.dataPreferencial) as string | null | undefined) ?? null,
    end: original?.fim ?? (data.dataHoraRetorno as string | null | undefined) ?? null,
  }
}

const sameMinute = (first: string | null, second: string) =>
  Math.floor(new Date(first ?? '').getTime() / 60000) === Math.floor(new Date(second).getTime() / 60000)

const conflictReasons: Record<ScheduleConflict['reason'], string> = {
  responsible: 'mesmo responsável',
  vehicle: 'mesmo veículo',
  driver: 'mesmo motorista',
}

export function ScheduleForm({
  module,
  detail,
  onDone,
}: {
  module: RequestModule
  detail: RequestDetail
  onDone: () => Promise<void>
}) {
  const rescheduling = Boolean(detail.request.scheduledAt)
  const [scheduledAt, setScheduledAt] = useState(toLocalInput(detail.request.scheduledAt))
  const [scheduledEnd, setScheduledEnd] = useState(toLocalInput(detail.request.scheduledEnd))
  const [responsibleId, setResponsibleId] = useState(detail.request.responsibleId ?? '')
  const [comment, setComment] = useState('')
  const [reasonCode, setReasonCode] = useState('')
  const [conditions, setConditions] = useState('')
  const [reasons, setReasons] = useState<ReasonOption[]>([])
  const [assignees, setAssignees] = useState<{ id: string; name: string }[]>([])
  const [conflicts, setConflicts] = useState<ScheduleConflict[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [workday, setWorkday] = useState<{ workdayStart: string; workdayEnd: string } | null>(null)
  const scheduledTime = scheduledAt.slice(11, 16)
  const requested = requestedPeriod(detail)
  const diverges = Boolean(
    scheduledAt &&
      ((requested.start && !sameMinute(requested.start, fromLocalInput(scheduledAt)!)) ||
        (requested.end && scheduledEnd && !sameMinute(requested.end, fromLocalInput(scheduledEnd)!))),
  )
  const needsReason = rescheduling || diverges || Boolean(conditions)
  const outsideWorkday =
    workday && scheduledTime && (scheduledTime < workday.workdayStart || scheduledTime > workday.workdayEnd)

  useEffect(() => {
    let active = true
    getCapabilities()
      .then((data) => {
        if (!active) return
        setWorkday(data.workday ?? null)
        setReasons(data.reasons?.scheduling ?? [])
      })
      .catch(() => {
        // Sem o expediente, o agendamento segue sem o aviso.
      })
    listAssignees()
      .then((data) => {
        if (active) setAssignees(data.assignees)
      })
      .catch(() => {
        // Sem a lista, o responsável passa a ser quem agenda.
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <ActionForm
      title={rescheduling ? 'Reagendar' : 'Agendar'}
      submitLabel={rescheduling ? 'Confirmar reagendamento' : 'Confirmar agendamento'}
      onSubmit={async () => {
        try {
          await requestAction(module, detail.request.id, 'schedule', {
            dataAgendada: fromLocalInput(scheduledAt),
            dataFim: fromLocalInput(scheduledEnd),
            responsavelId: responsibleId || undefined,
            comentario: comment,
            motivoCodigo: reasonCode || undefined,
            condicoesAlteradas: conditions || undefined,
            versao: detail.request.updatedAt,
            confirmarConflito: confirmed,
          })
        } catch (error) {
          if (error instanceof ApiError && error.code === 'SCHEDULE_CONFLICT') {
            setConflicts((error.data as { conflicts: ScheduleConflict[] }).conflicts)
            setConfirmed(false)
          }
          throw error
        }
        await onDone()
      }}
    >
      <Field label="Data e horário *">
        <input type="datetime-local" required value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} />
      </Field>
      {outsideWorkday && (
        <Alert tone="warning">
          Horário fora do expediente configurado ({workday.workdayStart} às {workday.workdayEnd}). O agendamento é permitido.
        </Alert>
      )}
      <Field label="Término previsto">
        <input type="datetime-local" value={scheduledEnd} onChange={(event) => setScheduledEnd(event.target.value)} />
      </Field>
      <Field label="Responsável">
        <select value={responsibleId} onChange={(event) => setResponsibleId(event.target.value)}>
          <option value="">Quem está agendando</option>
          {assignees.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </Field>
      {requested.start && (
        <p className="management-hint">
          Solicitado: {formatDateTime(requested.start)}
          {requested.end ? ` a ${formatDateTime(requested.end)}` : ''}
        </p>
      )}
      {diverges && (
        <Alert tone="warning">Diferente do que foi solicitado: informe o motivo. Ele será enviado ao solicitante.</Alert>
      )}
      <Field label="Outras condições diferentes do solicitado">
        <input maxLength={500} value={conditions} onChange={(event) => setConditions(event.target.value)} />
      </Field>
      {needsReason ? (
        <ReasonFields
          options={reasons}
          code={reasonCode}
          text={comment}
          required
          label={rescheduling ? 'Motivo da alteração' : 'Motivo da adequação'}
          onCode={setReasonCode}
          onText={setComment}
        />
      ) : (
        <Field label="Comentário interno">
          <textarea rows={2} value={comment} onChange={(event) => setComment(event.target.value)} />
        </Field>
      )}
      {conflicts.length > 0 && (
        <div className="schedule-conflicts">
          <strong>Compromissos no mesmo horário</strong>
          <ul>
            {conflicts.map((conflict) => (
              <li key={conflict.id}>
                {moduleLabels[conflict.module]} {protocolLabel(conflict.protocol)}, {formatDateTime(conflict.start)}
                {conflict.end ? ` a ${formatDateTime(conflict.end)}` : ''} ({conflictReasons[conflict.reason]})
              </li>
            ))}
          </ul>
          <label>
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            Agendar mesmo assim
          </label>
        </div>
      )}
    </ActionForm>
  )
}

function ExecutionForm({
  module,
  id,
  action,
  onDone,
}: {
  module: RequestModule
  id: string
  action: 'start' | 'complete'
  onDone: () => Promise<void>
}) {
  const [moment, setMoment] = useState('')
  const [comment, setComment] = useState('')
  const starting = action === 'start'

  return (
    <ActionForm
      title={starting ? 'Iniciar atendimento' : 'Concluir atendimento'}
      submitLabel={starting ? 'Iniciar' : 'Concluir'}
      onSubmit={async () => {
        await requestAction(module, id, action, {
          [starting ? 'inicioReal' : 'fimReal']: fromLocalInput(moment),
          comentario: comment,
        })
        await onDone()
      }}
    >
      <Field label={`${starting ? 'Início' : 'Término'} real (em branco: agora)`}>
        <input type="datetime-local" value={moment} onChange={(event) => setMoment(event.target.value)} />
      </Field>
      <Field label="Comentário">
        <textarea rows={2} value={comment} onChange={(event) => setComment(event.target.value)} />
      </Field>
    </ActionForm>
  )
}

function OccurrenceForm({ id, onDone }: { id: string; onDone: () => Promise<void> }) {
  const [type, setType] = useState('ocorrencia')
  const [delay, setDelay] = useState('')
  const [description, setDescription] = useState('')

  return (
    <ActionForm
      title="Registrar ocorrência ou atraso"
      submitLabel="Registrar"
      onSubmit={async () => {
        await requestAction('fleet', id, 'occurrences', {
          tipo: type,
          atrasoMinutos: type === 'atraso' ? Number(delay) : undefined,
          descricao: description,
        })
        setDescription('')
        setDelay('')
        await onDone()
      }}
    >
      <Field label="Tipo">
        <select value={type} onChange={(event) => setType(event.target.value)}>
          <option value="ocorrencia">Ocorrência</option>
          <option value="atraso">Atraso</option>
        </select>
      </Field>
      {type === 'atraso' && (
        <Field label="Atraso, em minutos *">
          <input type="number" min={1} required value={delay} onChange={(event) => setDelay(event.target.value)} />
        </Field>
      )}
      <Field label="Descrição *">
        <textarea required rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
      </Field>
    </ActionForm>
  )
}

export function CancelForm({
  module,
  id,
  onDone,
  withReasons = true,
}: {
  module: RequestModule
  id: string
  onDone: () => Promise<void>
  /** Quem atende escolhe um motivo padronizado; quem solicita só descreve. */
  withReasons?: boolean
}) {
  const [reason, setReason] = useState('')
  const [code, setCode] = useState('')
  const [options, setOptions] = useState<ReasonOption[]>([])

  useEffect(() => {
    if (!withReasons) return
    let active = true
    getCapabilities()
      .then((data) => {
        if (active) setOptions(data.reasons?.cancellation ?? [])
      })
      .catch(() => {
        // Sem a lista, o motivo em texto continua aceito.
      })
    return () => {
      active = false
    }
  }, [withReasons])

  return (
    <ActionForm
      title="Cancelar solicitação"
      submitLabel="Cancelar solicitação"
      danger
      onSubmit={async () => {
        await requestAction(module, id, 'cancel', { motivoCodigo: code || undefined, motivo: reason })
        await onDone()
      }}
    >
      {withReasons && options.length > 0 ? (
        <ReasonFields options={options} code={code} text={reason} required label="Motivo do cancelamento" onCode={setCode} onText={setReason} />
      ) : (
        <Field label="Motivo *">
          <textarea required rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      )}
    </ActionForm>
  )
}

function AdvanceForm({
  id,
  next,
  onDone,
}: {
  id: string
  next: string
  onDone: () => Promise<void>
}) {
  const [comment, setComment] = useState('')

  return (
    <ActionForm
      title="Avançar etapa"
      submitLabel={`Mover para ${statusLabels[next]}`}
      onSubmit={async () => {
        await requestAction('flights', id, 'advance', { status: next, comentario: comment })
        setComment('')
        await onDone()
      }}
    >
      <Field label="Comentário">
        <textarea rows={2} value={comment} onChange={(event) => setComment(event.target.value)} />
      </Field>
    </ActionForm>
  )
}

/** Os campos editáveis são os mesmos do formulário de abertura, conforme o módulo. */
const editableFields: Record<RequestModule, { key: string; label: string; kind?: 'long' | 'datetime' }[]> = {
  maintenance: [
    { key: 'localServico', label: 'Local do serviço' },
    { key: 'sala', label: 'Sala' },
    { key: 'descricao', label: 'Descrição', kind: 'long' },
    { key: 'dataPreferencial', label: 'Data e horário preferenciais', kind: 'datetime' },
    { key: 'observacoes', label: 'Observações', kind: 'long' },
  ],
  fleet: [
    { key: 'origem', label: 'Origem' },
    { key: 'destino', label: 'Destino' },
    { key: 'dataHora', label: 'Data e horário', kind: 'datetime' },
    { key: 'dataHoraRetorno', label: 'Retorno', kind: 'datetime' },
    { key: 'finalidade', label: 'Serviço solicitado', kind: 'long' },
    { key: 'veiculo', label: 'Veículo' },
    { key: 'observacoes', label: 'Observações', kind: 'long' },
  ],
  flights: [
    { key: 'bagagem', label: 'Bagagem' },
    { key: 'sala', label: 'Sala' },
    { key: 'observacoes', label: 'Observações', kind: 'long' },
  ],
}

function EditForm({
  module,
  detail,
  onDone,
}: {
  module: RequestModule
  detail: RequestDetail
  onDone: () => Promise<void>
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      editableFields[module].map((field) => {
        const raw =
          field.key === 'descricao'
            ? detail.request.description
            : (detail.request.details[field.key] as string | null | undefined)
        return [field.key, field.kind === 'datetime' ? toLocalInput(raw) : (raw ?? '')]
      }),
    ),
  )
  const [justification, setJustification] = useState('')

  return (
    <ActionForm
      title="Editar dados"
      submitLabel="Salvar alterações"
      onSubmit={async () => {
        const body = Object.fromEntries(
          editableFields[module].map((field) => [
            field.key,
            field.kind === 'datetime' ? fromLocalInput(values[field.key]) ?? null : values[field.key],
          ]),
        )
        await updateRequest(module, detail.request.id, { ...body, justificativa: justification })
        setJustification('')
        await onDone()
      }}
    >
      {editableFields[module].map((field) => (
        <Field key={field.key} label={field.label}>
          {field.kind === 'long' ? (
            <textarea
              rows={2}
              value={values[field.key]}
              onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
            />
          ) : (
            <input
              type={field.kind === 'datetime' ? 'datetime-local' : 'text'}
              value={values[field.key]}
              onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
            />
          )}
        </Field>
      ))}
      <Field label="Justificativa (obrigatória ao alterar dados de atendimento já agendado)">
        <textarea rows={2} value={justification} onChange={(event) => setJustification(event.target.value)} />
      </Field>
    </ActionForm>
  )
}

function PassengersPanel({
  detail,
  onDone,
}: {
  detail: RequestDetail
  onDone: () => Promise<void>
}) {
  const canReadCpf = useHasPermission('flights:cpf:read')
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [rows, setRows] = useState<{ id?: string; nome: string; cpf: string }[]>([])

  async function reveal(id: string) {
    setError('')
    try {
      const { cpf } = await readFullCpf(id)
      setRevealed((current) => ({ ...current, [id]: cpf }))
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível consultar o CPF.'))
    }
  }

  function startEditing() {
    setRows(detail.passengers.map((passenger) => ({ id: passenger.id, nome: passenger.name, cpf: '' })))
    setEditing(true)
  }

  return (
    <section className="admin-data-card detail-card">
      <h2>Passageiros</h2>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="data-table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>CPF</th>
              {canReadCpf && <th>Consulta auditada</th>}
            </tr>
          </thead>
          <tbody>
            {detail.passengers.map((passenger) => (
              <tr key={passenger.id}>
                <td>{passenger.name}</td>
                <td>{revealed[passenger.id] ?? passenger.cpfMasked}</td>
                {canReadCpf && (
                  <td>
                    <button
                      type="button"
                      disabled={Boolean(revealed[passenger.id])}
                      onClick={() => void reveal(passenger.id)}
                    >
                      Ver CPF completo
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail.actions.editPassengers && !editing && (
        <button type="button" className="maintenance-secondary-button" onClick={startEditing}>
          Editar passageiros
        </button>
      )}

      {editing && (
        <ActionForm
          title="Editar passageiros"
          submitLabel="Salvar passageiros"
          onSubmit={async () => {
            await replacePassengers(detail.request.id, rows)
            setEditing(false)
            setRevealed({})
            await onDone()
          }}
        >
          {rows.map((row, index) => (
            <div className="detail-passenger-row" key={row.id ?? `novo-${index}`}>
              <Field label="Nome">
                <input
                  required
                  value={row.nome}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((item, position) =>
                        position === index ? { ...item, nome: event.target.value } : item,
                      ),
                    )
                  }
                />
              </Field>
              <Field label={row.id ? 'CPF (em branco: mantém o atual)' : 'CPF'}>
                <input
                  required={!row.id}
                  autoComplete="off"
                  inputMode="numeric"
                  maxLength={14}
                  value={row.cpf}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((item, position) =>
                        position === index ? { ...item, cpf: event.target.value } : item,
                      ),
                    )
                  }
                />
              </Field>
              <button
                type="button"
                disabled={rows.length <= 1}
                onClick={() => setRows((current) => current.filter((_, position) => position !== index))}
              >
                Remover
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={rows.length >= 10}
            onClick={() => setRows((current) => [...current, { nome: '', cpf: '' }])}
          >
            Adicionar passageiro
          </button>
        </ActionForm>
      )}
    </section>
  )
}

function segmentText(segment: unknown) {
  if (!segment || typeof segment !== 'object') return null
  const { origem, destino, data, horario } = segment as Record<string, string | undefined>
  return `${origem} → ${destino}, ${data?.split('-').reverse().join('/')} às ${horario}`
}

/** Campos personalizados, com o nome que tinham no cadastro, mesmo depois de desativados. */
function CustomFields({ data }: { data: Record<string, unknown> }) {
  const values = (data.customFields ?? {}) as Record<string, string>
  const labels = (data.customFieldLabels ?? {}) as Record<string, string>
  return (
    <>
      {Object.entries(values).map(([id, value]) => (
        <Info key={id} label={labels[id] ?? 'Campo adicional'} value={value === 'true' ? 'Sim' : value.replaceAll('|', ', ')} />
      ))}
    </>
  )
}

function ModuleDetails({ detail }: { detail: RequestDetail }) {
  const { request } = detail
  const data = request.details

  if (request.module === 'maintenance') {
    return (
      <>
        <Info label="Tipo de serviço" value={request.serviceType} />
        <Info label="Local" value={data.localServico as string} />
        <Info label="Sala" value={data.sala as string} />
        <Info label="Data e horário preferenciais" value={formatDateTime(data.dataPreferencial as string | null)} />
        <Info label="Observações" value={data.observacoes as string} />
        <CustomFields data={data} />
      </>
    )
  }
  if (request.module === 'fleet') {
    const passengers = (data.passageiros as { nome: string }[] | undefined) ?? []
    return (
      <>
        <Info label="Origem" value={data.origem as string} />
        <Info label="Destino" value={data.destino as string} />
        <Info label="Saída prevista" value={formatDateTime(data.dataHora as string)} />
        <Info label="Retorno previsto" value={formatDateTime(data.dataHoraRetorno as string | null)} />
        <Info label="Veículo" value={data.veiculo as string} />
        <Info label="Passageiros" value={passengers.map((item) => item.nome).join(', ')} />
        <Info label="Observações" value={data.observacoes as string} />
        <CustomFields data={data} />
      </>
    )
  }
  return (
    <>
      <Info label="Tipo de viagem" value={tripLabels[String(data.tipoViagem)]} />
      <Info label="Ida" value={segmentText(data.ida)} />
      <Info label="Volta" value={segmentText(data.volta)} />
      <Info label="Bagagem" value={data.bagagem as string} />
      <Info label="Sala" value={data.sala as string} />
      <Info label="Observações" value={data.observacoes as string} />
      <CustomFields data={data} />
    </>
  )
}

function RequestDetailPage({ module }: { module: RequestModule }) {
  const { requestId = '' } = useParams()
  const [detail, setDetail] = useState<RequestDetail | null>(null)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    try {
      setDetail(await getRequest(module, requestId))
      setError('')
    } catch (err) {
      setDetail(null)
      setError(errorMessage(err, 'Não foi possível carregar a solicitação.'))
    }
  }, [module, requestId])

  useEffect(() => {
    let active = true
    getRequest(module, requestId)
      .then((result) => {
        if (active) setDetail(result)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar a solicitação.'))
      })
    return () => {
      active = false
    }
  }, [module, requestId])

  if (error && !detail) {
    return (
      <div className="maintenance-page">
        <Alert tone="error">{error}</Alert>
        <Link className="maintenance-secondary-button" to={paths[module]}>
          <Icon name="back" size={18} weight="bold" />
          Voltar
        </Link>
      </div>
    )
  }
  if (!detail) return <Loading label="Carregando solicitação..." />

  const { request, actions, occurrences } = detail

  return (
    <div className="maintenance-page request-detail-page">
      <PageHeader
        eyebrow={titles[module]}
        title={`Protocolo ${protocolLabel(request.protocol)}`}
        description={request.title}
        actions={
          <>
            <StatusBadge
              className="detail-status"
              status={request.status}
              label={statusLabels[request.status]}
            />
            <Link className="maintenance-secondary-button" to={paths[module]}>
              <Icon name="back" size={18} weight="bold" />
              Voltar
            </Link>
            <DeleteRecordButton kind="solicitacao" id={request.id} afterPath={paths[module]} />
          </>
        }
      />

      <div className="detail-layout">
        <div className="detail-main">
      <section className="admin-data-card detail-card">
        <h2>Dados da solicitação</h2>
        <dl className="detail-grid">
          <Info label="Solicitante" value={request.requester.name} />
          <Info label="E-mail" value={request.requester.email} />
          <Info label="Setor" value={request.sector} />
          <Info label="Andar" value={request.floor} />
          {request.onBehalf && <Info label="Aberta em nome do setor por" value={request.openedBy} />}
          <Info label="Descrição" value={request.description} />
          <ModuleDetails detail={detail} />
          <Info label="Registrada em" value={formatDateTime(request.createdAt)} />
        </dl>
      </section>

      {module !== 'flights' && (
        <section className="admin-data-card detail-card">
          <h2>Agendamento e execução</h2>
          <dl className="detail-grid">
            <Info label="Agendado para" value={formatDateTime(request.scheduledAt)} />
            <Info label="Término previsto" value={formatDateTime(request.scheduledEnd)} />
            <Info label="Agendado por" value={request.scheduledBy} />
            <Info label="Responsável" value={request.responsible} />
            <Info label="Início real" value={formatDateTime(request.startedAt)} />
            <Info label="Término real" value={formatDateTime(request.finishedAt)} />
            <Info label="Observação do atendimento" value={request.operatorNote} />
          </dl>
        </section>
      )}

      <ReturnPanel module={module} detail={detail} onDone={reload} />

      <ReportExport path={`/${module}/requests/${request.id}/report`} />

      <RequestManagement detail={detail} onDone={reload} />

      {request.cancelReason && (
        <section className="admin-data-card detail-card">
          <h2>Cancelamento</h2>
          <p>{request.cancelReason}</p>
        </section>
      )}

      {module === 'flights' && <PassengersPanel detail={detail} onDone={reload} />}

      {module === 'fleet' && <TripExecutionPanel requestId={request.id} status={request.status} onChanged={reload} />}

      {module === 'fleet' && (
        <section className="admin-data-card detail-card">
          <h2>Ocorrências e atrasos</h2>
          {occurrences.length === 0 ? (
            <p>Nenhuma ocorrência registrada.</p>
          ) : (
            <ul className="detail-history">
              {occurrences.map((item) => (
                <li key={item.id}>
                  <strong>
                    {item.type === 'atraso' ? `Atraso de ${item.delayMinutes} min` : 'Ocorrência'}
                  </strong>
                  <span>{item.description}</span>
                  {(item.customFields ?? []).map((field) => (
                    <span key={field.id}>
                      {field.label}: {field.value === 'true' ? 'Sim' : field.value.replace(/\|/g, ', ')}
                    </span>
                  ))}
                  <small>
                    {item.user} · {formatDateTime(item.at)}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {module === 'maintenance' && <ExecutionPanel detail={detail} onDone={reload} />}
      {module === 'flights' && actions.edit && <QuotesPanel requestId={request.id} onDone={reload} />}

      <AttachmentsPanel
        resourceType="service_request"
        resourceId={request.id}
        canUpload={actions.upload}
        canRemove={actions.removeAttachment}
        canRestrict={actions.removeAttachment}
        restrictedByDefault={module === 'flights'}
        categories={attachmentCategoriesFor(module)}
        onChanged={reload}
      />

      {actions.removeAttachment && (
        <CommunicationsPanel
          type="service_request"
          id={request.id}
          categories={attachmentCategoriesFor(module)}
          allowTicket={module === 'flights'}
        />
      )}

      <RequestTimeline detail={detail} />
        </div>

        <aside className="detail-side">
      <section className="detail-actions" aria-label="Ações disponíveis">
        {actions.schedule && <ScheduleForm key={request.updatedAt} module={module} detail={detail} onDone={reload} />}
        {actions.start && <ExecutionForm module={module} id={request.id} action="start" onDone={reload} />}
        {actions.complete && <ExecutionForm module={module} id={request.id} action="complete" onDone={reload} />}
        {actions.advanceTo && <AdvanceForm id={request.id} next={actions.advanceTo} onDone={reload} />}
        {actions.occurrence && <OccurrenceForm id={request.id} onDone={reload} />}
        {actions.edit && <EditForm key={`edit-${request.updatedAt}`} module={module} detail={detail} onDone={reload} />}
        {actions.cancel && <CancelForm module={module} id={request.id} onDone={reload} withReasons={actions.edit} />}
      </section>

        </aside>
      </div>
    </div>
  )
}

export default RequestDetailPage
