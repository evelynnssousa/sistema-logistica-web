import type { ReactNode } from 'react'
import type { SortState } from '../../app/tableSort'
import Icon from './Icon'

/** Cabeçalho de coluna que ordena ao clicar. Leitores de tela recebem a ordem por aria-sort. */
function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: ReactNode
  sortKey: string
  sort: SortState
  onSort: (key: string) => void
  className?: string
}) {
  const active = sort?.key === sortKey
  const direction = active ? sort.direction : null
  return (
    <th
      scope="col"
      className={className}
      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
    >
      <button type="button" className={`sort-button${active ? ' active' : ''}`} onClick={() => onSort(sortKey)}>
        {label}
        <Icon name={direction === 'asc' ? 'sortAsc' : direction === 'desc' ? 'sortDesc' : 'sortable'} size={12} weight="bold" />
      </button>
    </th>
  )
}

export default SortableTh
