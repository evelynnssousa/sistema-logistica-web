import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import { Link, NavLink, Outlet, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { errorMessage, formatCalendarDate, formatDateTime } from '../api/modulesApi'
import {
  assetColumnLabels,
  closePatrimonyCheck,
  confirmAssetImport,
  createAsset,
  createPatrimonyCheck,
  getAsset,
  getPatrimonyCheck,
  getPatrimonyOptions,
  listAssets,
  listPatrimonyChecks,
  lookupAsset,
  moveAsset,
  previewAssetImport,
  readPatrimonyCode,
  readResultLabels,
  situationOptions,
  updateAsset,
} from '../api/patrimonyApi'
import type {
  Asset,
  AssetColumnKey,
  AssetColumns,
  AssetHistoryEntry,
  AssetPayload,
  CheckRead,
  ImportPreview,
  PatrimonyCheck,
  PatrimonyCheckSummary,
  PatrimonyOptions,
} from '../api/patrimonyApi'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, FilterSelect, SearchField } from '../components/ui/Filters'
import Icon from '../components/ui/Icon'
import type { IconName } from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'
import Pagination from '../components/ui/Pagination'

/**
 * Patrimônio: bens do órgão por setor e sala. O leitor de código de barras (USB ou Bluetooth)
 * funciona como um teclado: "digita" o número e aperta Enter. Os campos de leitura ficam prontos
 * para receber o número e não enviam o formulário por engano com esse Enter.
 */

const money = (value: number | null) =>
  value === null ? '—' : value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

function useOptions() {
  const [options, setOptions] = useState<PatrimonyOptions | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    getPatrimonyOptions()
      .then((result) => {
        if (active) setOptions(result)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os setores.'))
      })
    return () => {
      active = false
    }
  }, [])
  return { options, error }
}

function MigrationPending() {
  return (
    <Alert tone="warning">
      O Patrimônio ainda não está ligado neste banco: falta aplicar a migração 023. Nada foi perdido; peça a
      aplicação com backup, como nas anteriores.
    </Alert>
  )
}

/**
 * Campo de leitura do código de barras. O Enter do leitor dispara onScan e limpa o campo, que
 * continua com o foco para a próxima leitura.
 */
function ScanField({
  label,
  onScan,
  busy,
  autoFocus = true,
  placeholder = 'Aponte o leitor para o código de barras ou digite e aperte Enter',
}: {
  label: string
  onScan: (value: string) => void
  busy?: boolean
  autoFocus?: boolean
  placeholder?: string
}) {
  const [value, setValue] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!busy && autoFocus) input.current?.focus()
  }, [busy, autoFocus])
  function submit() {
    const text = value.trim()
    if (!text) return
    onScan(text)
    setValue('')
  }
  return (
    <label className="maintenance-form-field patrimony-scan">
      <span>
        <Icon name="barcode" size={20} /> {label}
      </span>
      <div className="patrimony-scan-row">
        <input
          ref={input}
          inputMode="text"
          autoComplete="off"
          maxLength={60}
          placeholder={placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button className="maintenance-primary-button" type="button" disabled={busy || !value.trim()} onClick={submit}>
          Consultar
        </button>
      </div>
    </label>
  )
}

function AssetCard({ asset, children }: { asset: Asset; children?: ReactNode }) {
  return (
    <div className="patrimony-card">
      <p>
        <strong>
          <Link to={`/patrimonio/bens/${asset.id}`}>Patrimônio {asset.number}</Link>
        </strong>{' '}
        · {asset.description}
      </p>
      <p>
        Onde está: <strong>{asset.sector ?? 'Sem setor'}</strong>
        {asset.room ? `, ${asset.room}` : ''} · Situação: {asset.situationLabel}
      </p>
      <p>
        Patrimoniado em: <strong>{asset.registeredOn ? formatCalendarDate(asset.registeredOn) : 'data não informada'}</strong>
        {' · '}Cadastrado no sistema em {formatDateTime(asset.createdAt)}
        {asset.lastCheckAt ? ` · Última conferência: ${formatDateTime(asset.lastCheckAt)}` : ' · Nunca conferido'}
      </p>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bens
// ---------------------------------------------------------------------------
export function AssetsTab() {
  const navigate = useNavigate()
  const { options, error: optionsError } = useOptions()
  const [search, setSearch] = useState('')
  const [sectorId, setSectorId] = useState('')
  const [situation, setSituation] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ assets: Asset[]; total: number; totalValue: number | null; pageSize: number } | null>(null)
  const [error, setError] = useState('')
  const [lookup, setLookup] = useState<{ number: string; asset: Asset | null } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!options?.ready) return
    let active = true
    listAssets({ search, sectorId, situation, page })
      .then((result) => {
        if (active) {
          setError('')
          setData(result)
        }
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os bens.'))
      })
    return () => {
      active = false
    }
  }, [options, search, sectorId, situation, page])

  async function consult(number: string) {
    setBusy(true)
    try {
      setLookup(await lookupAsset(number))
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível consultar o número.'))
    } finally {
      setBusy(false)
    }
  }

  if (optionsError) return <Alert tone="error">{optionsError}</Alert>
  if (!options) return <Loading label="Carregando..." />
  if (!options.ready) return <MigrationPending />

  return (
    <>
      <section className="ui-card ui-stacked">
        <ScanField label="Consultar um bem pelo código de barras" onScan={(value) => void consult(value)} busy={busy} />
        {lookup && lookup.asset && (
          <Alert tone="success">
            Este bem <strong>já foi patrimoniado</strong>.
          </Alert>
        )}
        {lookup?.asset && <AssetCard asset={lookup.asset} />}
        {lookup && !lookup.asset && (
          <Alert tone="warning">
            O número <strong>{lookup.number}</strong> ainda não está cadastrado.{' '}
            <button className="maintenance-secondary-button" type="button" onClick={() => navigate(`/patrimonio/novo?numero=${encodeURIComponent(lookup.number)}`)}>
              Cadastrar este bem
            </button>
          </Alert>
        )}
      </section>

      <FilterBar
        label="Filtrar bens"
        canClear={Boolean(search || sectorId || situation)}
        onClear={() => {
          setSearch('')
          setSectorId('')
          setSituation('')
          setPage(1)
        }}
      >
        <SearchField
          label="Buscar"
          value={search}
          onChange={(value) => {
            setSearch(value)
            setPage(1)
          }}
          placeholder="Número, descrição, marca, modelo ou série"
        />
        <FilterSelect
          label="Setor"
          value={sectorId}
          onChange={(value) => {
            setSectorId(value)
            setPage(1)
          }}
          allLabel="Todos os setores"
          options={options.sectors.map((sector) => ({ value: sector.id, label: sector.name }))}
        />
        <FilterSelect
          label="Situação"
          value={situation}
          onChange={(value) => {
            setSituation(value)
            setPage(1)
          }}
          allLabel="Todas"
          options={situationOptions}
        />
      </FilterBar>

      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && <Loading label="Carregando os bens..." />}
      {data && (
        <section className="ui-card ui-stacked">
          <p>
            {data.total} bens{data.totalValue !== null ? ` · valor de aquisição somado: ${money(data.totalValue)}` : ''}
          </p>
          {data.assets.length === 0 ? (
            <EmptyState title="Nenhum bem encontrado">Cadastre pelo leitor ou importe a planilha na aba "Importar planilha".</EmptyState>
          ) : (
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Patrimônio</th>
                    <th>Descrição</th>
                    <th>Setor</th>
                    <th>Sala</th>
                    <th>Situação</th>
                    <th>Patrimoniado em</th>
                    <th>Última conferência</th>
                  </tr>
                </thead>
                <tbody>
                  {data.assets.map((asset) => (
                    <tr key={asset.id}>
                      <td>
                        <Link to={`/patrimonio/bens/${asset.id}`}>{asset.number}</Link>
                      </td>
                      <td>
                        {asset.description}
                        {(asset.brand || asset.model) && (
                          <small className="central-subtext">{[asset.brand, asset.model].filter(Boolean).join(' · ')}</small>
                        )}
                      </td>
                      <td>{asset.sector ?? '—'}</td>
                      <td>{asset.room ?? '—'}</td>
                      <td>{asset.situationLabel}</td>
                      <td>{formatCalendarDate(asset.registeredOn) || '—'}</td>
                      <td>{asset.lastCheckAt ? formatDateTime(asset.lastCheckAt) : 'Nunca'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination page={page} hasNext={page * data.pageSize < data.total} onChange={setPage} />
        </section>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Cadastro e alteração
// ---------------------------------------------------------------------------
const emptyAsset: AssetPayload = {
  number: '', description: '', sectorId: '', room: '', situation: 'em_uso', brand: '', model: '', serialNumber: '',
  registeredOn: '', acquisitionValue: '', invoice: '', supplier: '', note: '',
}

function payloadOf(asset: Asset): AssetPayload {
  return {
    number: asset.number,
    description: asset.description,
    sectorId: asset.sectorId ?? '',
    room: asset.room ?? '',
    situation: asset.situation,
    brand: asset.brand ?? '',
    model: asset.model ?? '',
    serialNumber: asset.serialNumber ?? '',
    registeredOn: asset.registeredOn ?? '',
    acquisitionValue: asset.acquisitionValue === null ? '' : asset.acquisitionValue.toLocaleString('pt-BR', { minimumFractionDigits: 2 }),
    invoice: asset.invoice ?? '',
    supplier: asset.supplier ?? '',
    note: asset.note ?? '',
  }
}

/** Enter do leitor no campo do número: não envia o formulário, só passa para o próximo campo. */
function enterMovesOn(event: KeyboardEvent<HTMLInputElement>, after?: () => void) {
  if (event.key !== 'Enter') return
  event.preventDefault()
  after?.()
  const form = event.currentTarget.form
  if (!form) return
  const fields = [...form.querySelectorAll<HTMLElement>('input, select, textarea')]
  fields[fields.indexOf(event.currentTarget) + 1]?.focus()
}

function AssetForm({
  initial,
  options,
  submitLabel,
  onSubmit,
  withJustification,
}: {
  initial: AssetPayload
  options: PatrimonyOptions
  submitLabel: string
  onSubmit: (payload: AssetPayload) => Promise<void>
  withJustification?: boolean
}) {
  const [form, setForm] = useState(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [existing, setExisting] = useState<Asset | null>(null)
  const set = (key: keyof AssetPayload) => (value: string) => setForm((current) => ({ ...current, [key]: value }))
  const rooms = [...new Set(options.rooms.filter((item) => !form.sectorId || item.sectorId === form.sectorId).map((item) => item.room))]

  async function checkNumber() {
    const number = form.number.trim()
    if (!number || number === initial.number) {
      setExisting(null)
      return
    }
    try {
      const found = await lookupAsset(number)
      setExisting(found.asset)
    } catch {
      setExisting(null)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await onSubmit(form)
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível salvar o bem.'))
      setBusy(false)
    }
  }

  const field = (key: keyof AssetPayload, label: string, input: ReactNode) => (
    <label className="maintenance-form-field" key={key}>
      <span>{label}</span>
      {input}
    </label>
  )
  const text = (key: keyof AssetPayload, label: string, max: number, extra: Record<string, unknown> = {}) =>
    field(key, label, <input maxLength={max} value={form[key] ?? ''} onChange={(event) => set(key)(event.target.value)} {...extra} />)

  return (
    <form className="detail-action" onSubmit={(event) => void submit(event)}>
      <label className="maintenance-form-field patrimony-scan">
        <span>
          <Icon name="barcode" size={20} /> Número do patrimônio * (leia o código de barras)
        </span>
        <input
          required
          autoFocus
          autoComplete="off"
          maxLength={60}
          value={form.number}
          onChange={(event) => set('number')(event.target.value)}
          onBlur={() => void checkNumber()}
          onKeyDown={(event) => enterMovesOn(event, () => void checkNumber())}
        />
      </label>
      {existing && (
        <Alert tone="warning">
          Este número já foi patrimoniado:
          <AssetCard asset={existing} />
        </Alert>
      )}
      {field('description', 'Descrição *', <input required minLength={2} maxLength={500} value={form.description} onChange={(event) => set('description')(event.target.value)} />)}
      <div className="robot-columns">
        {field(
          'sectorId',
          'Setor',
          <select value={form.sectorId} onChange={(event) => set('sectorId')(event.target.value)}>
            <option value="">Sem setor</option>
            {options.sectors.map((sector) => (
              <option key={sector.id} value={sector.id}>
                {sector.name}
              </option>
            ))}
          </select>,
        )}
        {text('room', 'Sala', 120, { list: 'patrimony-rooms', placeholder: 'Ex.: Sala 3, 2º andar' })}
        <datalist id="patrimony-rooms">
          {rooms.map((room) => (
            <option key={room} value={room} />
          ))}
        </datalist>
        {field(
          'situation',
          'Situação',
          <select value={form.situation} onChange={(event) => set('situation')(event.target.value)}>
            {situationOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>,
        )}
        {text('registeredOn', 'Data em que foi patrimoniado', 10, { type: 'date' })}
      </div>
      <div className="robot-columns">
        {text('brand', 'Marca', 120)}
        {text('model', 'Modelo', 120)}
        {text('serialNumber', 'Número de série', 120)}
      </div>
      <div className="robot-columns">
        {text('acquisitionValue', 'Valor de aquisição (R$)', 20, { inputMode: 'decimal', placeholder: 'Ex.: 1.250,00' })}
        {text('invoice', 'Nota fiscal', 60)}
        {text('supplier', 'Fornecedor', 200)}
      </div>
      {field('note', 'Observação', <textarea maxLength={2000} value={form.note} onChange={(event) => set('note')(event.target.value)} />)}
      {withJustification && text('justification', 'Motivo da alteração (fica no histórico)', 2000)}
      {error && <Alert tone="error">{error}</Alert>}
      <button className="maintenance-primary-button" type="submit" disabled={busy}>
        {submitLabel}
      </button>
    </form>
  )
}

export function NewAssetTab() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { options, error } = useOptions()
  if (error) return <Alert tone="error">{error}</Alert>
  if (!options) return <Loading label="Carregando..." />
  if (!options.ready) return <MigrationPending />
  return (
    <AssetForm
      initial={{ ...emptyAsset, number: params.get('numero') ?? '' }}
      options={options}
      submitLabel="Cadastrar bem"
      onSubmit={async (payload) => {
        const created = await createAsset(payload)
        navigate(`/patrimonio/bens/${created.id}`)
      }}
    />
  )
}

const historyLabels: Record<string, string> = {
  cadastro: 'Cadastrado',
  importacao: 'Importado da planilha',
  alteracao: 'Dados alterados',
  mudanca_local: 'Mudou de local',
  situacao: 'Situação alterada',
  conferencia: 'Conferido',
}

function historyText(entry: AssetHistoryEntry) {
  const parts: string[] = []
  const place = (sector: string | null, room: string | null) => `${sector ?? 'sem setor'}${room ? `, ${room}` : ''}`
  if (entry.type === 'mudanca_local') parts.push(`De ${place(entry.previousSector, entry.previousRoom)} para ${place(entry.newSector, entry.newRoom)}`)
  if (entry.type === 'cadastro' || entry.type === 'importacao') parts.push(`Em ${place(entry.newSector, entry.newRoom)}`)
  if (entry.previousSituation && entry.newSituation && entry.previousSituation !== entry.newSituation) {
    parts.push(`Situação: de ${entry.previousSituation} para ${entry.newSituation}`)
  }
  if (entry.fields.length) parts.push(`Campos: ${entry.fields.join(', ')}`)
  if (entry.note) parts.push(entry.note)
  return parts.join(' · ')
}

export function AssetDetailPage() {
  const { assetId = '' } = useParams()
  const { options } = useOptions()
  const [data, setData] = useState<{ asset: Asset; history: AssetHistoryEntry[] } | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState('')

  const load = useCallback(() => {
    getAsset(assetId)
      .then((result) => setData(result))
      .catch((err: unknown) => setError(errorMessage(err, 'Não foi possível carregar o bem.')))
  }, [assetId])

  useEffect(() => {
    load()
  }, [load])

  if (error) return <Alert tone="error">{error}</Alert>
  if (!data || !options) return <Loading label="Carregando o bem..." />
  const { asset, history } = data
  return (
    <>
      <p>
        <Link to="/patrimonio">← Voltar aos bens</Link>
      </p>
      {saved && <Alert tone="success">{saved}</Alert>}
      <section className="admin-data-card detail-card">
        <h2>
          Patrimônio {asset.number} · {asset.description}
        </h2>
        <dl className="detail-grid">
          {[
            ['Setor', asset.sector],
            ['Sala', asset.room],
            ['Situação', asset.situationLabel],
            ['Patrimoniado em', formatCalendarDate(asset.registeredOn)],
            ['Marca', asset.brand],
            ['Modelo', asset.model],
            ['Número de série', asset.serialNumber],
            ['Valor de aquisição', asset.acquisitionValue === null ? null : money(asset.acquisitionValue)],
            ['Nota fiscal', asset.invoice],
            ['Fornecedor', asset.supplier],
            ['Última conferência', asset.lastCheckAt ? `${formatDateTime(asset.lastCheckAt)}${asset.lastCheckBy ? ` por ${asset.lastCheckBy}` : ''}` : 'Nunca conferido'],
            ['Cadastrado no sistema', `${formatDateTime(asset.createdAt)}${asset.createdBy ? ` por ${asset.createdBy}` : ''}`],
            ['Observação', asset.note],
          ].map(([label, value]) => (
            <div className="detail-info" key={label}>
              <dt>{label}</dt>
              <dd>{value || '—'}</dd>
            </div>
          ))}
        </dl>
        <button className="maintenance-secondary-button" type="button" onClick={() => setEditing((current) => !current)}>
          {editing ? 'Fechar a alteração' : 'Alterar dados, local ou situação'}
        </button>
      </section>
      {editing && (
        <AssetForm
          key={asset.updatedAt}
          initial={payloadOf(asset)}
          options={options}
          withJustification
          submitLabel="Salvar alterações"
          onSubmit={async (payload) => {
            await updateAsset(asset.id, payload)
            setEditing(false)
            setSaved('Alterações salvas. O histórico registra o que mudou.')
            load()
          }}
        />
      )}
      <section className="ui-card ui-stacked">
        <h2>Histórico</h2>
        <p className="module-notice">Cada mudança fica registrada e não pode ser apagada.</p>
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Quando</th>
                <th>O quê</th>
                <th>Detalhes</th>
                <th>Quem</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry, index) => (
                <tr key={`${entry.at}-${index}`}>
                  <td>{formatDateTime(entry.at)}</td>
                  <td>{historyLabels[entry.type] ?? entry.type}</td>
                  <td>{historyText(entry) || '—'}</td>
                  <td>{entry.by ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Conferências
// ---------------------------------------------------------------------------
const checkStatusLabels: Record<string, string> = { em_andamento: 'Em andamento', concluida: 'Concluída', cancelada: 'Cancelada' }

export function PatrimonyChecksTab() {
  const navigate = useNavigate()
  const { options, error: optionsError } = useOptions()
  const [checks, setChecks] = useState<PatrimonyCheckSummary[] | null>(null)
  const [title, setTitle] = useState('')
  const [sectorId, setSectorId] = useState('')
  const [room, setRoom] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!options?.ready) return
    listPatrimonyChecks(1)
      .then((result) => setChecks(result.checks))
      .catch((err: unknown) => setError(errorMessage(err, 'Não foi possível carregar as conferências.')))
  }, [options])

  async function create(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      const created = await createPatrimonyCheck({ title, sectorId, room })
      navigate(`/patrimonio/conferencias/${created.id}`)
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível abrir a conferência.'))
    }
  }

  if (optionsError) return <Alert tone="error">{optionsError}</Alert>
  if (!options) return <Loading label="Carregando..." />
  if (!options.ready) return <MigrationPending />
  const rooms = [...new Set(options.rooms.filter((item) => item.sectorId === sectorId).map((item) => item.room))]

  return (
    <>
      <form className="detail-action" onSubmit={(event) => void create(event)}>
        <h2>Nova conferência</h2>
        <p className="module-notice">
          Escolha o setor e, se quiser, a sala. Depois é só passar o leitor em cada bem: o sistema diz na hora se o bem
          está no lugar certo, em outro local ou se não está cadastrado, e no fim mostra os que não foram encontrados.
        </p>
        <label className="maintenance-form-field">
          <span>Título *</span>
          <input required minLength={3} maxLength={160} value={title} placeholder="Ex.: Conferência anual — Gabinete" onChange={(event) => setTitle(event.target.value)} />
        </label>
        <div className="robot-columns">
          <label className="maintenance-form-field">
            <span>Setor</span>
            <select value={sectorId} onChange={(event) => setSectorId(event.target.value)}>
              <option value="">Todos (só confere se o bem existe)</option>
              {options.sectors.map((sector) => (
                <option key={sector.id} value={sector.id}>
                  {sector.name}
                </option>
              ))}
            </select>
          </label>
          <label className="maintenance-form-field">
            <span>Sala</span>
            <input maxLength={120} list="patrimony-check-rooms" disabled={!sectorId} value={room} placeholder="Todas as salas do setor" onChange={(event) => setRoom(event.target.value)} />
            <datalist id="patrimony-check-rooms">
              {rooms.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </label>
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <button className="maintenance-primary-button" type="submit">
          Começar a conferência
        </button>
      </form>

      <section className="ui-card ui-stacked">
        <h2>Conferências</h2>
        {!checks && <Loading label="Carregando..." />}
        {checks && checks.length === 0 && <EmptyState title="Nenhuma conferência ainda" />}
        {checks && checks.length > 0 && (
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Título</th>
                  <th>Local</th>
                  <th>Situação</th>
                  <th>Lidos</th>
                  <th>No lugar certo</th>
                  <th>Com pendência</th>
                  <th>Aberta em</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((check) => (
                  <tr key={check.id}>
                    <td>
                      <Link to={`/patrimonio/conferencias/${check.id}`}>{check.title}</Link>
                    </td>
                    <td>{check.sector ? `${check.sector}${check.room ? `, ${check.room}` : ''}` : 'Todos os setores'}</td>
                    <td>{checkStatusLabels[check.status] ?? check.status}</td>
                    <td>{check.read}</td>
                    <td>{check.inPlace}</td>
                    <td>{check.issues}</td>
                    <td>{formatDateTime(check.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

const resultTone: Record<CheckRead['result'], 'success' | 'warning' | 'error'> = {
  no_local: 'success',
  outro_local: 'warning',
  nao_cadastrado: 'error',
  baixado: 'error',
}

type LastRead = Awaited<ReturnType<typeof readPatrimonyCode>>

export function PatrimonyCheckPage() {
  const { checkId = '' } = useParams()
  const navigate = useNavigate()
  const [check, setCheck] = useState<PatrimonyCheck | null>(null)
  const [last, setLast] = useState<LastRead | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [comment, setComment] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(() => {
    getPatrimonyCheck(checkId)
      .then((result) => setCheck(result.check))
      .catch((err: unknown) => setError(errorMessage(err, 'Não foi possível carregar a conferência.')))
  }, [checkId])

  useEffect(() => {
    load()
  }, [load])

  async function scan(number: string) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      setLast(await readPatrimonyCode(checkId, number))
      load()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível registrar a leitura.'))
    } finally {
      setBusy(false)
    }
  }

  async function registerHere(assetId: string) {
    if (!check) return
    try {
      await moveAsset(assetId, { sectorId: check.sectorId, room: check.room ?? last?.asset?.room ?? null, note: `Encontrado na conferência "${check.title}"` })
      setNotice('Local do bem atualizado para o desta conferência. O histórico guarda o local anterior.')
      setLast(null)
      load()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível atualizar o local.'))
    }
  }

  async function close(outcome: 'concluida' | 'cancelada') {
    try {
      await closePatrimonyCheck(checkId, { outcome, comment })
      load()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível encerrar a conferência.'))
    }
  }

  if (!check) return error ? <Alert tone="error">{error}</Alert> : <Loading label="Carregando a conferência..." />
  const open = check.status === 'em_andamento'
  const count = (result: CheckRead['result']) => check.reads.filter((read) => read.result === result).length

  return (
    <>
      <p>
        <Link to="/patrimonio/conferencias">← Voltar às conferências</Link>
      </p>
      <section className="ui-card ui-stacked">
        <h2>{check.title}</h2>
        <p>
          Local: <strong>{check.sector ? `${check.sector}${check.room ? `, ${check.room}` : ' (todas as salas)'}` : 'Todos os setores'}</strong> ·{' '}
          {checkStatusLabels[check.status]} · Aberta em {formatDateTime(check.createdAt)}
        </p>
        <p>
          Lidos: {check.reads.length} · No lugar certo: {count('no_local')} · Em outro local: {count('outro_local')} · Não cadastrados:{' '}
          {count('nao_cadastrado')} · Baixados: {count('baixado')}
          {check.sectorId ? ` · Ainda não encontrados: ${check.missing.length}` : ''}
        </p>
        {open ? (
          <ScanField label="Leia o código de barras de cada bem" onScan={(value) => void scan(value)} busy={busy} />
        ) : (
          <Alert tone="info">Conferência encerrada{check.comment ? `: ${check.comment}` : '.'}</Alert>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        {last && (
          <div className="patrimony-last-read" aria-live="polite">
            <Alert tone={resultTone[last.result]}>
              <strong>{last.number}</strong>: {last.label}
              {last.repeated ? ' (já lido nesta conferência)' : ''}
            </Alert>
            {last.asset ? (
              <AssetCard asset={last.asset}>
                {last.result === 'outro_local' && open && (
                  <button className="maintenance-secondary-button" type="button" onClick={() => void registerHere(last.asset!.id)}>
                    O bem está aqui: registrar este local
                  </button>
                )}
              </AssetCard>
            ) : (
              <button className="maintenance-secondary-button" type="button" onClick={() => navigate(`/patrimonio/novo?numero=${encodeURIComponent(last.number)}`)}>
                Cadastrar este bem
              </button>
            )}
          </div>
        )}
      </section>

      {check.sectorId && check.missing.length > 0 && (
        <section className="ui-card ui-stacked">
          <h2>Ainda não encontrados ({check.missing.length})</h2>
          <p className="module-notice">Bens registrados neste local que ainda não foram lidos.</p>
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Patrimônio</th>
                  <th>Descrição</th>
                  <th>Sala</th>
                  <th>Última conferência</th>
                </tr>
              </thead>
              <tbody>
                {check.missing.map((asset) => (
                  <tr key={asset.id}>
                    <td>
                      <Link to={`/patrimonio/bens/${asset.id}`}>{asset.number}</Link>
                    </td>
                    <td>{asset.description}</td>
                    <td>{asset.room ?? '—'}</td>
                    <td>{asset.lastCheckAt ? formatDateTime(asset.lastCheckAt) : 'Nunca'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="ui-card ui-stacked">
        <h2>Leituras</h2>
        {check.reads.length === 0 ? (
          <EmptyState title="Nenhuma leitura ainda" />
        ) : (
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Número lido</th>
                  <th>Resultado</th>
                  <th>Descrição</th>
                  <th>Onde o sistema dizia que estava</th>
                  <th>Quando</th>
                </tr>
              </thead>
              <tbody>
                {check.reads.map((read) => (
                  <tr key={`${read.number}-${read.at}`}>
                    <td>{read.assetId ? <Link to={`/patrimonio/bens/${read.assetId}`}>{read.number}</Link> : read.number}</td>
                    <td>{readResultLabels[read.result]}</td>
                    <td>{read.description ?? '—'}</td>
                    <td>{read.assetId ? `${read.registeredSector ?? 'Sem setor'}${read.registeredRoom ? `, ${read.registeredRoom}` : ''}` : '—'}</td>
                    <td>{formatDateTime(read.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {open && (
        <section className="detail-action">
          <h2>Encerrar a conferência</h2>
          <label className="maintenance-form-field">
            <span>Comentário</span>
            <textarea maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} />
          </label>
          <div className="robot-actions">
            <button className="maintenance-primary-button" type="button" onClick={() => void close('concluida')}>
              Concluir
            </button>
            <button className="maintenance-secondary-button" type="button" onClick={() => void close('cancelada')}>
              Cancelar a conferência
            </button>
          </div>
        </section>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Importação pela planilha (robô)
// ---------------------------------------------------------------------------
export function AssetImportTab() {
  const { options, error: optionsError } = useOptions()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [columns, setColumns] = useState<AssetColumns | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  async function read(selected: File, chosen?: AssetColumns) {
    setBusy(true)
    setError('')
    setDone('')
    try {
      const result = await previewAssetImport(selected, chosen)
      setPreview(result)
      setColumns(result.columns)
    } catch (err) {
      setPreview(null)
      setError(errorMessage(err, 'Não foi possível ler a planilha.'))
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    if (!file || !columns) return
    setBusy(true)
    setError('')
    try {
      const result = await confirmAssetImport(file, columns)
      setDone(`${result.created} bens cadastrados. ${result.existing} já existiam e não mudaram. ${result.rejected} linhas com problema ficaram de fora.`)
      await read(file, columns)
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível importar.'))
      setBusy(false)
    }
  }

  if (optionsError) return <Alert tone="error">{optionsError}</Alert>
  if (!options) return <Loading label="Carregando..." />
  if (!options.ready) return <MigrationPending />

  const width = preview ? Math.max(0, ...preview.preview.map((row) => row.length)) : 0
  const headers = preview && columns ? (preview.preview[columns.headerRow] ?? []) : []
  const columnOptions = Array.from({ length: width }, (_, index) => ({ value: String(index), label: `Coluna ${index + 1}${headers[index] ? `: ${headers[index]}` : ''}` }))
  const lines = preview?.lines ?? []
  const newLines = lines.filter((line) => !line.problems.length && !line.existing)
  const moved = lines.filter((line) => line.existing && line.locationDiffers)

  return (
    <>
      <section className="ui-card ui-stacked">
        <h2>Importar a planilha de patrimônio</h2>
        <p className="module-notice">
          O robô lê a planilha (.xlsx, .csv, .ods ou o .xls do sistema), acha as colunas e mostra antes o que é novo, o que já
          está cadastrado e onde, e o que tem problema. Só os bens novos são cadastrados: os que já existem não mudam.
        </p>
        <label className="maintenance-form-field">
          <span>Planilha</span>
          <input
            type="file"
            accept=".xlsx,.xls,.csv,.ods,.txt"
            disabled={busy}
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null
              setFile(selected)
              if (selected) void read(selected)
            }}
          />
        </label>
        {busy && <Loading compact label="O robô está lendo a planilha..." />}
        {error && <Alert tone="error">{error}</Alert>}
        {done && <Alert tone="success">{done}</Alert>}
      </section>

      {preview && columns && file && (
        <>
          <section className="ui-card ui-stacked">
            <h2>Colunas</h2>
            <div className="data-table-wrapper">
              <table className="data-table">
                <tbody>
                  {preview.preview.slice(0, 6).map((row, index) => (
                    <tr key={index} className={index === columns.headerRow ? 'robot-header-row' : undefined}>
                      <th scope="row">{index + 1}</th>
                      {Array.from({ length: width }, (_, cell) => (
                        <td key={cell}>{row[cell] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="robot-columns">
              <FilterSelect
                label="Linha do cabeçalho"
                value={columns.headerRow < 0 ? '' : String(columns.headerRow)}
                onChange={(value) => setColumns({ ...columns, headerRow: value === '' ? -1 : Number(value) })}
                allLabel="Sem cabeçalho"
                options={preview.preview.slice(0, 12).map((_, index) => ({ value: String(index), label: `Linha ${index + 1}` }))}
              />
              {(Object.keys(assetColumnLabels) as AssetColumnKey[]).map((key) => (
                <FilterSelect
                  key={key}
                  label={assetColumnLabels[key]}
                  value={columns[key] === null ? '' : String(columns[key])}
                  onChange={(value) => setColumns({ ...columns, [key]: value === '' ? null : Number(value) })}
                  allLabel="Nenhuma"
                  options={columnOptions}
                />
              ))}
            </div>
            <button className="maintenance-secondary-button" type="button" disabled={busy} onClick={() => void read(file, columns)}>
              Ler de novo com estas colunas
            </button>
          </section>

          <section className="ui-card ui-stacked">
            <h2>Prévia</h2>
            <p>
              {lines.length} linhas · <strong>{newLines.length} novos</strong> · {lines.filter((line) => line.existing).length} já cadastrados
              {moved.length ? ` (${moved.length} com outro setor ou sala na planilha)` : ''} · {lines.filter((line) => line.problems.length).length} com problema
            </p>
            {moved.length > 0 && (
              <Alert tone="warning">
                {moved.length} bens já cadastrados aparecem em outro local na planilha. A importação não muda o local deles: confira e
                mude bem a bem, ou na conferência.
              </Alert>
            )}
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Linha</th>
                    <th>Patrimônio</th>
                    <th>Descrição</th>
                    <th>Local na planilha</th>
                    <th>O robô diz</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.slice(0, 500).map((line) => (
                    <tr key={line.line}>
                      <td>{line.line}</td>
                      <td>{line.number || '—'}</td>
                      <td>{line.description || '—'}</td>
                      <td>{[line.sectorText, line.room].filter(Boolean).join(', ') || '—'}</td>
                      <td>
                        {line.problems.length ? (
                          <strong>Fica de fora: {line.problems.join('; ')}</strong>
                        ) : line.existing ? (
                          <>
                            Já patrimoniado{line.existing.registeredOn ? ` em ${formatCalendarDate(line.existing.registeredOn)}` : ''}, em{' '}
                            {line.existing.sector ?? 'sem setor'}
                            {line.existing.room ? `, ${line.existing.room}` : ''}
                            {line.locationDiffers ? ' (local diferente da planilha)' : ''}
                          </>
                        ) : (
                          'Novo: será cadastrado'
                        )}
                        {line.warnings.length > 0 && <small className="central-subtext">{line.warnings.join('; ')}</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {lines.length > 500 && <p>Mostrando as 500 primeiras linhas; a importação considera todas.</p>}
            <button className="maintenance-primary-button" type="button" disabled={busy || newLines.length === 0} onClick={() => void confirm()}>
              Cadastrar os {newLines.length} bens novos
            </button>
          </section>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
const tabs: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/patrimonio', label: 'Bens', icon: 'lists', end: true },
  { to: '/patrimonio/novo', label: 'Cadastrar bem', icon: 'add' },
  { to: '/patrimonio/conferencias', label: 'Conferência', icon: 'inventory' },
  { to: '/patrimonio/importar', label: 'Importar planilha', icon: 'robot' },
]

function PatrimonyPage() {
  return (
    <div className="admin-module-page">
      <PageHeader title="Patrimônio" description="Bens do órgão por setor e sala, leitura do código de barras e conferências." />
      <nav className="module-tabs" aria-label="Áreas do Patrimônio">
        {tabs.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.end}>
            <Icon name={tab.icon} size={18} />
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Suspense fallback={<Loading label="Carregando..." />}>
        <Outlet />
      </Suspense>
    </div>
  )
}

export default PatrimonyPage
