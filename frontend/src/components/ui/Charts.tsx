/**
 * Gráficos sem biblioteca, com uma só série e uma só cor: identidade e valores vêm do texto.
 * Cada valor fica visível ou aparece ao passar o mouse ou focar com o teclado.
 */

export type ChartRow = { label: string; value: number }

export function BarChart({ rows, unit = '', showPercent = false }: { rows: ChartRow[]; unit?: string; showPercent?: boolean }) {
  const maximum = Math.max(1, ...rows.map((row) => row.value))
  const total = rows.reduce((sum, row) => sum + row.value, 0)
  return (
    <ul className="report-bars ui-bars">
      {rows.map((row) => (
        <li className="report-bar" key={row.label}>
          <span className="ui-bar-label">{row.label}</span>
          <span className="report-bar-track" aria-hidden="true">
            <span
              className="report-bar-fill"
              style={{ width: `${Math.max((row.value / maximum) * 100, row.value > 0 ? 1.5 : 0)}%` }}
            />
          </span>
          <strong>
            {row.value.toLocaleString('pt-BR')}
            {unit}
            {showPercent && total > 0 && (
              <span className="ui-bar-percent"> ({((row.value / total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%)</span>
            )}
          </strong>
        </li>
      ))}
    </ul>
  )
}

function monthLabel(month: string) {
  const [year, number] = month.split('-').map(Number)
  return new Date(year, number - 1, 1).toLocaleDateString('pt-BR', {
    month: 'short',
    year: '2-digit',
  })
}

/** Colunas por mês, com linha de base e rótulos só onde cabem. */
export function MonthlyChart({ rows }: { rows: { month: string; total: number }[] }) {
  const maximum = Math.max(1, ...rows.map((row) => row.total))
  const labelEvery = Math.max(1, Math.ceil(rows.length / 8))

  return (
    <div className="ui-columns" role="img" aria-label={rows.map((row) => `${monthLabel(row.month)}: ${row.total}`).join('; ')}>
      {rows.map((row, index) => (
        <div className="ui-column" key={row.month} tabIndex={0} aria-hidden="true">
          <span className="ui-column-tooltip">
            {monthLabel(row.month)}: <strong>{row.total}</strong>
          </span>
          <span className="ui-column-area">
            <span className="ui-column-fill" style={{ height: `${(row.total / maximum) * 100}%` }} />
          </span>
          <span className="ui-column-label">{index % labelEvery === 0 ? monthLabel(row.month) : ''}</span>
        </div>
      ))}
    </div>
  )
}
