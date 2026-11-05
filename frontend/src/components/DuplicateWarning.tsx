import { formatDate, modulePaths, protocolLabel, statusLabels } from '../api/modulesApi'
import type { PossibleDuplicate, RequestModule } from '../api/modulesApi'
import { Alert } from './ui/Feedback'

function DuplicateWarning({
  module,
  duplicates,
  onConfirm,
  onDismiss,
}: {
  module: RequestModule
  duplicates: PossibleDuplicate[]
  onConfirm: () => void
  onDismiss: () => void
}) {
  if (duplicates.length === 0) return null
  return (
    <div className="duplicate-warning" data-testid="duplicate-warning">
      <Alert tone="warning">
        <strong>Encontramos solicitações parecidas em aberto.</strong> Confira se a sua já foi registrada. Demandas
        semelhantes podem ser legítimas: você decide se envia.
      </Alert>
      <ul>
        {duplicates.map((item, index) => (
          <li key={item.id ?? index}>
            {item.canOpen ? (
              <a href={`${modulePaths[module]}/${item.id}`} target="_blank" rel="noreferrer">
                {protocolLabel(item.protocol ?? '')}: {item.title}
              </a>
            ) : (
              'Solicitação de outra pessoa, sem acesso aos detalhes'
            )}{' '}
            ({statusLabels[item.status] ?? item.status}, aberta em {formatDate(item.createdAt)}). {item.reasons.join(', ')}.
          </li>
        ))}
      </ul>
      <div className="duplicate-warning-actions">
        <button type="button" className="maintenance-primary-button" onClick={onConfirm}>
          Enviar mesmo assim
        </button>
        <button type="button" className="maintenance-secondary-button" onClick={onDismiss}>
          Voltar a editar
        </button>
      </div>
    </div>
  )
}

export default DuplicateWarning
