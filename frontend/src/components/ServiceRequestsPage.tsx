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
import StatusBadge from './ui/StatusBadge'

type Column = { label: string; render: (request: ServiceRequest) => ReactNode }

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
  extraAction?: { to: string; label: string; icon: IconName; permission: string }
  secondExtraAction?: { to: string; label: string; icon: IconName; permission: string }
  /** Filtro próprio do módulo, enviado à API. */
  tripTypeOptions?: { value: string; label: string }[]
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
  extraAction,
  secondExtraAction,
  tripTypeOptions,
}: ServiceRequestsPageProps) {
  const canCreate = useHasPermission(createPermission)
  const canSeeExtra = useHasPermission(extraAction?.permission ?? '')
  const canSeeSecondExtra = useHasPermission(secondExtraAction?.permission ?? '')
  const period = usePeriodFilter()
  const [searchTerm, setSearchTerm] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [status, setStatus] = useState('')
  const [tripType, setTripType] = useState('')
  const [page, setPage] = useState(1)
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
    listRequests(module, { status, tripType, search: appliedSearch, from, to, page })
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
  }, [module, status, tripType, appliedSearch, from, to, page])

  const filtering = Boolean(status || tripType || searchTerm) || period.isActive
  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <div className={className}>
      <PageHeader
        title={pageTitle}
        description={pageDescription}
        actions={
          <>
            {extraAction && canSeeExtra && (
              <Link className="maintenance-secondary-button" to={extraAction.to}>
                <Icon name={extraAction.icon} size={18} />
                {extraAction.label}
              </Link>
            )}
            {secondExtraAction && canSeeSecondExtra && (
              <Link className="maintenance-secondary-button" to={secondExtraAction.to}>
                <Icon name={secondExtraAction.icon} size={18} />
                {secondExtraAction.label}
              </Link>
            )}
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
                    <th scope="col">Protocolo</th>
                    {columns.map((column) => (
                      <th key={column.label} scope="col">
                        {column.label}
                      </th>
                    ))}
                    <th scope="col">Situação</th>
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
    </div>
  )
}

export default ServiceRequestsPage
