import { useManagedForm } from '../app/useManagedForm'
import { ExtraFields } from '../components/ExtraFields'
import { Suspense, useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  protocolLabel,
  createExternalWarehouseRequest,
  createInventoryCheck,
  createMaterial,
  deliveryStatusLabels,
  errorMessage,
  formatCalendarDate,
  formatDateTime,
  listInventoryChecks,
  listMaterials,
  listWarehouseRequests,
  originLabels,
  updateMaterial,
  warehouseStatusLabels,
} from '../api/modulesApi'
import type {
  InventoryCheckSummary,
  ItemPayload,
  Material,
  WarehouseRequest,
} from '../api/modulesApi'
import { useCatalog } from '../app/useCatalog'
import { usePeriodFilter } from '../app/period'
import { useAuthenticatedUser } from '../auth/UserContext'
import PrivacyNotice from '../components/PrivacyNotice'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, FilterSelect, PeriodFields, SearchField } from '../components/ui/Filters'
import Icon from '../components/ui/Icon'
import type { IconName } from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'
import Pagination from '../components/ui/Pagination'
import StatusBadge from '../components/ui/StatusBadge'

const notIntegratedNotice =
  'O JUCESP não está integrado ao sistema governamental. Os pedidos dessa origem são cópias digitadas aqui: editá-las não altera o pedido original.'

const checkStatusLabels: Record<string, string> = {
  em_andamento: 'Em andamento',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
}

export function RequestsTab() {
  const period = usePeriodFilter()
  const [status, setStatus] = useState('')
  const [origin, setOrigin] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ requests: WarehouseRequest[]; total: number; pageSize: number } | null>(null)
  const [error, setError] = useState('')
  const { from, to } = period.range

  useEffect(() => {
    let active = true
    listWarehouseRequests({ status, origin, search, from, to, page })
      .then((result) => {
        if (!active) return
        setData(result)
        setError('')
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os pedidos.'))
      })
    return () => {
      active = false
    }
  }, [status, origin, search, from, to, page])

  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const filter = (setter: (value: string) => void) => (value: string) => {
    setter(value)
    setPage(1)
  }
  const filtering = Boolean(status || origin || search) || period.isActive

  return (
    <section className="ui-card" aria-label="Central de pedidos">
      <FilterBar
        label="Filtros dos pedidos"
        canClear={filtering}
        onClear={() => {
          setStatus('')
          setOrigin('')
          setSearch('')
          period.clear()
          setPage(1)
        }}
      >
        <SearchField
          label="Pesquisar"
          value={search}
          placeholder="Protocolo, referência, solicitante"
          onChange={filter(setSearch)}
        />
        <FilterSelect
          label="Situação"
          value={status}
          onChange={filter(setStatus)}
          allLabel="Todas as situações"
          options={Object.entries(warehouseStatusLabels).map(([value, label]) => ({ value, label }))}
        />
        <FilterSelect
          label="Origem"
          value={origin}
          onChange={filter(setOrigin)}
          allLabel="Todas as origens"
          options={Object.entries(originLabels).map(([value, label]) => ({ value, label }))}
        />
        <PeriodFields filter={period} onChange={() => setPage(1)} />
      </FilterBar>

      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && <Loading label="Carregando pedidos..." />}

      {data && data.requests.length === 0 && (
        <EmptyState icon="warehouse" title={filtering ? 'Nada encontrado' : 'Nenhum pedido ainda'}>
          {filtering
            ? 'Não há pedidos para os filtros selecionados.'
            : 'Os pedidos de materiais aparecem aqui assim que forem registrados.'}
        </EmptyState>
      )}

      {data && data.requests.length > 0 && (
        <>
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Protocolo</th>
                  <th>Origem</th>
                  <th>Referência externa</th>
                  <th>Solicitante</th>
                  <th>Setor</th>
                  <th>Itens</th>
                  <th>Situação</th>
                  <th>Entrega</th>
                  <th>Data</th>
                </tr>
              </thead>
              <tbody>
                {data.requests.map((request) => (
                  <tr key={request.id}>
                    <td>
                      <Link to={`/almoxarifado/pedidos/${request.id}`}>{protocolLabel(request.protocol)}</Link>
                    </td>
                    <td>{originLabels[request.origin]}</td>
                    <td>{request.externalReference ?? '—'}</td>
                    <td>{request.externalRequester ?? request.requester}</td>
                    <td>{request.sector ?? '—'}</td>
                    <td>{request.itemCount}</td>
                    <td>
                      <StatusBadge status={request.status} label={warehouseStatusLabels[request.status]} />
                    </td>
                    <td>
                      {request.deliveryStatus ? (
                        <StatusBadge
                          status={request.deliveryStatus}
                          label={deliveryStatusLabels[request.deliveryStatus]}
                        />
                      ) : (
                        '—'
                      )}
                      {request.deliveryForecast && (
                        <small className="warehouse-forecast-date">
                          Previsão: {formatCalendarDate(request.deliveryForecast)}
                        </small>
                      )}
                    </td>
                    <td>{formatDateTime(request.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            summary={`${data.total} ${data.total === 1 ? 'pedido' : 'pedidos'} · Página ${page} de ${lastPage}`}
            hasNext={page < lastPage}
            onChange={setPage}
          />
        </>
      )}
    </section>
  )
}

function ItemRows({
  materials,
  items,
  onChange,
  withFulfilled = false,
}: {
  materials: Material[]
  items: ItemPayload[]
  onChange: (items: ItemPayload[]) => void
  withFulfilled?: boolean
}) {
  const update = (index: number, change: Partial<ItemPayload>) =>
    onChange(items.map((item, position) => (position === index ? { ...item, ...change } : item)))

  return (
    <>
      {items.map((item, index) => (
        <div className="warehouse-cart-row" key={index}>
          <label className="maintenance-form-field">
            <span>Material *</span>
            <select
              required
              value={item.materialId}
              onChange={(event) => update(index, { materialId: event.target.value })}
            >
              <option value="" disabled>
                Selecione
              </option>
              {materials.map((material) => (
                <option key={material.id} value={material.id}>
                  {material.name} ({material.unit})
                </option>
              ))}
            </select>
          </label>
          <label className="maintenance-form-field">
            <span>Solicitada *</span>
            <input
              required
              type="number"
              min="0.01"
              step="0.01"
              value={item.requested}
              onChange={(event) => update(index, { requested: event.target.value })}
            />
          </label>
          {withFulfilled ? (
            <label className="maintenance-form-field">
              <span>Atendida</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={item.fulfilled ?? ''}
                onChange={(event) => update(index, { fulfilled: event.target.value })}
              />
            </label>
          ) : (
            <span />
          )}
          <button
            type="button"
            disabled={items.length <= 1}
            onClick={() => onChange(items.filter((_, position) => position !== index))}
          >
            Remover
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...items, { materialId: '', requested: '' }])}>
        Adicionar item
      </button>
    </>
  )
}

export function ExternalRequestTab() {
  const navigate = useNavigate()
  const { catalog } = useCatalog()
  const [materials, setMaterials] = useState<Material[]>([])
  const [reference, setReference] = useState('')
  const [requester, setRequester] = useState('')
  const [requesterEmail, setRequesterEmail] = useState('')
  const [sectorId, setSectorId] = useState('')
  const [note, setNote] = useState('')
  const [items, setItems] = useState<ItemPayload[]>([{ materialId: '', requested: '' }])
  const [error, setError] = useState('')
  const form = useManagedForm('warehouseExternal')
  const [extra, setExtra] = useState<Record<string, string>>({})

  useEffect(() => {
    let active = true
    listMaterials()
      .then((data) => {
        if (active) setMaterials(data.materials)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os materiais.'))
      })
    return () => {
      active = false
    }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      const created = await createExternalWarehouseRequest({
        externalReference: reference,
        externalRequester: requester,
        externalRequesterEmail: requesterEmail,
        sectorId,
        note,
        items,
        customFields: extra,
      })
      navigate(`/almoxarifado/pedidos/${created.id}`)
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível registrar o pedido.'))
    }
  }

  return (
    <form className="detail-action" onSubmit={(event) => void submit(event)}>
      <h2>Inserir pedido do sistema governamental</h2>
      <p className="module-notice">{notIntegratedNotice}</p>
      <label className="maintenance-form-field">
        <span>{form.label('externalReference', 'Número de referência no sistema governamental')}</span>
        <input maxLength={120} value={reference} onChange={(event) => setReference(event.target.value)} />
      </label>
      <label className="maintenance-form-field">
        <span>{form.label('externalRequester', 'Solicitante informado no pedido')}</span>
        <input maxLength={120} value={requester} onChange={(event) => setRequester(event.target.value)} />
      </label>
      <label className="maintenance-form-field">
        <span>{form.label('externalRequesterEmail', 'E-mail institucional do solicitante')}</span>
        <input
          type="email"
          maxLength={254}
          value={requesterEmail}
          onChange={(event) => setRequesterEmail(event.target.value)}
        />
      </label>
      <label className="maintenance-form-field">
        <span>{form.label('sector', 'Setor')} *</span>
        <select required value={sectorId} onChange={(event) => setSectorId(event.target.value)}>
          <option value="" disabled>
            Selecione
          </option>
          {catalog.sectors.map((sector) => (
            <option key={sector.id} value={sector.id}>
              {sector.label}
            </option>
          ))}
        </select>
      </label>
      <label className="maintenance-form-field">
        <span>{form.label('note', 'Observação')}</span>
        <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <ItemRows materials={materials} items={items} onChange={setItems} withFulfilled />
      <ExtraFields fields={form.extraFields} values={extra} onChange={setExtra} />
      <PrivacyNotice module="warehouseExternal" />
      {error && <Alert tone="error">{error}</Alert>}
      <button className="maintenance-primary-button" type="submit">
        Registrar pedido externo
      </button>
    </form>
  )
}

const emptyMaterial = { code: '', name: '', description: '', unitId: '', categoryId: '', location: '', active: true, customFields: {} as Record<string, string> }

export function MaterialsTab() {
  const { catalog } = useCatalog()
  const [materials, setMaterials] = useState<Material[] | null>(null)
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(emptyMaterial)
  const materialForm = useManagedForm('material')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const reload = useCallback(async () => {
    const data = await listMaterials({ inactive: true, search })
    setMaterials(data.materials)
  }, [search])

  useEffect(() => {
    let active = true
    listMaterials({ inactive: true, search })
      .then((data) => {
        if (active) setMaterials(data.materials)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os materiais.'))
      })
    return () => {
      active = false
    }
  }, [search])

  function edit(material: Material) {
    setEditingId(material.id)
    setNotice('')
    setForm({
      code: material.code ?? '',
      name: material.name,
      description: material.description ?? '',
      // A unidade é um texto copiado; a opção correspondente vem do cadastro atual.
      unitId: catalog.measurementUnits.find((unit) => unit.label === material.unit)?.id ?? '',
      categoryId: material.categoryId ?? '',
      location: material.location ?? '',
      active: material.active,
      customFields: Object.fromEntries((material.customFields ?? []).map((item) => [item.id, item.value])),
    })
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      if (editingId) {
        await updateMaterial(editingId, form)
      } else {
        await createMaterial(form)
      }
      setNotice(editingId ? 'Material atualizado.' : 'Material cadastrado.')
      setEditingId(null)
      setForm(emptyMaterial)
      await reload()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível salvar o material.'))
    }
  }

  return (
    <>
      <form className="detail-action" onSubmit={(event) => void save(event)}>
        <h2>{editingId ? 'Editar material' : 'Cadastrar material'}</h2>
        <label className="maintenance-form-field">
          <span>{materialForm.label('name', 'Nome')} *</span>
          <input required maxLength={160} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </label>
        <label className="maintenance-form-field">
          <span>{materialForm.label('code', 'Código')}</span>
          <input maxLength={60} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
        </label>
        <label className="maintenance-form-field">
          <span>{materialForm.label('unit', 'Unidade de medida')} *</span>
          <select required value={form.unitId} onChange={(event) => setForm({ ...form, unitId: event.target.value })}>
            <option value="" disabled>
              {catalog.measurementUnits.length ? 'Selecione' : 'Cadastre em Configurações'}
            </option>
            {catalog.measurementUnits.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.label}
              </option>
            ))}
          </select>
        </label>
        <label className="maintenance-form-field">
          <span>{materialForm.label('category', 'Categoria')}</span>
          <select value={form.categoryId} onChange={(event) => setForm({ ...form, categoryId: event.target.value })}>
            <option value="">Sem categoria</option>
            {catalog.warehouseCategories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
        <label className="maintenance-form-field">
          <span>{materialForm.label('location', 'Localização (armário, prateleira)')}</span>
          <input
            maxLength={120}
            placeholder="Ex.: Armário 1, prateleira 2"
            value={form.location}
            onChange={(event) => setForm({ ...form, location: event.target.value })}
          />
        </label>
        <label className="maintenance-form-field">
          <span>{materialForm.label('description', 'Descrição')}</span>
          <textarea rows={2} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </label>
        <ExtraFields fields={materialForm.extraFields} values={form.customFields} onChange={(values) => setForm({ ...form, customFields: values })} />
        <label>
          <input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} /> Ativo
        </label>
        {error && <Alert tone="error">{error}</Alert>}
        {notice && <p role="status">{notice}</p>}
        <button className="maintenance-primary-button" type="submit">
          Salvar material
        </button>
      </form>

      <section className="ui-card ui-stacked">
        <h2>Catálogo de materiais</h2>
        <FilterBar label="Filtros dos materiais">
          <SearchField label="Pesquisar" value={search} onChange={setSearch} />
        </FilterBar>
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Código</th>
                <th>Material</th>
                <th>Localização</th>
                <th>Categoria</th>
                <th>Unidade</th>
                <th>Situação</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {materials?.map((material) => (
                <tr key={material.id}>
                  <td>{material.code ?? '—'}</td>
                  <td>{material.name}</td>
                  <td>{material.location ?? '—'}</td>
                  <td>{material.category ?? '—'}</td>
                  <td>{material.unit}</td>
                  <td>{material.active ? 'Ativo' : 'Inativo'}</td>
                  <td>
                    <button type="button" onClick={() => edit(material)}>
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
              {materials?.length === 0 && (
                <tr>
                  <td colSpan={6}>Nenhum material cadastrado.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

export function ChecksTab() {
  const navigate = useNavigate()
  const [checks, setChecks] = useState<InventoryCheckSummary[] | null>(null)
  const [materials, setMaterials] = useState<Material[]>([])
  const [title, setTitle] = useState('')
  const [referenceDate, setReferenceDate] = useState('')
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    Promise.all([listInventoryChecks(1), listMaterials()])
      .then(([checkData, materialData]) => {
        if (!active) return
        setChecks(checkData.checks)
        setMaterials(materialData.materials)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar as conferências.'))
      })
    return () => {
      active = false
    }
  }, [])

  async function create(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      const created = await createInventoryCheck({
        title,
        referenceDate,
        note: '',
        items: Object.entries(quantities)
          .filter(([, quantity]) => quantity !== '')
          .map(([materialId, governmentQuantity]) => ({ materialId, governmentQuantity })),
      })
      navigate(`/almoxarifado/conferencias/${created.id}`)
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível criar a conferência.'))
    }
  }

  return (
    <>
      <section className="ui-card ui-stacked">
        <h2>Histórico de conferências</h2>
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Protocolo</th>
                <th>Título</th>
                <th>Referência</th>
                <th>Situação</th>
                <th>Contados</th>
                <th>Divergências</th>
                <th>Criada por</th>
              </tr>
            </thead>
            <tbody>
              {checks?.map((check) => (
                <tr key={check.id}>
                  <td>
                    <Link to={`/almoxarifado/conferencias/${check.id}`}>{protocolLabel(check.protocol)}</Link>
                  </td>
                  <td>{check.title}</td>
                  <td>{check.referenceDate.split('-').reverse().join('/')}</td>
                  <td>
                    <StatusBadge
                      status={check.status === 'em_andamento' ? 'em_andamento_conferencia' : check.status}
                      label={checkStatusLabels[check.status]}
                    />
                  </td>
                  <td>
                    {check.counted} de {check.total}
                  </td>
                  <td>{check.divergent}</td>
                  <td>{check.createdBy}</td>
                </tr>
              ))}
              {checks?.length === 0 && (
                <tr>
                  <td colSpan={7}>Nenhuma conferência registrada.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <form className="detail-action" onSubmit={(event) => void create(event)}>
        <h2>Nova conferência</h2>
        <p className="module-notice">
          Digite a quantidade informada pelo sistema governamental. Deixe em branco os materiais fora
          desta conferência. {notIntegratedNotice}
        </p>
        <label className="maintenance-form-field">
          <span>Título *</span>
          <input required minLength={3} maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Data de referência *</span>
          <input required type="date" value={referenceDate} onChange={(event) => setReferenceDate(event.target.value)} />
        </label>
        {[...materials]
          .sort(
            (a, b) =>
              (a.location ?? '\uffff').localeCompare(b.location ?? '\uffff', 'pt-BR', { numeric: true }) ||
              a.name.localeCompare(b.name, 'pt-BR'),
          )
          .map((material) => (
          <label className="maintenance-form-field" key={material.id}>
            <span>
              {material.location ? `${material.location} · ` : ''}
              {material.name} ({material.unit})
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={quantities[material.id] ?? ''}
              onChange={(event) =>
                setQuantities((current) => ({ ...current, [material.id]: event.target.value }))
              }
            />
          </label>
        ))}
        {error && <Alert tone="error">{error}</Alert>}
        <button className="maintenance-primary-button" type="submit">
          Criar conferência
        </button>
      </form>
    </>
  )
}

const warehouseTabs: { to: string; label: string; icon: IconName; permission?: string; end?: boolean }[] = [
  { to: '/almoxarifado', label: 'Visão geral', icon: 'overview', end: true },
  { to: '/almoxarifado/solicitacoes', label: 'Solicitações', icon: 'requests' },
  { to: '/almoxarifado/nova', label: 'Nova solicitação', icon: 'add', permission: 'requests:create' },
  { to: '/almoxarifado/externo', label: 'Pedido externo', icon: 'lists', permission: 'warehouse:manage' },
  { to: '/almoxarifado/materiais', label: 'Materiais', icon: 'warehouse', permission: 'warehouse:manage' },
  { to: '/almoxarifado/estoque', label: 'Estoque interno', icon: 'stock', permission: 'warehouse:manage' },
  { to: '/almoxarifado/valores', label: 'Valores', icon: 'money', permission: 'warehouse:finance' },
  { to: '/almoxarifado/controle', label: 'Controle interno', icon: 'lists', permission: 'warehouse:manage' },
  { to: '/almoxarifado/inventario', label: 'Inventário', icon: 'inventory', permission: 'warehouse:manage' },
  { to: '/almoxarifado/robo', label: 'Robô', icon: 'robot', permission: 'warehouse:manage' },
  { to: '/almoxarifado/relatorios', label: 'Relatórios', icon: 'reports', permission: 'reports:read' },
]

/** Módulo dentro do layout comum, com suas áreas em abas e endereços próprios. */
function InventoryPage() {
  const user = useAuthenticatedUser()
  const tabs = warehouseTabs.filter(
    (tab) => !tab.permission || user?.permissions.includes(tab.permission),
  )

  return (
    <div className="admin-module-page inventory-page">
      <PageHeader
        title="Almoxarifado"
        description="Pedidos de materiais das duas origens, catálogo e conferências de inventário."
      />

      <nav className="module-tabs" aria-label="Áreas do Almoxarifado">
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

export { ItemRows }
export default InventoryPage
