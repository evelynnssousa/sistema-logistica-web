import { useMemo, useState } from 'react'

/**
 * Tabelas que ordenam ao clicar na coluna (13/11/2026). O primeiro clique ordena em ordem
 * crescente, o segundo inverte e o terceiro volta à ordem original.
 */
export type SortState = { key: string; direction: 'asc' | 'desc' } | null

export function nextSort(current: SortState, key: string): SortState {
  if (current?.key !== key) return { key, direction: 'asc' }
  return current.direction === 'asc' ? { key, direction: 'desc' } : null
}

type SortValue = string | number | Date | null | undefined

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' })

function compare(a: SortValue, b: SortValue) {
  // Vazio sempre por último, nas duas direções.
  const emptyA = a === null || a === undefined || a === ''
  const emptyB = b === null || b === undefined || b === ''
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1
  if (a instanceof Date || b instanceof Date) return new Date(a as Date).getTime() - new Date(b as Date).getTime()
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return collator.compare(String(a), String(b))
}

/** Ordenação na tela, para tabelas que já chegam completas (sem páginas no servidor). */
export function useTableSort<T>(rows: readonly T[], accessors: Record<string, (row: T) => SortValue>) {
  const [sort, setSort] = useState<SortState>(null)
  const sorted = useMemo(() => {
    if (!sort || !accessors[sort.key]) return rows
    const read = accessors[sort.key]
    const factor = sort.direction === 'asc' ? 1 : -1
    return [...rows]
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const valueA = read(left.row)
        const valueB = read(right.row)
        const empty = (value: SortValue) => value === null || value === undefined || value === ''
        if (empty(valueA) || empty(valueB)) return compare(valueA, valueB) || left.index - right.index
        return factor * compare(valueA, valueB) || left.index - right.index
      })
      .map((item) => item.row)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- os acessores são definidos a cada render
  }, [rows, sort])
  return { sorted, sort, onSort: (key: string) => setSort((current) => nextSort(current, key)) }
}
