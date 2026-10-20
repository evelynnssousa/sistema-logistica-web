type StatCardProps = {
  icon: string
  tone: 'blue' | 'orange' | 'green' | 'purple'
  tag: string
  label: string
  value: string
  description: string
}

function StatCard({
  icon,
  tone,
  tag,
  label,
  value,
  description,
}: StatCardProps) {
  return (
    <article className="stat-card">
      <div className="stat-top">
        <span className={`stat-icon ${tone}`} aria-hidden="true">
          {icon}
        </span>
        <span className="stat-tag">{tag}</span>
      </div>
      <p className="stat-label">{label}</p>
      <div className="stat-value">{value}</div>
      <p className="stat-description">{description}</p>
    </article>
  )
}

export default StatCard
