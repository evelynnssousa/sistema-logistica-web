import { useState } from 'react'

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

/** Dia no formato 14/11. */
function dayLabel(day: string) {
  const [, month, date] = day.split('-')
  return `${date}/${month}`
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

export type LineSeries = { key: string; label: string; color: string; values: number[] }

/**
 * Linhas por mês (13/11/2026): uma linha por módulo, com legenda, nome no fim de cada linha,
 * linha vertical e valores ao passar o mouse ou focar com o teclado, e a mesma informação em
 * tabela. Um só eixo. Cores na ordem fixa da paleta validada (azul, laranja, verde-água).
 */
export function LineChart({ months, series, granularity = 'month' }: { months: string[]; series: LineSeries[]; granularity?: 'month' | 'day' }) {
  // Mês a mês ou, com um mês só de dados, dia a dia (14/11/2026).
  const labelOf = granularity === 'day' ? dayLabel : monthLabel
  const unit = granularity === 'day' ? 'dia' : 'mês'
  const [active, setActive] = useState<number | null>(null)
  const width = 640
  const height = 240
  const pad = { top: 16, right: 96, bottom: 28, left: 36 }
  const plotWidth = width - pad.left - pad.right
  const plotHeight = height - pad.top - pad.bottom
  const maximum = Math.max(1, ...series.flatMap((line) => line.values))
  const step = niceStep(maximum)
  const top = Math.ceil(maximum / step) * step
  const x = (index: number) => pad.left + (months.length === 1 ? plotWidth / 2 : (index / (months.length - 1)) * plotWidth)
  const y = (value: number) => pad.top + plotHeight - (value / top) * plotHeight
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step)
  const labelEvery = Math.max(1, Math.ceil(months.length / 8))

  // Nomes no fim das linhas, afastados para não se sobreporem.
  const ends = series
    .map((line) => ({ line, y: y(line.values[line.values.length - 1] ?? 0) }))
    .sort((a, b) => a.y - b.y)
  for (let index = 1; index < ends.length; index += 1) {
    if (ends[index].y - ends[index - 1].y < 14) ends[index].y = ends[index - 1].y + 14
  }

  return (
    <div className="ui-line-chart">
      <ul className="ui-legend" aria-label="Legenda">
        {series.map((line) => (
          <li key={line.key}>
            <span className="ui-legend-swatch" style={{ background: line.color }} aria-hidden="true" />
            {line.label}
          </li>
        ))}
      </ul>
      <div className="ui-line-plot">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Solicitações por ${unit} e por módulo, de ${labelOf(months[0])} a ${labelOf(months[months.length - 1])}. Os valores estão na tabela abaixo.`}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="ui-line-grid" x1={pad.left} x2={pad.left + plotWidth} y1={y(tick)} y2={y(tick)} />
              <text className="ui-line-axis" x={pad.left - 8} y={y(tick) + 4} textAnchor="end">
                {tick}
              </text>
            </g>
          ))}
          {months.map((month, index) =>
            index % labelEvery === 0 ? (
              <text key={month} className="ui-line-axis" x={x(index)} y={height - 8} textAnchor="middle">
                {labelOf(month)}
              </text>
            ) : null,
          )}
          {active !== null && <line className="ui-line-crosshair" x1={x(active)} x2={x(active)} y1={pad.top} y2={pad.top + plotHeight} />}
          {series.map((line) => (
            <g key={line.key}>
              <polyline
                fill="none"
                stroke={line.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={line.values.map((value, index) => `${x(index)},${y(value)}`).join(' ')}
              />
              {line.values.map((value, index) =>
                active === index || line.values.length === 1 ? (
                  <circle key={index} cx={x(index)} cy={y(value)} r={4.5} fill={line.color} stroke="var(--surface)" strokeWidth={2} />
                ) : null,
              )}
            </g>
          ))}
          {ends.map(({ line, y: labelY }) => (
            <text key={line.key} className="ui-line-end" x={x(months.length - 1) + 8} y={labelY + 4}>
              {line.label}
            </text>
          ))}
          {months.map((month, index) => (
            <rect
              key={month}
              className="ui-line-hit"
              x={x(index) - plotWidth / Math.max(1, months.length - 1) / 2}
              y={pad.top}
              width={plotWidth / Math.max(1, months.length - 1)}
              height={plotHeight}
              tabIndex={0}
              aria-label={`${labelOf(month)}: ${series.map((line) => `${line.label} ${line.values[index]}`).join(', ')}`}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
            />
          ))}
        </svg>
        {active !== null && (
          <div
            className="ui-line-tooltip"
            // Perto da borda direita, a caixa abre para a esquerda, sem cobrir os nomes das linhas.
            style={{
              left: `${(x(active) / width) * 100}%`,
              transform: x(active) / width > 0.6 ? 'translateX(calc(-100% - 12px))' : 'translateX(-50%)',
            }}
            role="status"
          >
            <strong>{labelOf(months[active])}</strong>
            {series.map((line) => (
              <span key={line.key}>
                <span className="ui-legend-swatch" style={{ background: line.color }} aria-hidden="true" />
                {line.label}: <b>{line.values[active]}</b>
              </span>
            ))}
          </div>
        )}
      </div>
      <details className="ui-line-table">
        <summary>Ver em tabela</summary>
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>{granularity === 'day' ? 'Dia' : 'Mês'}</th>
                {series.map((line) => (
                  <th key={line.key}>{line.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {months.map((month, index) => (
                <tr key={month}>
                  <td>{labelOf(month)}</td>
                  {series.map((line) => (
                    <td key={line.key}>{line.values[index]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

/** Passo das linhas de grade: 1, 2 ou 5 vezes uma potência de 10, para 3 a 5 linhas. */
function niceStep(maximum: number) {
  const rough = maximum / 4
  const power = 10 ** Math.floor(Math.log10(Math.max(rough, 1)))
  const unit = [1, 2, 5, 10].find((candidate) => candidate * power >= rough) ?? 10
  return Math.max(1, unit * power)
}
