import { disabledModulePaths, useSystemInfo } from '../app/useSystemInfo'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  protocolLabel,
  errorMessage,
  formatDateTime,
  getDashboard,
  moduleLabels,
  modulePaths,
  statusLabels,
} from '../api/modulesApi'
import type { RecentRequest, SummaryResponse } from '../api/modulesApi'
import { useDemandContext } from '../app/useDemandContext'
import { useAuthenticatedUser } from '../auth/UserContext'
import StatCard from '../components/StatCard'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import Icon from '../components/ui/Icon'
import type { IconName } from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'
import StatusBadge from '../components/ui/StatusBadge'

// Atalhos para abrir pedidos: um clique a menos que passar pela lista de cada módulo.
const newRequestShortcuts: { path: string; label: string; icon: IconName; permission: string }[] = [
  { path: '/manutencao/nova', label: 'Pedir manutenção', icon: 'maintenance', permission: 'maintenance:create' },
  { path: '/frota/nova', label: 'Pedir veículo', icon: 'fleet', permission: 'fleet:create' },
  { path: '/passagens-aereas/nova', label: 'Pedir passagem', icon: 'flights', permission: 'flights:create' },
  { path: '/almoxarifado/nova', label: 'Pedir material', icon: 'warehouse', permission: 'warehouse:read' },
]

function HomePage() {
  const user = useAuthenticatedUser()
  const { context: demandContext } = useDemandContext()
  const [data, setData] = useState<(SummaryResponse & { recent: RecentRequest[] }) | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    getDashboard({})
      .then((result) => {
        if (active) setData(result)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar as solicitações.'))
      })
    return () => {
      active = false
    }
  }, [])

  const systemInfo = useSystemInfo()
  const canRequest = user?.permissions.includes('requests:create')
  // Cadastrar demanda depende do perfil no módulo, e não de uma permissão: vem do contexto do módulo.
  // Em desenvolvimento, sem as migrações, o atalho aparece como o item do menu e leva ao aviso do módulo.
  const showDemandShortcut = demandContext?.canCreate || (import.meta.env.DEV && demandContext?.migrated === false)
  // Módulos desligados em Configurações não oferecem atalho de pedido novo.
  const hidden = disabledModulePaths(systemInfo)
  const shortcuts: { path: string; label: string; icon: IconName }[] = [
    ...(canRequest ? newRequestShortcuts.filter((item) => user?.permissions.includes(item.permission)) : []),
    ...(showDemandShortcut ? [{ path: '/demandas/nova', label: 'Criar demanda', icon: 'demands' as const }] : []),
  ].filter((item) => !hidden.some((path) => item.path.startsWith(`${path}/`)))
  const firstName = user?.name.trim().split(/\s+/)[0]

  return (
    <div className="dashboard-page home-page">
      <PageHeader
        title={`Olá, ${firstName}`}
        description={
          user?.permissions.includes('requests:read_all')
            ? 'Estas são as solicitações que precisam de atenção.'
            : 'Acompanhe aqui as suas solicitações.'
        }
      />

      {systemInfo.homeMessage && <Alert tone="info">{systemInfo.homeMessage}</Alert>}

      {shortcuts.length > 0 && (
        <nav className="home-actions" aria-label="Abrir nova solicitação">
          {shortcuts.map((item) => (
            <Link key={item.path} className="home-action" to={item.path}>
              <Icon name={item.icon} size={18} />
              {item.label}
            </Link>
          ))}
        </nav>
      )}

      {error && <Alert tone="error">{error}</Alert>}

      {data && (
        <section className="home-pending" aria-label="Pendências">
          <StatCard
            icon="waiting"
            tone="yellow"
            label="Aguardando agendamento"
            value={String(data.totals.awaitingSchedule)}
            description="Manutenção e Frota"
          />
          <StatCard
            icon="progress"
            tone="black"
            label="Em andamento"
            value={String(data.totals.inProgress)}
            description="Atendimentos iniciados"
          />
          <StatCard
            icon="requests"
            tone="white"
            label="Em aberto"
            value={String(data.totals.open)}
            description="Ainda sem desfecho"
          />
        </section>
      )}

      <section className="recent-section" aria-labelledby="recent-title">
        <div className="ui-card-heading">
          <h2 id="recent-title">Solicitações recentes</h2>
          <Link to="/dashboard">Ver indicadores no Dashboard</Link>
        </div>

        {!data && !error && <Loading label="Carregando solicitações..." />}

        {data && data.recent.length === 0 && (
          <EmptyState title="Nenhuma solicitação por aqui">
            As solicitações aparecem nesta lista assim que forem registradas.
          </EmptyState>
        )}

        {data && data.recent.length > 0 && (
          <div className="recent-table-wrapper">
            <table className="recent-table">
              <caption className="visually-hidden">
                Solicitações recentes por identificação, módulo, solicitante, data e situação
              </caption>
              <thead>
                <tr>
                  <th scope="col">Identificação</th>
                  <th scope="col">Módulo</th>
                  <th scope="col">Solicitante</th>
                  <th scope="col">Data</th>
                  <th scope="col">Situação</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((request) => (
                  <tr key={request.id}>
                    <td>
                      <Link to={`${modulePaths[request.module]}/${request.id}`}>
                        {protocolLabel(request.protocol)} · {request.title}
                      </Link>
                    </td>
                    <td>{moduleLabels[request.module]}</td>
                    <td>{request.requester}</td>
                    <td>{formatDateTime(request.createdAt)}</td>
                    <td>
                      <StatusBadge status={request.status} label={statusLabels[request.status]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

export default HomePage
