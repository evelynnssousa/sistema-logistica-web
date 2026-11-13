import Icon from './ui/Icon'
import type { IconName } from './ui/Icon'

type StatCardProps = {
  icon: IconName
  tone: 'black' | 'yellow' | 'white' | 'graphite'
  label: string
  value: string
  description: string
  /** Comparação com o período anterior. "good" diz se subir é bom (verde) ou ruim (vermelho). */
  trend?: { percent: number | null; good: 'up' | 'down' } | null
}

function trendText(percent: number) {
  if (percent === 0) return '= igual ao período anterior'
  const value = Math.abs(percent).toLocaleString('pt-BR', { maximumFractionDigits: 1 })
  return `${percent > 0 ? '▲' : '▼'} ${value}% em relação ao período anterior`
}

function StatCard({ icon, tone, label, value, description, trend }: StatCardProps) {
  return (
    <article className={`stat-card ui-metric ui-metric-${tone}`}>
      <span className="ui-metric-icon">
        <Icon name={icon} size={26} weight="duotone" />
      </span>
      <p className="ui-metric-label">{label}</p>
      <div className="ui-metric-value">{value}</div>
      <p className="ui-metric-description">{description}</p>
      {trend && trend.percent !== null && (
        <p
          className={`ui-metric-trend ${
            trend.percent === 0 ? '' : (trend.percent > 0) === (trend.good === 'up') ? 'ui-metric-trend-good' : 'ui-metric-trend-bad'
          }`}
        >
          {trendText(trend.percent)}
        </p>
      )}
    </article>
  )
}

export default StatCard
