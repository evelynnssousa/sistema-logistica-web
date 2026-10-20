import { Link } from 'react-router-dom'
import StatCard from '../components/StatCard'

const moduleCards = [
  {
    path: '/manutencao',
    className: 'maintenance',
    icon: '⚙',
    title: 'Manutenção',
    description:
      'Solicitações, agendamentos e acompanhamento dos serviços de manutenção.',
  },
  {
    path: '/frota',
    className: 'fleet',
    icon: '▣',
    title: 'Gestão de frota',
    description:
      'Controle de solicitações, veículos, motoristas e agendamentos.',
  },
  {
    path: '/passagens-aereas',
    className: 'flights',
    icon: '✈',
    title: 'Passagens aéreas',
    description:
      'Organização das solicitações de viagens e acompanhamento dos pedidos.',
  },
] as const

function DashboardPage() {
  return (
    <div className="dashboard-page">
      <section className="welcome-section">
        <div>
          <div className="eyebrow">JUCESP · GESTÃO OPERACIONAL</div>
          <h1>Painel de controle</h1>
          <p>
            Acompanhe solicitações e serviços de logística e manutenção em um só
            lugar.
          </p>
        </div>
      </section>

      <section className="stats-grid" aria-label="Indicadores do sistema">
        <StatCard
          icon="▤"
          tone="blue"
          tag="GERAL"
          label="Total de solicitações"
          value="—"
          description="Aguardando integração com a base de dados"
        />
        <StatCard
          icon="◷"
          tone="orange"
          tag="PENDÊNCIAS"
          label="Em andamento"
          value="—"
          description="Solicitações em processamento"
        />
        <StatCard
          icon="✓"
          tone="green"
          tag="CONCLUÍDOS"
          label="Serviços concluídos"
          value="—"
          description="Serviços finalizados no sistema"
        />
        <StatCard
          icon="✈"
          tone="purple"
          tag="VIAGENS"
          label="Passagens aéreas"
          value="—"
          description="Módulo independente em preparação"
        />
      </section>

      <section className="recent-section" aria-labelledby="recent-title">
        <div className="section-heading">
          <div>
            <h2 id="recent-title">Solicitações recentes</h2>
            <p>Consulte as solicitações registradas no sistema.</p>
          </div>
        </div>
        <div className="recent-table-wrapper">
          <table className="recent-table">
            <caption className="visually-hidden">
              Solicitações recentes por módulo, identificação, solicitante, data
              e status
            </caption>
            <thead>
              <tr>
                <th scope="col">Módulo</th>
                <th scope="col">Identificação</th>
                <th scope="col">Solicitante</th>
                <th scope="col">Data</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={5}>
                  <div className="empty-state">
                    <span className="empty-state-icon" aria-hidden="true">
                      ▤
                    </span>
                    <strong>Nenhuma solicitação disponível</strong>
                    <span>
                      Os dados serão exibidos aqui quando a integração com as
                      solicitações estiver disponível.
                    </span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="shortcuts-section" aria-labelledby="shortcuts-title">
        <div className="section-heading">
          <div>
            <h2 id="shortcuts-title">Acesso rápido</h2>
            <p>Acesse um módulo do sistema.</p>
          </div>
        </div>
        <div className="modules-grid shortcuts-grid">
          {moduleCards.map((module) => (
            <Link
              key={module.path}
              className="module-card"
              to={module.path}
              aria-label={`Acessar módulo ${module.title}`}
            >
              <div
                className={`module-icon ${module.className}`}
                aria-hidden="true"
              >
                {module.icon}
              </div>
              <div className="module-card-content">
                <h3>{module.path === '/frota' ? 'Frota' : module.title}</h3>
                <p>{module.description}</p>
                <span className="module-link">
                  Acessar módulo <span aria-hidden="true">→</span>
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="notice-card">
        <div className="notice-icon" aria-hidden="true">
          i
        </div>
        <div>
          <strong>Nova plataforma em desenvolvimento</strong>
          <p>
            Esta interface é a base visual da nova plataforma. Os indicadores
            serão preenchidos quando a integração com os dados for implementada
            e validada.
          </p>
        </div>
      </section>
    </div>
  )
}

export default DashboardPage
