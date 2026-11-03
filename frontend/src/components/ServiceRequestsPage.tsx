import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useHasPermission } from '../auth/UserContext'

type ServiceRequestsPageProps = {
  pageTitle: string
  pageDescription: string
  searchPlaceholder: string
  listDescription: string
  statusOptions: readonly string[]
  columns: readonly string[]
  emptyDescription: string
  className?: string
  statusFilterStyle?: 'select' | 'tabs'
  emptyActionLabel?: string
  newRequestTo?: string
  createPermission?: string
}

function ServiceRequestsPage({
  pageTitle,
  pageDescription,
  searchPlaceholder,
  listDescription,
  statusOptions,
  columns,
  emptyDescription,
  className = 'maintenance-page',
  statusFilterStyle = 'select',
  emptyActionLabel,
  newRequestTo,
  createPermission,
}: ServiceRequestsPageProps) {
  const canCreate = useHasPermission(createPermission ?? '')
  const hidesCreateAction = Boolean(createPermission) && !canCreate
  const [searchTerm, setSearchTerm] = useState('')
  const [status, setStatus] = useState(
    statusFilterStyle === 'tabs' ? 'Todos' : statusOptions[0],
  )

  return (
    <div className={className}>
      <section className="maintenance-heading">
        <div>
          <div className="eyebrow">JUCESP · GESTÃO OPERACIONAL</div>
          <h1>{pageTitle}</h1>
          <p>{pageDescription}</p>
        </div>
        <div className="maintenance-action">
          {hidesCreateAction ? null : newRequestTo ? (
            <Link className="maintenance-primary-button" to={newRequestTo}>
              <span aria-hidden="true">+</span>
              Nova solicitação
            </Link>
          ) : (
            <>
              <button
                className="maintenance-primary-button"
                type="button"
                disabled
                aria-describedby="service-request-action-note"
              >
                <span aria-hidden="true">+</span>
                Nova solicitação
              </button>
              <span id="service-request-action-note">
                Disponível em uma próxima etapa.
              </span>
            </>
          )}
        </div>
      </section>

      <section
        className="maintenance-list"
        aria-labelledby="service-requests-list-title"
      >
        <div className="maintenance-section-heading">
          <div>
            <h2 id="service-requests-list-title">Solicitações</h2>
            <p>{listDescription}</p>
          </div>
        </div>

        <div className="maintenance-filters">
          <label className="maintenance-search">
            <span className="maintenance-search-icon" aria-hidden="true">
              ⌕
            </span>
            <span className="visually-hidden">{searchPlaceholder}</span>
            <input
              type="search"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder={searchPlaceholder}
            />
          </label>

          {statusFilterStyle === 'tabs' ? (
            <div
              className="service-status-tabs"
              role="group"
              aria-label="Filtrar por status"
            >
              {['Todos', ...statusOptions].map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`service-status-tab${status === option ? ' active' : ''}`}
                  aria-pressed={status === option}
                  onClick={() => setStatus(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          ) : (
            <label className="maintenance-status-filter">
              <span>Status</span>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                {statusOptions.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className="maintenance-table-wrapper">
          <table className="maintenance-table">
            <caption className="visually-hidden">
              {`Solicitações de ${pageTitle.toLocaleLowerCase('pt-BR')} por ${columns.join(', ')}`}
            </caption>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {emptyActionLabel ? (
                <tr>
                  <td colSpan={columns.length - 1}>
                    <div className="maintenance-empty-state">
                      <span aria-hidden="true">▤</span>
                      <strong>Nenhuma solicitação disponível</strong>
                      <p>{emptyDescription}</p>
                    </div>
                  </td>
                  <td className="service-empty-action-cell">
                    <button
                      className="service-row-action"
                      type="button"
                      disabled
                      title="Disponível quando houver solicitações."
                    >
                      {emptyActionLabel}
                    </button>
                  </td>
                </tr>
              ) : (
                <tr>
                  <td colSpan={columns.length}>
                    <div className="maintenance-empty-state">
                      <span aria-hidden="true">▤</span>
                      <strong>Nenhuma solicitação disponível</strong>
                      <p>{emptyDescription}</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

export default ServiceRequestsPage
