import { useEffect, useRef, useState } from 'react'

/**
 * Gráficos sem biblioteca, com uma só série e uma só cor: identidade e valores vêm do texto.
 * Cada valor fica visível ou aparece ao passar o mouse ou focar com o teclado.
 */

export type ChartRow = {
  label: string
  value: number
  /** Cor do módulo ou da situação (app/chartColors.ts). Sem cor, a cor padrão. */
  color?: string
}

export function BarChart({
  rows,
  unit = '',
  showPercent = false,
  sorted = false,
}: {
  rows: ChartRow[]
  unit?: string
  showPercent?: boolean
  /** Da maior para a menor. */
  sorted?: boolean
}) {
  const maximum = Math.max(1, ...rows.map((row) => row.value))
  const total = rows.reduce((sum, row) => sum + row.value, 0)
  const shown = sorted ? [...rows].sort((a, b) => b.value - a.value) : rows
  return (
    <ul className="report-bars ui-bars">
      {shown.map((row) => (
        <li className="report-bar" key={row.label}>
          <span className="ui-bar-label">{row.label}</span>
          <span className="report-bar-track" aria-hidden="true">
            <span
              className="report-bar-fill"
              style={{
                width: `${Math.max((row.value / maximum) * 100, row.value > 0 ? 1.5 : 0)}%`,
                ...(row.color ? { background: row.color } : {}),
              }}
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

/** Retângulo com os cantos de cima arredondados: o topo da coluna (a base fica reta, no eixo). */
function topRounded(x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height)
  return `M${x},${y + height} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height} Z`
}

/**
 * Colunas empilhadas por módulo (14/11/2026), no lugar das linhas: a altura é o total do mês ou do
 * dia, e cada cor é um módulo. Nada se esconde atrás de nada, como acontecia com linhas iguais.
 * Legenda, valores ao passar o mouse ou com as setas do teclado, total escrito na coluna mais alta
 * e a mesma informação em tabela.
 */
export function StackedColumnChart({
  periods,
  series,
  granularity = 'month',
}: {
  periods: string[]
  series: LineSeries[]
  granularity?: 'month' | 'day'
}) {
  const labelOf = granularity === 'day' ? dayLabel : monthLabel
  const unit = granularity === 'day' ? 'dia' : 'mês'
  const [active, setActive] = useState<number | null>(null)
  // Desenhado na largura real do cartão: no celular as letras não encolhem junto com o gráfico.
  const plot = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(560)
  useEffect(() => {
    const element = plot.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const measured = Math.round(entry.contentRect.width)
      if (measured > 0) setWidth(measured)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const height = width < 480 ? 200 : 240
  const pad = { top: 22, right: 8, bottom: 28, left: 32 }
  const plotWidth = width - pad.left - pad.right
  const plotHeight = height - pad.top - pad.bottom
  const totals = periods.map((_, index) => series.reduce((sum, line) => sum + (line.values[index] ?? 0), 0))
  const maximum = Math.max(1, ...totals)
  const step = niceStep(maximum)
  const top = Math.ceil(maximum / step) * step
  const band = plotWidth / Math.max(1, periods.length)
  const columnWidth = Math.max(3, Math.min(48, band * 0.62))
  const x = (index: number) => pad.left + band * index + (band - columnWidth) / 2
  const y = (value: number) => pad.top + plotHeight - (value / top) * plotHeight
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step)
  // Um rótulo a cada ~52 px, para as datas não se encostarem.
  const labelEvery = Math.max(1, Math.ceil(periods.length / Math.max(2, Math.floor(plotWidth / 52))))
  const peak = totals.indexOf(Math.max(...totals))
  const gap = 2

  return (
    <div className="ui-line-chart ui-stacked-chart">
      {series.length > 1 && (
        <ul className="ui-legend" aria-label="Legenda">
          {series.map((line) => (
            <li key={line.key}>
              <span className="ui-legend-swatch ui-legend-block" style={{ background: line.color }} aria-hidden="true" />
              {line.label}
            </li>
          ))}
        </ul>
      )}
      <div className="ui-line-plot" ref={plot}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          tabIndex={0}
          className="ui-line-svg"
          aria-label={`Solicitações por ${unit} e por módulo, de ${labelOf(periods[0])} a ${labelOf(periods[periods.length - 1])}. Use as setas para ver cada ${unit}. Os valores também estão na tabela abaixo.`}
          onFocus={() => setActive((current) => current ?? periods.length - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            setActive((current) => {
              const start = current ?? periods.length - 1
              return Math.min(periods.length - 1, Math.max(0, start + (event.key === 'ArrowRight' ? 1 : -1)))
            })
          }}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="ui-line-grid" x1={pad.left} x2={pad.left + plotWidth} y1={y(tick)} y2={y(tick)} />
              <text className="ui-line-axis" x={pad.left - 8} y={y(tick) + 4} textAnchor="end">
                {tick}
              </text>
            </g>
          ))}
          {periods.map((period, index) =>
            index % labelEvery === 0 ? (
              <text key={period} className="ui-line-axis" x={x(index) + columnWidth / 2} y={height - 8} textAnchor="middle">
                {labelOf(period)}
              </text>
            ) : null,
          )}
          {periods.map((period, index) => {
            let base = 0
            const filled = series.filter((line) => (line.values[index] ?? 0) > 0)
            return (
              <g key={period} className={active !== null && active !== index ? 'ui-stack-dim' : undefined}>
                {filled.map((line, position) => {
                  const value = line.values[index]
                  const bottom = y(base)
                  const topY = y(base + value)
                  base += value
                  // 2 px de fundo entre os pedaços; o de cima tem os cantos arredondados.
                  const segment = Math.max(1, bottom - topY - (position > 0 ? gap : 0))
                  return position === filled.length - 1 ? (
                    <path key={line.key} d={topRounded(x(index), topY, columnWidth, segment, 4)} fill={line.color} />
                  ) : (
                    <rect key={line.key} x={x(index)} y={topY} width={columnWidth} height={segment} fill={line.color} />
                  )
                })}
              </g>
            )
          })}
          {totals[peak] > 0 && (active === null || active === peak) && (
            <text className="ui-line-end" x={x(peak) + columnWidth / 2} y={y(totals[peak]) - 6} textAnchor="middle">
              {totals[peak]}
            </text>
          )}
          {periods.map((period, index) => (
            <rect
              key={period}
              className="ui-line-hit"
              x={pad.left + band * index}
              y={pad.top}
              width={band}
              height={plotHeight}
              aria-hidden="true"
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
            />
          ))}
        </svg>
        {active !== null && (
          <div
            className="ui-line-tooltip"
            style={{
              left: `${((x(active) + columnWidth / 2) / width) * 100}%`,
              transform: (x(active) + columnWidth / 2) / width > 0.6 ? 'translateX(calc(-100% - 12px))' : 'translateX(-50%)',
            }}
            role="status"
          >
            <strong>
              {labelOf(periods[active])}: {totals[active]} {totals[active] === 1 ? 'solicitação' : 'solicitações'}
            </strong>
            {[...series].reverse().map((line) => (
              <span key={line.key}>
                <span className="ui-legend-swatch ui-legend-block" style={{ background: line.color }} aria-hidden="true" />
                {line.label}: <b>{line.values[active] ?? 0}</b>
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
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((period, index) => (
                <tr key={period}>
                  <td>{labelOf(period)}</td>
                  {series.map((line) => (
                    <td key={line.key}>{line.values[index] ?? 0}</td>
                  ))}
                  <td>{totals[index]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

/** Legenda solta, para as barras coloridas pela situação. */
export function ChartLegend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="ui-legend" aria-label="Legenda das cores">
      {items.map((item) => (
        <li key={item.label}>
          <span className="ui-legend-swatch ui-legend-block" style={{ background: item.color }} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  )
}

/** Passo das linhas de grade: 1, 2 ou 5 vezes uma potência de 10, para 3 a 5 linhas. */
function niceStep(maximum: number) {
  const rough = maximum / 4
  const power = 10 ** Math.floor(Math.log10(Math.max(rough, 1)))
  const unit = [1, 2, 5, 10].find((candidate) => candidate * power >= rough) ?? 10
  return Math.max(1, unit * power)
}
