import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { errorMessage, formatDateTime } from '../api/modulesApi'
import { addStockMovement, listStock, listStockMovements, setStockMinimum, setStockReserved } from '../api/operationsApi'
import type { StockItem, StockMovement } from '../api/operationsApi'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, FilterSelect, SearchField } from '../components/ui/Filters'
import Modal from '../components/ui/Modal'
import Pagination from '../components/ui/Pagination'

const movementLabels: Record<string, string> = { entrada: 'Entrada', saida: 'Saída' }

/**
 * Controle interno de saldo, à parte do sistema governamental. Registrar a entrega de um pedido
 * não movimenta este saldo: quem administra lança as entradas e saídas, com justificativa.
 */
export function StockTab() {
  const [items, setItems] = useState<StockItem[] | null>(null)
  const [search, setSearch] = useState('')
  const [onlyBelow, setOnlyBelow] = useState('')
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

  const load = useCallback(async () => {
    const [stock, history] = await Promise.all([
      listStock({ search, belowMinimum: onlyBelow === 'below' }),
      listStockMovements({ page }),
    ])
    setItems(stock.items)
    setMovements({ list: history.movements, total: history.total, page: history.page, pageSize: history.pageSize })
  }, [search, onlyBelow, page])

  useEffect(() => {
    let active = true
    Promise.all([
      listStock({ search, belowMinimum: onlyBelow === 'below' }),
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
  }, [search, onlyBelow, page])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setFormError('')
    setNotice('')
    try {
      await addStockMovement({ materialId, tipo: type, quantidade: quantity, justificativa: reason })
      setQuantity('')
      setReason('')
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

  const below = items?.filter((item) => item.belowMinimum).length ?? 0

  return (
    <>
      <p className="module-notice">
        Controle interno de conferência. Não substitui o sistema governamental nem recebe solicitações de materiais.
        Ter saldo físico não obriga a disponibilizar o material: a decisão considera a necessidade apresentada.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {below > 0 && onlyBelow !== 'below' && (
        <Alert tone="warning">{below === 1 ? '1 material abaixo do mínimo.' : `${below} materiais abaixo do mínimo.`}</Alert>
      )}

      <FilterBar
        label="Filtros do estoque"
        canClear={Boolean(search || onlyBelow)}
        onClear={() => {
          setSearch('')
          setOnlyBelow('')
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
                    <th>Estoque físico</th>
                    <th>Reservado</th>
                    <th>Disponível para distribuição</th>
                    <th>Fornecido</th>
                    <th>Mínimo</th>
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
                      <td>
                        {item.current} {item.unit}
                        {item.belowMinimum && <span className="central-flag central-flag-late">Abaixo do mínimo</span>}
                      </td>
                      <td>{item.reserved} {item.unit}</td>
                      <td>{item.available} {item.unit}</td>
                      <td>{item.provided} {item.unit}</td>
                      <td>{item.minimum > 0 ? `${item.minimum} ${item.unit}` : 'Não definido'}</td>
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
