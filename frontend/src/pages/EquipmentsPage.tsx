import { useManagedForm } from '../app/useManagedForm'
import { ExtraFields } from '../components/ExtraFields'
import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { errorMessage, formatDateTime, modulePaths, protocolLabel } from '../api/modulesApi'
import { createEquipment, getEquipmentHistory, listEquipments, updateEquipment } from '../api/operationsApi'
import type { Equipment, Execution } from '../api/operationsApi'
import { useHasPermission } from '../auth/UserContext'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import Icon from '../components/ui/Icon'
import Modal from '../components/ui/Modal'
import PageHeader from '../components/ui/PageHeader'

/** Cadastro opcional: atendimentos continuam podendo ser registrados sem equipamento. */
function EquipmentsPage() {
  const canManage = useHasPermission('maintenance:manage')
  const [equipments, setEquipments] = useState<Equipment[] | null>(null)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [identification, setIdentification] = useState('')
  const [location, setLocation] = useState('')
  const equipmentForm = useManagedForm('equipment')
  const [extra, setExtra] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState('')
  const [history, setHistory] = useState<{ equipment: Equipment; executions: Execution[] } | null>(null)

  const load = useCallback(async () => {
    try {
      setEquipments((await listEquipments(true)).equipments)
      setError('')
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível carregar os equipamentos.'))
    }
  }, [])

  useEffect(() => {
    let active = true
    listEquipments(true)
      .then((data) => {
        if (active) setEquipments(data.equipments)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os equipamentos.'))
      })
    return () => {
      active = false
    }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setFormError('')
    try {
      await createEquipment({ nome: name, identificacao: identification, local: location, customFields: extra })
      setExtra({})
      setName('')
      setIdentification('')
      setLocation('')
      await load()
    } catch (err) {
      setFormError(errorMessage(err, 'Não foi possível cadastrar o equipamento.'))
    }
  }

  async function toggle(equipment: Equipment) {
    setError('')
    try {
      await updateEquipment(equipment.id, {
        nome: equipment.name,
        identificacao: equipment.identification,
        local: equipment.location,
        ativo: !equipment.active,
      })
      await load()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível alterar o equipamento.'))
    }
  }

  async function openHistory(equipment: Equipment) {
    setError('')
    try {
      const { executions } = await getEquipmentHistory(equipment.id)
      setHistory({ equipment, executions })
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível carregar o histórico.'))
    }
  }

  return (
    <div className="admin-module-page equipments-page">
      <PageHeader
        title="Equipamentos e locais"
        description="Cadastro opcional, para acompanhar o histórico de serviços por equipamento ou local."
        actions={
          <Link className="maintenance-secondary-button" to="/manutencao">
            <Icon name="back" size={18} weight="bold" />
            Solicitações de Manutenção
          </Link>
        }
      />
      {error && <Alert tone="error">{error}</Alert>}
      {!equipments && !error && <Loading label="Carregando equipamentos..." />}

      {equipments && (
        <section className="ui-card ui-stacked" aria-label="Equipamentos cadastrados">
          {equipments.length === 0 ? (
            <EmptyState icon="maintenance" title="Nenhum equipamento cadastrado" />
          ) : (
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th>Identificação</th>
                    <th>Local</th>
                    <th>Serviços</th>
                    <th>Último serviço</th>
                    <th>Situação</th>
                    <th>
                      <span className="visually-hidden">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {equipments.map((equipment) => (
                    <tr key={equipment.id}>
                      <td>
                        {equipment.name}
                        {(equipment.customFields ?? []).map((item) => (
                          <small key={item.id} className="central-subtext">
                            {item.label}: {item.value === 'true' ? 'Sim' : item.value.replace(/\|/g, ', ')}
                          </small>
                        ))}
                      </td>
                      <td>{equipment.identification ?? '—'}</td>
                      <td>{equipment.location ?? '—'}</td>
                      <td>{equipment.executions}</td>
                      <td>{formatDateTime(equipment.lastExecution)}</td>
                      <td>{equipment.active ? 'Ativo' : 'Inativo'}</td>
                      <td>
                        <div className="action-row">
                          <button type="button" className="central-link-button" onClick={() => void openHistory(equipment)}>
                            Histórico
                          </button>
                          {canManage && (
                            <button type="button" className="central-link-button" onClick={() => void toggle(equipment)}>
                              {equipment.active ? 'Desativar' : 'Reativar'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canManage && (
        <section className="ui-card ui-stacked" aria-labelledby="equipment-new">
          <h2 id="equipment-new">Novo equipamento ou local</h2>
          <form className="form-grid" onSubmit={(event) => void submit(event)}>
            <label className="maintenance-form-field">
              <span>{equipmentForm.label('name', 'Nome')} *</span>
              <input required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="maintenance-form-field">
              <span>{equipmentForm.label('identification', 'Identificação')}</span>
              <input maxLength={120} value={identification} onChange={(event) => setIdentification(event.target.value)} />
            </label>
            <label className="maintenance-form-field">
              <span>{equipmentForm.label('location', 'Local')}</span>
              <input maxLength={160} value={location} onChange={(event) => setLocation(event.target.value)} />
            </label>
            <ExtraFields fields={equipmentForm.extraFields} values={extra} onChange={setExtra} />
            <button type="submit" className="maintenance-primary-button">
              Cadastrar
            </button>
            {formError && <Alert tone="error" className="form-grid-wide">{formError}</Alert>}
          </form>
        </section>
      )}

      {history && (
        <Modal title={`Histórico de ${history.equipment.name}`} onClose={() => setHistory(null)}>
          {history.executions.length === 0 ? (
            <p>Nenhum serviço registrado.</p>
          ) : (
            <ul className="detail-history">
              {history.executions.map((item) => (
                <li key={item.id}>
                  <strong>
                    <Link to={`${modulePaths.maintenance}/${item.requestId}`}>{protocolLabel(item.protocol)}</Link>
                  </strong>
                  <span>{item.service}</span>
                  {item.pending && <span>Pendências: {item.pending}</span>}
                  <small>
                    {item.executedBy} · {formatDateTime(item.executedAt)}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </div>
  )
}

export default EquipmentsPage
