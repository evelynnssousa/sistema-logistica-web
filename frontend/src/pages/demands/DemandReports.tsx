import { useEffect, useMemo, useState } from 'react'
import { demandPriorityLabels, demandReportUrl, demandStatusLabels, demandStatusOrder, fetchDemandReport } from '../../api/demandsApi'
import type { DemandFilterValues, DemandReport, DemandReportGroup, DemandStatus } from '../../api/demandsApi'
import { errorMessage } from '../../api/modulesApi'
import { usePeriodFilter } from '../../app/period'
import StatCard from '../../components/StatCard'
import { BarChart, MonthlyChart } from '../../components/ui/Charts'
import { Alert, EmptyState, Loading } from '../../components/ui/Feedback'
import { FilterBar, FilterSelect, PeriodFields } from '../../components/ui/Filters'
import Icon from '../../components/ui/Icon'
import AccessDeniedPage from '../AccessDeniedPage'
import { useDemands } from './useDemands'

const flagOptions = [
  { value: 'true', label: 'Sim' },
  { value: 'false', label: 'Não' },
]

function GroupTable({ title, rows, labels }: { title: string; rows: DemandReportGroup[]; labels?: Record<string, string> }) {
  return (
    <section className="ui-card demand-panel">
      <div className="demand-panel-heading">
        <h2>{title}</h2>
      </div>
      {rows.length === 0 ? (
        <p className="demand-muted">Sem dados no recorte.</p>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Total</th>
                <th>Abertas</th>
                <th>Atrasadas</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <td>{labels?.[row.label] ?? row.label}</td>
                  <td>{row.total}</td>
                  <td>{row.open}</td>
                  <td>{row.overdue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function DemandReports() {
  const { context, options } = useDemands()
  const period = usePeriodFilter()
  const [sectorId, setSectorId] = useState('')
  const [responsibleId, setResponsibleId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [priority, setPriority] = useState('')
  const [status, setStatus] = useState('')
  const [recurring, setRecurring] = useState('')
  const [shared, setShared] = useState('')
  const [data, setData] = useState<DemandReport | null>(null)
  const [error, setError] = useState('')
  const { from, to } = period.range

  const filters = useMemo<DemandFilterValues>(
    () => ({ sectorId, responsibleId, categoryId, priority, status, recurring, shared, from, to }),
    [sectorId, responsibleId, categoryId, priority, status, recurring, shared, from, to],
  )

  useEffect(() => {
    if (!context.canSeeReports) return
    let active = true
    fetchDemandReport(filters)
      .then((result) => {
        if (!active) return
        setData(result)
        setError('')
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar o relatório.'))
      })
    return () => {
      active = false
    }
  }, [filters, context.canSeeReports])

  if (!context.canSeeReports) return <AccessDeniedPage />

  const totals = data?.totals
  const number = (value: number | null | undefined) => String(value ?? 0)

  return (
    <div className="demand-stack">
      <FilterBar
        label="Filtros do relatório"
        canClear={Boolean(sectorId || responsibleId || categoryId || priority || status || recurring || shared) || period.isActive}
        onClear={() => {
          setSectorId('')
          setResponsibleId('')
          setCategoryId('')
          setPriority('')
          setStatus('')
          setRecurring('')
          setShared('')
          period.clear()
        }}
      >
        <PeriodFields filter={period} />
        <FilterSelect label="Setor" value={sectorId} onChange={setSectorId} allLabel="Todos os setores"
          options={options.sectors.map((item) => ({ value: item.id, label: item.name }))} />
        <FilterSelect label="Responsável" value={responsibleId} onChange={setResponsibleId} allLabel="Todos os responsáveis"
          options={options.people.map((item) => ({ value: item.id, label: item.name }))} />
        <FilterSelect label="Categoria" value={categoryId} onChange={setCategoryId} allLabel="Todas as categorias"
          options={options.categories.map((item) => ({ value: item.id, label: item.name }))} />
        <FilterSelect label="Prioridade" value={priority} onChange={setPriority} allLabel="Todas as prioridades"
          options={Object.entries(demandPriorityLabels).map(([value, label]) => ({ value, label }))} />
        <FilterSelect label="Status" value={status} onChange={setStatus} allLabel="Todos os status"
          options={demandStatusOrder.map((value) => ({ value, label: demandStatusLabels[value] }))} />
        <FilterSelect label="Recorrente" value={recurring} onChange={setRecurring} allLabel="Todas" options={flagOptions} />
        <FilterSelect label="Compartilhada" value={shared} onChange={setShared} allLabel="Todas" options={flagOptions} />
      </FilterBar>

      <Alert tone="info">
        Finalidade: transparência sobre o volume e a distribuição das atividades administrativas. Estes indicadores não
        são instrumento de avaliação individual de desempenho.
      </Alert>

      <div className="report-export no-print">
        <a className="maintenance-secondary-button" href={demandReportUrl(filters, 'pdf')} download>
          <Icon name="download" size={18} />
          Exportar em PDF
        </a>
        <a className="maintenance-secondary-button" href={demandReportUrl(filters, 'xlsx')} download>
          <Icon name="download" size={18} />
          Exportar em Excel
        </a>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && <Loading label="Carregando relatório..." />}

      {data && totals && (
        totals.total === 0 ? (
          <section className="ui-card">
            <EmptyState icon="reports" title="Nenhuma demanda neste recorte" />
          </section>
        ) : (
          <>
            <section className="ui-metrics" aria-label="Indicadores do relatório">
              <StatCard icon="requests" tone="black" label="Abertas" value={number(totals.abertas)} description={`${number(totals.total)} no recorte`} />
              <StatCard icon="success" tone="white" label="Concluídas" value={number(totals.concluidas)} description="No recorte" />
              <StatCard icon="waiting" tone="graphite" label="Pendentes" value={number((totals.abertas ?? 0) - (totals.suspensas ?? 0))} description="Abertas, sem as suspensas" />
              <StatCard icon="attention" tone="yellow" label="Atrasadas" value={number(totals.atrasadas)} description="Prazo vencido" />
              <StatCard
                icon="progress"
                tone="white"
                label="Tempo médio de conclusão"
                value={totals.tempo_medio_dias === null ? '—' : `${String(totals.tempo_medio_dias).replace('.', ',')} dias`}
                description="Da abertura à conclusão"
              />
              <StatCard icon="users" tone="white" label="Aguardando terceiros" value={number(totals.aguardando_terceiros)} description="Providências externas" />
              <StatCard icon="repeat" tone="white" label="Recorrentes" value={number(totals.recorrentes)} description="Ocorrências geradas" />
              <StatCard icon="users" tone="white" label="Compartilhadas" value={number(totals.compartilhadas)} description="Com setores colaboradores" />
            </section>

            <div className="demand-grid">
              <section className="ui-card demand-panel">
                <div className="demand-panel-heading"><h2>Volume por setor</h2></div>
                <BarChart rows={data.bySector.map((row) => ({ label: row.label, value: row.total }))} />
              </section>
              <section className="ui-card demand-panel">
                <div className="demand-panel-heading"><h2>Volume por responsável</h2></div>
                <BarChart rows={data.byResponsible.slice(0, 12).map((row) => ({ label: row.label, value: row.total }))} />
              </section>
              <section className="ui-card demand-panel">
                <div className="demand-panel-heading"><h2>Evolução mensal: abertas</h2></div>
                <MonthlyChart rows={data.monthly.map((row) => ({ month: row.mes, total: row.abertas }))} />
              </section>
              <section className="ui-card demand-panel">
                <div className="demand-panel-heading"><h2>Evolução mensal: concluídas</h2></div>
                <MonthlyChart rows={data.monthly.map((row) => ({ month: row.mes, total: row.concluidas }))} />
              </section>
            </div>

            <div className="demand-grid">
              <GroupTable title="Por setor" rows={data.bySector} />
              <GroupTable title="Por responsável" rows={data.byResponsible} />
              <GroupTable title="Por categoria" rows={data.byCategory} />
              <GroupTable title="Por prioridade" rows={data.byPriority} labels={demandPriorityLabels} />
              <GroupTable title="Por status" rows={data.byStatus} labels={demandStatusLabels as Record<DemandStatus, string>} />
            </div>
          </>
        )
      )}
    </div>
  )
}

export default DemandReports
