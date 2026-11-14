import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchFleetMonthlySummary } from '../api/driverApi'
import type { DriverMonthHours, FleetMonthlySummary, VehicleKilometers } from '../api/driverApi'
import { errorMessage } from '../api/modulesApi'
import { useTableSort } from '../app/tableSort'
import StatCard from '../components/StatCard'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import Icon from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'
import SortableTh from '../components/ui/SortableTh'

/** Mês corrente no horário de Brasília, "AAAA-MM". */
function currentMonth() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7)
}

/** 125 → "2h05"; negativo com sinal. */
function hours(minutes: number) {
  const sign = minutes < 0 ? '−' : ''
  const absolute = Math.abs(Math.round(minutes))
  return `${sign}${Math.floor(absolute / 60)}h${String(absolute % 60).padStart(2, '0')}`
}

const km = (value: number) => `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`
const weekdayNames = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

function VehiclesTable({ rows }: { rows: VehicleKilometers[] }) {
  const table = useTableSort(rows, {
    veiculo: (row) => row.vehicle,
    viagens: (row) => row.trips,
    portal: (row) => row.tripKm,
    diario: (row) => row.logKm,
    total: (row) => row.totalKm,
  })
  return (
    <div className="data-table-wrapper">
      <table className="data-table">
        <thead>
          <tr>
            <SortableTh label="Veículo" sortKey="veiculo" sort={table.sort} onSort={table.onSort} />
            <SortableTh label="Viagens" sortKey="viagens" sort={table.sort} onSort={table.onSort} />
            <SortableTh label="Km nas viagens (portal)" sortKey="portal" sort={table.sort} onSort={table.onSort} />
            <SortableTh label="Km no diário de bordo" sortKey="diario" sort={table.sort} onSort={table.onSort} />
            <SortableTh label="Total no mês" sortKey="total" sort={table.sort} onSort={table.onSort} />
          </tr>
        </thead>
        <tbody>
          {table.sorted.map((row) => (
            <tr key={`${row.registered ? 'c' : 't'}:${row.vehicle}`}>
              <td>
                <strong>{row.vehicle}</strong>
                {row.model && <span className="demand-muted"> · {row.model}</span>}
                {!row.registered && <div className="demand-muted">Sem cadastro: como foi digitado na viagem</div>}
              </td>
              <td>
                {row.trips}
                {row.tripsWithoutOdometer > 0 && (
                  <div className="demand-muted">{row.tripsWithoutOdometer} sem hodômetro</div>
                )}
              </td>
              <td>{km(row.tripKm)}</td>
              <td>
                {km(row.logKm)}
                {row.logUses > 0 && <div className="demand-muted">{row.logUses} {row.logUses === 1 ? 'registro' : 'registros'}</div>}
              </td>
              <td><strong>{km(row.totalKm)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DriversTable({ rows }: { rows: DriverMonthHours[] }) {
  const table = useTableSort(rows, {
    motorista: (row) => row.driverName,
    dias: (row) => row.days,
    viagens: (row) => row.trips,
    trabalhadas: (row) => row.workedMinutes,
    previstas: (row) => row.expectedMinutes,
    extras: (row) => row.extraMinutes,
    menos: (row) => row.missingMinutes,
    saldo: (row) => row.balanceMinutes,
  })
  return (
    <div className="data-table-wrapper">
      <table className="data-table">
        <thead>
          <tr>
            <SortableTh label="Motorista" sortKey="motorista" sort={table.sort} onSort={table.onSort} />
            <SortableTh label="Dias com viagem" sortKey="dias" sort={table.sort} onSort={table.onSort} />
            <SortableTh label="Viagens" sortKey="viagens" sort={table.sort} onSort={table.onSort} />
            <SortableTh label="Horas trabalhadas" sortKey="trabalhadas" sort={table.sort} onSort={table.onSort} />
            <SortableTh label="Horas previstas" sortKey="previstas" sort={table.sort} onSort={table.onSort} />
            <SortableTh label="Horas a mais" sortKey="extras" sort={table.sort} onSort={table.onSort} />
            <SortableTh label="Horas a menos" sortKey="menos" sort={table.sort} onSort={table.onSort} />
            <SortableTh label="Saldo" sortKey="saldo" sort={table.sort} onSort={table.onSort} />
          </tr>
        </thead>
        <tbody>
          {table.sorted.map((row) => (
            <tr key={row.driverId}>
              <td><strong>{row.driverName}</strong></td>
              <td>{row.days}</td>
              <td>{row.trips}</td>
              <td>{hours(row.workedMinutes)}</td>
              <td>{hours(row.expectedMinutes)}</td>
              <td>{row.extraMinutes > 0 ? hours(row.extraMinutes) : '—'}</td>
              <td>{row.missingMinutes > 0 ? hours(row.missingMinutes) : '—'}</td>
              <td><strong>{row.balanceMinutes > 0 ? '+' : ''}{hours(row.balanceMinutes)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function FleetMonthlyPage() {
  const [month, setMonth] = useState(currentMonth)
  // A resposta guarda o mês a que pertence: trocar o mês mostra o carregamento sem limpar o estado.
  const [result, setResult] = useState<{ month: string; data: FleetMonthlySummary | null; error: string } | null>(null)

  useEffect(() => {
    if (!/^\d{4}-\d{2}$/.test(month)) return
    let active = true
    fetchFleetMonthlySummary(month)
      .then((data) => {
        if (active) setResult({ month, data, error: '' })
      })
      .catch((err: unknown) => {
        if (active) setResult({ month, data: null, error: errorMessage(err, 'Não foi possível carregar o resumo do mês.') })
      })
    return () => {
      active = false
    }
  }, [month])
  const current = result?.month === month ? result : null
  const data = current?.data ?? null
  const error = current?.error ?? ''

  const totalKm = data?.vehicles.reduce((sum, row) => sum + row.totalKm, 0) ?? 0
  const extra = data?.drivers?.reduce((sum, row) => sum + row.extraMinutes, 0) ?? 0
  const missing = data?.drivers?.reduce((sum, row) => sum + row.missingMinutes, 0) ?? 0

  return (
    <div className="admin-module-page">
      <PageHeader
        title="Resumo do mês"
        description="Quantos quilômetros cada carro rodou e quantas horas cada motorista fez a mais ou a menos no mês."
        actions={
          <Link className="maintenance-secondary-button" to="/frota">
            <Icon name="back" size={18} />
            Frota
          </Link>
        }
      />

      <section className="ui-card">
        <div className="module-filters ui-filter-bar" role="group" aria-label="Mês do resumo">
          <label className="ui-filter-field">
            <span>Mês</span>
            <input type="month" value={month} max={currentMonth()} onChange={(event) => setMonth(event.target.value)} />
          </label>
        </div>
      </section>

      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && <Loading label="Carregando o resumo do mês..." />}

      {data && (
        <>
          <section className="ui-metrics" aria-label="Totais do mês">
            <StatCard icon="vehicle" tone="black" label="Km rodados no mês" value={km(totalKm)} description={`${data.vehicles.length} ${data.vehicles.length === 1 ? 'veículo' : 'veículos'} com uso`} />
            {data.drivers && (
              <>
                <StatCard icon="add" tone="yellow" label="Horas a mais" value={hours(extra)} description="Soma de todos os motoristas" />
                <StatCard icon="waiting" tone="graphite" label="Horas a menos" value={hours(missing)} description="Só nos dias com viagem" />
              </>
            )}
          </section>

          <section className="ui-card ui-stacked" aria-labelledby="km-title">
            <h2 id="km-title">Quilômetros por carro</h2>
            <p className="demand-muted">
              Km nas viagens: hodômetro final menos o inicial, informados pelo motorista no portal. Km no diário de bordo:
              registros de utilização feitos na ficha do veículo. Quando a viagem não tem os dois hodômetros, ela é contada,
              mas não soma km.
            </p>
            {data.vehicles.length === 0 ? (
              <EmptyState icon="vehicle" title="Nenhum carro rodou neste mês">
                Não há viagens iniciadas nem registros de utilização no diário de bordo.
              </EmptyState>
            ) : (
              <VehiclesTable rows={data.vehicles} />
            )}
          </section>

          {data.drivers && data.journey && (
            <section className="ui-card ui-stacked" aria-labelledby="hours-title">
              <h2 id="hours-title">Horas dos motoristas</h2>
              <p className="demand-muted">
                Estimativa a partir das viagens (o motorista não bate ponto no sistema). Jornada de referência:{' '}
                {data.journey.weekdays.map((day) => weekdayNames[day]).join(', ')}, das {data.journey.start} às{' '}
                {data.journey.end}, com {data.journey.breakMinutes} min de intervalo ({hours(data.journey.dailyMinutes)} por dia).
                Horas a mais: o que passou da jornada; em folga, feriado ou fim de semana, tudo conta como a mais. Horas a
                menos: o que faltou para a jornada, só nos dias em que houve viagem.
              </p>
              {data.drivers.length === 0 ? (
                <EmptyState icon="users" title="Nenhuma viagem com motorista neste mês">
                  As horas aparecem quando a viagem tem motorista e foi iniciada no portal.
                </EmptyState>
              ) : (
                <DriversTable rows={data.drivers} />
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}

export default FleetMonthlyPage
