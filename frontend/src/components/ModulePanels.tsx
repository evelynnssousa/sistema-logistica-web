import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { errorMessage, formatDateTime, fromLocalInput } from '../api/modulesApi'
import type { RequestDetail } from '../api/modulesApi'
import { addExecution, addQuote, listEquipments, listExecutions, listQuotes, selectQuote } from '../api/operationsApi'
import type { Equipment, Execution, FlightQuote } from '../api/operationsApi'
import { useHasPermission } from '../auth/UserContext'
import { Alert } from './ui/Feedback'
import Modal from './ui/Modal'

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`maintenance-form-field${wide ? ' form-grid-wide' : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  )
}

/** Registro detalhado da manutenção: quem fez, quando, o que foi feito e o que ficou pendente. */
export function ExecutionPanel({ detail, onDone }: { detail: RequestDetail; onDone: () => Promise<void> }) {
  const canRecord = detail.actions.edit || detail.actions.complete || detail.actions.removeAttachment
  const requestId = detail.request.id
  const canListEquipments = useHasPermission('maintenance:update')
  const [executions, setExecutions] = useState<Execution[] | null>(null)
  const [equipments, setEquipments] = useState<Equipment[]>([])
  const [executedBy, setExecutedBy] = useState('')
  const [executedAt, setExecutedAt] = useState('')
  const [service, setService] = useState('')
  const [pending, setPending] = useState('')
  const [equipmentId, setEquipmentId] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(() => {
    return listExecutions(requestId).then((data) => setExecutions(data.executions))
  }, [requestId])

  useEffect(() => {
    let active = true
    listExecutions(requestId)
      .then((data) => {
        if (active) setExecutions(data.executions)
      })
      .catch(() => {
        // Migração pendente: o restante da solicitação continua disponível.
        if (active) setExecutions(null)
      })
    if (canListEquipments) {
      listEquipments()
        .then((data) => {
          if (active) setEquipments(data.equipments)
        })
        .catch(() => undefined)
    }
    return () => {
      active = false
    }
  }, [requestId, canListEquipments])

  if (executions === null) return null

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await addExecution(requestId, {
        equipamentoId: equipmentId || undefined,
        executadoPor: executedBy,
        executadoEm: fromLocalInput(executedAt),
        servico: service,
        pendencias: pending,
      })
      setService('')
      setPending('')
      setExecutedBy('')
      setExecutedAt('')
      setEquipmentId('')
      await load()
      await onDone()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível registrar a execução.'))
    }
  }

  return (
    <section className="admin-data-card detail-card" aria-labelledby="execution-title">
      <h2 id="execution-title">Registro da execução</h2>
      {executions.length === 0 ? (
        <p>Nenhuma execução registrada.</p>
      ) : (
        <ul className="detail-history">
          {executions.map((item) => (
            <li key={item.id}>
              <strong>
                {item.executedBy} · {formatDateTime(item.executedAt)}
              </strong>
              {item.equipment && <span>Equipamento: {item.equipment}</span>}
              <span>{item.service}</span>
              {item.pending && <span>Pendências: {item.pending}</span>}
              <small>Registrado por {item.registeredBy}</small>
            </li>
          ))}
        </ul>
      )}
      {canRecord && (
        <form className="form-grid" onSubmit={(event) => void submit(event)}>
          <Field label="Quem realizou *">
            <input required maxLength={160} value={executedBy} onChange={(event) => setExecutedBy(event.target.value)} />
          </Field>
          <Field label="Data e horário *">
            <input type="datetime-local" required value={executedAt} onChange={(event) => setExecutedAt(event.target.value)} />
          </Field>
          <Field label="Equipamento (opcional)">
            <select value={equipmentId} onChange={(event) => setEquipmentId(event.target.value)}>
              <option value="">Não se aplica</option>
              {equipments.map((equipment) => (
                <option key={equipment.id} value={equipment.id}>
                  {equipment.name}
                  {equipment.location ? ` · ${equipment.location}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Serviço realizado *" wide>
            <textarea required rows={2} maxLength={4000} value={service} onChange={(event) => setService(event.target.value)} />
          </Field>
          <Field label="Pendências" wide>
            <textarea rows={2} maxLength={2000} value={pending} onChange={(event) => setPending(event.target.value)} />
          </Field>
          {error && <Alert tone="error" className="form-grid-wide">{error}</Alert>}
          <button type="submit" className="maintenance-secondary-button">
            Registrar execução
          </button>
        </form>
      )}
    </section>
  )
}

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

/** Cotações lado a lado. As registradas não mudam; escolher outra exige justificativa. */
export function QuotesPanel({ requestId, onDone }: { requestId: string; onDone: () => Promise<void> }) {
  const [quotes, setQuotes] = useState<FlightQuote[] | null>(null)
  const [company, setCompany] = useState('')
  const [flights, setFlights] = useState('')
  const [value, setValue] = useState('')
  const [conditions, setConditions] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [choosing, setChoosing] = useState<FlightQuote | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(() => {
    return listQuotes(requestId).then((data) => setQuotes(data.quotes))
  }, [requestId])

  useEffect(() => {
    let active = true
    listQuotes(requestId)
      .then((data) => {
        if (active) setQuotes(data.quotes)
      })
      .catch(() => {
        if (active) setQuotes(null)
      })
    return () => {
      active = false
    }
  }, [requestId])

  if (quotes === null) return null

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await addQuote(requestId, {
        companhia: company,
        voos: flights,
        valor: value,
        condicoes: conditions,
        validade: fromLocalInput(validUntil),
      })
      setCompany('')
      setFlights('')
      setValue('')
      setConditions('')
      setValidUntil('')
      await load()
      await onDone()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível registrar a cotação.'))
    }
  }

  async function confirmChoice(event: FormEvent) {
    event.preventDefault()
    if (!choosing) return
    setError('')
    try {
      await selectQuote(requestId, choosing.id, reason)
      setChoosing(null)
      setReason('')
      await load()
      await onDone()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível escolher a cotação.'))
      setChoosing(null)
    }
  }

  return (
    <section className="admin-data-card detail-card" aria-labelledby="quotes-title">
      <h2 id="quotes-title">Cotações</h2>
      {quotes.length === 0 ? (
        <p>Nenhuma cotação registrada.</p>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Companhia</th>
                <th>Voos</th>
                <th>Valor</th>
                <th>Condições</th>
                <th>Validade</th>
                <th>Registro</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((quote) => (
                <tr key={quote.id} className={quote.selected ? 'quote-selected' : ''}>
                  <td>{quote.company}</td>
                  <td>{quote.flights}</td>
                  <td>{money.format(quote.value)}</td>
                  <td>{quote.conditions ?? '—'}</td>
                  <td>{formatDateTime(quote.validUntil)}</td>
                  <td>
                    {quote.registeredBy}
                    <small className="central-subtext">{formatDateTime(quote.at)}</small>
                  </td>
                  <td>
                    {quote.selected ? (
                      <strong>Escolhida</strong>
                    ) : (
                      <button type="button" className="central-link-button" onClick={() => setChoosing(quote)}>
                        Escolher
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="Companhia *">
          <input required maxLength={120} value={company} onChange={(event) => setCompany(event.target.value)} />
        </Field>
        <Field label="Voos *">
          <input required maxLength={500} value={flights} onChange={(event) => setFlights(event.target.value)} />
        </Field>
        <Field label="Valor (R$) *">
          <input required inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} />
        </Field>
        <Field label="Validade">
          <input type="datetime-local" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} />
        </Field>
        <Field label="Condições" wide>
          <textarea rows={2} value={conditions} onChange={(event) => setConditions(event.target.value)} />
        </Field>
        {error && <Alert tone="error" className="form-grid-wide">{error}</Alert>}
        <button type="submit" className="maintenance-secondary-button">
          Registrar cotação
        </button>
      </form>

      {choosing && (
        <Modal title={`Escolher ${choosing.company}`} onClose={() => setChoosing(null)}>
          <form className="ui-stacked" onSubmit={(event) => void confirmChoice(event)}>
            <p>{money.format(choosing.value)} · {choosing.flights}</p>
            <Field label="Justificativa *">
              <textarea required rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
            </Field>
            <button type="submit" className="maintenance-primary-button">
              Confirmar escolha
            </button>
          </form>
        </Modal>
      )}
    </section>
  )
}
