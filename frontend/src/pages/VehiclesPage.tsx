import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { errorMessage, formatDate, formatDateTime, fromLocalInput, modulePaths, protocolLabel } from '../api/modulesApi'
import {
  addVehicleLog,
  createVehicle,
  getVehicle,
  listVehicles,
  updateVehicle,
  vehicleLogLabels,
  vehicleStatusLabels,
} from '../api/operationsApi'
import type { Vehicle, VehicleDetail } from '../api/operationsApi'
import { useHasPermission } from '../auth/UserContext'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import Icon from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'
import Pagination from '../components/ui/Pagination'

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`maintenance-form-field${wide ? ' form-grid-wide' : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  )
}

function reviewText(vehicle: Vehicle) {
  if (vehicle.reviewAlert === 'vencida') return 'Revisão vencida'
  if (vehicle.reviewAlert === 'proxima') return 'Revisão próxima'
  return null
}

function ReviewFlag({ vehicle }: { vehicle: Vehicle }) {
  const text = reviewText(vehicle)
  if (!text) return null
  return <span className={`central-flag${vehicle.reviewAlert === 'vencida' ? ' central-flag-late' : ''}`}>{text}</span>
}

function VehicleForm({ vehicle, onSaved }: { vehicle?: Vehicle; onSaved: () => Promise<void> }) {
  const [plate, setPlate] = useState(vehicle?.plate ?? '')
  const [model, setModel] = useState(vehicle?.model ?? '')
  const [identification, setIdentification] = useState(vehicle?.identification ?? '')
  const [status, setStatus] = useState(vehicle?.status ?? 'disponivel')
  const [km, setKm] = useState(String(vehicle?.currentKm ?? 0))
  const [reviewKm, setReviewKm] = useState(vehicle?.nextReviewKm === null || vehicle?.nextReviewKm === undefined ? '' : String(vehicle.nextReviewKm))
  const [reviewDate, setReviewDate] = useState(vehicle?.nextReviewDate ?? '')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setNotice('')
    const body = {
      placa: plate,
      modelo: model,
      identificacao: identification,
      situacao: status,
      kmAtual: km,
      proximaRevisaoKm: reviewKm,
      proximaRevisaoData: reviewDate,
    }
    try {
      if (vehicle) await updateVehicle(vehicle.id, body)
      else await createVehicle(body)
      setNotice('Veículo salvo.')
      if (!vehicle) {
        setPlate('')
        setModel('')
        setIdentification('')
        setKm('0')
        setReviewKm('')
        setReviewDate('')
      }
      await onSaved()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível salvar o veículo.'))
    }
  }

  return (
    <form className="form-grid" onSubmit={(event) => void submit(event)}>
      <Field label="Placa *">
        <input required maxLength={10} value={plate} onChange={(event) => setPlate(event.target.value.toUpperCase())} />
      </Field>
      <Field label="Modelo *">
        <input required maxLength={120} value={model} onChange={(event) => setModel(event.target.value)} />
      </Field>
      <Field label="Identificação interna">
        <input maxLength={120} value={identification} onChange={(event) => setIdentification(event.target.value)} />
      </Field>
      <Field label="Situação">
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          {Object.entries(vehicleStatusLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Quilometragem atual">
        <input type="number" min="0" value={km} onChange={(event) => setKm(event.target.value)} />
      </Field>
      <Field label="Próxima revisão (km)">
        <input type="number" min="0" value={reviewKm} onChange={(event) => setReviewKm(event.target.value)} />
      </Field>
      <Field label="Próxima revisão (data)">
        <input type="date" value={reviewDate} onChange={(event) => setReviewDate(event.target.value)} />
      </Field>
      <button type="submit" className="maintenance-primary-button">
        {vehicle ? 'Salvar veículo' : 'Cadastrar veículo'}
      </button>
      {error && <Alert tone="error" className="form-grid-wide">{error}</Alert>}
      {notice && <Alert tone="success" className="form-grid-wide">{notice}</Alert>}
    </form>
  )
}

function VehiclesPage() {
  const canManage = useHasPermission('fleet:manage')
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setVehicles((await listVehicles()).vehicles)
      setError('')
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível carregar os veículos.'))
    }
  }, [])

  useEffect(() => {
    let active = true
    listVehicles()
      .then((data) => {
        if (active) setVehicles(data.vehicles)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os veículos.'))
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="admin-module-page vehicles-page">
      <PageHeader
        title="Veículos"
        description="Cadastro, quilometragem, ocorrências e manutenção preventiva da frota."
        actions={
          <Link className="maintenance-secondary-button" to="/frota">
            <Icon name="back" size={18} weight="bold" />
            Solicitações de Frota
          </Link>
        }
      />
      {error && <Alert tone="error">{error}</Alert>}
      {!vehicles && !error && <Loading label="Carregando veículos..." />}
      {vehicles && (
        <section className="ui-card ui-stacked" aria-label="Veículos cadastrados">
          {vehicles.length === 0 ? (
            <EmptyState icon="vehicle" title="Nenhum veículo cadastrado" />
          ) : (
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Placa</th>
                    <th>Modelo</th>
                    <th>Situação</th>
                    <th>Quilometragem</th>
                    <th>Próxima revisão</th>
                  </tr>
                </thead>
                <tbody>
                  {vehicles.map((vehicle) => (
                    <tr key={vehicle.id}>
                      <td>
                        <Link to={`/frota/veiculos/${vehicle.id}`}>{vehicle.plate}</Link>
                      </td>
                      <td>{vehicle.model}</td>
                      <td>{vehicleStatusLabels[vehicle.status]}</td>
                      <td>{vehicle.currentKm.toLocaleString('pt-BR')} km</td>
                      <td>
                        {vehicle.nextReviewKm !== null && `${vehicle.nextReviewKm.toLocaleString('pt-BR')} km `}
                        {vehicle.nextReviewDate && formatDate(`${vehicle.nextReviewDate}T12:00:00`)}
                        {vehicle.nextReviewKm === null && !vehicle.nextReviewDate && '—'}
                        <ReviewFlag vehicle={vehicle} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {canManage && vehicles && (
        <section className="ui-card ui-stacked" aria-labelledby="vehicle-new">
          <h2 id="vehicle-new">Novo veículo</h2>
          <VehicleForm onSaved={load} />
        </section>
      )}
    </div>
  )
}

export function VehicleDetailPage() {
  const { vehicleId = '' } = useParams()
  const canManage = useHasPermission('fleet:manage')
  const [detail, setDetail] = useState<VehicleDetail | null>(null)
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  const [type, setType] = useState('utilizacao')
  const [at, setAt] = useState('')
  const [startKm, setStartKm] = useState('')
  const [endKm, setEndKm] = useState('')
  const [liters, setLiters] = useState('')
  const [value, setValue] = useState('')
  const [protocol, setProtocol] = useState('')
  const [description, setDescription] = useState('')
  const [formError, setFormError] = useState('')

  const load = useCallback(async () => {
    try {
      setDetail(await getVehicle(vehicleId, page))
      setError('')
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível carregar o veículo.'))
    }
  }, [vehicleId, page])

  useEffect(() => {
    let active = true
    getVehicle(vehicleId, page)
      .then((data) => {
        if (active) setDetail(data)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar o veículo.'))
      })
    return () => {
      active = false
    }
  }, [vehicleId, page])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setFormError('')
    try {
      await addVehicleLog(vehicleId, {
        tipo: type,
        data: fromLocalInput(at),
        kmInicial: startKm,
        kmFinal: endKm,
        litros: liters,
        valor: value,
        protocolo: protocol,
        descricao: description,
      })
      setStartKm('')
      setEndKm('')
      setLiters('')
      setValue('')
      setProtocol('')
      setDescription('')
      await load()
    } catch (err) {
      setFormError(errorMessage(err, 'Não foi possível registrar.'))
    }
  }

  if (error && !detail) return <Alert tone="error">{error}</Alert>
  if (!detail) return <Loading label="Carregando veículo..." />
  const { vehicle, summary, logs } = detail

  return (
    <div className="admin-module-page vehicles-page">
      <PageHeader
        eyebrow="Veículo"
        title={vehicle.plate}
        description={`${vehicle.model} · ${vehicleStatusLabels[vehicle.status]}`}
        actions={
          <Link className="maintenance-secondary-button" to="/frota/veiculos">
            <Icon name="back" size={18} weight="bold" />
            Voltar
          </Link>
        }
      />
      {vehicle.reviewAlert && (
        <Alert tone={vehicle.reviewAlert === 'vencida' ? 'error' : 'warning'}>{reviewText(vehicle)}.</Alert>
      )}

      <section className="ui-card ui-stacked" aria-label="Resumo do veículo">
        <dl className="indicator-list">
          <div><dt>Quilometragem atual</dt><dd>{vehicle.currentKm.toLocaleString('pt-BR')} km</dd></div>
          <div><dt>Quilômetros registrados</dt><dd>{summary.kmDriven.toLocaleString('pt-BR')} km</dd></div>
          <div><dt>Abastecimentos</dt><dd>{summary.fuelings}</dd></div>
          <div><dt>Litros</dt><dd>{summary.liters.toLocaleString('pt-BR')}</dd></div>
          <div><dt>Ocorrências</dt><dd>{summary.occurrences}</dd></div>
          <div><dt>Intervenções</dt><dd>{summary.interventions}</dd></div>
        </dl>
      </section>

      <section className="ui-card ui-stacked" aria-labelledby="vehicle-history">
        <h2 id="vehicle-history">Histórico</h2>
        {logs.length === 0 ? (
          <EmptyState icon="vehicle" title="Nenhum registro" />
        ) : (
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Tipo</th>
                  <th>Quilometragem</th>
                  <th>Abastecimento</th>
                  <th>Descrição</th>
                  <th>Solicitação</th>
                  <th>Registro</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td>{formatDateTime(log.at)}</td>
                    <td>{vehicleLogLabels[log.type]}</td>
                    <td>{log.startKm !== null || log.endKm !== null ? `${log.startKm ?? '—'} a ${log.endKm ?? '—'}` : '—'}</td>
                    <td>{log.liters !== null ? `${log.liters} L` : '—'}{log.value !== null ? ` · R$ ${log.value.toFixed(2).replace('.', ',')}` : ''}</td>
                    <td>{log.description}</td>
                    <td>
                      {log.protocol && log.requestId ? (
                        <Link to={`${modulePaths.fleet}/${log.requestId}`}>{protocolLabel(log.protocol)}</Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{log.registeredBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination
          page={detail.page}
          summary={`${detail.total} no total`}
          hasNext={detail.page * detail.pageSize < detail.total}
          onChange={setPage}
        />
      </section>

      <section className="ui-card ui-stacked" aria-labelledby="vehicle-record">
        <h2 id="vehicle-record">Novo registro</h2>
        <form className="form-grid" onSubmit={(event) => void submit(event)}>
          <Field label="Tipo">
            <select value={type} onChange={(event) => setType(event.target.value)}>
              {Object.entries(vehicleLogLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Data e horário *">
            <input type="datetime-local" required value={at} onChange={(event) => setAt(event.target.value)} />
          </Field>
          <Field label={type === 'utilizacao' ? 'Km inicial *' : 'Km inicial'}>
            <input type="number" min="0" required={type === 'utilizacao'} value={startKm} onChange={(event) => setStartKm(event.target.value)} />
          </Field>
          <Field label={type === 'utilizacao' ? 'Km final *' : 'Km final'}>
            <input type="number" min="0" required={type === 'utilizacao'} value={endKm} onChange={(event) => setEndKm(event.target.value)} />
          </Field>
          {type === 'abastecimento' && (
            <Field label="Litros">
              <input inputMode="decimal" value={liters} onChange={(event) => setLiters(event.target.value)} />
            </Field>
          )}
          {(type === 'abastecimento' || type === 'manutencao') && (
            <Field label="Valor (R$)">
              <input inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} />
            </Field>
          )}
          <Field label="Protocolo de Frota (opcional)">
            <input maxLength={40} placeholder="FRO-2026-00001" value={protocol} onChange={(event) => setProtocol(event.target.value)} />
          </Field>
          <Field label="Descrição *" wide>
            <textarea required rows={2} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          {formError && <Alert tone="error" className="form-grid-wide">{formError}</Alert>}
          <button type="submit" className="maintenance-primary-button">
            Registrar
          </button>
        </form>
      </section>

      {canManage && (
        <section className="ui-card ui-stacked" aria-labelledby="vehicle-edit">
          <h2 id="vehicle-edit">Cadastro</h2>
          <VehicleForm key={`${vehicle.id}-${vehicle.currentKm}-${vehicle.status}`} vehicle={vehicle} onSaved={load} />
        </section>
      )}
    </div>
  )
}

export default VehiclesPage
