import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  changeDemandStatus,
  completeDemand,
  demandPriorityLabels,
  demandStatusLabels,
  demandStatusOrder,
  listDemands,
} from '../../api/demandsApi'
import type { DemandFilterValues, DemandStatus, DemandSummary } from '../../api/demandsApi'
import { errorMessage } from '../../api/modulesApi'
import { usePeriodFilter } from '../../app/period'
import { Alert, EmptyState, Loading } from '../../components/ui/Feedback'
import { FilterBar, FilterSelect, PeriodFields, SearchField } from '../../components/ui/Filters'
import Icon from '../../components/ui/Icon'
import Modal from '../../components/ui/Modal'
import Pagination from '../../components/ui/Pagination'
import { AgendaCalendar } from './DemandAgenda'
import { useDemands } from './useDemands'
import { DemandFlags, DemandStatusBadge, DueLabel, PriorityTag, ProgressBar } from './demandUi'

type Scope = 'all' | 'mine' | 'sector' | 'shared'
type View = 'lista' | 'quadro' | 'calendario'

const defaultSort = 'atualizacao'

const sortOptions = [
  { value: 'atualizacao', label: 'Atualização recente' },
  { value: 'prazo', label: 'Prazo' },
  { value: 'abertura', label: 'Data de abertura' },
  { value: 'prioridade', label: 'Prioridade' },
]

const flagOptions = [
  { value: 'true', label: 'Sim' },
  { value: 'false', label: 'Não' },
]

const kanbanStatuses = demandStatusOrder

/** A mudança para um status que exige dados abre o formulário, e nunca presume os valores. */
function KanbanMoveDialog({
  demand,
  status,
  onClose,
  onDone,
}: {
  demand: DemandSummary
  status: DemandStatus
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [text, setText] = useState('')
  const [date, setDate] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const label =
    status === 'aguardando_terceiros'
      ? 'Quem ou qual instituição está sendo aguardada'
      : status === 'suspensa'
        ? 'Justificativa da suspensão'
        : 'O que foi realizado'

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (status === 'concluida') {
        await completeDemand(demand.id, { done: text, version: demand.version })
      } else {
        await changeDemandStatus(demand.id, {
          status,
          version: demand.version,
          waitingFor: status === 'aguardando_terceiros' ? text : undefined,
          suspensionReason: status === 'suspensa' ? text : undefined,
          resumeDate: status === 'suspensa' ? date : undefined,
        })
      }
      await onDone()
      onClose()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível mover a demanda.'))
      setBusy(false)
    }
  }

  return (
    <Modal title={`${demand.number}: ${demandStatusLabels[status]}`} onClose={onClose}>
      <form className="demand-dialog-form" onSubmit={(event) => void submit(event)}>
        {error && <Alert tone="error">{error}</Alert>}
        <label className="maintenance-form-field">
          <span>{label}</span>
          <textarea required minLength={3} rows={3} value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        {status === 'suspensa' && (
          <label className="maintenance-form-field">
            <span>Previsão de retomada (opcional)</span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
        )}
        <div className="demand-dialog-actions">
          <button type="button" className="maintenance-secondary-button" onClick={onClose}>Voltar</button>
          <button type="submit" className="maintenance-primary-button" disabled={busy}>Confirmar</button>
        </div>
      </form>
    </Modal>
  )
}

function KanbanBoard({
  demands,
  canMove,
  onChanged,
}: {
  demands: DemandSummary[]
  canMove: boolean
  onChanged: () => Promise<void>
}) {
  const [error, setError] = useState('')
  const [pending, setPending] = useState<{ demand: DemandSummary; status: DemandStatus } | null>(null)
  const [dragOver, setDragOver] = useState<DemandStatus | null>(null)

  async function move(demand: DemandSummary, status: DemandStatus) {
    if (demand.status === status) return
    setError('')
    if (status === 'cancelada') {
      setError('Para cancelar, abra a demanda e informe o motivo.')
      return
    }
    if (status === 'concluida' || status === 'suspensa' || status === 'aguardando_terceiros') {
      setPending({ demand, status })
      return
    }
    try {
      await changeDemandStatus(demand.id, { status, version: demand.version })
      await onChanged()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível mover a demanda.'))
      await onChanged()
    }
  }

  function drop(event: DragEvent, status: DemandStatus) {
    event.preventDefault()
    setDragOver(null)
    const demand = demands.find((item) => item.id === event.dataTransfer.getData('text/plain'))
    if (demand) void move(demand, status)
  }

  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="demand-kanban" role="list" aria-label="Quadro por status">
        {kanbanStatuses.map((status) => {
          const column = demands.filter((item) => item.status === status)
          return (
            <section
              key={status}
              role="listitem"
              className={`demand-kanban-column${dragOver === status ? ' is-target' : ''}`}
              aria-label={demandStatusLabels[status]}
              onDragOver={(event) => {
                event.preventDefault()
                setDragOver(status)
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(event) => drop(event, status)}
            >
              <h3>
                {demandStatusLabels[status]} <span>{column.length}</span>
              </h3>
              {column.map((demand) => (
                <article
                  key={demand.id}
                  className="demand-card"
                  draggable={canMove}
                  onDragStart={(event) => event.dataTransfer.setData('text/plain', demand.id)}
                >
                  <Link to={`/demandas/${demand.id}`}>
                    <small>{demand.number}</small>
                    <strong>{demand.title}</strong>
                  </Link>
                  <DemandFlags demand={demand} />
                  <span className="demand-card-line">
                    <PriorityTag priority={demand.priority} />
                    <DueLabel demand={demand} />
                  </span>
                  <span className="demand-muted">{demand.responsible ?? 'Sem responsável'}</span>
                  {demand.progress !== null && <ProgressBar value={demand.progress} />}
                  {/* Alternativa ao arrastar, para teclado e toque. */}
                  {canMove && (
                    <label className="demand-card-move">
                      <span className="visually-hidden">Mover {demand.number} para</span>
                      <select
                        value={demand.status}
                        disabled={demand.status === 'concluida' || demand.status === 'cancelada'}
                        onChange={(event) => void move(demand, event.target.value as DemandStatus)}
                      >
                        {kanbanStatuses.map((option) => (
                          <option key={option} value={option}>
                            {demandStatusLabels[option]}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </article>
              ))}
            </section>
          )
        })}
      </div>
      {!canMove && <p className="demand-muted">Somente consulta: o quadro não permite mover demandas.</p>}
      {pending && (
        <KanbanMoveDialog
          demand={pending.demand}
          status={pending.status}
          onClose={() => setPending(null)}
          onDone={onChanged}
        />
      )}
    </>
  )
}

function DemandTable({ demands }: { demands: DemandSummary[] }) {
  return (
    <div className="data-table-wrapper">
      <table className="data-table demand-table">
        <thead>
          <tr>
            <th>Identificação</th>
            <th>Título</th>
            <th>Setor</th>
            <th>Responsável</th>
            <th>Prioridade</th>
            <th>Prazo</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {demands.map((demand) => (
            <tr key={demand.id}>
              <td>
                <Link to={`/demandas/${demand.id}`}>{demand.number}</Link>
              </td>
              <td>
                <Link className="demand-table-title" to={`/demandas/${demand.id}`}>{demand.title}</Link>
                <DemandFlags demand={demand} />
                {demand.progress !== null && <ProgressBar value={demand.progress} />}
              </td>
              <td>{demand.responsibleSector ?? '—'}</td>
              <td>{demand.responsible ?? <span className="demand-muted">Sem responsável</span>}</td>
              <td><PriorityTag priority={demand.priority} /></td>
              <td><DueLabel demand={demand} /></td>
              <td><DemandStatusBadge status={demand.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DemandList({ scope }: { scope: Scope }) {
  const { context, options } = useDemands()
  const [params, setParams] = useSearchParams()
  const period = usePeriodFilter()
  const [view, setView] = useState<View>('lista')
  const [number, setNumber] = useState('')
  const [text, setText] = useState('')
  const [requester, setRequester] = useState('')
  const [moreFilters, setMoreFilters] = useState(params.get('overdue') === 'true' || params.get('unassigned') === 'true')
  const [status, setStatus] = useState('')
  const [priority, setPriority] = useState('')
  const [sectorId, setSectorId] = useState('')
  const [responsibleId, setResponsibleId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [dueFrom, setDueFrom] = useState('')
  const [dueTo, setDueTo] = useState('')
  const [recurring, setRecurring] = useState('')
  const [shared, setShared] = useState('')
  const [overdue, setOverdue] = useState(params.get('overdue') === 'true')
  const [unassigned, setUnassigned] = useState(params.get('unassigned') === 'true')
  const [drafts, setDrafts] = useState(false)
  const [sort, setSort] = useState(defaultSort)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ demands: DemandSummary[]; total: number; pageSize: number } | null>(null)
  const [error, setError] = useState('')
  const { from, to } = period.range

  const filters = useMemo<DemandFilterValues>(
    () => ({
      number,
      text,
      requester,
      status,
      priority,
      sectorId,
      responsibleId,
      categoryId,
      from,
      to,
      dueFrom,
      dueTo,
      recurring,
      shared,
      overdue: overdue || undefined,
      unassigned: unassigned || undefined,
      scope: drafts ? 'drafts' : scope === 'all' ? undefined : scope,
    }),
    [number, text, requester, status, priority, sectorId, responsibleId, categoryId, from, to, dueFrom, dueTo, recurring, shared, overdue, unassigned, drafts, scope],
  )

  const pageSize = view === 'quadro' ? 200 : 25

  const load = useCallback(async () => {
    try {
      const result = await listDemands({ ...filters, sort, page: view === 'quadro' ? 1 : page, pageSize })
      setData(result)
      setError('')
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível carregar as demandas.'))
    }
  }, [filters, sort, page, pageSize, view])

  useEffect(() => {
    let active = true
    listDemands({ ...filters, sort, page: view === 'quadro' ? 1 : page, pageSize })
      .then((result) => {
        if (!active) return
        setData(result)
        setError('')
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar as demandas.'))
      })
    return () => {
      active = false
    }
  }, [filters, sort, page, pageSize, view])

  const change =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value)
      setPage(1)
    }

  // Os filtros menos usados ficam recolhidos; o contador avisa quando algum deles está valendo.
  const hiddenFilters = [requester, responsibleId, dueFrom, dueTo, recurring, overdue, priority, categoryId, shared, unassigned, drafts, period.isActive].filter(Boolean).length
  const filtering = Boolean(number || text || status || sectorId) || hiddenFilters > 0

  // A pesquisa nunca alcança outros setores: o servidor confere. Aqui, só não se oferece o que não traria nada.
  const seesAllSectors = context.directorate || context.administrator
  const ownSectorIds = context.memberships.map((item) => item.sectorId)
  const sectorChoices = options.sectors
    .filter((item) => seesAllSectors || ownSectorIds.includes(item.id))
    .map((item) => ({ value: item.id, label: item.name }))
  const responsibleChoices = options.people
    .filter((item) => seesAllSectors || item.sectorIds.some((id) => ownSectorIds.includes(id)))
    .map((item) => ({ value: item.id, label: item.name }))
  const views: { key: View; label: string; icon: 'requests' | 'demands' | 'calendar' }[] = [
    { key: 'lista', label: 'Lista', icon: 'requests' },
    { key: 'quadro', label: 'Quadro', icon: 'demands' },
    { key: 'calendario', label: 'Calendário', icon: 'calendar' },
  ]

  return (
    <div className="demand-stack">
      {scope === 'sector' && context.memberships.length > 0 && (
        <section className="demand-sector-cards" aria-label="Seus setores">
          {context.memberships.map((item) => (
            <button
              type="button"
              key={item.sectorId}
              className={sectorId === item.sectorId ? 'is-active' : ''}
              onClick={() => change(setSectorId)(sectorId === item.sectorId ? '' : item.sectorId)}
            >
              <strong>{item.sectorName}</strong>
              <span>{item.role === 'responsavel' ? 'Você é responsável pelo setor' : 'Você integra o setor'}</span>
            </button>
          ))}
        </section>
      )}

      <FilterBar
        label="Filtros das demandas"
        canClear={filtering || sort !== defaultSort}
        onClear={() => {
          // Volta à listagem original: inclusive a ordem e os filtros vindos de um link do painel.
          setSort(defaultSort)
          setParams({}, { replace: true })
          setNumber('')
          setText('')
          setRequester('')
          setStatus('')
          setPriority('')
          setSectorId('')
          setResponsibleId('')
          setCategoryId('')
          setDueFrom('')
          setDueTo('')
          setRecurring('')
          setShared('')
          setOverdue(false)
          setUnassigned(false)
          setDrafts(false)
          period.clear()
          setPage(1)
        }}
      >
        <SearchField label="Número/protocolo" value={number} placeholder="Ex.: DEM-2026-00001" onChange={change(setNumber)} />
        <SearchField label="Título e descrição" value={text} placeholder="Palavra do título ou da descrição" onChange={change(setText)} />
        <FilterSelect label="Setor" value={sectorId} onChange={change(setSectorId)} allLabel="Todos os setores" options={sectorChoices} />
        <FilterSelect label="Status" value={status} onChange={change(setStatus)} allLabel="Todos os status"
          options={demandStatusOrder.map((value) => ({ value, label: demandStatusLabels[value] }))} />
        <button
          type="button"
          className="maintenance-secondary-button demand-more-filters"
          aria-expanded={moreFilters}
          onClick={() => setMoreFilters(!moreFilters)}
        >
          <Icon name="filter" size={18} />
          {moreFilters ? 'Menos filtros' : 'Mais filtros'}
          {hiddenFilters > 0 && ` (${hiddenFilters})`}
        </button>
        {moreFilters && (
          <>
            <label className="ui-filter-field">
              <span>Solicitante</span>
              <input type="search" maxLength={120} placeholder="Nome" value={requester} onChange={(event) => change(setRequester)(event.target.value)} />
            </label>
            <FilterSelect label="Responsável" value={responsibleId} onChange={change(setResponsibleId)} allLabel="Todos os responsáveis" options={responsibleChoices} />
            <PeriodFields label="Data de cadastro" filter={period} onChange={() => setPage(1)} />
            <label className="ui-filter-field">
              <span>Prazo a partir de</span>
              <input type="date" value={dueFrom} onChange={(event) => change(setDueFrom)(event.target.value)} />
            </label>
            <label className="ui-filter-field">
              <span>Prazo até</span>
              <input type="date" value={dueTo} onChange={(event) => change(setDueTo)(event.target.value)} />
            </label>
            <FilterSelect label="Recorrente" value={recurring} onChange={change(setRecurring)} allLabel="Todas" options={flagOptions} />
            <FilterSelect label="Prioridade" value={priority} onChange={change(setPriority)} allLabel="Todas as prioridades"
              options={Object.entries(demandPriorityLabels).map(([value, label]) => ({ value, label }))} />
            <FilterSelect label="Categoria" value={categoryId} onChange={change(setCategoryId)} allLabel="Todas as categorias"
              options={options.categories.map((item) => ({ value: item.id, label: item.name }))} />
            <FilterSelect label="Compartilhada" value={shared} onChange={change(setShared)} allLabel="Todas" options={flagOptions} />
            <FilterSelect label="Ordenar por" value={sort} onChange={change(setSort)} options={sortOptions} />
            <label className="demand-check">
              <input type="checkbox" checked={overdue} onChange={(event) => change(setOverdue)(event.target.checked)} />
              Só atrasadas
            </label>
            <label className="demand-check">
              <input type="checkbox" checked={unassigned} onChange={(event) => change(setUnassigned)(event.target.checked)} />
              Só sem responsável
            </label>
            {scope === 'all' && context.canCreate && (
              <label className="demand-check">
                <input type="checkbox" checked={drafts} onChange={(event) => change(setDrafts)(event.target.checked)} />
                Meus rascunhos
              </label>
            )}
          </>
        )}
      </FilterBar>

      <div className="demand-view-switch" role="group" aria-label="Forma de visualização">
        {views.map((item) => (
          <button
            type="button"
            key={item.key}
            aria-pressed={view === item.key}
            className={view === item.key ? 'is-active' : ''}
            onClick={() => setView(item.key)}
          >
            <Icon name={item.icon} size={18} />
            {item.label}
          </button>
        ))}
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {view === 'calendario' ? (
        <section className="ui-card">
          <p className="demand-muted">O calendário segue o setor e o responsável selecionados nos filtros.</p>
          <AgendaCalendar
            filters={{
              scope: scope === 'mine' ? 'individual' : scope === 'sector' ? 'sector' : 'all',
              sectorId,
              responsibleId,
            }}
          />
        </section>
      ) : (
        <>
          {!data && !error && <Loading label="Carregando demandas..." />}
          {data && data.demands.length === 0 && (
            <section className="ui-card">
              <EmptyState icon="requests" title="Nenhuma demanda encontrada">
                {filtering ? 'Tente alterar a pesquisa ou os filtros.' : 'As demandas visíveis para você aparecem aqui.'}
              </EmptyState>
            </section>
          )}
          {data && data.demands.length > 0 && view === 'lista' && (
            <section className="ui-card">
              <DemandTable demands={data.demands} />
              <Pagination
                page={page}
                summary={`${data.total} no total`}
                hasNext={page * data.pageSize < data.total}
                onChange={setPage}
              />
            </section>
          )}
          {data && data.demands.length > 0 && view === 'quadro' && (
            <>
              {data.total > data.demands.length && (
                <Alert tone="info">
                  O quadro mostra as {data.demands.length} primeiras de {data.total} demandas. Use os filtros para refinar.
                </Alert>
              )}
              <KanbanBoard demands={data.demands} canMove={!context.consultationOnly} onChanged={load} />
            </>
          )}
        </>
      )}
    </div>
  )
}

export default DemandList
