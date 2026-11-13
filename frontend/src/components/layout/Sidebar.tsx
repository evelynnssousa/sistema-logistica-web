import { NavLink, useLocation } from 'react-router-dom'
import logoJucesp from '../../assets/logoJucespNovo.png'
import { getNavigationForUser, navigationGroups } from '../../app/navigation'
import { roleLabels } from '../../app/roleLabels'
import { useDemandContext } from '../../app/useDemandContext'
import { disabledModulePaths, useSystemInfo } from '../../app/useSystemInfo'
import { useAuthenticatedUser } from '../../auth/UserContext'
import Icon from '../ui/Icon'

type SidebarProps = {
  open: boolean
  onClose: () => void
}

function Sidebar({ open, onClose }: SidebarProps) {
  const { pathname } = useLocation()
  const user = useAuthenticatedUser()
  const { context: demandContext } = useDemandContext()
  const systemInfo = useSystemInfo()
  // Módulo desligado em Configurações sai do menu; os registros continuam acessíveis pelo endereço.
  const hidden = disabledModulePaths(systemInfo)
  const visibleItems = user
    ? getNavigationForUser(user, demandContext?.hasAccess === true || import.meta.env.DEV, demandContext?.canConfigure === true).filter(
        (item) => !hidden.includes(item.path),
      )
    : []
  const currentPath = pathname.replace(/\/+$/, '') || '/'

  return (
    <aside className={`sidebar${open ? ' open' : ''}`}>
      <div className="brand">
        <div className="brand-symbol">
          <img src={logoJucesp} alt="Logo da JUCESP" />
        </div>
        <div className="brand-text">
          <strong>GESTÃO DE SERVIÇOS</strong>
          <span>LOGÍSTICA E MANUTENÇÃO</span>
        </div>
        <button type="button" className="sidebar-close" aria-label="Fechar menu" onClick={onClose}>
          <Icon name="close" size={20} weight="bold" />
        </button>
      </div>

      <nav className="navigation" aria-label="Navegação principal">
        {navigationGroups.map((group) => {
          const items = visibleItems.filter((item) => item.group === group.key)
          if (items.length === 0) return null

          return (
            <div key={group.key} className="nav-group">
              {group.label && <div className="nav-group-label">{group.label}</div>}
              {items.map((item) => {
                const isActive =
                  currentPath === item.path ||
                  (item.path !== '/' && currentPath.startsWith(`${item.path}/`))

                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    end={item.path === '/'}
                    className={`nav-item${isActive ? ' active' : ''}`}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={onClose}
                  >
                    <span className="nav-icon">
                      <Icon name={item.icon} size={21} />
                    </span>
                    <span className="nav-label">{item.name}</span>
                  </NavLink>
                )
              })}
            </div>
          )
        })}
      </nav>

      <div className="sidebar-bottom">
        <div className="user-profile">
          <div className="avatar" aria-hidden="true">
            {(user?.name || 'U').trim().charAt(0).toUpperCase()}
          </div>
          <div className="user-info">
            <strong>{user?.name || 'Usuário'}</strong>
            <span>
              {user ? roleLabels[user.role] : ''}
              {user?.slmMember && user.role !== 'slm_operator' ? ' · Equipe SLM' : ''}
            </span>
          </div>
        </div>
      </div>
    </aside>
  )
}

export default Sidebar
