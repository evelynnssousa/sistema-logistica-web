import Icon from './Icon'
import type { IconName } from './Icon'

type Tone = 'neutral' | 'waiting' | 'scheduled' | 'progress' | 'success' | 'danger'

// Cor, ícone e texto juntos: a situação nunca depende só da cor.
const toneByStatus: Record<string, Tone> = {
  aguardando_agendamento: 'waiting',
  agendado: 'scheduled',
  reagendado: 'scheduled',
  em_andamento: 'progress',
  concluido: 'success',
  cancelado: 'danger',
  em_cotacao: 'waiting',
  aguardando_aprovacao: 'waiting',
  em_emissao: 'progress',
  emitida: 'success',
  cancelada: 'danger',
  pendente: 'waiting',
  em_analise: 'progress',
  atendido_parcial: 'scheduled',
  atendido: 'success',
  entregue: 'success',
  aguardando_entrega: 'waiting',
  entrega_reagendada: 'scheduled',
  rejeitado: 'danger',
  em_andamento_conferencia: 'progress',
  concluida: 'success',
  success: 'success',
  failure: 'danger',
  denied: 'danger',
  demanda_nao_iniciada: 'neutral',
  demanda_em_andamento: 'progress',
  demanda_aguardando_terceiros: 'waiting',
  demanda_aguardando_autorizacao: 'waiting',
  demanda_suspensa: 'neutral',
  demanda_concluida: 'success',
  demanda_cancelada: 'danger',
}

const iconByTone: Record<Tone, IconName> = {
  neutral: 'info',
  waiting: 'waiting',
  scheduled: 'calendar',
  progress: 'progress',
  success: 'success',
  danger: 'error',
}

function StatusBadge({
  status,
  label,
  className = '',
}: {
  status: string
  label: string
  className?: string
}) {
  const tone = toneByStatus[status] ?? 'neutral'
  return (
    <span className={`ui-badge ui-badge-${tone} ${className}`.trim()} data-status={status}>
      <Icon name={iconByTone[tone]} size={15} />
      {label}
    </span>
  )
}

export default StatusBadge
