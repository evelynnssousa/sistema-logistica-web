import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { errorMessage, formatDateTime } from '../api/modulesApi'
import {
  addStockMovement,
  formatMoney,
  listMaterialInstruments,
  listPriceAgreements,
  listStock,
  listStockMovements,
  setStockMinimum,
  setStockReserved,
  setStockValue,
} from '../api/operationsApi'
import type { MaterialInstrument, PriceAgreement, StockItem, StockMovement } from '../api/operationsApi'
import { useHasPermission } from '../auth/UserContext'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, FilterSelect, SearchField } from '../components/ui/Filters'
import Modal from '../components/ui/Modal'
import Pagination from '../components/ui/Pagination'

const movementLabels: Record<string, string> = { entrada: 'Entrada', saida: 'Saída' }

/**
 * Controle interno de saldo, à parte do sistema governamental. Desde 12/11/2026, registrar a
 * entrega de um pedido dá baixa automática no saldo; as demais entradas e saídas são lançadas
 * aqui, com justificativa. Quem tem warehouse:finance vê e registra os valores (custo médio).
 */
/** Média mensal das entregas, com a base do cálculo, para a pessoa saber o quanto confiar. */
function consumptionText(item: StockItem) {
  const consumption = item.monthlyConsumption
  if (!consumption || consumption.average === null) return 'Sem entregas'
  const average = consumption.average.toLocaleString('pt-BR', { maximumFractionDigits: 2 })
  const months = consumption.months === 1 ? '1 mês' : `${String(consumption.months).replace('.', ',')} meses`
  return `${average} ${item.unit} (base: ${months})`
}

export function StockTab() {
  const [items, setItems] = useState<StockItem[] | null>(null)
  const [search, setSearch] = useState('')
  const [onlyBelow, setOnlyBelow] = useState('')
  const [order, setOrder] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [movements, setMovements] = useState<{ list: StockMovement[]; total: number; page: number; pageSize: number } | null>(null)
  const [page, setPage] = useState(1)
  const [materialId, setMaterialId] = useState('')
  const [type, setType] = useState('entrada')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [formError, setFormError] = useState('')
  const [minimumFor, setMinimumFor] = useState<StockItem | null>(null)
  const [minimum, setMinimum] = useState('')
  const [reservedFor, setReservedFor] = useState<StockItem | null>(null)
  const [reserved, setReserved] = useState('')
  const [reservedReason, setReservedReason] = useState('')
  const [reservedError, setReservedError] = useState('')
  const seesValues = useHasPermission('warehouse:finance')
  const [agreements, setAgreements] = useState<PriceAgreement[]>([])
  const [paid, setPaid] = useState('')
  const [invoice, setInvoice] = useState('')
  const [commitment, setCommitment] = useState('')
  const [supplier, setSupplier] = useState('')
  const [agreementId, setAgreementId] = useState('')
  const [instruments, setInstruments] = useState<MaterialInstrument[]>([])
  const [instrumentItemId, setInstrumentItemId] = useState('')
  const [valueFor, setValueFor] = useState<StockItem | null>(null)
  const [stockValue, setStockValueInput] = useState('')
  const [valueReason, setValueReason] = useState('')
  const [valueError, setValueError] = useState('')

  useEffect(() => {
    if (!seesValues) return
    let active = true
    listPriceAgreements()
      .then((result) => {
        if (active) setAgreements(result.agreements.filter((agreement) => agreement.active))
      })
      // Sem a migração 020 não há atas: o formulário segue sem a lista.
      .catch(() => undefined)
    // Atas e contratos de materiais do Controle de Demandas (021).
    listMaterialInstruments()
      .then((result) => {
        if (active) setInstruments(result.instruments.filter((item) => !item.expired && item.items.length > 0))
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [seesValues])

  const load = useCallback(async () => {
    const [stock, history] = await Promise.all([
      listStock({ search, belowMinimum: onlyBelow === 'below', byLocation: order === 'location' }),
      listStockMovements({ page }),
    ])
    setItems(stock.items)
    setMovements({ list: history.movements, total: history.total, page: history.page, pageSize: history.pageSize })
  }, [search, onlyBelow, order, page])

  useEffect(() => {
    let active = true
    Promise.all([
      listStock({ search, belowMinimum: onlyBelow === 'below', byLocation: order === 'location' }),
      listStockMovements({ page }),
    ])
      .then(([stock, history]) => {
        if (!active) return
        setItems(stock.items)
        setMovements({ list: history.movements, total: history.total, page: history.page, pageSize: history.pageSize })
        setError('')
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar o estoque.'))
      })
    return () => {
      active = false
    }
  }, [search, onlyBelow, order, page])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setFormError('')
    setNotice('')
    try {
      const withFinance = seesValues && type === 'entrada'
      await addStockMovement({
        materialId,
        tipo: type,
        quantidade: quantity,
        justificativa: reason,
        ...(withFinance
          ? {
              valorPago: paid || undefined,
              notaFiscal: invoice || undefined,
              empenho: commitment || undefined,
              fornecedor: supplier || undefined,
              ataId: agreementId.startsWith('instrumento:') ? undefined : agreementId || undefined,
              itemAtaId: agreementId.startsWith('instrumento:') ? instrumentItemId || undefined : undefined,
            }
          : {}),
      })
      setQuantity('')
      setReason('')
      setPaid('')
      setInvoice('')
      setCommitment('')
      setSupplier('')
      setAgreementId('')
      setInstrumentItemId('')
      setNotice('Movimentação registrada.')
      await load()
    } catch (err) {
      setFormError(errorMessage(err, 'Não foi possível registrar a movimentação.'))
    }
  }

  async function saveMinimum(event: FormEvent) {
    event.preventDefault()
    if (!minimumFor) return
    try {
      await setStockMinimum(minimumFor.id, minimum)
      setMinimumFor(null)
      await load()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível salvar o estoque mínimo.'))
      setMinimumFor(null)
    }
  }

  async function saveReserved(event: FormEvent) {
    event.preventDefault()
    if (!reservedFor) return
    setReservedError('')
    try {
      await setStockReserved(reservedFor.id, reserved, reservedReason)
      setReservedFor(null)
      await load()
    } catch (err) {
      setReservedError(errorMessage(err, 'Não foi possível salvar a reserva.'))
    }
  }

  async function saveValue(event: FormEvent) {
    event.preventDefault()
    if (!valueFor) return
    setValueError('')
    try {
      await setStockValue(valueFor.id, stockValue, valueReason)
      setValueFor(null)
      setNotice('Valor do estoque registrado.')
      await load()
    } catch (err) {
      setValueError(errorMessage(err, 'Não foi possível salvar o valor.'))
    }
  }

  const below = items?.filter((item) => item.belowMinimum).length ?? 0

  return (
    <>
      <p className="module-notice">
        Controle interno de conferência. Não substitui o sistema governamental nem recebe solicitações de materiais.
        Ter saldo físico não obriga a disponibilizar o material: a decisão considera a necessidade apresentada.
        Ao registrar a entrega de um pedido, o sistema dá baixa automática nas quantidades entregues.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {below > 0 && onlyBelow !== 'below' && (
        <Alert tone="warning">{below === 1 ? '1 material abaixo do mínimo.' : `${below} materiais abaixo do mínimo.`}</Alert>
      )}

      <FilterBar
        label="Filtros do estoque"
        canClear={Boolean(search || onlyBelow || order)}
        onClear={() => {
          setSearch('')
          setOnlyBelow('')
          setOrder('')
        }}
      >
        <SearchField label="Pesquisar" value={search} placeholder="Nome ou código" onChange={setSearch} />
        <FilterSelect
          label="Situação"
          value={onlyBelow}
          onChange={setOnlyBelow}
          allLabel="Todos"
          options={[{ value: 'below', label: 'Abaixo do mínimo' }]}
        />
        <FilterSelect
          label="Ordem"
          value={order}
          onChange={setOrder}
          allLabel="Abaixo do mínimo primeiro"
          options={[{ value: 'location', label: 'Por localização (para contagem)' }]}
        />
      </FilterBar>

      {!items && !error && <Loading label="Carregando estoque..." />}
      {items && (
        <section className="ui-card ui-stacked" aria-label="Saldo interno">
          {items.length === 0 ? (
            <EmptyState icon="stock" title="Nenhum material encontrado" />
          ) : (
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Material</th>
                    <th>Localização</th>
                    <th>Estoque físico</th>
                    <th>Reservado</th>
                    <th>Disponível para distribuição</th>
                    <th>Fornecido</th>
                    <th>Consumo médio por mês</th>
                    <th>Mínimo</th>
                    {seesValues && <th>Custo médio</th>}
                    {seesValues && <th>Valor em estoque</th>}
                    <th>Última movimentação</th>
                    <th>
                      <span className="visually-hidden">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {item.name}
                        {item.code && <small className="central-subtext">{item.code}</small>}
                      </td>
                      <td>{item.location ?? '—'}</td>
                      <td>
                        {item.current} {item.unit}
                        {item.belowMinimum && <span className="central-flag central-flag-late">Abaixo do mínimo</span>}
                      </td>
                      <td>{item.reserved} {item.unit}</td>
                      <td>{item.available} {item.unit}</td>
                      <td>{item.provided} {item.unit}</td>
                      <td>{consumptionText(item)}</td>
                      <td>{item.minimum > 0 ? `${item.minimum} ${item.unit}` : 'Não definido'}</td>
                      {seesValues && <td>{item.averageCost === null || item.averageCost === undefined ? '—' : `${formatMoney(item.averageCost)} / ${item.unit}`}</td>}
                      {seesValues && (
                        <td>
                          {formatMoney(item.stockValue)}
                          {item.current > 0 && item.stockValue === 0 && (
                            <span className="central-flag central-flag-late">Sem valor</span>
                          )}
                        </td>
                      )}
                      <td>{formatDateTime(item.lastMovement)}</td>
                      <td>
                        <button
                          type="button"
                          className="central-link-button"
                          onClick={() => {
                            setMinimumFor(item)
                            setMinimum(String(item.minimum))
                          }}
                        >
                          Definir mínimo
                        </button>{' '}
                        <button
                          type="button"
                          className="central-link-button"
                          onClick={() => {
                            setReservedFor(item)
                            setReserved(String(item.reserved))
                            setReservedReason('')
                            setReservedError('')
                          }}
                        >
                          Definir reserva
                        </button>
                        {seesValues && item.stockValue !== null && item.stockValue !== undefined && (
                          <>
                            {' '}
                            <button
                              type="button"
                              className="central-link-button"
                              onClick={() => {
                                setValueFor(item)
                                setStockValueInput(item.stockValue ? String(item.stockValue) : '')
                                setValueReason('')
                                setValueError('')
                              }}
                            >
                              Informar valor
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {items && (
        <section className="ui-card ui-stacked" aria-labelledby="stock-new">
          <h2 id="stock-new">Registrar movimentação</h2>
          <form className="form-grid" onSubmit={(event) => void submit(event)}>
            <label className="maintenance-form-field">
              <span>Material *</span>
              <select required value={materialId} onChange={(event) => setMaterialId(event.target.value)}>
                <option value="">Selecione</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.unit})
                  </option>
                ))}
              </select>
            </label>
            <label className="maintenance-form-field">
              <span>Tipo</span>
              <select value={type} onChange={(event) => setType(event.target.value)}>
                <option value="entrada">Entrada</option>
                <option value="saida">Saída</option>
              </select>
            </label>
            <label className="maintenance-form-field">
              <span>Quantidade *</span>
              <input type="number" min="0.01" step="0.01" required value={quantity} onChange={(event) => setQuantity(event.target.value)} />
            </label>
            {seesValues && type === 'entrada' && (
              <>
                <label className="maintenance-form-field">
                  <span>Valor total pago (R$)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={paid}
                    aria-describedby="stock-paid-hint"
                    onChange={(event) => setPaid(event.target.value)}
                  />
                </label>
                <label className="maintenance-form-field">
                  <span>Nota fiscal</span>
                  <input maxLength={60} value={invoice} onChange={(event) => setInvoice(event.target.value)} />
                </label>
                <label className="maintenance-form-field">
                  <span>Empenho</span>
                  <input maxLength={60} value={commitment} onChange={(event) => setCommitment(event.target.value)} />
                </label>
                <label className="maintenance-form-field">
                  <span>Fornecedor</span>
                  <input maxLength={200} value={supplier} onChange={(event) => setSupplier(event.target.value)} />
                </label>
                <label className="maintenance-form-field">
                  <span>Ata de registro de preços</span>
                  <select
                    value={agreementId}
                    onChange={(event) => {
                      setAgreementId(event.target.value)
                      const instrument = instruments.find((item) => `instrumento:${item.id}` === event.target.value)
                      setInstrumentItemId(instrument?.items[0]?.id ?? '')
                    }}
                  >
                    <option value="">Sem ata</option>
                    {instruments.length > 0 && (
                      <optgroup label="Atas e contratos (Controle de Demandas)">
                        {instruments.map((item) => (
                          <option key={item.id} value={`instrumento:${item.id}`}>
                            {item.type === 'ata' ? 'Ata' : 'Contrato'} {item.number}
                            {item.supplier ? ` (${item.supplier})` : ''}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {agreements.length > 0 && (
                      <optgroup label="Atas cadastradas no Almoxarifado">
                        {agreements.map((agreement) => (
                          <option key={agreement.id} value={agreement.id}>
                            {agreement.number}
                            {agreement.supplier ? ` (${agreement.supplier})` : ''}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </label>
                {agreementId.startsWith('instrumento:') && (
                  <label className="maintenance-form-field">
                    <span>Item da ata ou do contrato *</span>
                    <select required value={instrumentItemId} onChange={(event) => setInstrumentItemId(event.target.value)}>
                      {instruments
                        .find((item) => `instrumento:${item.id}` === agreementId)
                        ?.items.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.description} ({formatMoney(item.unitPrice)}/{item.unit}, saldo {item.balance.toLocaleString('pt-BR')})
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <p id="stock-paid-hint" className="central-subtext form-grid-wide">
                  Valor total pago: o valor de toda a quantidade da entrada. Em branco, a entrada vale o preço do item da ata (se
                  escolhida) ou o custo médio atual (por exemplo, numa devolução). Com item de ata ou contrato, o saldo dele baixa
                  automaticamente.
                </p>
              </>
            )}
            <label className="maintenance-form-field form-grid-wide">
              <span>Justificativa *</span>
              <textarea required rows={2} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            {formError && <Alert tone="error" className="form-grid-wide">{formError}</Alert>}
            <button type="submit" className="maintenance-primary-button">
              Registrar
            </button>
          </form>
        </section>
      )}

      {movements && (
        <section className="ui-card ui-stacked" aria-labelledby="stock-history">
          <h2 id="stock-history">Histórico de movimentações</h2>
          {movements.list.length === 0 ? (
            <EmptyState icon="stock" title="Nenhuma movimentação registrada" />
          ) : (
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Material</th>
                    <th>Tipo</th>
                    <th>Quantidade</th>
                    {seesValues && <th>Valor</th>}
                    {seesValues && <th>Nota, empenho e ata</th>}
                    <th>Justificativa</th>
                    <th>Registro</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.list.map((movement) => (
                    <tr key={movement.id}>
                      <td>{formatDateTime(movement.at)}</td>
                      <td>{movement.material}</td>
                      <td>{movementLabels[movement.type]}</td>
                      <td>
                        {movement.quantity} {movement.unit}
                      </td>
                      {seesValues && (
                        <td>
                          {formatMoney(movement.value)}
                          {movement.value !== null && movement.value !== undefined && !movement.valueInformed && (
                            <small className="central-subtext">pelo custo médio</small>
                          )}
                        </td>
                      )}
                      {seesValues && (
                        <td>
                          {[
                            movement.invoice && `NF ${movement.invoice}`,
                            movement.commitment && `Empenho ${movement.commitment}`,
                            movement.agreement && `Ata ${movement.agreement}`,
                            movement.supplier,
                          ]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </td>
                      )}
                      <td>{movement.reason ?? '—'}</td>
                      <td>{movement.user}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination
            page={movements.page}
            summary={`${movements.total} no total`}
            hasNext={movements.page * movements.pageSize < movements.total}
            onChange={setPage}
          />
        </section>
      )}

      {reservedFor && (
        <Modal title={`Reserva de ${reservedFor.name}`} onClose={() => setReservedFor(null)}>
          <form className="ui-stacked" onSubmit={(event) => void saveReserved(event)}>
            <label className="maintenance-form-field">
              <span>Quantidade reservada ({reservedFor.unit}) *</span>
              <input type="number" min="0" step="0.01" required value={reserved} onChange={(event) => setReserved(event.target.value)} />
            </label>
            <label className="maintenance-form-field">
              <span>Justificativa *</span>
              <textarea required rows={2} minLength={3} maxLength={2000} value={reservedReason} onChange={(event) => setReservedReason(event.target.value)} />
            </label>
            {reservedError && <Alert tone="error">{reservedError}</Alert>}
            <button type="submit" className="maintenance-primary-button">Salvar</button>
          </form>
        </Modal>
      )}

      {valueFor && (
        <Modal title={`Valor do estoque de ${valueFor.name}`} onClose={() => setValueFor(null)}>
          <form className="ui-stacked" onSubmit={(event) => void saveValue(event)}>
            <p>
              Informe quanto vale, em reais, todo o saldo atual ({valueFor.current} {valueFor.unit}). Use para o estoque que
              já existia antes do controle de valores ou para corrigir um valor. O custo médio passa a ser este valor dividido
              pela quantidade.
            </p>
            <label className="maintenance-form-field">
              <span>Valor total do saldo (R$) *</span>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                required
                value={stockValue}
                onChange={(event) => setStockValueInput(event.target.value)}
              />
            </label>
            <label className="maintenance-form-field">
              <span>Justificativa *</span>
              <textarea required rows={2} minLength={3} maxLength={2000} value={valueReason} onChange={(event) => setValueReason(event.target.value)} />
            </label>
            {valueError && <Alert tone="error">{valueError}</Alert>}
            <button type="submit" className="maintenance-primary-button">Salvar</button>
          </form>
        </Modal>
      )}

      {minimumFor && (
        <Modal title={`Estoque mínimo de ${minimumFor.name}`} onClose={() => setMinimumFor(null)}>
          <form className="ui-stacked" onSubmit={(event) => void saveMinimum(event)}>
            <label className="maintenance-form-field">
              <span>Mínimo ({minimumFor.unit})</span>
              <input type="number" min="0" step="0.01" required value={minimum} onChange={(event) => setMinimum(event.target.value)} />
            </label>
            <button type="submit" className="maintenance-primary-button">
              Salvar
            </button>
          </form>
        </Modal>
      )}
    </>
  )
}
