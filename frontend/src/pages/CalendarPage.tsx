import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  protocolLabel,
  errorMessage,
  formatDateTime,
  getCalendarEvents,
  getRequest,
  historyActionLabels,
  listAssignees,
  moduleLabels,
  modulePaths,
  statusLabels,
} from '../api/modulesApi'
import type { CalendarEvent, RequestDetail, RequestModule } from '../api/modulesApi'
import { useHasPermission } from '../auth/UserContext'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterSelect } from '../components/ui/Filters'
import Icon from '../components/ui/Icon'
import Modal from '../components/ui/Modal'
import PageHeader from '../components/ui/PageHeader'
import StatusBadge from '../components/ui/StatusBadge'
import { CancelForm, ScheduleForm } from './RequestDetailPage'

const views = ['Mês', 'Semana', 'Dia'] as const
type View = (typeof views)[number]

const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const modules = ['maintenance', 'fleet'] as const
const statusOptions = ['agendado', 'reagendado', 'em_andamento', 'concluido', 'cancelado'].map((value) => ({ value, label: statusLabels[value] }))

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

/** Dias exibidos em cada visualização. No mês, completa as semanas das pontas. */
function rangeOf(view: View, reference: Date) {
  if (view === 'Dia') {
    const from = startOfDay(reference)
    return { from, to: addDays(from, 1) }
  }
  if (view === 'Semana') {
    const from = addDays(startOfDay(reference), -reference.getDay())
    return { from, to: addDays(from, 7) }
  }
  const first = new Date(reference.getFullYear(), reference.getMonth(), 1)
  const from = addDays(first, -first.getDay())
  const last = new Date(reference.getFullYear(), reference.getMonth() + 1, 0)
  return { from, to: addDays(last, 7 - last.getDay()) }
}

function move(view: View, reference: Date, direction: 1 | -1) {
  if (view === 'Dia') return addDays(reference, direction)
  if (view === 'Semana') return addDays(reference, 7 * direction)
  return new Date(reference.getFullYear(), reference.getMonth() + direction, 1)
}

function periodLabel(view: View, reference: Date, from: Date, to: Date) {
  if (view === 'Dia') return reference.toLocaleDateString('pt-BR', { dateStyle: 'full' })
  if (view === 'Semana') {
    return `${from.toLocaleDateString('pt-BR')} a ${addDays(to, -1).toLocaleDateString('pt-BR')}`
  }
  return reference.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
}

function EventButton({
  event,
  withDetails = false,
  onOpen,
}: {
  event: CalendarEvent
  withDetails?: boolean
  onOpen: (event: CalendarEvent) => void
}) {
  const time = new Date(event.start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return (
    <button
      type="button"
      className={`calendar-event ${event.module}${event.status === 'cancelado' ? ' is-cancelled' : ''}`}
      onClick={() => onOpen(event)}
    >
      {time} · {protocolLabel(event.protocol)} {event.title}
      {withDetails && (
        <>
          {' '}
          · {moduleLabels[event.module]} · {statusLabels[event.status]}
          {event.responsible ? ` · ${event.responsible}` : ''}
        </>
      )}
    </button>
  )
}

/** Detalhes do compromisso, lidos do próprio módulo. As ações usam as mesmas rotas e regras. */
function EventDetails({
  event,
  onClose,
  onChanged,
}: {
  event: CalendarEvent
  onClose: () => void
  onChanged: () => void
}) {
  const module: RequestModule = event.module
  const [detail, setDetail] = useState<RequestDetail | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setDetail(await getRequest(module, event.id))
      setError('')
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível carregar o compromisso.'))
    }
  }, [module, event.id])

  useEffect(() => {
    let active = true
    getRequest(module, event.id)
      .then((data) => {
        if (active) setDetail(data)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar o compromisso.'))
      })
    return () => {
      active = false
    }
  }, [module, event.id])

  const afterChange = async () => {
    await load()
    onChanged()
  }

  return (
    <Modal title={`${moduleLabels[module]} ${protocolLabel(event.protocol)}`} onClose={onClose}>
      {error && <Alert tone="error">{error}</Alert>}
      {!detail && !error && <Loading label="Carregando compromisso..." />}
      {detail && (
        <div className="calendar-details">
          <StatusBadge status={detail.request.status} label={statusLabels[detail.request.status]} />
          <p>{detail.request.title}</p>
          <dl className="detail-grid">
            <div className="detail-info"><dt>Início</dt><dd>{formatDateTime(detail.request.scheduledAt)}</dd></div>
            <div className="detail-info"><dt>Término previsto</dt><dd>{formatDateTime(detail.request.scheduledEnd)}</dd></div>
            <div className="detail-info"><dt>Responsável</dt><dd>{detail.request.responsible ?? '—'}</dd></div>
            <div className="detail-info"><dt>Setor</dt><dd>{detail.request.sector ?? '—'}</dd></div>
          </dl>
          <Link className="maintenance-secondary-button" to={`${modulePaths[module]}/${event.id}`}>
            <Icon name="view" size={18} />
            Abrir solicitação
          </Link>

          {detail.actions.schedule && (
            <ScheduleForm key={detail.request.updatedAt} module={module} detail={detail} onDone={afterChange} />
          )}
          {detail.actions.cancel && <CancelForm module={module} id={event.id} onDone={afterChange} />}

          <h3>Histórico</h3>
          <ul className="detail-history">
            {detail.history.map((entry) => (
              <li key={entry.id}>
                <strong>{historyActionLabels[entry.action] ?? entry.action}</strong>
                {entry.comment && <span>{entry.comment}</span>}
                <small>
                  {entry.user ?? 'Sistema'} · {formatDateTime(entry.at)}
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  )
}

function CalendarPage() {
  const canSeeAssignees = useHasPermission('requests:update')
  const [view, setView] = useState<View>('Mês')
  const [reference, setReference] = useState(() => new Date())
  const [selected, setSelected] = useState<string[]>([...modules])
  const [status, setStatus] = useState('')
  const [responsibleId, setResponsibleId] = useState('')
  const [assignees, setAssignees] = useState<{ value: string; label: string }[]>([])
  const [events, setEvents] = useState<CalendarEvent[] | null>(null)
  const [opened, setOpened] = useState<CalendarEvent | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [error, setError] = useState('')

  const { from, to } = useMemo(() => rangeOf(view, reference), [view, reference])

  useEffect(() => {
    let active = true
    if (selected.length === 0) return
    getCalendarEvents(from, to, selected, { status, responsibleId })
      .then((data) => {
        if (!active) return
        setEvents(data.events)
        setError('')
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar a agenda.'))
      })
    return () => {
      active = false
    }
  }, [from, to, selected, status, responsibleId, reloadKey])

  useEffect(() => {
    if (!canSeeAssignees) return
    let active = true
    listAssignees()
      .then((data) => {
        if (active) setAssignees(data.assignees.map((person) => ({ value: person.id, label: person.name })))
      })
      .catch(() => {
        // Sem a lista, o filtro por responsável não é oferecido.
      })
    return () => {
      active = false
    }
  }, [canSeeAssignees])

  const visibleEvents = useMemo(
    () => (selected.length === 0 ? [] : (events ?? [])),
    [selected, events],
  )

  // Um compromisso de vários dias aparece em cada um deles.
  const eventsByDay = useMemo(() => {
    const grouped = new Map<string, CalendarEvent[]>()
    for (const event of visibleEvents) {
      // Só os dias visíveis: o tamanho do compromisso não pesa na tela.
      const start = startOfDay(new Date(event.start))
      const end = startOfDay(new Date(event.end ?? event.start))
      const first = start < from ? from : start
      const last = end >= to ? addDays(to, -1) : end
      for (let day = first; day <= last; day = addDays(day, 1)) {
        const key = day.toDateString()
        grouped.set(key, [...(grouped.get(key) ?? []), event])
      }
    }
    return grouped
  }, [visibleEvents, from, to])

  const days = useMemo(() => {
    const list: Date[] = []
    for (let day = from; day < to; day = addDays(day, 1)) list.push(day)
    return list
  }, [from, to])

  return (
    <div className="admin-module-page calendar-page">
      <PageHeader
        title="Calendário"
        description="Agendamentos de Manutenção e Frota, a partir dos próprios registros dos módulos."
      />

      <section className="ui-card" aria-label="Calendário de serviços">
        <div className="calendar-toolbar">
          <div className="calendar-period-controls">
            <button type="button" aria-label="Período anterior" onClick={() => setReference(move(view, reference, -1))}>
              <Icon name="previous" size={18} weight="bold" />
            </button>
            <button type="button" aria-label="Período seguinte" onClick={() => setReference(move(view, reference, 1))}>
              <Icon name="next" size={18} weight="bold" />
            </button>
            <button type="button" onClick={() => setReference(new Date())}>
              Hoje
            </button>
            <span>{periodLabel(view, reference, from, to)}</span>
          </div>
          <div className="calendar-view-controls" aria-label="Visualização">
            {views.map((option) => (
              <button
                key={option}
                type="button"
                className={view === option ? 'active' : ''}
                aria-pressed={view === option}
                onClick={() => setView(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        <div className="calendar-filter-row" aria-label="Filtros da agenda">
          {modules.map((module) => (
            <label key={module} className="calendar-module-filter">
              <input
                type="checkbox"
                checked={selected.includes(module)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, module]
                      : current.filter((item) => item !== module),
                  )
                }
              />
              <span>{moduleLabels[module]}</span>
            </label>
          ))}
          <FilterSelect
            label="Situação"
            value={status}
            onChange={setStatus}
            allLabel="Todas"
            options={statusOptions}
          />
          {assignees.length > 0 && (
            <FilterSelect
              label="Responsável"
              value={responsibleId}
              onChange={setResponsibleId}
              allLabel="Todos"
              options={assignees}
            />
          )}
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        {view === 'Mês' ? (
          <div className="calendar-grid">
            {weekdays.map((day) => (
              <div className="calendar-weekday" key={day}>
                {day}
              </div>
            ))}
            {days.map((day) => (
              <div
                className={`calendar-day${day.getMonth() === reference.getMonth() ? '' : ' outside'}${
                  day.toDateString() === new Date().toDateString() ? ' today' : ''
                }`}
                key={day.toISOString()}
              >
                <div className="calendar-day-number">{day.getDate()}</div>
                {(eventsByDay.get(day.toDateString()) ?? []).map((event) => (
                  <EventButton key={event.id} event={event} onOpen={setOpened} />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="calendar-list">
            {days.map((day) => (
              <div key={day.toISOString()}>
                <strong>{day.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })}</strong>
                {(eventsByDay.get(day.toDateString()) ?? []).map((event) => (
                  <EventButton key={event.id} event={event} withDetails onOpen={setOpened} />
                ))}
                {!eventsByDay.has(day.toDateString()) && <p>Nenhum agendamento.</p>}
              </div>
            ))}
          </div>
        )}

        {events && visibleEvents.length === 0 && !error && (
          <EmptyState icon="calendar" title="Nenhum agendamento neste período">
            Os agendamentos de Manutenção e Frota aparecem aqui assim que forem realizados.
          </EmptyState>
        )}
      </section>

      {opened && (
        <EventDetails
          event={opened}
          onClose={() => setOpened(null)}
          onChanged={() => setReloadKey((key) => key + 1)}
        />
      )}
    </div>
  )
}

export default CalendarPage
