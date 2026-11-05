import { communicationLabels, formatDateTime, historyActionLabels, statusLabels } from '../api/modulesApi'
import type { RequestDetail } from '../api/modulesApi'
import Icon from './ui/Icon'
import type { IconName } from './ui/Icon'

type Change = { campo: string; de: string | null; para: string | null }

const actionIcons: Record<string, IconName> = {
  criada: 'add',
  agendada: 'calendar',
  agendamento_alterado: 'calendar',
  reagendada: 'calendar',
  iniciada: 'progress',
  concluida: 'success',
  cancelada: 'error',
  responsavel_alterado: 'users',
  nota_interna: 'requests',
}

function printable(value: string | null) {
  if (value === null) return '(vazio)'
  // Datas em ISO vêm do histórico; o restante é texto.
  return /^\d{4}-\d{2}-\d{2}T/.test(value) ? formatDateTime(value) : value
}

type Item = {
  key: string
  at: string
  icon: IconName
  title: string
  user: string | null
  lines: string[]
  changes: Change[]
}

function buildItems(detail: RequestDetail): Item[] {
  const history: Item[] = detail.history.map((entry) => {
    const changes = Array.isArray(entry.details?.alteracoes) ? (entry.details.alteracoes as Change[]) : []
    const statusLine =
      entry.from !== entry.to && entry.to
        ? `${entry.from ? `${statusLabels[entry.from] ?? entry.from} → ` : ''}${statusLabels[entry.to] ?? entry.to}`
        : null
    return {
      key: `h-${entry.id}`,
      at: entry.at,
      icon: actionIcons[entry.action] ?? 'info',
      title: historyActionLabels[entry.action] ?? entry.action,
      user: entry.user,
      lines: [
        statusLine,
        entry.comment ? `Justificativa ou comentário: ${entry.comment}` : null,
        typeof entry.details?.condicoes === 'string' ? `Condições: ${entry.details.condicoes}` : null,
        Array.isArray(entry.details?.campos) && entry.action.startsWith('devolvida')
          ? `Campos a corrigir: ${(entry.details.campos as string[]).join(', ')}`
          : null,
      ].filter(
        (line): line is string => Boolean(line),
      ),
      changes,
    }
  })

  const communications: Item[] = detail.communications.map((item) => ({
    key: `c-${item.id}`,
    at: item.at,
    icon: item.channel === 'email' ? 'mail' : 'calendar',
    title: item.channel === 'email' ? 'E-mail' : 'Calendário externo',
    user: null,
    lines: [`${communicationLabels[item.status] ?? item.status}${item.simulated ? ' (simulado)' : ''}`],
    changes: [],
  }))

  return [...history, ...communications].sort((first, second) => first.at.localeCompare(second.at))
}

/** Reúne histórico e comunicações. É só leitura: a API não tem rota para alterar esses registros. */
function RequestTimeline({ detail }: { detail: RequestDetail }) {
  const items = buildItems(detail)

  return (
    <section className="admin-data-card detail-card" aria-labelledby="timeline-title">
      <h2 id="timeline-title">Linha do tempo</h2>
      <ol className="request-timeline">
        {items.map((item) => (
          <li key={item.key} data-kind={item.key.startsWith('h-') ? 'history' : 'communication'}>
            <span className="request-timeline-icon">
              <Icon name={item.icon} size={16} />
            </span>
            <div>
              <strong>{item.title}</strong>
              {item.lines.map((line) => (
                <span key={line}>{line}</span>
              ))}
              {item.changes.length > 0 && (
                <ul className="request-timeline-changes">
                  {item.changes.map((change) => (
                    <li key={change.campo}>
                      <b>{change.campo}:</b>{' '}
                      {change.de === null && change.para === null
                        ? 'alterado'
                        : `${printable(change.de)} → ${printable(change.para)}`}
                    </li>
                  ))}
                </ul>
              )}
              <small>
                {item.user ?? 'Sistema'} · {formatDateTime(item.at)}
              </small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

export default RequestTimeline
