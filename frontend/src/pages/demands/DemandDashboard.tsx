import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { demandStatusLabels, fetchDemandDashboard, historyLabels } from '../../api/demandsApi'
import type { DemandDashboard as DashboardData } from '../../api/demandsApi'
import { errorMessage, formatCalendarDate, formatDateTime } from '../../api/modulesApi'
import { usePeriodFilter } from '../../app/period'
import StatCard from '../../components/StatCard'
import { BarChart, MonthlyChart } from '../../components/ui/Charts'
import { Alert, EmptyState, Loading } from '../../components/ui/Feedback'
import { FilterBar, FilterSelect, PeriodFields } from '../../components/ui/Filters'
import { useDemands } from './useDemands'
import { DemandMiniList } from './demandUi'

function Panel({ title, children, to }: { title: string; children: React.ReactNode; to?: string }) {
  return (
    <section className="ui-card demand-panel">
      <div className="demand-panel-heading">
        <h2>{title}</h2>
        {to && <Link to={to}>Ver todas</Link>}
      </div>
      {children}
    </section>
  )
}

function DemandDashboard() {
  const { context, options } = useDemands()
  const period = usePeriodFilter()
  const [sectorId, setSectorId] = useState('')
  const [responsibleId, setResponsibleId] = useState('')
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState('')
  const { from, to } = period.range

  useEffect(() => {
    let active = true
    fetchDemandDashboard({ sectorId, responsibleId, from, to })
      .then((result) => {
        if (!active) return
        setData(result)
        setError('')
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar o painel.'))
      })
    return () => {
      active = false
    }
  }, [sectorId, responsibleId, from, to])

  const totals = data?.totals

  return (
    <div className="demand-stack">
      <FilterBar
        label="Filtros do painel"
        canClear={Boolean(sectorId || responsibleId) || period.isActive}
        onClear={() => {
          setSectorId('')
          setResponsibleId('')
          period.clear()
        }}
      >
        <PeriodFields filter={period} />
        <FilterSelect
          label="Setor"
          value={sectorId}
          onChange={setSectorId}
          allLabel="Todos os setores"
          options={options.sectors.map((item) => ({ value: item.id, label: item.name }))}
        />
        <FilterSelect
          label="Responsável"
          value={responsibleId}
          onChange={setResponsibleId}
          allLabel="Todos os responsáveis"
          options={options.people.map((item) => ({ value: item.id, label: item.name }))}
        />
      </FilterBar>

      {options.sectors.length === 0 && (
        <Alert tone="warning">Nenhum setor cadastrado. Os setores e seus integrantes são definidos em Configurações.</Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && <Loading label="Carregando indicadores..." />}

      {data && totals && (
        <>
          <section className="ui-metrics" aria-label="Indicadores">
            <StatCard icon="requests" tone="black" label="Demandas abertas" value={String(totals.abertas)} description={`${totals.sem_responsavel} sem responsável`} />
            <StatCard icon="waiting" tone="white" label="Não iniciadas" value={String(totals.nao_iniciadas)} description="Ainda sem andamento" />
            <StatCard icon="progress" tone="graphite" label="Em andamento" value={String(totals.em_andamento)} description="Atividades em execução" />
            <StatCard icon="attention" tone="yellow" label="Em atraso" value={String(totals.atrasadas)} description="Prazo vencido" />
            <StatCard icon="users" tone="white" label="Aguardando terceiros" value={String(totals.aguardando_terceiros)} description="Providências externas" />
            <StatCard icon="locked" tone="white" label="Aguardando autorização" value={String(totals.aguardando_autorizacao)} description="Dependem de aprovação" />
            <StatCard icon="success" tone="white" label="Concluídas no mês" value={String(totals.concluidas_no_mes)} description={`${totals.concluidas} no recorte`} />
            <StatCard icon="denied" tone="white" label="Canceladas" value={String(totals.canceladas)} description="Disponíveis para consulta" />
          </section>

          {totals.total === 0 ? (
            <section className="ui-card">
              <EmptyState icon="requests" title="Nenhuma demanda para mostrar">
                Os indicadores aparecem assim que houver demandas visíveis para você neste recorte.
              </EmptyState>
            </section>
          ) : (
            <div className="demand-grid">
              <Panel title="Por setor">
                <BarChart rows={data.bySector} />
              </Panel>
              <Panel title="Por situação">
                <BarChart rows={data.byStatus.map((row) => ({ label: demandStatusLabels[row.status] ?? row.status, value: row.value }))} />
              </Panel>
              <Panel title="Por responsável">
                <BarChart rows={data.byResponsible.slice(0, 10)} />
              </Panel>
              <Panel title="Abertas por mês">
                {data.monthly.length > 0 ? (
                  <MonthlyChart rows={data.monthly.map((row) => ({ month: row.mes, total: row.abertas }))} />
                ) : (
                  <p className="demand-muted">Sem dados no recorte.</p>
                )}
              </Panel>
            </div>
          )}

          <div className="demand-grid">
            <Panel title="Atrasadas" to="/demandas/todas?overdue=true">
              <DemandMiniList demands={data.overdue} empty="Nenhuma demanda atrasada." />
            </Panel>
            <Panel title="Próximas do vencimento">
              <DemandMiniList demands={data.dueSoon} empty="Nenhum prazo nos próximos 7 dias." />
            </Panel>
            <Panel title="Atividades prioritárias">
              <DemandMiniList demands={data.priority} empty="Nenhuma atividade de prioridade alta ou urgente." />
            </Panel>
            <Panel title="Sem responsável" to="/demandas/todas?unassigned=true">
              <DemandMiniList demands={data.unassigned} empty="Todas as demandas têm responsável." />
            </Panel>
            <Panel title="Aguardando providências externas">
              <DemandMiniList demands={data.waiting} empty="Nenhuma demanda aguardando terceiros ou autorização." />
            </Panel>
            <Panel title="Próximas atividades recorrentes">
              {data.recurring.length === 0 ? (
                <p className="demand-muted">Nenhuma recorrência ativa.</p>
              ) : (
                <ul className="demand-mini-list">
                  {data.recurring.map((item) => (
                    <li key={item.seriesId}>
                      <div>
                        <strong>{item.title}</strong>
                        <span>{item.description}</span>
                      </div>
                      <span className="demand-due">{formatCalendarDate(item.nextDate)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Últimas atualizações">
              {data.updates.length === 0 ? (
                <p className="demand-muted">Nenhuma atualização.</p>
              ) : (
                <ul className="demand-mini-list">
                  {data.updates.map((item) => (
                    <li key={item.id}>
                      <Link to={`/demandas/${item.demandId}`}>
                        <strong>{historyLabels[item.action] ?? item.action}</strong>
                        <span>
                          {item.number} · {item.title} · {item.user ?? 'Sistema'}
                        </span>
                      </Link>
                      <small className="demand-muted">{formatDateTime(item.at)}</small>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          {context.consultationOnly && (
            <p className="demand-muted">Acesso administrativo: inclui demandas restritas, somente para consulta.</p>
          )}
          {context.directorate && <p className="demand-muted">Visão de todos os setores, inclusive demandas restritas.</p>}
        </>
      )}
    </div>
  )
}

export default DemandDashboard
