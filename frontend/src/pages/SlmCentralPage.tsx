import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  errorMessage,
  formatDate,
  moduleLabels,
  modulePaths,
  protocolLabel,
  statusLabels,
} from '../api/modulesApi'
import {
  complexityLabels,
  getCentralOverview,
  getCentralTeam,
  listCentralRequests,
  priorityLabels,
} from '../api/operationsApi'
import type { CentralOverview, CentralRequest, QueueKey, TeamMember } from '../api/operationsApi'
import { usePeriodFilter } from '../app/period'
import { useCatalog } from '../app/useCatalog'
import { BarChart } from '../components/ui/Charts'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, FilterSelect, PeriodFields, SearchField } from '../components/ui/Filters'
import Icon from '../components/ui/Icon'
import type { IconName } from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'
import Pagination from '../components/ui/Pagination'
import StatusBadge from '../components/ui/StatusBadge'

const queueCards: { key: QueueKey; label: string; icon: IconName; attention?: boolean }[] = [
  { key: 'late', label: 'Atrasadas', icon: 'warning', attention: true },
  { key: 'near_due', label: 'Próximas do vencimento', icon: 'attention', attention: true },
  { key: 'unassigned', label: 'Sem responsável', icon: 'attention', attention: true },
  { key: 'stale', label: 'Sem movimentação', icon: 'waiting', attention: true },
  { key: 'approval', label: 'Aprovações pendentes', icon: 'scales', attention: true },
  { key: 'awaiting_requester', label: 'Aguardando o solicitante', icon: 'waiting' },
  { key: 'awaiting_internal', label: 'Providências internas', icon: 'requests' },
  { key: 'today', label: 'Agendamentos do dia', icon: 'calendar' },
  { key: 'awaiting_schedule', label: 'Aguardando agendamento', icon: 'calendar' },
  { key: 'awaiting_service', label: 'Aguardando atendimento', icon: 'requests' },
  { key: 'in_progress', label: 'Em andamento', icon: 'progress' },
  { key: 'concluded', label: 'Concluídas', icon: 'success' },
  { key: 'cancelled', label: 'Canceladas', icon: 'error' },
]

function durationLabel(seconds: number | null) {
  if (seconds === null) return 'sem dados'
  const hours = Math.floor(seconds / 3600)
  return hours >= 48 ? `${Math.round(hours / 24)} dias` : `${hours} h ${Math.floor((seconds % 3600) / 60)} min`
}

function Queues({
  overview,
  selected,
  onSelect,
}: {
  overview: CentralOverview
  selected: string
  onSelect: (queue: string) => void
}) {
  return (
    <section className="central-queues" aria-label="Filas de trabalho">
      {queueCards.map((card) => {
        const value = overview.counts[card.key]
        const highlighted = card.attention && value > 0
        return (
          <button
            key={card.key}
            type="button"
            aria-pressed={selected === card.key}
            className={`central-queue${selected === card.key ? ' is-selected' : ''}${highlighted ? ' needs-attention' : ''}`}
            onClick={() => onSelect(selected === card.key ? '' : card.key)}
          >
            <Icon name={card.icon} size={20} weight="duotone" />
            <strong>{value}</strong>
            <span>{card.label}</span>
          </button>
        )
      })}
    </section>
  )
}

function Alerts({ overview }: { overview: CentralOverview }) {
  const { communications } = overview
  const items = [
    communications?.emailsFailed
      ? { tone: 'error' as const, text: `${communications.emailsFailed} e-mails com falha de envio.` }
      : null,
    communications?.calendarFailed
      ? { tone: 'error' as const, text: `${communications.calendarFailed} falhas de sincronização com o calendário.` }
      : null,
    communications?.emailsPending
      ? { tone: 'info' as const, text: `${communications.emailsPending} e-mails aguardando envio.` }
      : null,
    communications?.emailsNotConfigured
      ? { tone: 'info' as const, text: `${communications.emailsNotConfigured} e-mails não enviados porque o serviço não está ativo.` }
      : null,
  ].filter((item) => item !== null)

  if (items.length === 0) return null
  return (
    <section className="central-alerts" aria-label="Alertas operacionais">
      {items.map((item) => (
        <Alert key={item.text} tone={item.tone}>
          {item.text}
        </Alert>
      ))}
    </section>
  )
}

function TeamPanel({
  team,
  selected,
  onSelect,
}: {
  team: TeamMember[]
  selected: string
  onSelect: (id: string) => void
}) {
  return (
    <section className="ui-card ui-stacked" aria-labelledby="team-title">
      <h2 id="team-title">Equipe</h2>
      <p className="management-hint">
        Volume e complexidade lado a lado. Quantidade sozinha não mede desempenho: um atendimento complexo não
        equivale a um simples, e solicitações sem classificação não entram na leitura de complexidade.
      </p>
      {team.length === 0 ? (
        <EmptyState icon="users" title="Nenhum integrante elegível" />
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Integrante</th>
                <th>Em aberto</th>
                <th>Atrasadas</th>
                <th>Urgentes</th>
                <th>Em andamento</th>
                <th>Concluídas (30 dias)</th>
                <th>Complexidade em aberto</th>
              </tr>
            </thead>
            <tbody>
              {team.map((member) => (
                <tr key={member.id} className={selected === member.id ? 'is-selected-row' : ''}>
                  <td>
                    <button
                      type="button"
                      className="central-link-button"
                      aria-pressed={selected === member.id}
                      onClick={() => onSelect(selected === member.id ? '' : member.id)}
                    >
                      {member.name}
                    </button>
                  </td>
                  <td>{member.open}</td>
                  <td>{member.late}</td>
                  <td>{member.urgent}</td>
                  <td>{member.inProgress}</td>
                  <td>{member.concluded30d}</td>
                  <td>
                    {member.complexity.simple} simples, {member.complexity.medium} médias, {member.complexity.complex} complexas
                    {member.complexity.unclassified > 0 && `, ${member.complexity.unclassified} sem classificação`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function RequestRow({ request }: { request: CentralRequest }) {
  return (
    <tr>
      <td>
        <Link to={`${modulePaths[request.module]}/${request.id}`}>{protocolLabel(request.protocol)}</Link>
        <small className="central-subtext">{moduleLabels[request.module]}</small>
      </td>
      <td className="central-title-cell">
        {request.title}
        <small>
          {request.requester}
          {request.sector ? ` · ${request.sector}` : ''}
        </small>
      </td>
      <td>
        <StatusBadge status={request.status} label={statusLabels[request.status] ?? request.status} />
        {request.late && <span className="central-flag central-flag-late">Atrasada</span>}
        {request.nearDue && <span className="central-flag">Vence em breve</span>}
        {request.waitingRequester && <span className="central-flag">Aguardando o solicitante</span>}
        {request.stale && <span className="central-flag">Sem movimentação</span>}
      </td>
      <td>{request.responsible ?? <em>Sem responsável</em>}</td>
      <td>
        {priorityLabels[request.priority] ?? request.priority}
        {request.complexity && <small className="central-subtext">{complexityLabels[request.complexity]}</small>}
      </td>
      <td>{formatDate(request.deadline)}</td>
      <td>{formatDate(request.updatedAt)}</td>
    </tr>
  )
}

const statusOptions = Object.entries(statusLabels).map(([value, label]) => ({ value, label }))

function SlmCentralPage() {
  const { catalog } = useCatalog()
  const period = usePeriodFilter()
  const { from, to } = period.range
  const [overview, setOverview] = useState<CentralOverview | null>(null)
  const [team, setTeam] = useState<TeamMember[]>([])
  const [listing, setListing] = useState<Awaited<ReturnType<typeof listCentralRequests>> | null>(null)
  const [queue, setQueue] = useState('')
  const [module, setModule] = useState('')
  const [sectorId, setSectorId] = useState('')
  const [responsibleId, setResponsibleId] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    Promise.all([getCentralOverview(), getCentralTeam()])
      .then(([summary, members]) => {
        if (!active) return
        setOverview(summary)
        setTeam(members.team)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar a Central.'))
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    listCentralRequests({ queue, module, sectorId, responsibleId, status, search, from, to, page })
      .then((data) => {
        if (active) {
          setListing(data)
          setError('')
        }
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar as solicitações.'))
      })
    return () => {
      active = false
    }
  }, [queue, module, sectorId, responsibleId, status, search, from, to, page])

  function change<Value>(setter: (value: Value) => void) {
    return (value: Value) => {
      setter(value)
      setPage(1)
    }
  }

  const hasFilters = Boolean(queue || module || sectorId || responsibleId || status || search) || period.isActive

  return (
    <div className="admin-module-page central-page">
      <PageHeader
        title="Central de Operações"
        description="Demandas de todos os módulos, para a rotina da equipe SLM."
      />

      {error && <Alert tone="error">{error}</Alert>}
      {!overview && !error && <Loading label="Carregando a Central..." />}

      {overview && (
        <>
          <Queues overview={overview} selected={queue} onSelect={change(setQueue)} />
          <Alerts overview={overview} />
        </>
      )}

      <FilterBar
        label="Filtros da Central"
        canClear={hasFilters}
        onClear={() => {
          setQueue('')
          setModule('')
          setSectorId('')
          setResponsibleId('')
          setStatus('')
          setSearch('')
          period.clear()
          setPage(1)
        }}
      >
        <SearchField
          label="Pesquisa"
          value={search}
          placeholder="Protocolo, assunto, solicitante ou setor"
          onChange={change(setSearch)}
        />
        <FilterSelect
          label="Módulo"
          value={module}
          onChange={change(setModule)}
          allLabel="Todos os módulos"
          options={['maintenance', 'fleet', 'flights'].map((value) => ({ value, label: moduleLabels[value] }))}
        />
        <FilterSelect
          label="Setor"
          value={sectorId}
          onChange={change(setSectorId)}
          allLabel="Todos os setores"
          options={catalog.sectors.map((sector) => ({ value: sector.id, label: sector.label }))}
        />
        <FilterSelect
          label="Responsável"
          value={responsibleId}
          onChange={change(setResponsibleId)}
          allLabel="Todos"
          options={team.map((member) => ({ value: member.id, label: member.name }))}
        />
        <FilterSelect
          label="Situação"
          value={status}
          onChange={change(setStatus)}
          allLabel="Todas"
          options={statusOptions}
        />
        <PeriodFields filter={period} onChange={() => setPage(1)} />
      </FilterBar>

      {listing && (
        <section className="ui-card ui-stacked" aria-label="Solicitações">
          {listing.requests.length === 0 ? (
            <EmptyState icon="requests" title="Nenhuma solicitação encontrada" />
          ) : (
            <div className="data-table-wrapper">
              <table className="data-table central-table">
                <caption className="visually-hidden">Solicitações da Central de Operações</caption>
                <thead>
                  <tr>
                    <th>Protocolo</th>
                    <th>Assunto</th>
                    <th>Situação</th>
                    <th>Responsável</th>
                    <th>Prioridade</th>
                    <th>Prazo</th>
                    <th>Movimentação</th>
                  </tr>
                </thead>
                <tbody>
                  {listing.requests.map((request) => (
                    <RequestRow key={request.id} request={request} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination
            page={listing.page}
            summary={`${listing.total} no total`}
            hasNext={listing.page * listing.pageSize < listing.total}
            onChange={setPage}
          />
        </section>
      )}

      <TeamPanel team={team} selected={responsibleId} onSelect={change(setResponsibleId)} />

      {overview && (
        <div className="ui-grid-2">
          <section className="ui-card reports-chart" aria-labelledby="central-module">
            <h2 id="central-module">Em aberto por módulo</h2>
            {overview.byModule.length === 0 ? (
              <EmptyState icon="reports" title="Sem dados para exibir" />
            ) : (
              <BarChart rows={overview.byModule.map((row) => ({ label: moduleLabels[row.module], value: row.open }))} />
            )}
          </section>
          <section className="ui-card reports-chart" aria-labelledby="central-sector">
            <h2 id="central-sector">Em aberto por setor</h2>
            {overview.bySector.length === 0 ? (
              <EmptyState icon="reports" title="Sem dados para exibir" />
            ) : (
              <BarChart rows={overview.bySector.map((row) => ({ label: row.sector, value: row.open }))} />
            )}
          </section>
        </div>
      )}
      {overview?.warehouse && (
        <p className="management-hint">
          Almoxarifado: {overview.warehouse.openRequests === 1 ? '1 pedido' : `${overview.warehouse.openRequests} pedidos`} em aberto.{' '}
          <Link to="/almoxarifado/solicitacoes">Abrir pedidos</Link>
        </p>
      )}
      {overview && overview.timing.basedOn > 0 && (
        <section className="ui-card ui-stacked" aria-labelledby="central-times">
          <h2 id="central-times">Tempos médios, últimos 90 dias</h2>
          <div className="timing-grid">
            <p><strong>Espera pelo solicitante:</strong> {durationLabel(overview.timing.requesterWaitSeconds)}</p>
            <p><strong>Execução interna:</strong> {durationLabel(overview.timing.internalSeconds)}</p>
            <p><strong>Resolução total:</strong> {durationLabel(overview.timing.totalSeconds)}</p>
          </div>
          <p className="management-hint">Com base em {overview.timing.basedOn} solicitações concluídas.</p>
        </section>
      )}
      {overview && (
        <p className="management-hint">
          "Próximas do vencimento" considera {overview.warningDays} dias de antecedência. A espera registrada pelo solicitante não conta como atraso interno.
        </p>
      )}
      {overview && (
        <p className="management-hint">
          "Sem movimentação" considera {overview.staleDays} dias sem atualização, valor definido em Configurações.
        </p>
      )}
    </div>
  )
}

export default SlmCentralPage
