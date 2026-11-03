import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { navigationItems } from '../../app/navigation'
import { useAuthenticatedUser, useLogout } from '../../auth/UserContext'

type TopbarProps = {
  apiOnline: boolean | null
}

function Topbar({ apiOnline }: TopbarProps) {
  const { pathname } = useLocation()
  const user = useAuthenticatedUser()
  const logout = useLogout()
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const currentPath = pathname.replace(/\/+$/, '') || '/'
  const currentPage = navigationItems.find(
    (item) =>
      item.path === currentPath ||
      (item.path !== '/' && currentPath.startsWith(`${item.path}/`)),
  )

  async function handleLogout() {
    setLoggingOut(true)
    setLogoutError('')

    try {
      await logout()
    } catch (error) {
      setLogoutError(
        error instanceof Error
          ? error.message
          : 'Não foi possível sair. Tente novamente.',
      )
      setLoggingOut(false)
    }
  }

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
        {logoutError && (
          <span className="topbar-logout-error" role="alert">
            {logoutError}
          </span>
        )}
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
        <div
          className="topbar-avatar"
          aria-label={`Usuário: ${user?.name ?? ''}`}
          title={user?.name}
        >
          {(user?.name || 'U').trim().charAt(0).toUpperCase()}
        </div>
        <button
          className="topbar-logout"
          type="button"
          onClick={() => void handleLogout()}
          disabled={loggingOut}
        >
          {loggingOut ? 'Saindo...' : 'Sair'}
        </button>
      </div>
    </header>
  )
}

export default Topbar
