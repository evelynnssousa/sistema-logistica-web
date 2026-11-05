import type { ReactNode } from 'react'
import Icon from './Icon'
import type { IconName } from './Icon'

const alertIcons: Record<AlertTone, IconName> = {
  success: 'success',
  error: 'error',
  warning: 'warning',
  info: 'info',
}

type AlertTone = 'success' | 'error' | 'warning' | 'info'

/** Mensagens com ícone e texto, nunca só com cor. Erros são anunciados de imediato. */
export function Alert({
  tone = 'info',
  children,
  className = '',
}: {
  tone?: AlertTone
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`ui-alert ui-alert-${tone} ${className}`.trim()}
      role={tone === 'error' ? 'alert' : tone === 'success' ? 'status' : undefined}
    >
      <Icon name={alertIcons[tone]} size={20} />
      <div>{children}</div>
    </div>
  )
}

export function EmptyState({
  icon = 'empty',
  title,
  children,
  action,
}: {
  icon?: IconName
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="ui-empty">
      <div className="ui-empty-art" aria-hidden="true">
        <span className="ui-empty-ring" />
        <span className="ui-empty-dot" />
        <Icon name={icon} size={40} weight="duotone" />
      </div>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function Loading({ label = 'Carregando...' }: { label?: string }) {
  return (
    <div className="ui-loading" role="status">
      <span className="ui-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}
