import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { errorMessage } from '../api/modulesApi'
import {
  createPriceAgreement,
  formatMoney,
  getWarehouseFinance,
  updatePriceAgreement,
} from '../api/operationsApi'
import type { PriceAgreement, PriceAgreementInput, WarehouseFinanceSummary } from '../api/operationsApi'
import StatCard from '../components/StatCard'
import { BarChart } from '../components/ui/Charts'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar } from '../components/ui/Filters'
import Icon from '../components/ui/Icon'
import Modal from '../components/ui/Modal'

/**
 * Valores do Almoxarifado (12/11/2026): valor do estoque, compras e consumo por mês, atas de
 * registro de preços, materiais mais caros e consumo por setor. Só Administrador e Operador SLM
 * (warehouse:finance). Custo médio ponderado: entradas pelo valor pago, saídas pelo custo médio.
 */

const situationLabels: Record<PriceAgreement['situation'], string> = {
  vigente: 'Vigente',
  futura: 'Ainda não vigente',
  vencida: 'Vencida',
  encerrada: 'Encerrada',
}

const day = (value: string | null) => (value ? value.split('-').reverse().join('/') : '—')

function monthName(month: string) {
  const [year, number] = month.split('-').map(Number)
  return new Date(year, number - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
}

const emptyAgreement: PriceAgreementInput = {
  numero: '',
  fornecedor: '',
  objeto: '',
  valorTotal: '',
  vigenciaInicio: '',
  vigenciaFim: '',
  ativo: true,
}

export function WarehouseFinanceTab() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [summary, setSummary] = useState<WarehouseFinanceSummary | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<{ id: string | null; form: PriceAgreementInput } | null>(null)
  const [formError, setFormError] = useState('')

  const load = useCallback(async () => {
    const result = await getWarehouseFinance({ from: from || undefined, to: to || undefined })
    setSummary(result.summary)
    setError('')
  }, [from, to])

  useEffect(() => {
    let active = true
    getWarehouseFinance({ from: from || undefined, to: to || undefined })
      .then((result) => {
        if (!active) return
        setSummary(result.summary)
        setError('')
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os valores do Almoxarifado.'))
      })
    return () => {
      active = false
    }
  }, [from, to])

  async function saveAgreement(event: FormEvent) {
    event.preventDefault()
    if (!editing) return
    setFormError('')
    try {
      if (editing.id) await updatePriceAgreement(editing.id, editing.form)
      else await createPriceAgreement(editing.form)
      setEditing(null)
      setNotice('Ata salva.')
      await load()
    } catch (err) {
      setFormError(errorMessage(err, 'Não foi possível salvar a ata.'))
    }
  }

  function edit(agreement: PriceAgreement | null) {
    setFormError('')
    setEditing(
      agreement
        ? {
            id: agreement.id,
            form: {
              numero: agreement.number,
              fornecedor: agreement.supplier ?? '',
              objeto: agreement.subject ?? '',
              valorTotal: String(agreement.total),
              vigenciaInicio: agreement.validFrom ?? '',
              vigenciaFim: agreement.validUntil ?? '',
              ativo: agreement.active,
            },
          }
        : { id: null, form: { ...emptyAgreement } },
    )
  }

  const setField = (field: keyof PriceAgreementInput, value: string | boolean) =>
    setEditing((current) => (current ? { ...current, form: { ...current.form, [field]: value } } : current))

  const periodText = summary
    ? `${new Date(summary.period.from).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} a ${new Date(
        new Date(summary.period.to).getTime() - 1,
      ).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`
    : ''

  return (
    <>
      <p className="module-notice">
        Valores pelo custo médio: cada entrada soma o valor pago, e cada saída (inclusive a baixa automática das entregas)
        sai pelo custo médio do momento. Visível só para o Administrador e o Operador SLM.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <FilterBar
        label="Período dos valores"
        canClear={Boolean(from || to)}
        onClear={() => {
          setFrom('')
          setTo('')
        }}
      >
        <label className="ui-filter-field">
          <span>De</span>
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="ui-filter-field">
          <span>Até</span>
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
      </FilterBar>

      {!summary && !error && <Loading label="Carregando valores..." />}
      {summary && (
        <>
          <section className="ui-metrics" aria-label="Valores do Almoxarifado">
            <StatCard
              icon="money"
              tone="white"
              label="Valor em estoque"
              value={formatMoney(summary.stockValue)}
              description={`Agora, em ${summary.materialsInStock} ${summary.materialsInStock === 1 ? 'material' : 'materiais'} com saldo`}
            />
            <StatCard icon="add" tone="white" label="Compras" value={formatMoney(summary.purchases)} description={`Entradas com valor pago, ${periodText}`} />
            <StatCard icon="stock" tone="white" label="Consumo" value={formatMoney(summary.consumption)} description={`Saídas pelo custo médio, ${periodText}`} />
            <StatCard
              icon="scales"
              tone="white"
              label="Saldo das atas vigentes"
              value={formatMoney(summary.agreementsBalance)}
              description={`Gasto ${formatMoney(summary.agreementsSpent)} de ${formatMoney(summary.agreementsTotal)}`}
            />
          </section>

          {summary.materialsWithoutValue > 0 && (
            <Alert tone="warning">
              {summary.materialsWithoutValue === 1
                ? '1 material tem saldo e ainda não tem valor.'
                : `${summary.materialsWithoutValue} materiais têm saldo e ainda não têm valor.`}{' '}
              Informe o valor em <Link to="/almoxarifado/estoque">Estoque interno</Link>, no botão "Informar valor" de cada
              material, para o valor do estoque ficar completo.
            </Alert>
          )}

          <section className="ui-card ui-stacked" aria-labelledby="finance-agreements">
            <div className="ui-card-heading">
              <h2 id="finance-agreements">Atas de registro de preços</h2>
              <button type="button" className="maintenance-secondary-button" onClick={() => edit(null)}>
                <Icon name="add" size={18} />
                Nova ata
              </button>
            </div>
            {summary.agreements.length === 0 ? (
              <EmptyState icon="scales" title="Nenhuma ata cadastrada">
                Cadastre as atas com o valor disponível. Ao registrar uma entrada no estoque, escolha a ata: o gasto e o saldo
                aparecem aqui.
              </EmptyState>
            ) : (
              <div className="data-table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Ata</th>
                      <th>Vigência</th>
                      <th>Situação</th>
                      <th>Valor da ata</th>
                      <th>Gasto</th>
                      <th>Saldo</th>
                      <th>Usado</th>
                      <th>
                        <span className="visually-hidden">Ações</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.agreements.map((agreement) => (
                      <tr key={agreement.id}>
                        <td>
                          {agreement.number}
                          {agreement.supplier && <small className="central-subtext">{agreement.supplier}</small>}
                          {agreement.subject && <small className="central-subtext">{agreement.subject}</small>}
                        </td>
                        <td>
                          {day(agreement.validFrom)} a {day(agreement.validUntil)}
                        </td>
                        <td>{situationLabels[agreement.situation]}</td>
                        <td>{formatMoney(agreement.total)}</td>
                        <td>{formatMoney(agreement.spent)}</td>
                        <td>
                          {formatMoney(agreement.balance)}
                          {agreement.balance < 0 && <span className="central-flag central-flag-late">Acima da ata</span>}
                        </td>
                        <td>{agreement.usedPercent === null ? '—' : `${agreement.usedPercent.toLocaleString('pt-BR')}%`}</td>
                        <td>
                          <button type="button" className="central-link-button" onClick={() => edit(agreement)}>
                            Editar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="ui-card ui-stacked" aria-labelledby="finance-monthly">
            <h2 id="finance-monthly">Compras e consumo por mês</h2>
            {summary.monthly.length === 0 ? (
              <EmptyState icon="money" title="Nenhuma movimentação com valor no período" />
            ) : (
              <div className="data-table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Mês</th>
                      <th>Compras</th>
                      <th>Consumo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.monthly.map((row) => (
                      <tr key={row.month}>
                        <td>{monthName(row.month)}</td>
                        <td>{formatMoney(row.purchases)}</td>
                        <td>{formatMoney(row.consumption)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="ui-grid-2">
            <section className="ui-card ui-stacked" aria-labelledby="finance-expensive">
              <h2 id="finance-expensive">Materiais mais caros (por unidade)</h2>
              {summary.mostExpensive.length === 0 ? (
                <EmptyState icon="money" title="Nenhum material com valor ainda" />
              ) : (
                <div className="data-table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Material</th>
                        <th>Custo médio</th>
                        <th>Último preço pago</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.mostExpensive.map((item) => (
                        <tr key={item.id}>
                          <td>{item.name}</td>
                          <td>{item.averageCost === null ? '—' : `${formatMoney(item.averageCost)} / ${item.unit}`}</td>
                          <td>{item.lastPrice === null ? '—' : `${formatMoney(item.lastPrice)} / ${item.unit}`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="ui-card ui-stacked" aria-labelledby="finance-top">
              <h2 id="finance-top">Maiores gastos no período</h2>
              {summary.topSpend.length === 0 ? (
                <EmptyState icon="money" title="Nenhuma compra com valor no período" />
              ) : (
                <div className="data-table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Material</th>
                        <th>Quantidade comprada</th>
                        <th>Total pago</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.topSpend.map((item) => (
                        <tr key={item.name}>
                          <td>{item.name}</td>
                          <td>
                            {item.quantity.toLocaleString('pt-BR')} {item.unit}
                          </td>
                          <td>{formatMoney(item.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="ui-card ui-stacked" aria-labelledby="finance-sectors">
              <h2 id="finance-sectors">Consumo por setor (R$)</h2>
              {summary.bySector.length === 0 ? (
                <EmptyState icon="money" title="Nenhuma entrega com baixa no período" />
              ) : (
                <BarChart rows={summary.bySector.map((row) => ({ label: row.sector, value: row.value }))} />
              )}
            </section>

            <section className="ui-card ui-stacked" aria-labelledby="finance-stock">
              <h2 id="finance-stock">Onde está o valor do estoque</h2>
              {summary.highestStockValue.length === 0 ? (
                <EmptyState icon="money" title="Nenhum material com valor em estoque" />
              ) : (
                <div className="data-table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Material</th>
                        <th>Saldo</th>
                        <th>Valor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.highestStockValue.map((item) => (
                        <tr key={item.id}>
                          <td>{item.name}</td>
                          <td>
                            {item.quantity.toLocaleString('pt-BR')} {item.unit}
                          </td>
                          <td>{formatMoney(item.stockValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </>
      )}

      {editing && (
        <Modal title={editing.id ? 'Editar ata' : 'Nova ata de registro de preços'} onClose={() => setEditing(null)}>
          <form className="ui-stacked" onSubmit={(event) => void saveAgreement(event)}>
            <label className="maintenance-form-field">
              <span>Número da ata *</span>
              <input required maxLength={60} value={editing.form.numero} onChange={(event) => setField('numero', event.target.value)} />
            </label>
            <label className="maintenance-form-field">
              <span>Fornecedor</span>
              <input maxLength={200} value={editing.form.fornecedor} onChange={(event) => setField('fornecedor', event.target.value)} />
            </label>
            <label className="maintenance-form-field">
              <span>Objeto</span>
              <input maxLength={500} value={editing.form.objeto} onChange={(event) => setField('objeto', event.target.value)} />
            </label>
            <label className="maintenance-form-field">
              <span>Valor total da ata (R$) *</span>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                required
                value={editing.form.valorTotal}
                onChange={(event) => setField('valorTotal', event.target.value)}
              />
            </label>
            <label className="maintenance-form-field">
              <span>Início da vigência</span>
              <input type="date" value={editing.form.vigenciaInicio} onChange={(event) => setField('vigenciaInicio', event.target.value)} />
            </label>
            <label className="maintenance-form-field">
              <span>Fim da vigência</span>
              <input type="date" value={editing.form.vigenciaFim} onChange={(event) => setField('vigenciaFim', event.target.value)} />
            </label>
            <label className="parameter-check">
              <input type="checkbox" checked={editing.form.ativo} onChange={(event) => setField('ativo', event.target.checked)} />
              <span>Ata ativa (aparece na entrada de materiais)</span>
            </label>
            {formError && <Alert tone="error">{formError}</Alert>}
            <button type="submit" className="maintenance-primary-button">
              Salvar
            </button>
          </form>
        </Modal>
      )}
    </>
  )
}
