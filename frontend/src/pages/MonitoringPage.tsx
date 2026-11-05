import { useEffect, useState } from 'react'
import { errorMessage, formatDateTime } from '../api/modulesApi'
import { getMonitoringStatus, listTechnicalEvents, serviceLabels } from '../api/operationsApi'
import type { MonitoringStatus } from '../api/operationsApi'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, FilterSelect } from '../components/ui/Filters'
import Icon from '../components/ui/Icon'
import type { IconName } from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'
import Pagination from '../components/ui/Pagination'

const statusText: Record<string, { label: string; icon: IconName }> = {
  up: { label: 'Disponível', icon: 'success' },
  down: { label: 'Com falha', icon: 'error' },
  not_configured: { label: 'Não configurado', icon: 'info' },
}

const incidentLabels: Record<string, string> = {
  down: 'Indisponível',
  unknown: 'Sem verificação',
}

function MonitoringPage() {
  const [status, setStatus] = useState<MonitoringStatus | null>(null)
  const [events, setEvents] = useState<Awaited<ReturnType<typeof listTechnicalEvents>> | null>(null)
  const [service, setService] = useState('')
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    getMonitoringStatus()
      .then((data) => {
        if (active) setStatus(data)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível consultar o monitoramento.'))
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    listTechnicalEvents({ service, page })
      .then((data) => {
        if (active) setEvents(data)
      })
      .catch(() => {
        if (active) setEvents(null)
      })
    return () => {
      active = false
    }
  }, [service, page])

  return (
    <div className="admin-module-page monitoring-page">
      <PageHeader title="Monitoramento" description="Situação dos serviços essenciais e registros técnicos de erro." />
      {error && <Alert tone="error">{error}</Alert>}
      {!status && !error && <Loading label="Verificando os serviços..." />}

      {status && (
        <>
          {!status.monitoringActive && (
            <Alert tone="info">
              O registro contínuo de disponibilidade está desligado nesta instalação (MONITORING_ENABLED). A situação
              abaixo é a verificação feita agora.
            </Alert>
          )}

          <section className="ui-card ui-stacked" aria-labelledby="monitoring-services">
            <h2 id="monitoring-services">Serviços agora</h2>
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Serviço</th>
                    <th>Situação</th>
                    <th>Resposta</th>
                    <th>Disponibilidade (30 dias)</th>
                  </tr>
                </thead>
                <tbody>
                  {status.checks.map((check) => {
                    const availability = status.availability.find((item) => item.service === check.service)
                    const text = statusText[check.status]
                    return (
                      <tr key={check.service}>
                        <td>{serviceLabels[check.service] ?? check.service}</td>
                        <td>
                          <span className={`service-status service-status-${check.status}`}>
                            <Icon name={text.icon} size={16} />
                            {text.label}
                          </span>
                        </td>
                        <td>{check.responseMs === null ? '—' : `${check.responseMs} ms`}</td>
                        <td>
                          {availability?.availabilityPercent === null || !availability
                            ? 'Sem medição suficiente'
                            : `${availability.availabilityPercent.toLocaleString('pt-BR')}%`}
                          {availability && availability.downMinutes > 0 && (
                            <small className="central-subtext">{availability.downMinutes} min indisponível</small>
                          )}
                          {availability && availability.unknownMinutes > 0 && (
                            <small className="central-subtext">{availability.unknownMinutes} min sem verificação</small>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="ui-card ui-stacked" aria-labelledby="monitoring-backup">
            <h2 id="monitoring-backup">Backup</h2>
            {!status.backup.configured ? (
              <p>O registro de cópias não está configurado nesta instalação (BACKUP_LOG_PATH).</p>
            ) : (
              <dl className="indicator-list">
                <div>
                  <dt>Última cópia</dt>
                  <dd>{status.backup.last ? (status.backup.last.ok ? 'Concluída' : 'Falhou') : 'Nenhuma'}</dd>
                  <small>{formatDateTime(status.backup.last?.at)}</small>
                </div>
                <div>
                  <dt>Último teste de restauração</dt>
                  <dd>{status.backup.lastVerified ? (status.backup.lastVerified.ok ? 'Aprovado' : 'Falhou') : 'Nenhum'}</dd>
                  <small>{formatDateTime(status.backup.lastVerified?.at)}</small>
                </div>
              </dl>
            )}
            <p className="management-hint">Uma cópia só é considerada confiável depois de um teste de restauração aprovado.</p>
          </section>

          <section className="ui-card ui-stacked" aria-labelledby="monitoring-incidents">
            <h2 id="monitoring-incidents">Períodos de indisponibilidade</h2>
            {status.incidents.length === 0 ? (
              <EmptyState icon="success" title="Nenhum período registrado" />
            ) : (
              <div className="data-table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Serviço</th>
                      <th>Tipo</th>
                      <th>Início</th>
                      <th>Fim</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.incidents.map((incident) => (
                      <tr key={`${incident.service}-${incident.startedAt}`}>
                        <td>{serviceLabels[incident.service] ?? incident.service}</td>
                        <td>{incidentLabels[incident.status] ?? incident.status}</td>
                        <td>{formatDateTime(incident.startedAt)}</td>
                        <td>{formatDateTime(incident.endedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <section className="ui-card ui-stacked" aria-labelledby="monitoring-events">
        <h2 id="monitoring-events">Registros técnicos{status ? ` (${status.errorsLast24h} nas últimas 24 horas)` : ''}</h2>
        <p className="management-hint">Só serviço, evento e código. Senhas, tokens, CPFs e conteúdos não são registrados.</p>
        <FilterBar label="Filtro dos registros" canClear={Boolean(service)} onClear={() => setService('')}>
          <FilterSelect
            label="Serviço"
            value={service}
            onChange={(value) => {
              setService(value)
              setPage(1)
            }}
            allLabel="Todos"
            options={Object.entries(serviceLabels).map(([value, label]) => ({ value, label }))}
          />
        </FilterBar>
        {events && events.events.length === 0 && <EmptyState icon="success" title="Nenhum registro" />}
        {events && events.events.length > 0 && (
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Serviço</th>
                  <th>Evento</th>
                  <th>Código</th>
                </tr>
              </thead>
              <tbody>
                {events.events.map((event) => (
                  <tr key={event.id}>
                    <td>{formatDateTime(event.at)}</td>
                    <td>{serviceLabels[event.service] ?? event.service}</td>
                    <td>{event.event}</td>
                    <td>{event.errorCode ?? event.errorName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {events && (
          <Pagination
            page={events.page}
            summary={`${events.total} no total`}
            hasNext={events.page * events.pageSize < events.total}
            onChange={setPage}
          />
        )}
      </section>
    </div>
  )
}

export default MonitoringPage
