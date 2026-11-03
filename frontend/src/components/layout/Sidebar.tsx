import { NavLink, useLocation } from 'react-router-dom'
import logoJucesp from '../../assets/logoJucespNovo.png'
import { getNavigationForUser } from '../../app/navigation'
import { useAuthenticatedUser } from '../../auth/UserContext'

function Sidebar() {
  const { pathname } = useLocation()
  const user = useAuthenticatedUser()
  const visibleItems = user ? getNavigationForUser(user) : []
  const currentPath = pathname.replace(/\/+$/, '') || '/'

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-symbol">
          <img src={logoJucesp} alt="Logo da JUCESP" />
        </div>
        <div className="brand-text">
          <strong>GESTÃO DE SERVIÇOS</strong>
          <span>LOGÍSTICA E MANUTENÇÃO</span>
        </div>
      </div>

      <div className="menu-label">MENU PRINCIPAL</div>

      <nav className="navigation" aria-label="Navegação principal">
        {visibleItems.map((item) => {
          const isActive =
            currentPath === item.path ||
            (item.path !== '/' && currentPath.startsWith(`${item.path}/`))

          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              className={`nav-item${isActive ? ' active' : ''}`}
              aria-label={item.name}
              title={item.name}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="nav-label">{item.name}</span>
              {isActive && (
                <span className="active-indicator" aria-hidden="true" />
              )}
            </NavLink>
          )
        })}
      </nav>

      <div className="sidebar-bottom">
        <div className="help-card">
          <span className="help-icon" aria-hidden="true">
            i
          </span>
          <strong>Precisa de ajuda?</strong>
          <p>Consulte a equipe responsável pelo sistema.</p>
        </div>
        <div className="user-profile">
          <div className="avatar" aria-hidden="true">
            {(user?.name || 'U').trim().charAt(0).toUpperCase()}
          </div>
          <div className="user-info">
            <strong>{user?.name || 'Usuário'}</strong>
            <span>
              {user?.role === 'administrator'
                ? 'Administrador'
                : user?.role === 'slm_operator'
                  ? 'Operador SLM'
                  : 'Solicitante'}
            </span>
          </div>
        </div>
      </div>
    </aside>
  )
}

export default Sidebar
