import { useEffect, useState } from 'react'
import {
  errorMessage,
  getOperationalReport,
  getReport,
  moduleLabels,
  statusLabels,
  warehouseStatusLabels,
} from '../api/modulesApi'
import type { OperationalReport } from '../api/modulesApi'
import { getCentralTeam, getPerformanceReport } from '../api/operationsApi'
import type { PerformanceReport, TeamMember } from '../api/operationsApi'
import { useHasPermission } from '../auth/UserContext'
import { usePeriodFilter } from '../app/period'
import { useCatalog } from '../app/useCatalog'
import StatCard from '../components/StatCard'
import { BarChart, MonthlyChart } from '../components/ui/Charts'
import type { ChartRow } from '../components/ui/Charts'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, FilterSelect, PeriodFields } from '../components/ui/Filters'
import Icon from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'

type Report = Awaited<ReturnType<typeof getReport>>

function Bars({ rows }: { rows: ChartRow[] }) {
  return rows.length === 0 ? (
    <EmptyState icon="reports" title="Sem dados para exibir" />
  ) : (
    <BarChart rows={rows} />
  )
}

function statusRows(report: Report) {
  const rows: { module: string; status: string; total: number }[] = []
  for (const [module, statuses] of Object.entries(report.byModule)) {
    for (const [status, total] of Object.entries(statuses)) {
      rows.push({ module: moduleLabels[module], status: statusLabels[status] ?? status, total })
    }
  }
  for (const [status, total] of Object.entries(report.warehouse ?? {})) {
    rows.push({
      module: moduleLabels.warehouse,
      status: warehouseStatusLabels[status] ?? status,
      total,
    })
  }
  return rows
}

/** Só o que está na tela, já restrito ao alcance de quem consulta. */
function originLabel(origin: string) {
  return origin === 'governamental' ? 'Sistema governamental' : 'Sistema JUCESP'
}

function duration(minutes: number | null) {
  if (minutes === null) return 'Sem dados'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ${minutes % 60} min`
  return `${Math.round(hours / 24)} dias`
}

function PerformanceSection({ data }: { data: PerformanceReport }) {
  const times = [
    { label: 'Até o agendamento', help: 'Da abertura ao primeiro agendamento', value: data.times.untilSchedule },
    { label: 'Espera até o início', help: 'Da abertura ao início real', value: data.times.waitUntilStart },
    { label: 'Atendimento efetivo', help: 'Do início real ao término real', value: data.times.effectiveService },
    { label: 'Resolução total', help: 'Da abertura à conclusão', value: data.times.totalResolution },
  ]
  return (
    <section className="ui-card ui-stacked" aria-labelledby="report-performance">
      <h2 id="report-performance">Desempenho</h2>
      <dl className="indicator-list">
        <div><dt>Recebidas</dt><dd>{data.received}</dd></div>
        <div><dt>Concluídas</dt><dd>{data.concluded}</dd></div>
        <div><dt>Pendentes</dt><dd>{data.pending}</dd></div>
        <div><dt>Atrasadas</dt><dd>{data.late}</dd></div>
        <div><dt>Cancelamentos</dt><dd>{data.cancelled}</dd></div>
        <div><dt>Reagendamentos</dt><dd>{data.rescheduled}</dd></div>
        <div>
          <dt>Cumprimento de prazos</dt>
          <dd>{data.deadlines.percent === null ? 'Sem dados' : `${data.deadlines.percent.toLocaleString('pt-BR')}%`}</dd>
          <small>{data.deadlines.onTime} de {data.deadlines.withDeadline} concluídas com prazo</small>
        </div>
      </dl>
      <h3>Tempos médios</h3>
      <dl className="indicator-list">
        {times.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{duration(item.value.minutes)}</dd>
            <small>{item.help}. Base: {item.value.basedOn}.</small>
          </div>
        ))}
      </dl>
      {data.byCategory.length > 0 && (
        <>
          <h3>Manutenção por categoria</h3>
          <BarChart rows={data.byCategory.map((row) => ({ label: row.category, value: row.total }))} />
        </>
      )}
      {data.monthly.length > 0 && (
        <>
          <h3>Evolução mensal</h3>
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>Mês</th><th>Recebidas</th><th>Concluídas</th></tr>
              </thead>
              <tbody>
                {data.monthly.map((row) => (
                  <tr key={row.month}><td>{row.month}</td><td>{row.received}</td><td>{row.concluded}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {data.productivity && (
        <>
          <h3>Atendimentos por responsável</h3>
          <p className="management-hint">
            Quantidade, complexidade e tempo são informações diferentes e não formam uma nota. Solicitações sem
            classificação de complexidade aparecem separadas.
          </p>
          {data.productivity.length === 0 ? (
            <EmptyState icon="users" title="Nenhuma solicitação com responsável neste período" />
          ) : (
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Responsável</th>
                    <th>Concluídas</th>
                    <th>Em aberto</th>
                    <th>Complexidade das concluídas</th>
                    <th>Atendimento efetivo médio</th>
                  </tr>
                </thead>
                <tbody>
                  {data.productivity.map((row) => (
                    <tr key={row.responsible}>
                      <td>{row.responsible}</td>
                      <td>{row.concluded}</td>
                      <td>{row.open}</td>
                      <td>
                        {row.complexity.simple} simples, {row.complexity.medium} médias, {row.complexity.complex} complexas,{' '}
                        {row.complexity.unclassified} sem classificação
                      </td>
                      <td>
                        {duration(row.effectiveMinutes)}
                        <small className="central-subtext">Base: {row.basedOn}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function ReportsPage() {
  const { catalog } = useCatalog()
  const period = usePeriodFilter()
  const { from, to } = period.range
  const [module, setModule] = useState('')
  const [sectorId, setSectorId] = useState('')
  const [report, setReport] = useState<Report | null>(null)
  const [operational, setOperational] = useState<OperationalReport | null>(null)
  const [performance, setPerformance] = useState<PerformanceReport | null>(null)
  const canSeeTeam = useHasPermission('slm_central:read')
  const [team, setTeam] = useState<TeamMember[]>([])
  const [responsibleId, setResponsibleId] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!canSeeTeam) return
    let active = true
    getCentralTeam()
      .then((data) => {
        if (active) setTeam(data.team)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [canSeeTeam])

  useEffect(() => {
    let active = true
    getReport({
      module,
      sectorId,
      from,
      to,
    })
      .then((data) => {
        if (!active) return
        setReport(data)
        setError('')
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar o relatório.'))
      })
    getOperationalReport({ module, sectorId, from, to })
      .then((data) => {
        if (active) setOperational(data)
      })
      .catch(() => {
        // Os demais indicadores continuam disponíveis.
        if (active) setOperational(null)
      })
    getPerformanceReport({ module, sectorId, from, to, responsibleId, status })
      .then((data) => {
        if (active) setPerformance(data)
      })
      .catch(() => {
        if (active) setPerformance(null)
      })
    return () => {
      active = false
    }
  }, [from, to, module, sectorId, responsibleId, status])

  const rows = report ? statusRows(report) : []

  return (
    <div className="admin-module-page reports-page">
      <PageHeader
        title="Relatórios"
        description="Indicadores calculados diretamente dos registros dos módulos."
        actions={
          <>
            <button className="maintenance-secondary-button no-print" type="button" disabled={!report} onClick={() => window.print()}>
              <Icon name="reports" size={18} />
              Imprimir ou salvar em PDF
            </button>
            {/* Planilha geral (.xlsx) gerada no servidor, com os mesmos filtros da tela. */}
            <a
              className="maintenance-primary-button no-print"
              href={`/api/reports/general/spreadsheet?${new URLSearchParams(
                Object.entries({ from, to, module, sectorId, responsibleId, status }).filter(
                  (entry): entry is [string, string] => Boolean(entry[1]),
                ),
              ).toString()}`}
              download
            >
              <Icon name="download" size={18} />
              Baixar planilha (Excel)
            </a>
          </>
        }
      />

      <FilterBar
        label="Filtros de relatórios"
        canClear={Boolean(module || sectorId || responsibleId || status) || period.isActive}
        onClear={() => {
          setModule('')
          setSectorId('')
          setResponsibleId('')
          setStatus('')
          period.clear()
        }}
      >
        <PeriodFields filter={period} />
        <FilterSelect
          label="Módulo"
          value={module}
          onChange={setModule}
          allLabel="Todos os módulos"
          options={Object.entries(moduleLabels).map(([value, label]) => ({ value, label }))}
        />
        <FilterSelect
          label="Setor"
          value={sectorId}
          onChange={setSectorId}
          allLabel="Todos os setores"
          options={catalog.sectors.map((sector) => ({ value: sector.id, label: sector.label }))}
        />
        <FilterSelect
          label="Situação"
          value={status}
          onChange={setStatus}
          allLabel="Todas as situações"
          options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))}
        />
        {canSeeTeam && (
          <FilterSelect
            label="Responsável"
            value={responsibleId}
            onChange={setResponsibleId}
            allLabel="Todos"
            options={team.map((member) => ({ value: member.id, label: member.name }))}
          />
        )}
      </FilterBar>


      {error && <Alert tone="error">{error}</Alert>}
      {!report && !error && <Loading label="Carregando relatório..." />}

      {report && (
        <>
          <section className="ui-metrics" aria-label="Indicadores">
            <StatCard
              icon="requests"
              tone="black"
              label="Total de solicitações"
              value={String(report.totals.requests)}
              description="No período selecionado"
            />
            <StatCard
              icon="waiting"
              tone="yellow"
              label="Solicitações em aberto"
              value={String(report.totals.open)}
              description="Ainda não concluídas nem canceladas"
            />
            <StatCard
              icon="success"
              tone="white"
              label="Concluídas ou emitidas"
              value={String(report.totals.concluded)}
              description="No período selecionado"
            />
          </section>

          <div className="ui-grid-2">
            <section className="ui-card reports-chart" aria-labelledby="report-period">
              <h2 id="report-period">Solicitações por mês</h2>
              {report.byPeriod.length === 0 ? (
                <EmptyState icon="reports" title="Sem dados para exibir" />
              ) : (
                <MonthlyChart rows={report.byPeriod} />
              )}
            </section>
            <section className="ui-card reports-chart" aria-labelledby="report-status">
              <h2 id="report-status">Distribuição por situação</h2>
              <Bars rows={rows.map((row) => ({ label: `${row.module}: ${row.status}`, value: row.total }))} />
            </section>
            <section className="ui-card reports-chart" aria-labelledby="report-sector">
              <h2 id="report-sector">Solicitações por setor</h2>
              <Bars rows={report.bySector.map((row) => ({ label: row.sector, value: row.total }))} />
            </section>
            <section className="ui-card reports-chart" aria-labelledby="report-materials">
              <h2 id="report-materials">Materiais mais solicitados</h2>
              <Bars
                rows={report.materials.map((row) => ({
                  label: `${row.material} (${row.unit})`,
                  value: row.requested,
                }))}
              />
            </section>
          </div>

          {performance && <PerformanceSection data={performance} />}

          {operational && (
            <section className="ui-card ui-stacked operational-report" aria-labelledby="report-operational">
              <h2 id="report-operational">Agendamentos e execução</h2>
              <dl>
                <div><dt>Agendamentos</dt><dd>{operational.scheduling.scheduled}</dd></div>
                <div><dt>Reagendamentos</dt><dd>{operational.scheduling.rescheduled}</dd></div>
                <div><dt>Cancelamentos</dt><dd>{operational.scheduling.cancelled}</dd></div>
                {operational.fleet && (
                  <>
                    <div><dt>Execuções de frota</dt><dd>{operational.fleet.executions}</dd></div>
                    <div><dt>Ocorrências de frota</dt><dd>{operational.fleet.occurrences}</dd></div>
                    <div><dt>Atrasos de frota</dt><dd>{operational.fleet.delays}</dd></div>
                  </>
                )}
                {operational.warehouse?.byOrigin.map((row) => (
                  <div key={row.origin}><dt>Pedidos: {originLabel(row.origin)}</dt><dd>{row.total}</dd></div>
                ))}
                {operational.warehouse && (
                  <div><dt>Atendidos parcialmente</dt><dd>{operational.warehouse.partial}</dd></div>
                )}
                {operational.inventory && (
                  <>
                    <div><dt>Conferências de inventário</dt><dd>{operational.inventory.checks}</dd></div>
                    <div><dt>Itens contados</dt><dd>{operational.inventory.counted} de {operational.inventory.items}</dd></div>
                    <div><dt>Itens com divergência</dt><dd>{operational.inventory.divergent}</dd></div>
                  </>
                )}
              </dl>

              {operational.serviceTime.map((row) => (
                <p className="report-limitation" key={row.module}>
                  <strong>Tempo de atendimento em {moduleLabels[row.module]}:</strong>{' '}
                  {row.averageMinutes === null
                    ? `sem dados. Nenhuma das ${row.concluded} concluídas tem início e término reais registrados.`
                    : `média de ${row.averageMinutes} minutos, calculada sobre ${row.withData} de ${row.concluded} concluídas. As demais não têm início e término reais registrados.`}
                </p>
              ))}
              {operational.fleetUsage && (
                <>
                  <h3>Utilização e quilometragem por veículo</h3>
                  {operational.fleetUsage.length === 0 ? (
                    <p>Nenhum registro de veículo no período.</p>
                  ) : (
                    <div className="data-table-wrapper">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Veículo</th>
                            <th>Usos</th>
                            <th>Quilômetros</th>
                            <th>Ocorrências</th>
                            <th>Abastecimentos</th>
                            <th>Manutenções</th>
                          </tr>
                        </thead>
                        <tbody>
                          {operational.fleetUsage.map((row) => (
                            <tr key={row.vehicle}>
                              <td>{row.vehicle}</td>
                              <td>{row.uses}</td>
                              <td>{row.kilometers ?? 'Sem dados'}</td>
                              <td>{row.occurrences}</td>
                              <td>{row.fuelings}</td>
                              <td>{row.maintenances}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              {operational.stockFlow && (
                <>
                  <h3>Consumo do estoque interno</h3>
                  {operational.stockFlow.length === 0 ? (
                    <p>Nenhuma movimentação de estoque no período.</p>
                  ) : (
                    <div className="data-table-wrapper">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Material</th>
                            <th>Unidade</th>
                            <th>Entradas</th>
                            <th>Saídas</th>
                          </tr>
                        </thead>
                        <tbody>
                          {operational.stockFlow.map((row) => (
                            <tr key={row.material}>
                              <td>{row.material}</td>
                              <td>{row.unit}</td>
                              <td>{row.entries}</td>
                              <td>{row.exits}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              <p className="report-limitation">
                O período considera a data de abertura de cada solicitação. Não há estimativas: só entram registros com os dados necessários.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  )
}

export default ReportsPage
