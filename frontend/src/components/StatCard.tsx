import Icon from './ui/Icon'
import type { IconName } from './ui/Icon'

type StatCardProps = {
  icon: IconName
  tone: 'black' | 'yellow' | 'white' | 'graphite'
  label: string
  value: string
  description: string
}

function StatCard({ icon, tone, label, value, description }: StatCardProps) {
  return (
    <article className={`stat-card ui-metric ui-metric-${tone}`}>
      <span className="ui-metric-icon">
        <Icon name={icon} size={26} weight="duotone" />
      </span>
      <p className="ui-metric-label">{label}</p>
      <div className="ui-metric-value">{value}</div>
      <p className="ui-metric-description">{description}</p>
    </article>
  )
}

export default StatCard
