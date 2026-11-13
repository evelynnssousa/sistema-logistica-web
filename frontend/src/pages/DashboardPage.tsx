import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  errorMessage,
  getDashboard,
  moduleLabels,
  statusLabels,
  warehouseStatusLabels,
} from '../api/modulesApi'
import type { DashboardResponse, Rate } from '../api/modulesApi'
import { formatMoney, getWarehouseFinance } from '../api/operationsApi'
import { usePeriodFilter } from '../app/period'
import { useAuthenticatedUser } from '../auth/UserContext'
import StatCard from '../components/StatCard'
import { BarChart, LineChart, MonthlyChart } from '../components/ui/Charts'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, FilterSelect, PeriodFields } from '../components/ui/Filters'
import PageHeader from '../components/ui/PageHeader'

function sum(values: Record<string, number>) {
  return Object.values(values).reduce((total, value) => total + value, 0)
}

/** Período anterior do mesmo tamanho, logo antes do escolhido. Sem início ("todo o período"), não há. */
function previousRange(from?: string, to?: string) {
  if (!from) return null
  const start = new Date(from).getTime()
  const end = to ? new Date(to).getTime() : Date.now()
  if (!(end > start)) return null
  return { from: new Date(start - (end - start)).toISOString(), to: new Date(start - 1).toISOString() }
}

/** Variação percentual; sem base no período anterior, não há comparação. */
function change(current: number, previous: number | undefined) {
  if (previous === undefined || previous === 0) return null
  return Math.round(((current - previous) / previous) * 1000) / 10
}

const percentText = (value: number, total: number) =>
  total > 0 ? `${((value / total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% do total` : 'Sem base'

function rateValue(rate: Rate | null | undefined) {
  return rate && rate.percent !== null ? `${rate.percent.toLocaleString('pt-BR')}%` : '—'
}

function DashboardPage() {
  const user = useAuthenticatedUser()
  const period = usePeriodFilter()
  const [module, setModule] = useState('')
  const [data, setData] = useState<DashboardResponse | null>(null)
  const [previous, setPrevious] = useState<DashboardResponse | null>(null)
  const [agreements, setAgreements] = useState<{ spent: number; total: number } | null>(null)
  const [error, setError] = useState('')
  const { from, to } = period.range
  const seesValues = user?.permissions.includes('warehouse:finance') === true

  // Comparação: o mesmo painel no período anterior. Falhar aqui não esconde o painel.
  useEffect(() => {
    const range = previousRange(from, to)
    let active = true
    const load = range ? getDashboard({ module, ...range }) : Promise.resolve(null)
    load
      .then((result) => {
        if (active) setPrevious(result)
      })
      .catch(() => {
        if (active) setPrevious(null)
      })
    return () => {
      active = false
    }
  }, [module, from, to])

  // Atas do Almoxarifado: só para quem vê valores. Sem a migração 020, o cartão não aparece.
  useEffect(() => {
    if (!seesValues) return
    let active = true
    getWarehouseFinance({})
      .then((result) => {
        if (active) setAgreements({ spent: result.summary.agreementsSpent, total: result.summary.agreementsTotal })
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [seesValues])

  useEffect(() => {
    let active = true
    getDashboard({ module, from, to })
      .then((result) => {
        if (!active) return
        setData(result)
        setError('')
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os indicadores.'))
      })
    return () => {
      active = false
    }
  }, [module, from, to])

  const moduleOptions = Object.entries(moduleLabels)
    .filter(([key]) => user?.permissions.includes(`${key}:read`))
    .map(([value, label]) => ({ value, label }))

  const byModule = data
    ? [
        ...Object.entries(data.byModule).map(([key, statuses]) => ({
          label: moduleLabels[key],
          value: sum(statuses),
        })),
        ...(data.warehouse ? [{ label: moduleLabels.warehouse, value: sum(data.warehouse) }] : []),
      ]
    : []

  const byStatus = data
    ? Object.values(
        Object.values(data.byModule).reduce<Record<string, { label: string; value: number }>>(
          (rows, statuses) => {
            for (const [status, total] of Object.entries(statuses)) {
              const label = statusLabels[status] ?? status
              rows[label] = { label, value: (rows[label]?.value ?? 0) + total }
            }
            return rows
          },
          {},
        ),
      ).sort((first, second) => second.value - first.value)
    : []

  const warehouseRows = Object.entries(data?.warehouse ?? {}).map(([status, value]) => ({
    label: warehouseStatusLabels[status] ?? status,
    value,
  }))

  const hasData = byModule.some((row) => row.value > 0)

  return (
    <div className="dashboard-page">
      <PageHeader
        title="Dashboard"
        description={
          user?.permissions.includes('requests:read_all')
            ? 'Indicadores operacionais de todas as solicitações que você pode acompanhar.'
            : 'Indicadores das suas solicitações.'
        }
        actions={
          user?.permissions.includes('reports:read') && (
            <Link className="maintenance-secondary-button" to="/relatorios">
              Abrir relatórios
            </Link>
          )
        }
      />

      <FilterBar
        label="Filtros do Dashboard"
        canClear={Boolean(module) || period.isActive}
        onClear={() => {
          setModule('')
          period.clear()
        }}
      >
        <PeriodFields filter={period} />
        <FilterSelect
          label="Módulo"
          value={module}
          onChange={setModule}
          options={moduleOptions}
          allLabel="Todos os módulos"
        />
      </FilterBar>

      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && <Loading label="Carregando indicadores..." />}

      {data && (
        <>
          <section className="ui-metrics" aria-label="Indicadores">
            <StatCard
              icon="requests"
              tone="black"
              label="Total de solicitações"
              value={String(data.totals.requests)}
              description="No período e módulos selecionados"
              trend={{ percent: change(data.totals.requests, previous?.totals.requests), good: 'up' }}
            />
            <StatCard
              icon="waiting"
              tone="yellow"
              label="Aguardando agendamento"
              value={String(data.totals.awaitingSchedule)}
              description={`${percentText(data.totals.awaitingSchedule, data.totals.requests)}; ${data.totals.open} em aberto`}
              trend={{ percent: change(data.totals.awaitingSchedule, previous?.totals.awaitingSchedule), good: 'down' }}
            />
            <StatCard
              icon="progress"
              tone="graphite"
              label="Em andamento"
              value={String(data.totals.inProgress)}
              description={percentText(data.totals.inProgress, data.totals.requests)}
              trend={{ percent: change(data.totals.inProgress, previous?.totals.inProgress), good: 'up' }}
            />
            <StatCard
              icon="success"
              tone="white"
              label="Concluídas"
              value={String(data.totals.concluded)}
              description={`${percentText(data.totals.concluded, data.totals.requests)}, inclusive passagens emitidas`}
              trend={{ percent: change(data.totals.concluded, previous?.totals.concluded), good: 'up' }}
            />
          </section>

          {data.rates && (
            <section className="ui-metrics" aria-label="Taxas de desempenho">
              <StatCard
                icon="progress"
                tone="white"
                label="Concluídas no prazo"
                value={rateValue(data.rates.onTime)}
                description={
                  data.rates.onTime.eligible
                    ? `${data.rates.onTime.value} de ${data.rates.onTime.eligible} concluídas com prazo definido`
                    : 'Nenhuma concluída com prazo definido'
                }
              />
              <StatCard
                icon="error"
                tone="white"
                label="Canceladas"
                value={rateValue(data.rates.cancelled)}
                description={`${data.rates.cancelled.value} de ${data.rates.cancelled.eligible} solicitações`}
                trend={{
                  percent: change(data.rates.cancelled.value, previous?.rates?.cancelled.value),
                  good: 'down',
                }}
              />
              {data.rates.warehouseComplete && (
                <StatCard
                  icon="warehouse"
                  tone="white"
                  label="Almoxarifado: atendidos por completo"
                  value={rateValue(data.rates.warehouseComplete)}
                  description={
                    data.rates.warehouseComplete.eligible
                      ? `${data.rates.warehouseComplete.value} de ${data.rates.warehouseComplete.eligible} pedidos atendidos`
                      : 'Nenhum pedido atendido no período'
                  }
                />
              )}
              {seesValues && agreements && agreements.total > 0 && (
                <StatCard
                  icon="money"
                  tone="white"
                  label="Atas do Almoxarifado: usado"
                  value={`${((agreements.spent / agreements.total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}
                  description={`${formatMoney(agreements.spent)} de ${formatMoney(agreements.total)} das atas vigentes`}
                />
              )}
            </section>
          )}

          {!hasData ? (
            <section className="ui-card">
              <EmptyState icon="overview" title="Sem dados para exibir">
                Não há registros para os filtros selecionados.
              </EmptyState>
            </section>
          ) : (
            <div className="ui-grid-2">
              {data.byPeriod.length > 0 && (
                <section className="ui-card" aria-labelledby="chart-period">
                  <h2 id="chart-period">Solicitações por mês</h2>
                  {data.byPeriod.length > 1 && data.byPeriod[0].byModule ? (
                    <LineChart
                      months={data.byPeriod.map((row) => row.month)}
                      series={[
                        { key: 'maintenance', label: 'Manutenção', color: '#2a78d6' },
                        { key: 'fleet', label: 'Frota', color: '#eb6834' },
                        { key: 'flights', label: 'Passagens', color: '#1baf7a' },
                      ]
                        .map((line) => ({ ...line, values: data.byPeriod.map((row) => row.byModule?.[line.key] ?? 0) }))
                        // Módulo sem nenhum registro no período não ganha linha zerada.
                        .filter((line) => line.values.some((value) => value > 0))}
                    />
                  ) : (
                    <MonthlyChart rows={data.byPeriod} />
                  )}
                </section>
              )}
              <section className="ui-card" aria-labelledby="chart-module">
                <h2 id="chart-module">Solicitações por módulo</h2>
                <BarChart rows={byModule} showPercent />
              </section>
              {byStatus.length > 0 && (
                <section className="ui-card" aria-labelledby="chart-status">
                  <h2 id="chart-status">Situação dos atendimentos</h2>
                  <BarChart rows={byStatus} showPercent />
                </section>
              )}
              {warehouseRows.length > 0 && (
                <section className="ui-card" aria-labelledby="chart-warehouse">
                  <h2 id="chart-warehouse">Pedidos do Almoxarifado</h2>
                  <BarChart rows={warehouseRows} showPercent />
                </section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default DashboardPage
