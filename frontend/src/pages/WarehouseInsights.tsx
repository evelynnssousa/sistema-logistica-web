import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  protocolLabel,
  errorMessage,
  formatDateTime,
  getDashboard,
  getReport,
  listInventoryChecks,
  listWarehouseRequests,
  originLabels,
  warehouseStatusLabels,
} from '../api/modulesApi'
import type { InventoryCheckSummary, WarehouseRequest } from '../api/modulesApi'
import { usePeriodFilter } from '../app/period'
import { useHasPermission } from '../auth/UserContext'
import StatCard from '../components/StatCard'
import { BarChart } from '../components/ui/Charts'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, PeriodFields } from '../components/ui/Filters'
import StatusBadge from '../components/ui/StatusBadge'

const openStatuses = ['pendente', 'em_analise', 'atendido_parcial', 'atendido']

/** Só registros reais: contagens da API e os pedidos mais recentes. */
export function WarehouseOverviewTab() {
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  const [recent, setRecent] = useState<WarehouseRequest[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    Promise.all([getDashboard({ module: 'warehouse' }), listWarehouseRequests({ page: 1 })])
      .then(([summary, requests]) => {
        if (!active) return
        setCounts(summary.warehouse ?? {})
        setRecent(requests.requests.slice(0, 5))
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar o Almoxarifado.'))
      })
    return () => {
      active = false
    }
  }, [])

  if (error) return <Alert tone="error">{error}</Alert>
  if (!counts) return <Loading label="Carregando indicadores..." />

  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  const open = openStatuses.reduce((sum, status) => sum + (counts[status] ?? 0), 0)

  return (
    <>
      <section className="ui-metrics" aria-label="Indicadores do Almoxarifado">
        <StatCard icon="requests" tone="black" label="Total de pedidos" value={String(total)} description="Das duas origens" />
        <StatCard icon="waiting" tone="yellow" label="Pedidos em aberto" value={String(open)} description="Ainda sem entrega ou encerramento" />
        <StatCard icon="success" tone="white" label="Entregues" value={String(counts.entregue ?? 0)} description="Com entrega registrada" />
      </section>

      <section className="ui-card" aria-labelledby="warehouse-recent">
        <div className="ui-card-heading">
          <h2 id="warehouse-recent">Pedidos recentes</h2>
          <Link to="/almoxarifado/solicitacoes">Ver todos</Link>
        </div>
        {recent.length === 0 ? (
          <EmptyState icon="warehouse" title="Nenhum pedido ainda">
            Os pedidos de materiais aparecem aqui assim que forem registrados.
          </EmptyState>
        ) : (
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Protocolo</th>
                  <th>Origem</th>
                  <th>Setor</th>
                  <th>Situação</th>
                  <th>Data</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((request) => (
                  <tr key={request.id}>
                    <td>
                      <Link to={`/almoxarifado/pedidos/${request.id}`}>{protocolLabel(request.protocol)}</Link>
                    </td>
                    <td>{originLabels[request.origin]}</td>
                    <td>{request.sector ?? '—'}</td>
                    <td>
                      <StatusBadge status={request.status} label={warehouseStatusLabels[request.status]} />
                    </td>
                    <td>{formatDateTime(request.createdAt)}</td>
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

type ReportData = {
  warehouse: Record<string, number>
  materials: { material: string; unit: string; requested: number; fulfilled: number }[]
  origins: { label: string; value: number }[]
  checks: InventoryCheckSummary[]
}

export function WarehouseReportsTab() {
  const canManage = useHasPermission('warehouse:manage')
  const period = usePeriodFilter()
  const [data, setData] = useState<ReportData | null>(null)
  const [error, setError] = useState('')
  const { from, to } = period.range

  useEffect(() => {
    let active = true
    Promise.all([
      getReport({ module: 'warehouse', from, to }),
      listWarehouseRequests({ origin: 'interna', from, to, page: 1 }),
      listWarehouseRequests({ origin: 'governamental', from, to, page: 1 }),
      canManage ? listInventoryChecks(1) : Promise.resolve({ checks: [] }),
    ])
      .then(([report, internal, external, inventory]) => {
        if (!active) return
        setData({
          warehouse: report.warehouse ?? {},
          materials: report.materials,
          origins: [
            { label: originLabels.interna, value: internal.total },
            { label: originLabels.governamental, value: external.total },
          ],
          checks: inventory.checks.filter((check) => check.status === 'concluida'),
        })
        setError('')
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar o relatório.'))
      })
    return () => {
      active = false
    }
  }, [from, to, canManage])

  const statusRows = Object.entries(data?.warehouse ?? {}).map(([status, value]) => ({
    label: warehouseStatusLabels[status] ?? status,
    value,
  }))
  const hasOrders = (data?.origins ?? []).some((row) => row.value > 0)

  return (
    <>
      <FilterBar label="Filtros do relatório" canClear={period.isActive} onClear={period.clear}>
        <PeriodFields filter={period} />
      </FilterBar>

      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && <Loading label="Carregando relatório..." />}

      {data && !hasOrders && (
        <section className="ui-card">
          <EmptyState icon="reports" title="Sem dados para exibir">
            Não há pedidos de materiais no período selecionado.
          </EmptyState>
        </section>
      )}

      {data && hasOrders && (
        <div className="ui-grid-2">
          <section className="ui-card" aria-labelledby="warehouse-origin">
            <h2 id="warehouse-origin">Pedidos por origem</h2>
            <BarChart rows={data.origins} />
          </section>
          <section className="ui-card" aria-labelledby="warehouse-status">
            <h2 id="warehouse-status">Pedidos por situação</h2>
            <BarChart rows={statusRows} />
          </section>
          {data.materials.length > 0 && (
            <section className="ui-card" aria-labelledby="warehouse-top">
              <h2 id="warehouse-top">Materiais mais solicitados</h2>
              <BarChart
                rows={data.materials.map((row) => ({
                  label: `${row.material} (${row.unit})`,
                  value: row.requested,
                }))}
              />
            </section>
          )}
        </div>
      )}

      {data && data.checks.length > 0 && (
        <section className="ui-card ui-stacked" aria-labelledby="warehouse-checks">
          <h2 id="warehouse-checks">Divergências nas conferências concluídas</h2>
          <BarChart rows={data.checks.map((check) => ({ label: `${protocolLabel(check.protocol)} ${check.title}`, value: check.divergent }))} />
        </section>
      )}
    </>
  )
}
