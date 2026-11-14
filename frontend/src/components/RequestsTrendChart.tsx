import { LineChart, MonthlyChart } from './ui/Charts'

type ModuleCounts = Record<string, number>

const lines = [
  { key: 'maintenance', label: 'Manutenção', color: '#2a78d6' },
  { key: 'fleet', label: 'Frota', color: '#eb6834' },
  { key: 'flights', label: 'Passagens', color: '#1baf7a' },
]

/**
 * Solicitações ao longo do tempo, igual no Dashboard e nos Relatórios (14/11/2026). Dois meses ou
 * mais: uma linha por módulo, mês a mês. Um mês só: as mesmas linhas, dia a dia. Sem pontos
 * suficientes para uma linha (por exemplo, no dia 1), as colunas do mês.
 */
function RequestsTrendChart({
  headingId,
  byPeriod,
  byDay,
}: {
  headingId: string
  byPeriod: { month: string; total: number; byModule?: ModuleCounts }[]
  byDay?: { day: string; total: number; byModule: ModuleCounts }[] | null
}) {
  const monthly = byPeriod.length > 1 && Boolean(byPeriod[0].byModule)
  const points = monthly
    ? byPeriod.map((row) => ({ key: row.month, byModule: row.byModule ?? {} }))
    : (byDay ?? []).map((row) => ({ key: row.day, byModule: row.byModule }))
  const series = lines
    .map((line) => ({ ...line, values: points.map((point) => point.byModule[line.key] ?? 0) }))
    // Módulo sem nenhum registro no período não ganha linha zerada.
    .filter((line) => line.values.some((value) => value > 0))
  const daily = !monthly && points.length > 1 && series.length > 0
  const monthName = byPeriod[0]
    ? new Date(`${byPeriod[0].month}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
    : ''

  return (
    <>
      <h2 id={headingId}>{daily ? `Solicitações por dia · ${monthName}` : 'Solicitações por mês'}</h2>
      {(monthly || daily) && series.length > 0 ? (
        <LineChart months={points.map((point) => point.key)} series={series} granularity={daily ? 'day' : 'month'} />
      ) : (
        <MonthlyChart rows={byPeriod} />
      )}
    </>
  )
}

export default RequestsTrendChart
