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

/**
 * Carregamento em "esqueleto" (13/11/2026): blocos cinza no formato do conteúdo que vai chegar,
 * no lugar do texto solto. O texto continua lá para leitores de tela. "compact" mantém o
 * indicador pequeno, para espaços estreitos.
 */
export function Loading({ label = 'Carregando...', compact = false, rows = 4 }: { label?: string; compact?: boolean; rows?: number }) {
  if (compact) {
    return (
      <div className="ui-loading" role="status">
        <span className="ui-spinner" aria-hidden="true" />
        <span>{label}</span>
      </div>
    )
  }
  return (
    <div className="ui-loading ui-skeleton" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      <span className="ui-skeleton-line ui-skeleton-title" aria-hidden="true" />
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="ui-skeleton-row" aria-hidden="true">
          <span className="ui-skeleton-line ui-skeleton-avatar" />
          <span className="ui-skeleton-line" style={{ width: `${88 - ((index * 17) % 40)}%` }} />
        </span>
      ))}
    </div>
  )
}
