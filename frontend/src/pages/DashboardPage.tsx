import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  errorMessage,
  getDashboard,
  moduleLabels,
  statusLabels,
  warehouseStatusLabels,
} from '../api/modulesApi'
import type { DashboardResponse } from '../api/modulesApi'
import { usePeriodFilter } from '../app/period'
import { useAuthenticatedUser } from '../auth/UserContext'
import StatCard from '../components/StatCard'
import { BarChart, MonthlyChart } from '../components/ui/Charts'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, FilterSelect, PeriodFields } from '../components/ui/Filters'
import PageHeader from '../components/ui/PageHeader'

function sum(values: Record<string, number>) {
  return Object.values(values).reduce((total, value) => total + value, 0)
}

function DashboardPage() {
  const user = useAuthenticatedUser()
  const period = usePeriodFilter()
  const [module, setModule] = useState('')
  const [data, setData] = useState<DashboardResponse | null>(null)
  const [error, setError] = useState('')
  const { from, to } = period.range

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
            />
            <StatCard
              icon="waiting"
              tone="yellow"
              label="Aguardando agendamento"
              value={String(data.totals.awaitingSchedule)}
              description={`${data.totals.open} em aberto no total`}
            />
            <StatCard
              icon="progress"
              tone="graphite"
              label="Em andamento"
              value={String(data.totals.inProgress)}
              description="Atendimentos iniciados"
            />
            <StatCard
              icon="success"
              tone="white"
              label="Concluídas"
              value={String(data.totals.concluded)}
              description="Atendimentos concluídos e passagens emitidas"
            />
          </section>

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
                  <MonthlyChart rows={data.byPeriod} />
                </section>
              )}
              <section className="ui-card" aria-labelledby="chart-module">
                <h2 id="chart-module">Solicitações por módulo</h2>
                <BarChart rows={byModule} />
              </section>
              {byStatus.length > 0 && (
                <section className="ui-card" aria-labelledby="chart-status">
                  <h2 id="chart-status">Situação dos atendimentos</h2>
                  <BarChart rows={byStatus} />
                </section>
              )}
              {warehouseRows.length > 0 && (
                <section className="ui-card" aria-labelledby="chart-warehouse">
                  <h2 id="chart-warehouse">Pedidos do Almoxarifado</h2>
                  <BarChart rows={warehouseRows} />
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
