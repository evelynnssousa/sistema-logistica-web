import { appRoutes, type AppRouteId, type ModuleRouteId } from '../app/routes'

interface DashboardPageProps {
  activeRoute: AppRouteId
  onNavigate: (route: AppRouteId) => void
  accessibleRoutes: AppRouteId[]
}

const moduleCards: {
  route: ModuleRouteId
  title: string
  description: string
  icon: string
  style: string
}[] = [
  {
    route: 'manutencao',
    title: 'Manutenção',
    description:
      'Solicitações, agendamentos e acompanhamento dos serviços de manutenção.',
    icon: '⚙',
    style: 'maintenance',
  },
  {
    route: 'frota',
    title: 'Gestão de frota',
    description: 'Controle de solicitações, veículos, motoristas e agendamentos.',
    icon: '▣',
    style: 'fleet',
  },
  {
    route: 'passagens-aereas',
    title: 'Passagens aéreas',
    description:
      'Organização das solicitações de viagens e acompanhamento dos pedidos.',
    icon: '✈',
    style: 'flights',
  },
]

export function DashboardPage({ activeRoute, onNavigate, accessibleRoutes }: DashboardPageProps) {
  const currentRoute = appRoutes.find((route) => route.id === activeRoute)

  return (
    <>
      <section className="welcome-section">
        <div>
          <div className="eyebrow">JUCESP · GESTÃO OPERACIONAL</div>
          <h1>
            {activeRoute === 'overview' ? 'Painel de controle' : currentRoute?.label}
          </h1>
          <p>Acompanhe as solicitações e os serviços em um só lugar.</p>
        </div>
        <div className="date-label">
          <span className="date-icon" aria-hidden="true">▦</span>
          <span>Visão geral do sistema</span>
        </div>
      </section>

      {activeRoute === 'overview' ? (
        <>
          <section className="stats-grid" aria-label="Indicadores do sistema">
            <article className="stat-card">
              <div className="stat-top">
                <span className="stat-icon blue" aria-hidden="true">▤</span>
                <span className="stat-tag">GERAL</span>
              </div>
              <p className="stat-label">Total de solicitações</p>
              <div className="stat-value">—</div>
              <p className="stat-description">
                Aguardando integração com a base de dados
              </p>
            </article>

            <article className="stat-card">
              <div className="stat-top">
                <span className="stat-icon orange" aria-hidden="true">◷</span>
                <span className="stat-tag">PENDÊNCIAS</span>
              </div>
              <p className="stat-label">Em andamento</p>
              <div className="stat-value">—</div>
              <p className="stat-description">Solicitações em processamento</p>
            </article>

            <article className="stat-card">
              <div className="stat-top">
                <span className="stat-icon green" aria-hidden="true">✓</span>
                <span className="stat-tag">CONCLUÍDOS</span>
              </div>
              <p className="stat-label">Serviços concluídos</p>
              <div className="stat-value">—</div>
              <p className="stat-description">Serviços finalizados no sistema</p>
            </article>

            <article className="stat-card">
              <div className="stat-top">
                <span className="stat-icon purple" aria-hidden="true">✈</span>
                <span className="stat-tag">VIAGENS</span>
              </div>
              <p className="stat-label">Passagens aéreas</p>
              <div className="stat-value">—</div>
              <p className="stat-description">
                Módulo independente em preparação
              </p>
            </article>
          </section>

          <section className="section-heading">
            <div>
              <h2>Módulos do sistema</h2>
              <p>Acesse a área que deseja consultar.</p>
            </div>
          </section>

          <section className="modules-grid" aria-label="Módulos disponíveis">
            {moduleCards.filter((module) => accessibleRoutes.includes(module.route)).map((module) => (
              <button
                className="module-card"
                key={module.route}
                type="button"
                onClick={() => onNavigate(module.route)}
              >
                <div className={`module-icon ${module.style}`} aria-hidden="true">
                  {module.icon}
                </div>
                <div className="module-card-content">
                  <h3>{module.title}</h3>
                  <p>{module.description}</p>
                  <span className="module-link">
                    Acessar módulo <span aria-hidden="true">→</span>
                  </span>
                </div>
              </button>
            ))}
          </section>

          <section className="notice-card">
            <div className="notice-icon" aria-hidden="true">i</div>
            <div>
              <strong>Nova plataforma em desenvolvimento</strong>
              <p>
                Esta interface é a base visual da nova plataforma. Os indicadores
                serão preenchidos quando a integração com os dados for
                implementada e validada.
              </p>
            </div>
          </section>
        </>
      ) : (
        <section className="placeholder-card">
          <div className="placeholder-icon" aria-hidden="true">
            {currentRoute?.icon}
          </div>
          <h2>Módulo de {currentRoute?.label}</h2>
          <p>
            A estrutura visual está preparada. As funcionalidades serão
            desenvolvidas por etapas e testadas antes da migração do sistema
            atual.
          </p>
          <button
            className="back-button"
            type="button"
            onClick={() => onNavigate('overview')}
          >
            ← Voltar ao painel
          </button>
        </section>
      )}
    </>
  )
}