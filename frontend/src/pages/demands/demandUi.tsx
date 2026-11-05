import { Link } from 'react-router-dom'
import { demandPriorityLabels, demandStatusLabels } from '../../api/demandsApi'
import type { DemandSummary } from '../../api/demandsApi'
import { formatCalendarDate } from '../../api/modulesApi'
import Icon from '../../components/ui/Icon'
import StatusBadge from '../../components/ui/StatusBadge'

/** Peças pequenas repetidas nas telas do módulo. */

export function PriorityTag({ priority }: { priority: string }) {
  return (
    <span className={`demand-priority demand-priority-${priority}`}>
      {(priority === 'urgente' || priority === 'alta') && <Icon name="attention" size={14} />}
      {demandPriorityLabels[priority] ?? priority}
    </span>
  )
}

export function DueLabel({ demand }: { demand: Pick<DemandSummary, 'dueDate' | 'overdue' | 'dueSoon'> }) {
  if (!demand.dueDate) return <span className="demand-muted">Sem prazo</span>
  return (
    <span className={`demand-due${demand.overdue ? ' is-overdue' : demand.dueSoon ? ' is-soon' : ''}`}>
      {formatCalendarDate(demand.dueDate)}
      {demand.overdue && ' · Atrasada'}
      {!demand.overdue && demand.dueSoon && ' · Vence em breve'}
    </span>
  )
}

export function DemandFlags({ demand }: { demand: Pick<DemandSummary, 'restricted' | 'recurring' | 'shared' | 'draft'> }) {
  return (
    <span className="demand-flags">
      {demand.draft && <span className="demand-flag">Rascunho</span>}
      {demand.restricted && (
        <span className="demand-flag">
          <Icon name="locked" size={13} />
          Restrita
        </span>
      )}
      {demand.recurring && (
        <span className="demand-flag">
          <Icon name="repeat" size={13} />
          Recorrente
        </span>
      )}
      {demand.shared && (
        <span className="demand-flag">
          <Icon name="users" size={13} />
          Compartilhada
        </span>
      )}
    </span>
  )
}

export function DemandStatusBadge({ status }: { status: DemandSummary['status'] }) {
  return <StatusBadge status={`demanda_${status}`} label={demandStatusLabels[status]} />
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  return (
    <span className="demand-progress" role="img" aria-label={label ?? `${value}% concluído`}>
      <span className="demand-progress-track" aria-hidden="true">
        <span className="demand-progress-fill" style={{ width: `${value}%` }} />
      </span>
      <small>{value}%</small>
    </span>
  )
}

/** Lista curta do painel: uma linha por demanda, sempre com número, situação e prazo. */
export function DemandMiniList({ demands, empty }: { demands: DemandSummary[]; empty: string }) {
  if (demands.length === 0) return <p className="demand-muted">{empty}</p>
  return (
    <ul className="demand-mini-list">
      {demands.map((demand) => (
        <li key={demand.id}>
          <Link to={`/demandas/${demand.id}`}>
            <strong>{demand.title}</strong>
            <span>
              {demand.number} · {demand.responsible ?? 'Sem responsável'}
            </span>
          </Link>
          <DueLabel demand={demand} />
        </li>
      ))}
    </ul>
  )
}
