import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { agendaKindLabels, cancelAgendaEvent, createAgendaEvent, fetchDemandAgenda } from '../../api/demandsApi'
import type { AgendaItem } from '../../api/demandsApi'
import { errorMessage, formatCalendarDate, formatDateTime } from '../../api/modulesApi'
import { Alert, EmptyState, Loading } from '../../components/ui/Feedback'
import { FilterBar, FilterSelect } from '../../components/ui/Filters'
import Icon from '../../components/ui/Icon'
import Modal from '../../components/ui/Modal'
import { useDemands } from './useDemands'

type Mode = 'dia' | 'semana' | 'mes'

const weekdayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function toIso(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseIso(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function shifted(date: Date, days: number) {
  const copy = new Date(date)
  copy.setDate(copy.getDate() + days)
  return copy
}

function rangeOf(mode: Mode, anchor: Date) {
  if (mode === 'dia') return { start: anchor, end: anchor }
  if (mode === 'semana') {
    const start = shifted(anchor, -anchor.getDay())
    return { start, end: shifted(start, 6) }
  }
  // Mês em semanas inteiras, como um calendário de parede.
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
  return { start: shifted(first, -first.getDay()), end: shifted(last, 6 - last.getDay()) }
}

function titleOf(mode: Mode, anchor: Date) {
  if (mode === 'mes') return anchor.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
  if (mode === 'dia') return anchor.toLocaleDateString('pt-BR', { dateStyle: 'full' })
  const { start, end } = rangeOf('semana', anchor)
  return `${start.toLocaleDateString('pt-BR')} a ${end.toLocaleDateString('pt-BR')}`
}

function ItemChip({ item, onSelect }: { item: AgendaItem; onSelect: (item: AgendaItem) => void }) {
  const state = item.done ? 'is-done' : item.overdue ? 'is-overdue' : item.dueSoon ? 'is-soon' : ''
  const stateLabel = item.done ? 'Concluída' : item.overdue ? 'Vencida' : item.dueSoon ? 'Vence em breve' : ''
  return (
    <button type="button" className={`demand-agenda-chip ${state}`} onClick={() => onSelect(item)}>
      <small>
        {agendaKindLabels[item.kind]}
        {stateLabel && ` · ${stateLabel}`}
      </small>
      {item.title}
    </button>
  )
}

function ItemDialog({ item, onClose, onCancelled }: { item: AgendaItem; onClose: () => void; onCancelled: () => void }) {
  const [error, setError] = useState('')

  async function cancel() {
    if (!item.eventId) return
    try {
      await cancelAgendaEvent(item.eventId)
      onCancelled()
      onClose()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível cancelar o compromisso.'))
    }
  }

  return (
    <Modal title={item.title} onClose={onClose}>
      {error && <Alert tone="error">{error}</Alert>}
      <dl className="demand-facts">
        <div>
          <dt>Tipo</dt>
          <dd>{agendaKindLabels[item.kind]}</dd>
        </div>
        <div>
          <dt>Data</dt>
          <dd>{item.start ? formatDateTime(item.start) : formatCalendarDate(item.date)}</dd>
        </div>
        {item.number && (
          <div>
            <dt>Demanda</dt>
            <dd>{item.number}</dd>
          </div>
        )}
        {item.sector && (
          <div>
            <dt>Setor</dt>
            <dd>{item.sector}</dd>
          </div>
        )}
        {item.responsible && (
          <div>
            <dt>Pessoa</dt>
            <dd>{item.responsible}</dd>
          </div>
        )}
        {item.description && (
          <div>
            <dt>Descrição</dt>
            <dd>{item.description}</dd>
          </div>
        )}
      </dl>
      {item.kind === 'recorrencia' && (
        <p className="demand-muted">Data prevista pela recorrência. A demanda será gerada automaticamente.</p>
      )}
      {item.origins.length > 0 && (
        <p>
          Relacionada a:{' '}
          {item.origins.map((origin) =>
            origin.path ? (
              <Link key={origin.protocol} to={origin.path}>{origin.protocol}</Link>
            ) : (
              <span key={origin.protocol}>{origin.protocol}</span>
            ),
          )}
        </p>
      )}
      <div className="demand-dialog-actions">
        {item.canCancel && (
          <button type="button" className="ui-button-danger" onClick={() => void cancel()}>Cancelar compromisso</button>
        )}
        {item.demandId && (
          <Link className="maintenance-primary-button" to={`/demandas/${item.demandId}`}>Abrir demanda</Link>
        )}
      </div>
    </Modal>
  )
}

export function AgendaCalendar({ filters }: { filters: { scope: string; sectorId: string; responsibleId: string } }) {
  const [mode, setMode] = useState<Mode>('mes')
  const [anchor, setAnchor] = useState(() => new Date())
  const [items, setItems] = useState<AgendaItem[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<AgendaItem | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const { start, end } = useMemo(() => rangeOf(mode, anchor), [mode, anchor])
  const from = toIso(start)
  const to = toIso(end)
  const today = toIso(new Date())

  useEffect(() => {
    let active = true
    fetchDemandAgenda({
      from,
      to,
      scope: filters.scope,
      sectorId: filters.sectorId || undefined,
      responsibleId: filters.responsibleId || undefined,
    })
      .then((result) => {
        if (!active) return
        setItems(result.items)
        setError('')
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar a agenda.'))
      })
    return () => {
      active = false
    }
  }, [from, to, filters.scope, filters.sectorId, filters.responsibleId, reloadKey])

  const days = useMemo(() => {
    const list: string[] = []
    for (let current = parseIso(from); toIso(current) <= to; current = shifted(current, 1)) list.push(toIso(current))
    return list
  }, [from, to])

  function move(direction: 1 | -1) {
    const next = new Date(anchor)
    if (mode === 'dia') next.setDate(next.getDate() + direction)
    if (mode === 'semana') next.setDate(next.getDate() + direction * 7)
    if (mode === 'mes') next.setMonth(next.getMonth() + direction, 1)
    setAnchor(next)
  }

  const modes: { key: Mode; label: string }[] = [
    { key: 'dia', label: 'Dia' },
    { key: 'semana', label: 'Semana' },
    { key: 'mes', label: 'Mês' },
  ]

  const byDay = (day: string) => (items ?? []).filter((item) => item.date === day)

  return (
    <div className="demand-agenda">
      <div className="demand-agenda-toolbar">
        <div className="demand-view-switch" role="group" aria-label="Período da agenda">
          {modes.map((item) => (
            <button
              type="button"
              key={item.key}
              aria-pressed={mode === item.key}
              className={mode === item.key ? 'is-active' : ''}
              onClick={() => setMode(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="demand-agenda-nav">
          <button type="button" className="maintenance-secondary-button" aria-label="Período anterior" onClick={() => move(-1)}>
            <Icon name="previous" size={16} weight="bold" />
          </button>
          <button type="button" className="maintenance-secondary-button" onClick={() => setAnchor(new Date())}>Hoje</button>
          <button type="button" className="maintenance-secondary-button" aria-label="Próximo período" onClick={() => move(1)}>
            <Icon name="next" size={16} weight="bold" />
          </button>
          <strong className="demand-agenda-title">{titleOf(mode, anchor)}</strong>
        </div>
      </div>

      <ul className="demand-agenda-legend" aria-label="Legenda">
        <li className="is-overdue">Vencida</li>
        <li className="is-soon">Vence em breve</li>
        <li className="is-done">Concluída</li>
      </ul>

      {error && <Alert tone="error">{error}</Alert>}
      {!items && !error && <Loading label="Carregando agenda..." />}

      {items && mode === 'mes' && (
        <div className="demand-month" role="grid" aria-label="Calendário do mês">
          {weekdayNames.map((name) => (
            <div key={name} className="demand-month-head" role="columnheader">{name}</div>
          ))}
          {days.map((day) => {
            const list = byDay(day)
            const outside = parseIso(day).getMonth() !== anchor.getMonth()
            return (
              <div key={day} role="gridcell" className={`demand-month-day${outside ? ' is-outside' : ''}${day === today ? ' is-today' : ''}`}>
                <span className="demand-month-number">{parseIso(day).getDate()}</span>
                {list.slice(0, 4).map((item) => (
                  <ItemChip key={item.key} item={item} onSelect={setSelected} />
                ))}
                {list.length > 4 && (
                  <button
                    type="button"
                    className="demand-more"
                    onClick={() => {
                      setAnchor(parseIso(day))
                      setMode('dia')
                    }}
                  >
                    Mais {list.length - 4}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {items && mode !== 'mes' && (
        items.length === 0 ? (
          <EmptyState icon="calendar" title="Nada neste período" />
        ) : (
          <div className="demand-agenda-list">
            {days
              .filter((day) => byDay(day).length > 0)
              .map((day) => (
                <section key={day}>
                  <h3 className={day === today ? 'is-today' : ''}>
                    {parseIso(day).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })}
                  </h3>
                  {byDay(day).map((item) => (
                    <ItemChip key={item.key} item={item} onSelect={setSelected} />
                  ))}
                </section>
              ))}
          </div>
        )
      )}

      {selected && (
        <ItemDialog
          item={selected}
          onClose={() => setSelected(null)}
          onCancelled={() => setReloadKey((value) => value + 1)}
        />
      )}
    </div>
  )
}

function NewEventDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { context, options } = useDemands()
  // O Diretor agenda para qualquer setor; o Chefe, para o que chefia.
  const eventSectors = context.directorate
    ? options.sectors.map((item) => ({ id: item.id, name: item.name }))
    : context.memberships.filter((item) => item.role === 'responsavel').map((item) => ({ id: item.sectorId, name: item.sectorName }))
  const [kind, setKind] = useState('reuniao')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [sectorId, setSectorId] = useState(eventSectors[0]?.id ?? '')
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await createAgendaEvent({
        kind,
        title,
        description,
        start: new Date(start).toISOString(),
        end: end ? new Date(end).toISOString() : undefined,
        sectorId: sectorId || undefined,
      })
      onCreated()
      onClose()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível criar o compromisso.'))
    }
  }

  return (
    <Modal title="Novo compromisso" onClose={onClose}>
      <form className="demand-dialog-form" onSubmit={(event) => void submit(event)}>
        {error && <Alert tone="error">{error}</Alert>}
        <label className="maintenance-form-field">
          <span>Tipo</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="reuniao">Reunião administrativa</option>
            <option value="entrega">Entrega prevista</option>
            <option value="atividade">Atividade programada</option>
          </select>
        </label>
        <label className="maintenance-form-field">
          <span>Título</span>
          <input required minLength={3} maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Setor</span>
          <select value={sectorId} onChange={(event) => setSectorId(event.target.value)}>
            <option value="">Somente eu</option>
            {eventSectors.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        <label className="maintenance-form-field">
          <span>Início</span>
          <input required type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Término (opcional)</span>
          <input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Descrição (opcional)</span>
          <textarea rows={2} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="demand-dialog-actions">
          <button type="button" className="maintenance-secondary-button" onClick={onClose}>Voltar</button>
          <button type="submit" className="maintenance-primary-button">Criar compromisso</button>
        </div>
      </form>
    </Modal>
  )
}

function DemandAgenda() {
  const { context, options } = useDemands()
  const [scope, setScope] = useState('all')
  const [sectorId, setSectorId] = useState('')
  const [responsibleId, setResponsibleId] = useState('')
  const [creating, setCreating] = useState(false)
  const [calendarKey, setCalendarKey] = useState(0)
  const reload = useCallback(() => setCalendarKey((value) => value + 1), [])

  return (
    <div className="demand-stack">
      <FilterBar
        label="Filtros da agenda"
        canClear={scope !== 'all' || Boolean(sectorId || responsibleId)}
        onClear={() => {
          setScope('all')
          setSectorId('')
          setResponsibleId('')
        }}
      >
        <FilterSelect
          label="Visão"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: context.directorate ? 'Todos os setores' : 'Tudo que posso ver' },
            { value: 'sector', label: 'Por setor' },
            { value: 'individual', label: 'Individual' },
          ]}
        />
        <FilterSelect label="Setor" value={sectorId} onChange={setSectorId} allLabel="Todos os setores"
          options={options.sectors.map((item) => ({ value: item.id, label: item.name }))} />
        <FilterSelect label="Responsável" value={responsibleId} onChange={setResponsibleId} allLabel="Todos os responsáveis"
          options={options.people.map((item) => ({ value: item.id, label: item.name }))} />
        {context.canCreateEvents && (
          <button type="button" className="maintenance-secondary-button" onClick={() => setCreating(true)}>
            <Icon name="add" size={18} />
            Novo compromisso
          </button>
        )}
      </FilterBar>
      <section className="ui-card">
        <AgendaCalendar key={calendarKey} filters={{ scope, sectorId, responsibleId }} />
      </section>
      <p className="demand-muted">
        Complementa a agenda de Manutenção, Frota e Passagens aéreas, que fica em Calendário. As agendas funcionam
        só dentro do sistema, sem calendário externo.
      </p>
      {creating && <NewEventDialog onClose={() => setCreating(false)} onCreated={reload} />}
    </div>
  )
}

export default DemandAgenda
