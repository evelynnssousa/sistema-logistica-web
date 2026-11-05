import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import logoJucesp from '../assets/logoJucespNovo.png'
import {
  addTripOccurrence,
  fetchDriverHistory,
  fetchDriverProfile,
  fetchTrip,
  finishTrip,
  formatDuration,
  formatTripDay,
  formatTripHour,
  formatTripMoment,
  listTrips,
  startTrip,
  tripGroupLabels,
  tripGroupOrder,
  uploadOccurrenceAttachment,
} from '../api/driverApi'
import type { DriverProfile, ExecutionField, ExecutionInput, HistoryTrip, Trip, TripField, TripGroup, TripOccurrence } from '../api/driverApi'
import { listNotifications, markAllNotificationsRead } from '../api/integrationsApi'
import type { UserNotification } from '../api/integrationsApi'
import { errorMessage, statusLabels } from '../api/modulesApi'
import { ApiError } from '../auth/apiClient'
import { useAuthenticatedUser, useLogout } from '../auth/UserContext'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import Icon from '../components/ui/Icon'
import Modal from '../components/ui/Modal'
import Pagination from '../components/ui/Pagination'
import StatusBadge from '../components/ui/StatusBadge'
import '../styles/driver-portal.css'

type Tab = 'viagens' | 'historico' | 'avisos'

// A jornada mostrada é a da própria viagem: a vigente quando ela começou, e não a de hoje.
function JourneyFlag({ journey }: { journey: Trip['journeyReference'] }) {
  return (
    <p className="driver-flag">
      <Icon name="attention" size={16} />
      Fora da jornada de {journey.start} às {journey.end}. O registro segue valendo.
    </p>
  )
}

const weekdayLabels = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
const acceptedExtensions: Record<string, string> = {
  pdf: '.pdf', png: '.png', jpeg: '.jpg,.jpeg', webp: '.webp', docx: '.docx', xlsx: '.xlsx', txt: '.txt',
}

/** Avisos, orientação e contato, como a administração definiu em Configurações. */
function PortalMessages({ portal, journeyInfo = true }: { portal: DriverProfile['portal']; journeyInfo?: boolean }) {
  const { journey, display } = portal
  return (
    <section className="driver-messages" data-testid="driver-messages">
      {display.notices.map((notice, index) => (
        <p key={index} className="driver-trip-notes" data-testid="driver-notice">
          <Icon name="attention" size={16} />
          {notice}
        </p>
      ))}
      {display.guidance && (
        <p className="driver-trip-notes">
          <Icon name="info" size={16} />
          {display.guidance}
        </p>
      )}
      {journeyInfo && (
        <p className="driver-muted" data-testid="driver-journey">
          Jornada: {journey.start} às {journey.end}
          {journey.weekdays.length < 7 && `, ${journey.weekdays.map((day) => weekdayLabels[day]).join(', ')}`}
          {journey.breakMinutes > 0 && `. Intervalo de ${formatDuration(journey.breakMinutes)}`}
          {journey.expectedMinutes !== null && `. Duração prevista de ${formatDuration(journey.expectedMinutes)}`}.
        </p>
      )}
      {display.contact && (
        <p className="driver-muted" data-testid="driver-contact">
          Situações excepcionais: {[display.contact.name, display.contact.phone, display.contact.email, display.contact.hours].filter(Boolean).join(' · ')}
        </p>
      )}
    </section>
  )
}

/** Confirmação antes de iniciar ou finalizar: o horário registrado é o deste momento. */
function ConfirmDialog({
  trip,
  action,
  portal,
  onClose,
  onDone,
}: {
  trip: Trip
  action: 'start' | 'finish'
  portal: DriverProfile['portal']
  onClose: () => void
  onDone: (message: string) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const starting = action === 'start'
  const [input, setInput] = useState<ExecutionInput>({})
  const fields: ExecutionField[] = starting ? portal.execution.startFields : portal.execution.finishFields
  const rule = starting ? portal.journey.outsideStart : portal.journey.outsideFinish
  // O servidor decide na hora: se o horário virou com a janela aberta, ele pede, e o campo aparece.
  const [justificationAsked, setJustificationAsked] = useState(false)
  const needsJustification = justificationAsked || (rule === 'justify' && trip.outsideJourneyNow)
  const change = (key: keyof ExecutionInput) => (event: { target: { value: string } }) =>
    setInput((current) => ({ ...current, [key]: event.target.value }))

  async function confirm(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (starting) {
        const result = await startTrip(trip.id, input)
        await onDone(`Viagem iniciada às ${formatTripHour(result.startedAt)}.`)
      } else {
        const result = await finishTrip(trip.id, input)
        await onDone(`Viagem finalizada às ${formatTripHour(result.finishedAt)}. Tempo efetivo: ${formatDuration(result.durationMinutes)}.`)
      }
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'JOURNEY_JUSTIFICATION_REQUIRED') setJustificationAsked(true)
      setError(errorMessage(err, starting ? 'Não foi possível iniciar a viagem.' : 'Não foi possível finalizar a viagem.'))
      setBusy(false)
    }
  }

  return (
    <Modal title={starting ? 'Iniciar viagem?' : 'Finalizar viagem?'} onClose={onClose}>
      <form className="driver-form" onSubmit={(event) => void confirm(event)}>
      {error && <Alert tone="error">{error}</Alert>}
      <p className="driver-confirm-route">{trip.title}</p>
      <p>
        {starting
          ? 'O sistema vai registrar agora a data e o horário de início, em seu nome.'
          : 'O sistema vai registrar agora a data e o horário de término, em seu nome.'}{' '}
        Depois de confirmado, o horário só muda por correção autorizada pela equipe de Frota.
      </p>
      {starting && trip.scheduledAt && (
        <p>
          Previsto para <strong>{formatTripMoment(trip.scheduledAt)}</strong>.
        </p>
      )}
      {starting && trip.startNeedsVehicle && (
        <label>
          <span>Veículo</span>
          <input required minLength={2} maxLength={120} value={input.veiculo ?? ''} onChange={change('veiculo')} />
        </label>
      )}
      {fields.includes('odometer') && (
        <label>
          <span>Hodômetro (km)</span>
          <input type="number" inputMode="numeric" required min="0" max="9999999" step="1" value={input.hodometro ?? ''} onChange={change('hodometro')} />
        </label>
      )}
      {fields.includes('notes') && (
        <label>
          <span>Observação</span>
          <textarea required minLength={2} maxLength={1000} rows={3} value={input.observacao ?? ''} onChange={change('observacao')} />
        </label>
      )}
      {needsJustification && (
        <label>
          <span>Justificativa por estar fora da jornada</span>
          <textarea required minLength={3} maxLength={1000} rows={3} value={input.justificativa ?? ''} onChange={change('justificativa')} />
        </label>
      )}
      <div className="driver-dialog-actions">
        <button type="button" className="driver-button driver-button-secondary" onClick={onClose}>
          Voltar
        </button>
        <button type="submit" className="driver-button driver-button-primary" disabled={busy}>
          {busy ? 'Registrando...' : starting ? 'Confirmar início' : 'Confirmar término'}
        </button>
      </div>
      </form>
    </Modal>
  )
}

function OccurrenceDialog({
  trip,
  attachments,
  types,
  onClose,
  onDone,
}: {
  trip: Trip
  attachments: DriverProfile['attachments']
  types: DriverProfile['portal']['occurrences']['types']
  onClose: () => void
  onDone: (message: string) => Promise<void>
}) {
  const [category, setCategory] = useState('')
  const [description, setDescription] = useState('')
  const [justification, setJustification] = useState('')
  const [minutes, setMinutes] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selected = types.find((type) => type.key === category)
  const canAttach = attachments.enabled && selected?.allowsAttachments === true

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { id } = await addTripOccurrence(trip.id, {
        categoria: category,
        descricao: description,
        ...(selected?.requiresJustification ? { justificativa: justification } : {}),
        ...(selected?.asksDelay ? { atrasoMinutos: Number(minutes) } : {}),
      })
      // A ocorrência já está registrada: um arquivo recusado não a desfaz, e a pessoa fica sabendo.
      const failed: string[] = []
      for (const file of canAttach ? files : []) {
        try {
          await uploadOccurrenceAttachment(trip.id, id, file)
        } catch (err) {
          failed.push(`${file.name}: ${errorMessage(err, 'não enviado')}`)
        }
      }
      await onDone(
        failed.length > 0
          ? `Ocorrência registrada, mas estes arquivos não foram enviados. ${failed.join(' ')}`
          : 'Ocorrência registrada. A equipe de Frota já pode consultar.',
      )
      onClose()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível registrar a ocorrência.'))
      setBusy(false)
    }
  }

  return (
    <Modal title="Registrar ocorrência" onClose={onClose}>
      <form className="driver-form" onSubmit={(event) => void submit(event)}>
        {error && <Alert tone="error">{error}</Alert>}
        <p className="driver-confirm-route">{trip.title}</p>
        <label>
          <span>O que aconteceu?</span>
          <select required value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">Selecione</option>
            {types.map((type) => (
              <option key={type.key} value={type.key}>{type.label}</option>
            ))}
          </select>
        </label>
        {selected?.asksDelay && (
          <label>
            <span>Atraso, em minutos</span>
            <input type="number" inputMode="numeric" required min="1" max="100000" value={minutes} onChange={(event) => setMinutes(event.target.value)} />
          </label>
        )}
        <label>
          <span>Descrição</span>
          <textarea required minLength={3} maxLength={2000} rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        {selected?.requiresJustification && (
          <label>
            <span>Justificativa</span>
            <textarea required minLength={3} maxLength={1000} rows={3} value={justification} onChange={(event) => setJustification(event.target.value)} />
          </label>
        )}
        {canAttach && (
          <label>
            <span>Anexos (opcional), até {attachments.maxFileMb} MB cada</span>
            <input type="file" multiple accept={(attachments.allowedKinds ?? []).map((kind) => acceptedExtensions[kind]).join(',')} onChange={(event) => setFiles([...(event.target.files ?? [])])} />
          </label>
        )}
        <p className="driver-muted">A data, o horário e o seu nome são registrados automaticamente.</p>
        <div className="driver-dialog-actions">
          <button type="button" className="driver-button driver-button-secondary" onClick={onClose}>
            Voltar
          </button>
          <button type="submit" className="driver-button driver-button-primary" disabled={busy}>
            {busy ? 'Registrando...' : 'Registrar ocorrência'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function OccurrenceList({ items }: { items: TripOccurrence[] }) {
  if (items.length === 0) return <p className="driver-muted">Nenhuma ocorrência registrada por você nesta viagem.</p>
  return (
    <ul className="driver-occurrences">
      {items.map((item) => (
        <li key={item.id}>
          <strong>
            {item.categoryLabel ?? 'Ocorrência'}
            {item.delayMinutes ? `: ${item.delayMinutes} min` : ''}
          </strong>
          <span>{item.description}</span>
          {item.justification && <span>Justificativa: {item.justification}</span>}
          <small>{formatTripMoment(item.at)}</small>
          {item.attachments.map((file) => (
            <small key={file.id}>
              <Icon name="attachment" size={14} /> {file.name}
            </small>
          ))}
        </li>
      ))}
    </ul>
  )
}

/** Campo a campo, na ordem da tela. Campo oculto chega vazio da própria API. */
function tripFacts(trip: Trip): { key: TripField; label: string; value: string | null }[] {
  return [
    { key: 'purpose', label: 'Serviço', value: trip.purpose },
    { key: 'requester', label: 'Solicitante', value: trip.requester },
    { key: 'sector', label: 'Setor', value: trip.sector },
    { key: 'vehicle', label: 'Veículo', value: trip.vehicle },
    { key: 'scheduledEnd', label: 'Término previsto', value: trip.scheduledEnd && formatTripMoment(trip.scheduledEnd) },
    { key: 'returnAt', label: 'Retorno pedido', value: trip.returnAt && formatTripMoment(trip.returnAt) },
    { key: 'passengers', label: 'Passageiros', value: trip.passengers.join(', ') || null },
  ]
}

function TripDetails({ trip, profile }: { trip: Trip; profile: DriverProfile }) {
  const { fields } = profile.portal.display
  const [occurrences, setOccurrences] = useState<TripOccurrence[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetchTrip(trip.id)
      .then((data) => {
        if (active) setOccurrences(data.occurrences)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os detalhes.'))
      })
    return () => {
      active = false
    }
  }, [trip.id, trip.status])

  return (
    <div className="driver-details">
      <dl>
        <div><dt>Protocolo</dt><dd>{trip.protocol}</dd></div>
        {tripFacts(trip)
          .filter((fact) => fields[fact.key] === 'details' && fact.value)
          .map((fact) => <div key={fact.key}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
        {fields.origin === 'details' && trip.origin && <div><dt>Saída</dt><dd>{trip.origin}</dd></div>}
        {fields.destination === 'details' && trip.destination && <div><dt>Destino</dt><dd>{trip.destination}</dd></div>}
        {fields.notes === 'details' && trip.notes && <div><dt>Observações</dt><dd>{trip.notes}</dd></div>}
        {trip.startedAt && <div><dt>Início efetivo</dt><dd>{formatTripMoment(trip.startedAt)}</dd></div>}
        {trip.finishedAt && <div><dt>Término efetivo</dt><dd>{formatTripMoment(trip.finishedAt)}</dd></div>}
        {trip.durationMinutes !== null && <div><dt>Tempo efetivo</dt><dd>{formatDuration(trip.durationMinutes)}</dd></div>}
      </dl>
      <h4>Suas ocorrências</h4>
      {error && <Alert tone="error">{error}</Alert>}
      {!occurrences && !error && <Loading label="Carregando..." />}
      {occurrences && <OccurrenceList items={occurrences} />}
    </div>
  )
}

function TripCard({
  trip,
  profile,
  onAction,
  onOccurrence,
}: {
  trip: Trip
  profile: DriverProfile
  onAction: (trip: Trip, action: 'start' | 'finish') => void
  onOccurrence: (trip: Trip) => void
}) {
  const [open, setOpen] = useState(false)
  const { fields } = profile.portal.display
  const cardFacts = tripFacts(trip).filter((fact) => fields[fact.key] === 'card' && fact.value)
  return (
    <article className="driver-trip" data-testid="driver-trip">
      <header>
        <div className="driver-trip-when">
          <strong>{formatTripDay(trip.scheduledAt)}</strong>
          <span>{formatTripHour(trip.scheduledAt)}</span>
        </div>
        <StatusBadge status={trip.status} label={statusLabels[trip.status] ?? trip.status} />
      </header>
      <p className="driver-trip-route">
        {fields.origin === 'card' && <span><small>Saída</small> {trip.origin ?? '—'}</span>}
        {fields.destination === 'card' && <span><small>Destino</small> <strong>{trip.destination ?? '—'}</strong></span>}
      </p>
      {cardFacts.length > 0 && (
        <dl className="driver-card-facts">
          {cardFacts.map((fact) => <div key={fact.key}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
        </dl>
      )}
      {fields.notes === 'card' && trip.notes && (
        <p className="driver-trip-notes">
          <Icon name="info" size={16} />
          {trip.notes}
        </p>
      )}
      {trip.startedAt && (
        <p className="driver-trip-times">
          Início: <strong>{formatTripMoment(trip.startedAt)}</strong>
          {trip.finishedAt && <> · Término: <strong>{formatTripMoment(trip.finishedAt)}</strong></>}
        </p>
      )}
      {trip.exceedsJourney && <JourneyFlag journey={trip.journeyReference} />}
      {trip.startBlockedByJourney && (
        <p className="driver-flag">
          <Icon name="attention" size={16} />
          Fora da jornada, esta viagem não inicia pelo portal. Fale com a equipe de Frota.
        </p>
      )}

      <div className="driver-trip-actions">
        {trip.canStart && (
          <button type="button" className="driver-button driver-button-primary" onClick={() => onAction(trip, 'start')}>
            <Icon name="progress" size={20} />
            Iniciar viagem
          </button>
        )}
        {trip.canFinish && (
          <button type="button" className="driver-button driver-button-primary" onClick={() => onAction(trip, 'finish')}>
            <Icon name="success" size={20} />
            Finalizar viagem
          </button>
        )}
        {trip.canReportOccurrence && (
          <button type="button" className="driver-button driver-button-secondary" onClick={() => onOccurrence(trip)}>
            <Icon name="attention" size={20} />
            Registrar ocorrência
          </button>
        )}
        <button type="button" className="driver-button driver-button-quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Ocultar detalhes' : 'Ver detalhes'}
        </button>
      </div>
      {open && <TripDetails trip={trip} profile={profile} />}
    </article>
  )
}

function TripsTab({ profile }: { profile: DriverProfile }) {
  const [group, setGroup] = useState<TripGroup | null>(null)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ trips: Trip[]; counts: Partial<Record<TripGroup, number>>; pageSize: number } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirming, setConfirming] = useState<{ trip: Trip; action: 'start' | 'finish' } | null>(null)
  const [reporting, setReporting] = useState<Trip | null>(null)
  const shown = group ?? 'proximas'

  const load = useCallback(async () => {
    try {
      const result = await listTrips(shown, page)
      setData(result)
      setError('')
      // Na primeira abertura, a viagem em andamento vem antes de tudo.
      if (group === null && shown === 'proximas' && (result.counts.em_andamento ?? 0) > 0) setGroup('em_andamento')
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível carregar as viagens.'))
    }
  }, [shown, page, group])

  useEffect(() => {
    let active = true
    listTrips(shown, page)
      .then((result) => {
        if (!active) return
        setData(result)
        setError('')
        if (group === null && (result.counts.em_andamento ?? 0) > 0) setGroup('em_andamento')
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar as viagens.'))
      })
    return () => {
      active = false
    }
  }, [shown, page, group])

  const done = async (message: string) => {
    setNotice(message)
    await load()
  }

  return (
    <>
      <nav className="driver-groups" aria-label="Viagens por situação">
        {tripGroupOrder.filter((key) => profile.portal.execution.visibleGroups.includes(key)).map((key) => (
          <button
            type="button"
            key={key}
            aria-pressed={shown === key}
            className={shown === key ? 'is-active' : ''}
            onClick={() => {
              setGroup(key)
              setPage(1)
              setNotice('')
            }}
          >
            {tripGroupLabels[key]}
            <span>{data?.counts[key] ?? 0}</span>
          </button>
        ))}
      </nav>

      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && <Loading label="Carregando viagens..." />}
      {data && data.trips.length === 0 && (
        <EmptyState icon="fleet" title="Nenhuma viagem aqui">
          As viagens atribuídas a você aparecem nesta página.
        </EmptyState>
      )}
      {data && data.trips.map((trip) => (
        <TripCard
          key={trip.id}
          trip={trip}
          profile={profile}
          onAction={(selected, action) => {
            setNotice('')
            setConfirming({ trip: selected, action })
          }}
          onOccurrence={(selected) => {
            setNotice('')
            setReporting(selected)
          }}
        />
      ))}
      {data && (data.counts[shown] ?? 0) > data.pageSize && (
        <Pagination page={page} summary={`${data.counts[shown]} no total`} hasNext={page * data.pageSize < (data.counts[shown] ?? 0)} onChange={setPage} />
      )}

      {confirming && <ConfirmDialog trip={confirming.trip} action={confirming.action} portal={profile.portal} onClose={() => setConfirming(null)} onDone={done} />}
      {reporting && <OccurrenceDialog trip={reporting} attachments={profile.attachments} types={profile.portal.occurrences.types} onClose={() => setReporting(null)} onDone={done} />}
    </>
  )
}

function HistoryTab() {
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ trips: HistoryTrip[]; total: number; pageSize: number } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetchDriverHistory(page)
      .then((result) => {
        if (active) setData(result)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar o histórico.'))
      })
    return () => {
      active = false
    }
  }, [page])

  if (error) return <Alert tone="error">{error}</Alert>
  if (!data) return <Loading label="Carregando histórico..." />
  if (data.trips.length === 0) {
    return (
      <EmptyState icon="requests" title="Nenhuma viagem no histórico">
        As viagens que você executar aparecem aqui, com os horários registrados.
      </EmptyState>
    )
  }
  return (
    <>
      {data.trips.map((trip) => (
        <article className="driver-trip" key={trip.id} data-testid="driver-history-item">
          <header>
            <div className="driver-trip-when">
              <strong>{formatTripDay(trip.scheduledAt)}</strong>
              <span>{trip.destination ?? trip.title}</span>
            </div>
            <StatusBadge status={trip.status} label={statusLabels[trip.status] ?? trip.status} />
          </header>
          <dl className="driver-history-times">
            <div><dt>Previsto</dt><dd>{formatTripHour(trip.scheduledAt)}</dd></div>
            <div><dt>Início efetivo</dt><dd>{formatTripMoment(trip.startedAt)}</dd></div>
            <div><dt>Término efetivo</dt><dd>{formatTripMoment(trip.finishedAt)}</dd></div>
            <div><dt>Tempo efetivo</dt><dd>{formatDuration(trip.durationMinutes)}</dd></div>
          </dl>
          {trip.exceedsJourney && <JourneyFlag journey={trip.journeyReference} />}
          {trip.occurrences.length > 0 && (
            <ul className="driver-occurrences">
              {trip.occurrences.map((item, index) => (
                <li key={index}>
                  <strong>{item.categoryLabel ?? 'Ocorrência'}</strong>
                  <span>{item.description}</span>
                  <small>{formatTripMoment(item.at)}</small>
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
      <Pagination page={page} summary={`${data.total} no total`} hasNext={page * data.pageSize < data.total} onChange={setPage} />
    </>
  )
}

function NoticesTab({ onRead }: { onRead: () => void }) {
  const [items, setItems] = useState<UserNotification[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    listNotifications({ page: 1 })
      .then((result) => {
        if (!active) return
        setItems(result.notifications)
        // Abrir a lista é o que conta como leitura: os avisos não levam a outra tela.
        if (result.notifications.some((item) => !item.readAt)) {
          void markAllNotificationsRead().then(onRead).catch(() => undefined)
        }
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os avisos.'))
      })
    return () => {
      active = false
    }
  }, [onRead])

  if (error) return <Alert tone="error">{error}</Alert>
  if (!items) return <Loading label="Carregando avisos..." />
  if (items.length === 0) {
    return (
      <EmptyState icon="notifications" title="Nenhum aviso">
        Avisos sobre as suas viagens aparecem aqui.
      </EmptyState>
    )
  }
  return (
    <ul className="driver-notices">
      {items.map((item) => (
        <li key={item.id} className={item.readAt ? '' : 'is-unread'}>
          <strong>{item.message}</strong>
          <small>{item.title} · {formatTripMoment(item.createdAt)}</small>
        </li>
      ))}
    </ul>
  )
}

/**
 * Interface exclusiva do perfil Motorista, sem menu nem telas da administração. Só decide o que
 * aparece: quem protege os dados é o backend, em cada requisição.
 */
function DriverPortalPage() {
  const user = useAuthenticatedUser()
  const logout = useLogout()
  const { pathname } = useLocation()
  const [tab, setTab] = useState<Tab>('viagens')
  const [profile, setProfile] = useState<DriverProfile | null>(null)
  const [error, setError] = useState('')
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    let active = true
    fetchDriverProfile()
      .then((data) => {
        if (active) setProfile(data)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar o portal.'))
      })
    listNotifications({ unread: true, page: 1 })
      .then((data) => {
        if (active) setUnread(data.unread)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const clearUnread = useCallback(() => setUnread(0), [])

  // Qualquer endereço da administração leva ao portal.
  if (pathname !== '/motorista') return <Navigate to="/motorista" replace />

  const enabled = profile?.portal.enabled !== false
  const tabs: { key: Tab; label: string; icon: 'fleet' | 'requests' | 'notifications' }[] = [
    ...(enabled
      ? [
          { key: 'viagens' as const, label: 'Viagens', icon: 'fleet' as const },
          { key: 'historico' as const, label: 'Histórico', icon: 'requests' as const },
        ]
      : []),
    { key: 'avisos', label: 'Avisos', icon: 'notifications' },
  ]
  const shownTab: Tab = enabled ? tab : 'avisos'

  return (
    <div className="driver-portal">
      <header className="driver-header">
        <div className="driver-brand">
          <img src={logoJucesp} alt="Logo da JUCESP" />
          <div>
            <strong>Portal do Motorista</strong>
            <span>{profile?.driver?.name ?? user?.name}</span>
          </div>
        </div>
        <button type="button" className="driver-logout" onClick={() => void logout()}>
          <Icon name="logout" size={18} />
          Sair
        </button>
      </header>

      <nav className="driver-tabs" aria-label="Áreas do portal">
        {tabs.map((item) => (
          <button
            type="button"
            key={item.key}
            aria-pressed={shownTab === item.key}
            className={shownTab === item.key ? 'is-active' : ''}
            onClick={() => setTab(item.key)}
          >
            <Icon name={item.icon} size={20} />
            {item.label}
            {item.key === 'avisos' && unread > 0 && <span className="driver-tab-badge">{unread}</span>}
          </button>
        ))}
      </nav>

      <main className="driver-content">
        {error && <Alert tone="error">{error}</Alert>}
        {!profile && !error && <Loading label="Carregando o portal..." />}
        {profile && !profile.linked && (
          <Alert tone="warning">
            Seu cadastro de motorista ainda não está ativo. Fale com a equipe de Frota para receber viagens.
          </Alert>
        )}
        {profile && !enabled && (
          <Alert tone="warning">
            O Portal do Motorista está desativado pela administração. Suas viagens seguem com a equipe de Frota.
          </Alert>
        )}
        {profile && <PortalMessages portal={profile.portal} journeyInfo={enabled} />}
        {profile?.linked && shownTab === 'viagens' && <TripsTab profile={profile} />}
        {profile?.linked && shownTab === 'historico' && <HistoryTab />}
        {profile && shownTab === 'avisos' && <NoticesTab onRead={clearUnread} />}
      </main>
    </div>
  )
}

export default DriverPortalPage
