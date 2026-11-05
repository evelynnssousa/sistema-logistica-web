import Icon from './Icon'

type PaginationProps = {
  page: number
  summary?: string
  hasPrevious?: boolean
  hasNext: boolean
  onChange: (page: number) => void
}

function Pagination({ page, summary, hasPrevious = page > 1, hasNext, onChange }: PaginationProps) {
  return (
    <nav className="users-pagination ui-pagination" aria-label="Paginação">
      <span>{summary ?? `Página ${page}`}</span>
      <button type="button" disabled={!hasPrevious} onClick={() => onChange(page - 1)}>
        <Icon name="previous" size={16} weight="bold" />
        Anterior
      </button>
      <button type="button" disabled={!hasNext} onClick={() => onChange(page + 1)}>
        Próxima
        <Icon name="next" size={16} weight="bold" />
      </button>
    </nav>
  )
}

export default Pagination
