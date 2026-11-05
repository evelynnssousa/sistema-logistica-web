import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  protocolLabel,
  closeInventoryCheck,
  errorMessage,
  getInventoryCheck,
  updateInventoryItem,
} from '../api/modulesApi'
import type { InventoryCheck } from '../api/modulesApi'
import { Alert, Loading } from '../components/ui/Feedback'
import Icon from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'
import StatusBadge from '../components/ui/StatusBadge'

const situationLabels = {
  pendente: 'Pendente',
  confere: 'Confere',
  divergente: 'Divergente',
}

const statusLabels: Record<string, string> = {
  em_andamento: 'Em andamento',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
}

type Draft = { government: string; counted: string; note: string }

function InventoryCheckPage() {
  const { checkId = '' } = useParams()
  const [check, setCheck] = useState<InventoryCheck | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [comment, setComment] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const apply = useCallback((data: InventoryCheck) => {
    setCheck(data)
    setDrafts(
      Object.fromEntries(
        data.items.map((item) => [
          item.materialId,
          {
            government: String(item.governmentQuantity),
            counted: item.countedQuantity === null ? '' : String(item.countedQuantity),
            note: item.note ?? '',
          },
        ]),
      ),
    )
  }, [])

  useEffect(() => {
    let active = true
    getInventoryCheck(checkId)
      .then((data) => {
        if (active) apply(data.check)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar a conferência.'))
      })
    return () => {
      active = false
    }
  }, [checkId, apply])

  async function run(action: () => Promise<unknown>, success: string) {
    setError('')
    setNotice('')
    try {
      await action()
      apply((await getInventoryCheck(checkId)).check)
      setNotice(success)
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível concluir a ação.'))
    }
  }

  if (!check) {
    return error ? <Alert tone="error">{error}</Alert> : <Loading label="Carregando conferência..." />
  }

  const open = check.status === 'em_andamento'
  const updateDraft = (materialId: string, change: Partial<Draft>) =>
    setDrafts((current) => ({ ...current, [materialId]: { ...current[materialId], ...change } }))

  return (
    <div className="admin-module-page">
      <PageHeader
        eyebrow={`Conferência ${protocolLabel(check.protocol)}`}
        title={check.title}
        description={`Data de referência: ${check.referenceDate.split('-').reverse().join('/')}`}
        actions={
          <>
            <StatusBadge
              className="detail-status"
              status={check.status === 'em_andamento' ? 'em_andamento_conferencia' : check.status}
              label={statusLabels[check.status]}
            />
            <Link className="maintenance-secondary-button" to="/almoxarifado/inventario">
              <Icon name="back" size={18} weight="bold" />
              Voltar
            </Link>
          </>
        }
      />

      <p className="module-notice">
        A quantidade do sistema governamental é digitada aqui. O JUCESP não a consulta nem a altera
        automaticamente.
      </p>
      {check.note && <p>{check.note}</p>}
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <section className="ui-card ui-stacked">
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Material</th>
                <th>Sistema governamental</th>
                <th>Contagem interna</th>
                <th>Diferença</th>
                <th>Situação</th>
                <th>Observação</th>
                {open && <th>Ações</th>}
              </tr>
            </thead>
            <tbody>
              {check.items.map((item) => {
                const draft = drafts[item.materialId]
                return (
                  <tr key={item.materialId}>
                    <td>
                      {item.material} ({item.unit})
                    </td>
                    <td>
                      {open ? (
                        <input
                          aria-label={`Quantidade governamental de ${item.material}`}
                          type="number"
                          min="0"
                          step="0.01"
                          value={draft?.government ?? ''}
                          onChange={(event) => updateDraft(item.materialId, { government: event.target.value })}
                        />
                      ) : (
                        item.governmentQuantity
                      )}
                    </td>
                    <td>
                      {open ? (
                        <input
                          aria-label={`Contagem de ${item.material}`}
                          type="number"
                          min="0"
                          step="0.01"
                          value={draft?.counted ?? ''}
                          onChange={(event) => updateDraft(item.materialId, { counted: event.target.value })}
                        />
                      ) : (
                        (item.countedQuantity ?? '—')
                      )}
                    </td>
                    <td>{item.difference ?? '—'}</td>
                    <td>
                      <StatusBadge
                        status={item.situation === 'confere' ? 'success' : item.situation === 'divergente' ? 'failure' : 'pendente'}
                        label={situationLabels[item.situation]}
                      />
                    </td>
                    <td>
                      {open ? (
                        <input
                          aria-label={`Observação de ${item.material}`}
                          maxLength={500}
                          value={draft?.note ?? ''}
                          onChange={(event) => updateDraft(item.materialId, { note: event.target.value })}
                        />
                      ) : (
                        (item.note ?? '—')
                      )}
                    </td>
                    {open && (
                      <td>
                        <button
                          type="button"
                          onClick={() =>
                            void run(
                              () =>
                                updateInventoryItem(check.id, item.materialId, {
                                  governmentQuantity: draft.government,
                                  countedQuantity: draft.counted === '' ? null : draft.counted,
                                  note: draft.note,
                                }),
                              `${item.material}: contagem salva.`,
                            )
                          }
                        >
                          Salvar
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {open && (
        <section className="detail-action detail-card">
          <h3>Encerrar conferência</h3>
          <label className="maintenance-form-field">
            <span>Comentário (obrigatório para cancelar)</span>
            <textarea rows={2} value={comment} onChange={(event) => setComment(event.target.value)} />
          </label>
          <button
            className="maintenance-primary-button"
            type="button"
            onClick={() =>
              void run(() => closeInventoryCheck(check.id, 'concluida', comment), 'Conferência concluída.')
            }
          >
            Concluir conferência
          </button>
          <button
            className="maintenance-secondary-button"
            type="button"
            onClick={() =>
              void run(() => closeInventoryCheck(check.id, 'cancelada', comment), 'Conferência cancelada.')
            }
          >
            Cancelar conferência
          </button>
        </section>
      )}
    </div>
  )
}

export default InventoryCheckPage
