/**
 * Ordena um lote retirado da fila pela próxima tentativa, a mais antiga primeiro, e pelo id no
 * empate. O PostgreSQL não garante a ordem das linhas de um UPDATE ... RETURNING, mesmo quando a
 * seleção interna usa ORDER BY.
 */
export function byNextAttempt<T extends { id: string }>(rows: readonly T[], nextAttemptOf: (row: T) => Date): T[] {
  return [...rows].sort(
    (a, b) => new Date(nextAttemptOf(a)).getTime() - new Date(nextAttemptOf(b)).getTime() || a.id.localeCompare(b.id),
  )
}
