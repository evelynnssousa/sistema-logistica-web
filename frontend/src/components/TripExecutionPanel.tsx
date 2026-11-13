import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  assignTripDriver,
  correctTripExecution,
  fetchTripExecution,
  formatDuration,
  formatTripMoment,
  listAssignableDrivers,
} from '../api/driverApi'
import type { ExecutionRecord, TripExecution } from '../api/driverApi'
import { errorMessage, fromLocalInput, toLocalInput } from '../api/modulesApi'
import { ApiError } from '../auth/apiClient'
import { useHasPermission } from '../auth/UserContext'
import { Alert } from './ui/Feedback'
import '../styles/driver-portal.css'

/** O que o motorista informou ao iniciar ou finalizar, conforme a configuração da época. */
function RecordLines({ title, record }: { title: string; record: ExecutionRecord | null }) {
  if (!record || Object.keys(record).length === 0) return null
  return (
    <p data-testid="trip-execution-record">
      <strong>{title}:</strong>{' '}
      {[
        record.veiculo && `veículo ${record.veiculo}`,
        record.hodometro !== undefined && `hodômetro ${record.hodometro}`,
        record.observacao && `observação: ${record.observacao}`,
        record.justificativa && `justificativa: ${record.justificativa}`,
      ]
        .filter(Boolean)
        .join(' · ')}
    </p>
  )
}

function AssignForm({
  requestId,
  execution,
  onDone,
}: {
  requestId: string
  execution: TripExecution
  onDone: () => Promise<void>
}) {
  const [drivers, setDrivers] = useState<{ id: string; name: string }[]>([])
  const [driverId, setDriverId] = useState(execution.driver?.id ?? '')
  const [notes, setNotes] = useState(execution.notes ?? '')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState('')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    listAssignableDrivers()
      .then((data) => {
        if (active) setDrivers(data.drivers)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os motoristas.'))
      })
    return () => {
      active = false
    }
  }, [])

  async function save(confirmConflicts: boolean) {
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      await assignTripDriver(requestId, { driverId: driverId || null, notes: notes || null, confirmConflicts })
      setConflict('')
      setSaved(true)
      await onDone()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SCHEDULE_CONFLICT') {
        const conflicts = (err.data as { conflicts?: { protocol: string }[] } | undefined)?.conflicts ?? []
        setConflict(`Este motorista já tem viagem neste horário: ${conflicts.map((item) => item.protocol).join(', ')}.`)
      } else {
        setError(errorMessage(err, 'Não foi possível atribuir o motorista.'))
      }
    } finally {
      setBusy(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void save(false)
  }

  const current = execution.driver
  const offered = current && !drivers.some((item) => item.id === current.id) ? [...drivers, current] : drivers

  return (
    <form className="fleet-execution-form" onSubmit={submit}>
      <h3>Atribuir motorista</h3>
      {error && <div className="form-grid-wide"><Alert tone="error">{error}</Alert></div>}
      {saved && <div className="form-grid-wide"><Alert tone="success">Atribuição salva. O motorista foi avisado.</Alert></div>}
      <label className="maintenance-form-field">
        <span>Motorista</span>
        <select value={driverId} onChange={(event) => setDriverId(event.target.value)}>
          <option value="">Sem motorista</option>
          {offered.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
      </label>
      <label className="maintenance-form-field">
        <span>Observações para o motorista (ele verá este texto)</span>
        <textarea rows={2} maxLength={1000} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>
      {conflict && <div className="form-grid-wide"><Alert tone="warning">{conflict}</Alert></div>}
      <div className="fleet-execution-actions">
        <button type="submit" className="maintenance-primary-button" disabled={busy}>Salvar atribuição</button>
        {conflict && (
          <button type="button" className="maintenance-secondary-button" disabled={busy} onClick={() => void save(true)}>
            Atribuir mesmo assim
          </button>
        )}
      </div>
    </form>
  )
}

function CorrectionForm({
  requestId,
  execution,
  canCorrectEnd,
  onDone,
}: {
  requestId: string
  execution: TripExecution
  canCorrectEnd: boolean
  onDone: () => Promise<void>
}) {
  const [start, setStart] = useState(toLocalInput(execution.startedAt))
  const [end, setEnd] = useState(toLocalInput(execution.finishedAt))
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    // O campo não tem segundos: reenviar o que não foi mexido alteraria o horário registrado.
    const startChanged = Boolean(start) && start !== toLocalInput(execution.startedAt)
    const endChanged = canCorrectEnd && Boolean(end) && end !== toLocalInput(execution.finishedAt)
    if (!startChanged && !endChanged) {
      setError('Altere o horário que precisa ser corrigido.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await correctTripExecution(requestId, {
        ...(startChanged ? { start: fromLocalInput(start) } : {}),
        ...(endChanged ? { end: fromLocalInput(end) } : {}),
        reason,
      })
      setReason('')
      await onDone()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível corrigir os horários.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="fleet-execution-form" onSubmit={(event) => void submit(event)}>
      <h3>Corrigir horários</h3>
      <p className="form-grid-wide demand-muted">Os valores atuais ficam guardados, com quem corrigiu, quando e o motivo.</p>
      {error && <div className="form-grid-wide"><Alert tone="error">{error}</Alert></div>}
      <label className="maintenance-form-field">
        <span>Início efetivo</span>
        <input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} />
      </label>
      {canCorrectEnd && (
        <label className="maintenance-form-field">
          <span>Término efetivo</span>
          <input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} />
        </label>
      )}
      <label className="maintenance-form-field form-grid-wide">
        <span>Motivo da correção</span>
        <textarea required minLength={3} maxLength={1000} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <div className="fleet-execution-actions">
        <button type="submit" className="maintenance-primary-button" disabled={busy}>Registrar correção</button>
      </div>
    </form>
  )
}

/**
 * Motorista, horários efetivos, ocorrências e correções da viagem, para a equipe. Enquanto a migração
 * 016 não for aplicada, a API responde que o recurso não existe, e o painel simplesmente não aparece.
 */
function TripExecutionPanel({ requestId, status, onChanged }: { requestId: string; status: string; onChanged: () => Promise<void> | void }) {
  const canRead = useHasPermission('requests:read_all')
  const canSchedule = useHasPermission('requests:schedule')
  const canAssignInFleet = useHasPermission('fleet:schedule')
  const canCorrect = useHasPermission('fleet:execution_correct')
  const [execution, setExecution] = useState<TripExecution | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  const load = useCallback(async () => {
    try {
      setExecution(await fetchTripExecution(requestId))
      setUnavailable(false)
    } catch {
      setUnavailable(true)
    }
  }, [requestId])

  useEffect(() => {
    if (!canRead) return
    let active = true
    fetchTripExecution(requestId)
      .then((data) => {
        if (active) setExecution(data)
      })
      .catch(() => {
        if (active) setUnavailable(true)
      })
    return () => {
      active = false
    }
    // O status muda quando a viagem anda: os horários precisam acompanhar.
  }, [canRead, requestId, status])

  if (!canRead || unavailable || !execution) return null

  const refresh = async () => {
    await load()
    await onChanged()
  }

  const assignable = canSchedule && canAssignInFleet && (status === 'agendado' || status === 'reagendado')

  return (
    <section className="admin-data-card detail-card" data-testid="trip-execution">
      <h2>Execução da viagem</h2>
      <dl className="fleet-execution-grid">
        <div><dt>Motorista</dt><dd>{execution.driver?.name ?? 'Não atribuído'}</dd></div>
        <div><dt>Início efetivo</dt><dd>{formatTripMoment(execution.startedAt)}</dd></div>
        <div><dt>Término efetivo</dt><dd>{formatTripMoment(execution.finishedAt)}</dd></div>
        <div><dt>Tempo efetivo</dt><dd>{formatDuration(execution.durationMinutes)}</dd></div>
      </dl>
      {execution.notes && <p><strong>Observações para o motorista:</strong> {execution.notes}</p>}
      {execution.exceedsJourney && (
        <Alert tone="warning">
          Esta viagem ultrapassa a jornada vigente quando começou, de {execution.journeyReference.start} às {execution.journeyReference.end}. O registro segue valendo.
        </Alert>
      )}
      <RecordLines title="Ao iniciar" record={execution.startRecord} />
      <RecordLines title="Ao finalizar" record={execution.finishRecord} />

      <h3>Ocorrências do motorista</h3>
      {execution.occurrences.length === 0 ? (
        <p>Nenhuma ocorrência registrada pelo motorista.</p>
      ) : (
        <ul className="detail-history">
          {execution.occurrences.map((item) => (
            <li key={item.id}>
              <strong>
                {item.categoryLabel ?? 'Ocorrência'}
                {item.delayMinutes ? `: ${item.delayMinutes} min` : ''}
              </strong>
              <span>{item.description}</span>
              {item.justification && <span>Justificativa: {item.justification}</span>}
              {(item.customFields ?? []).map((field) => (
                <span key={field.id}>
                  {field.label}: {field.value === 'true' ? 'Sim' : field.value.replace(/\|/g, ', ')}
                </span>
              ))}
              <small>{item.driver} · {formatTripMoment(item.at)}</small>
              {item.attachments.map((file) => (
                <small key={file.id}>
                  <a href={`/api/attachments/files/${file.id}/content`}>{file.name}</a>
                </small>
              ))}
            </li>
          ))}
        </ul>
      )}

      {execution.corrections.length > 0 && (
        <>
          <h3>Correções de horário</h3>
          <ul className="detail-history">
            {execution.corrections.map((item) => (
              <li key={item.id}>
                <strong>
                  Início: {formatTripMoment(item.previousStart)} → {formatTripMoment(item.newStart)}
                  {' · '}Término: {formatTripMoment(item.previousEnd)} → {formatTripMoment(item.newEnd)}
                </strong>
                <span>{item.reason}</span>
                <small>{item.user} · {formatTripMoment(item.at)}</small>
              </li>
            ))}
          </ul>
        </>
      )}

      {assignable && <AssignForm key={execution.driver?.id ?? 'sem-motorista'} requestId={requestId} execution={execution} onDone={refresh} />}
      {canCorrect && execution.startedAt && (
        <CorrectionForm
          key={`${execution.startedAt}:${execution.finishedAt}`}
          requestId={requestId}
          execution={execution}
          canCorrectEnd={status === 'concluido'}
          onDone={refresh}
        />
      )}
    </section>
  )
}

export default TripExecutionPanel
