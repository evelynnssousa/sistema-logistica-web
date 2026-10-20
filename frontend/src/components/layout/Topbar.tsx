import { useLocation } from 'react-router-dom'
import { navigationItems } from '../../app/navigation'

type TopbarProps = {
  apiOnline: boolean | null
}

function Topbar({ apiOnline }: TopbarProps) {
  const { pathname } = useLocation()
  const currentPath = pathname.replace(/\/+$/, '') || '/'
  const currentPage = navigationItems.find(
    (item) =>
      item.path === currentPath ||
      (item.path !== '/' && currentPath.startsWith(`${item.path}/`)),
  )

  return (
    <header className="topbar">
      <div className="breadcrumb" aria-label="Localização atual">
        <span>Início</span>
        <span className="breadcrumb-separator" aria-hidden="true">
          /
        </span>
        <strong>{currentPage?.name ?? 'Visão geral'}</strong>
      </div>
      <div className="topbar-right">
        <span className="environment-badge" role="status">
          <span
            className={`status-dot ${
              apiOnline === true
                ? 'online'
                : apiOnline === false
                  ? 'offline'
                  : ''
            }`}
            aria-hidden="true"
          />
          {apiOnline === null
            ? 'Verificando conexão...'
            : apiOnline
              ? 'API conectada'
              : 'API indisponível'}
        </span>
        <div className="topbar-avatar" aria-label="Usuário">
          U
        </div>
      </div>
    </header>
  )
}

export default Topbar
