import { useManagedForm } from '../app/useManagedForm'
import { ExtraFields } from '../components/ExtraFields'
import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { createFleetDriver, listFleetDrivers, updateFleetDriver } from '../api/driverApi'
import type { FleetDriver } from '../api/driverApi'
import { errorMessage } from '../api/modulesApi'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import Icon from '../components/ui/Icon'
import Modal from '../components/ui/Modal'
import PageHeader from '../components/ui/PageHeader'

type Account = { id: string; name: string; email: string }

function DriverDialog({
  driver,
  accounts,
  onClose,
  onSaved,
}: {
  driver: FleetDriver | null
  accounts: Account[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(driver?.name ?? '')
  const [registration, setRegistration] = useState(driver?.registration ?? '')
  const [userId, setUserId] = useState(driver?.userId ?? '')
  const [active, setActive] = useState(driver?.active ?? true)
  const driverForm = useManagedForm('driver')
  const [extra, setExtra] = useState<Record<string, string>>(
    Object.fromEntries((driver?.customFields ?? []).map((item) => [item.id, item.value])),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const body = { name, registration: registration || null, active, userId: userId || null, customFields: extra }
    try {
      if (driver) await updateFleetDriver(driver.id, body)
      else await createFleetDriver(body)
      await onSaved()
      onClose()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível salvar o motorista.'))
      setBusy(false)
    }
  }

  return (
    <Modal title={driver ? `Editar ${driver.name}` : 'Novo motorista'} onClose={onClose}>
      <form className="demand-dialog-form" onSubmit={(event) => void submit(event)}>
        {error && <Alert tone="error">{error}</Alert>}
        <label className="maintenance-form-field">
          <span>{driverForm.label('name', 'Nome')}</span>
          <input required minLength={3} maxLength={160} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>{driverForm.label('registration', 'Matrícula (opcional)')}</span>
          <input maxLength={40} value={registration} onChange={(event) => setRegistration(event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>{driverForm.label('account', 'Conta de acesso')}</span>
          <select value={userId} onChange={(event) => setUserId(event.target.value)}>
            <option value="">Sem conta vinculada</option>
            {driver?.userId && (
              <option value={driver.userId}>
                {driver.accountName} ({driver.accountEmail})
              </option>
            )}
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.email})
              </option>
            ))}
          </select>
          <small className="demand-muted">
            Só aparecem contas ativas de perfil Motorista, ainda sem cadastro. O perfil é definido em{' '}
            <Link to="/usuarios">Usuários</Link> ou ao aprovar o cadastro.
          </small>
        </label>
        <ExtraFields fields={driverForm.extraFields} values={extra} onChange={setExtra} />
        <label className="demand-check">
          <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
          Motorista ativo
        </label>
        <div className="demand-dialog-actions">
          <button type="button" className="maintenance-secondary-button" onClick={onClose}>Voltar</button>
          <button type="submit" className="maintenance-primary-button" disabled={busy}>
            {busy ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Cadastro de motoristas da Frota. Criar a conta e definir o perfil continuam em Usuários. */
function DriversPage() {
  const [drivers, setDrivers] = useState<FleetDriver[] | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<FleetDriver | 'new' | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await listFleetDrivers()
      setDrivers(data.drivers)
      setAccounts(data.accounts)
      setError('')
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível carregar os motoristas.'))
    }
  }, [])

  useEffect(() => {
    let active = true
    listFleetDrivers()
      .then((data) => {
        if (!active) return
        setDrivers(data.drivers)
        setAccounts(data.accounts)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os motoristas.'))
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="admin-module-page">
      <PageHeader
        title="Motoristas"
        description="Cadastro dos motoristas da Frota e vínculo com a conta de acesso ao Portal do Motorista."
        actions={
          <>
            <Link className="maintenance-secondary-button" to="/frota">
              <Icon name="back" size={18} />
              Frota
            </Link>
            <button type="button" className="maintenance-primary-button" onClick={() => setEditing('new')}>
              <Icon name="add" size={18} />
              Novo motorista
            </button>
          </>
        }
      />

      {error && <Alert tone="error">{error}</Alert>}
      {!drivers && !error && <Loading label="Carregando motoristas..." />}
      {drivers && drivers.length === 0 && (
        <section className="ui-card">
          <EmptyState icon="users" title="Nenhum motorista cadastrado">
            Cadastre os motoristas para poder atribuir viagens a eles.
          </EmptyState>
        </section>
      )}
      {drivers && drivers.length > 0 && (
        <section className="ui-card">
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Matrícula</th>
                  <th>Conta de acesso</th>
                  <th>Viagens em aberto</th>
                  <th>Situação</th>
                  <th><span className="visually-hidden">Ações</span></th>
                </tr>
              </thead>
              <tbody>
                {drivers.map((driver) => (
                  <tr key={driver.id}>
                    <td>{driver.name}</td>
                    <td>{driver.registration ?? '—'}</td>
                    <td>{driver.accountEmail ?? <span className="demand-muted">Sem conta</span>}</td>
                    <td>{driver.openTrips}</td>
                    <td>
                      {!driver.active ? 'Inativo' : driver.canReceiveTrips ? 'Pode receber viagens' : 'Falta a conta de perfil Motorista'}
                    </td>
                    <td>
                      <button type="button" className="maintenance-secondary-button" onClick={() => setEditing(driver)}>
                        Editar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {editing && (
        <DriverDialog
          driver={editing === 'new' ? null : editing}
          accounts={accounts}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
    </div>
  )
}

export default DriversPage
