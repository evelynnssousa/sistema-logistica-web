import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { protocolLabel, errorMessage, listRequests, statusLabels } from '../api/modulesApi'
import type { RequestModule, ServiceRequest } from '../api/modulesApi'
import { usePeriodFilter } from '../app/period'
import { useHasPermission } from '../auth/UserContext'
import { Alert, EmptyState, Loading } from './ui/Feedback'
import { FilterBar, FilterSelect, PeriodFields, SearchField } from './ui/Filters'
import Icon from './ui/Icon'
import type { IconName } from './ui/Icon'
import PageHeader from './ui/PageHeader'
import Pagination from './ui/Pagination'
import SortableTh from './ui/SortableTh'
import { nextSort } from '../app/tableSort'
import type { SortState } from '../app/tableSort'
import StatusBadge from './ui/StatusBadge'

/** sortKey: coluna que o servidor sabe ordenar (requestSortColumns). Sem ela, a coluna não ordena. */
type Column = { label: string; render: (request: ServiceRequest) => ReactNode; sortKey?: string }

type ServiceRequestsPageProps = {
  module: RequestModule
  basePath: string
  pageTitle: string
  pageDescription: string
  searchPlaceholder: string
  statusOptions: readonly string[]
  columns: readonly Column[]
  className?: string
  createPermission: string
  /** Atalhos do cabeçalho (Veículos, Motoristas, Resumo do mês...), cada um com a sua permissão. */
  extraActions?: readonly ExtraAction[]
  /** Filtro próprio do módulo, enviado à API. */
  tripTypeOptions?: { value: string; label: string }[]
  /** Conteúdo próprio do módulo, abaixo da lista (ex.: a planilha da Frota). */
  footer?: ReactNode
}

type ExtraAction = { to: string; label: string; icon: IconName; permission: string }

function ExtraActionLink({ action }: { action: ExtraAction }) {
  const allowed = useHasPermission(action.permission)
  if (!allowed) return null
  return (
    <Link className="maintenance-secondary-button" to={action.to}>
      <Icon name={action.icon} size={18} />
      {action.label}
    </Link>
  )
}

function ServiceRequestsPage({
  module,
  basePath,
  pageTitle,
  pageDescription,
  searchPlaceholder,
  statusOptions,
  columns,
  className = 'maintenance-page',
  createPermission,
  extraActions = [],
  tripTypeOptions,
  footer,
}: ServiceRequestsPageProps) {
  const canCreate = useHasPermission(createPermission)
  const period = usePeriodFilter()
  const [searchTerm, setSearchTerm] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [status, setStatus] = useState('')
  const [tripType, setTripType] = useState('')
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<SortState>(null)
  const onSort = (key: string) => {
    setSort((current) => nextSort(current, key))
    setPage(1)
  }
  const [data, setData] = useState<{ requests: ServiceRequest[]; total: number; pageSize: number } | null>(null)
  const [error, setError] = useState('')
  const { from, to } = period.range

  useEffect(() => {
    const timer = setTimeout(() => {
      setAppliedSearch(searchTerm)
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchTerm])

  useEffect(() => {
    let active = true
    listRequests(module, { status, tripType, search: appliedSearch, from, to, page, ordem: sort?.key, direcao: sort?.direction })
      .then((result) => {
        if (!active) return
        setData(result)
        setError('')
      })
      .catch((err: unknown) => {
        if (!active) return
        setData(null)
        setError(errorMessage(err, 'Não foi possível carregar as solicitações.'))
      })
    return () => {
      active = false
    }
  }, [module, status, tripType, appliedSearch, from, to, page, sort])

  const filtering = Boolean(status || tripType || searchTerm) || period.isActive
  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <div className={className}>
      <PageHeader
        title={pageTitle}
        description={pageDescription}
        actions={
          <>
            {extraActions.map((action) => (
              <ExtraActionLink key={action.to} action={action} />
            ))}
            {canCreate && (
              <Link className="maintenance-primary-button" to={`${basePath}/nova`}>
                <Icon name="add" size={20} />
                Nova solicitação
              </Link>
            )}
          </>
        }
      />

      <section className="ui-card" aria-label={`Solicitações de ${pageTitle}`}>
        <FilterBar
          label="Filtros das solicitações"
          canClear={filtering}
          onClear={() => {
            setSearchTerm('')
            setStatus('')
            setTripType('')
            period.clear()
            setPage(1)
          }}
        >
          <SearchField
            label="Pesquisar"
            value={searchTerm}
            placeholder={searchPlaceholder}
            onChange={setSearchTerm}
          />
          <FilterSelect
            label="Situação"
            value={status}
            allLabel="Todas as situações"
            options={statusOptions.map((value) => ({ value, label: statusLabels[value] }))}
            onChange={(value) => {
              setStatus(value)
              setPage(1)
            }}
          />
          {tripTypeOptions && (
            <FilterSelect
              label="Tipo de viagem"
              value={tripType}
              allLabel="Todos os tipos"
              options={tripTypeOptions}
              onChange={(value) => {
                setTripType(value)
                setPage(1)
              }}
            />
          )}
          <PeriodFields filter={period} onChange={() => setPage(1)} />
        </FilterBar>

        {error && <Alert tone="error">{error}</Alert>}
        {!data && !error && <Loading label="Carregando solicitações..." />}

        {data && data.requests.length === 0 && (
          <EmptyState title={filtering ? 'Nada encontrado' : 'Nenhuma solicitação ainda'}>
            {filtering
              ? 'Não há solicitações para os filtros selecionados.'
              : 'As solicitações aparecem aqui assim que forem registradas.'}
          </EmptyState>
        )}

        {data && data.requests.length > 0 && (
          <>
            <div className="maintenance-table-wrapper">
              <table className="maintenance-table">
                <caption className="visually-hidden">Solicitações de {pageTitle}</caption>
                <thead>
                  <tr>
                    <SortableTh label="Protocolo" sortKey="protocolo" sort={sort} onSort={onSort} />
                    {columns.map((column) =>
                      column.sortKey ? (
                        <SortableTh key={column.label} label={column.label} sortKey={column.sortKey} sort={sort} onSort={onSort} />
                      ) : (
                        <th key={column.label} scope="col">
                          {column.label}
                        </th>
                      ),
                    )}
                    <SortableTh label="Situação" sortKey="situacao" sort={sort} onSort={onSort} />
                    <th scope="col">
                      <span className="visually-hidden">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.requests.map((request) => (
                    <tr key={request.id}>
                      <td>{protocolLabel(request.protocol)}</td>
                      {columns.map((column) => (
                        <td key={column.label}>{column.render(request)}</td>
                      ))}
                      <td>
                        <StatusBadge status={request.status} label={statusLabels[request.status]} />
                      </td>
                      <td>
                        <Link
                          className="service-row-action"
                          to={`${basePath}/${request.id}`}
                          aria-label={`Ver a solicitação ${request.protocol}`}
                        >
                          <Icon name="view" size={16} />
                          Ver
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              summary={`${data.total} ${data.total === 1 ? 'solicitação' : 'solicitações'} · Página ${page} de ${lastPage}`}
              hasNext={page < lastPage}
              onChange={setPage}
            />
          </>
        )}
      </section>
      {footer}
    </div>
  )
}

export default ServiceRequestsPage
