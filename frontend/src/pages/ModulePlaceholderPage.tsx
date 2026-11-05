import { Link, useLocation } from 'react-router-dom'
import { navigationItems } from '../app/navigation'
import Icon from '../components/ui/Icon'

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
          <h1>{module.name}</h1>
          <p>Acompanhe as solicitações e os serviços em um só lugar.</p>
        </div>
      </section>

      <section className="placeholder-card">
        <div className="placeholder-icon" aria-hidden="true">
          <Icon name={module.icon} size={40} weight="duotone" />
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
