import { Link, useLocation } from 'react-router-dom'
import { navigationItems } from '../app/navigation'

function ModulePlaceholderPage() {
  const { pathname } = useLocation()
  const module = navigationItems.find((item) => item.path === pathname)

  if (!module || module.path === '/') {
    return null
  }

  return (
    <>
      <section className="welcome-section">
        <div>
          <div className="eyebrow">JUCESP · GESTÃO OPERACIONAL</div>
          <h1>{module.name}</h1>
          <p>Acompanhe as solicitações e os serviços em um só lugar.</p>
        </div>
      </section>

      <section className="placeholder-card">
        <div className="placeholder-icon" aria-hidden="true">
          {module.icon}
        </div>
        <h2>Módulo de {module.name}</h2>
        <p>
          A estrutura visual está preparada. As funcionalidades serão
          desenvolvidas por etapas e testadas antes da migração do sistema atual.
        </p>
        <Link className="back-button" to="/">
          ← Voltar ao painel
        </Link>
      </section>
    </>
  )
}

export default ModulePlaceholderPage
