import { moduleColors } from '../app/chartColors'
import { MonthlyChart, StackedColumnChart } from './ui/Charts'

type ModuleCounts = Record<string, number>

const modules = [
  { key: 'maintenance', label: 'Manutenção' },
  { key: 'fleet', label: 'Frota' },
  { key: 'flights', label: 'Passagens' },
]

const number = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })

/**
 * Solicitações ao longo do tempo, igual no Dashboard e nos Relatórios (14/11/2026). Colunas
 * empilhadas por módulo: mês a mês ou, com um mês só, dia a dia. Em cima, o resumo do período:
 * total, média, pico e, quando há o período anterior, a variação.
 */
function RequestsTrendChart({
  headingId,
  byPeriod,
  byDay,
  previousTotal,
}: {
  headingId: string
  byPeriod: { month: string; total: number; byModule?: ModuleCounts }[]
  byDay?: { day: string; total: number; byModule: ModuleCounts }[] | null
  /** Total do período anterior, do mesmo tamanho. Sem ele, não há comparação. */
  previousTotal?: number | null
}) {
  const monthly = byPeriod.length > 1 && Boolean(byPeriod[0].byModule)
  const points = monthly
    ? byPeriod.map((row) => ({ key: row.month, byModule: row.byModule ?? {} }))
    : (byDay ?? []).map((row) => ({ key: row.day, byModule: row.byModule }))
  const series = modules
    .map((module) => ({ ...module, color: moduleColors[module.key], values: points.map((point) => point.byModule[module.key] ?? 0) }))
    // Módulo sem nenhum registro no período não entra na legenda.
    .filter((line) => line.values.some((value) => value > 0))
  const daily = !monthly && points.length > 1 && series.length > 0
  const monthName = byPeriod[0]
    ? new Date(`${byPeriod[0].month}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
    : ''

  const total = byPeriod.reduce((sum, row) => sum + row.total, 0)
  const totals = points.map((point) => Object.values(point.byModule).reduce((sum, value) => sum + value, 0))
  const peakIndex = totals.indexOf(Math.max(0, ...totals))
  const unit = daily ? 'dia' : 'mês'
  const peakLabel =
    peakIndex >= 0 && totals[peakIndex] > 0
      ? daily
        ? points[peakIndex].key.split('-').reverse().slice(0, 2).join('/')
        : new Date(`${points[peakIndex].key}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' })
      : null
  const change =
    previousTotal !== undefined && previousTotal !== null && previousTotal > 0
      ? Math.round(((total - previousTotal) / previousTotal) * 1000) / 10
      : null

  return (
    <>
      <h2 id={headingId}>{daily ? `Solicitações por dia · ${monthName}` : 'Solicitações por mês'}</h2>
      <p className="ui-trend-summary">
        <strong>
          {total.toLocaleString('pt-BR')} {total === 1 ? 'solicitação' : 'solicitações'} no período
        </strong>
        {points.length > 1 && <> · média de {number(total / points.length)} por {unit}</>}
        {peakLabel && points.length > 1 && <> · pico em {peakLabel} ({totals[peakIndex]})</>}
        {change !== null && (
          <>
            {' · '}
            <span className={change > 0 ? 'ui-trend-change-good' : change < 0 ? 'ui-trend-change-bad' : undefined}>
              {change > 0 ? '▲' : change < 0 ? '▼' : '='} {number(Math.abs(change))}%
            </span>{' '}
            em relação ao período anterior
          </>
        )}
      </p>
      {(monthly || daily) && series.length > 0 ? (
        <StackedColumnChart periods={points.map((point) => point.key)} series={series} granularity={daily ? 'day' : 'month'} />
      ) : (
        <MonthlyChart rows={byPeriod} />
      )}
    </>
  )
}

export default RequestsTrendChart
