import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  errorMessage,
  formatDateTime,
  moduleLabels,
  protocolLabel,
  statusLabels,
  warehouseStatusLabels,
} from '../api/modulesApi'
import { globalSearch, searchCategoryLabels } from '../api/operationsApi'
import type { SearchCategoryResult, SearchHit } from '../api/operationsApi'
import { usePeriodFilter } from '../app/period'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, FilterSelect, PeriodFields } from '../components/ui/Filters'
import PageHeader from '../components/ui/PageHeader'
import Pagination from '../components/ui/Pagination'

const statusOptions = Object.entries({ ...warehouseStatusLabels, ...statusLabels }).map(([value, label]) => ({
  value,
  label,
}))

function Hit({ hit }: { hit: SearchHit }) {
  const status = hit.status ? (statusLabels[hit.status] ?? warehouseStatusLabels[hit.status] ?? hit.status) : null
  return (
    <li>
      <Link className="search-hit" to={hit.link}>
        <strong>{hit.protocol ? `${protocolLabel(hit.protocol)} · ${hit.title}` : hit.title}</strong>
        {hit.subtitle && <span>{hit.subtitle}</span>}
        <small>
          {[moduleLabels[hit.module], status, hit.at ? formatDateTime(hit.at) : null].filter(Boolean).join(' · ')}
        </small>
      </Link>
    </li>
  )
}

function SearchPage() {
  const [params] = useSearchParams()
  const term = params.get('q')?.trim() ?? ''
  const period = usePeriodFilter()
  const { from, to } = period.range
  const [module, setModule] = useState('')
  const [status, setStatus] = useState('')
  const [category, setCategory] = useState('')
  const [page, setPage] = useState(1)
  const [results, setResults] = useState<Record<string, SearchCategoryResult> | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (term.length < 2) return
    let active = true
    globalSearch({ q: term, module, status, from, to, category, page })
      .then((data) => {
        if (!active) return
        setResults(data.results)
        setError('')
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível pesquisar.'))
      })
    return () => {
      active = false
    }
  }, [term, module, status, from, to, category, page])

  const groups = Object.entries(results ?? {})

  return (
    <div className="admin-module-page search-page">
      <PageHeader
        title="Pesquisa"
        description={term ? `Resultados para "${term}", conforme as suas permissões.` : 'Use a barra no topo da página.'}
      />

      <FilterBar
        label="Filtros da pesquisa"
        canClear={Boolean(module || status || category) || period.isActive}
        onClear={() => {
          setModule('')
          setStatus('')
          setCategory('')
          setPage(1)
          period.clear()
        }}
      >
        <FilterSelect
          label="Categoria"
          value={category}
          onChange={(value) => {
            setCategory(value)
            setPage(1)
          }}
          allLabel="Todas"
          options={Object.entries(searchCategoryLabels).map(([value, label]) => ({ value, label }))}
        />
        <FilterSelect
          label="Módulo"
          value={module}
          onChange={(value) => {
            setModule(value)
            setPage(1)
          }}
          allLabel="Todos"
          options={Object.entries(moduleLabels).map(([value, label]) => ({ value, label }))}
        />
        <FilterSelect
          label="Situação"
          value={status}
          onChange={(value) => {
            setStatus(value)
            setPage(1)
          }}
          allLabel="Todas"
          options={statusOptions}
        />
        <PeriodFields filter={period} onChange={() => setPage(1)} />
      </FilterBar>

      {error && <Alert tone="error">{error}</Alert>}
      {term.length >= 2 && !results && !error && <Loading label="Pesquisando..." />}
      {results && groups.length === 0 && (
        <EmptyState icon="search" title="Nenhum resultado">
          Confira o termo ou os filtros. Só aparecem registros que você pode consultar.
        </EmptyState>
      )}

      {groups.map(([key, group]) => (
        <section key={key} className="ui-card ui-stacked search-group" aria-labelledby={`search-${key}`}>
          <h2 id={`search-${key}`}>
            {searchCategoryLabels[key]} ({group.total})
          </h2>
          <ul>
            {group.hits.map((hit) => (
              <Hit key={hit.id} hit={hit} />
            ))}
          </ul>
          {category ? (
            <Pagination
              page={group.page}
              summary={`${group.total} no total`}
              hasNext={group.page * group.pageSize < group.total}
              onChange={setPage}
            />
          ) : (
            group.total > group.hits.length && (
              <button
                type="button"
                className="maintenance-secondary-button"
                onClick={() => {
                  setCategory(key)
                  setPage(1)
                }}
              >
                Ver todos os {group.total} resultados
              </button>
            )
          )}
        </section>
      ))}
    </div>
  )
}

export default SearchPage
