import { useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { navigationItems } from '../../app/navigation'
import { useLogout } from '../../auth/UserContext'
import NotificationBell from '../NotificationBell'
import Icon from '../ui/Icon'

type TopbarProps = {
  apiOnline: boolean | null
  onOpenMenu: () => void
}

function Topbar({ apiOnline, onOpenMenu }: TopbarProps) {
  const { pathname } = useLocation()
  const logout = useLogout()
  const navigate = useNavigate()
  const [term, setTerm] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const currentPath = pathname.replace(/\/+$/, '') || '/'
  const currentPage = navigationItems.find(
    (item) =>
      item.path === currentPath ||
      (item.path !== '/' && currentPath.startsWith(`${item.path}/`)),
  )

  function search(event: FormEvent) {
    event.preventDefault()
    const text = term.trim()
    if (text.length >= 2) navigate(`/pesquisa?q=${encodeURIComponent(text)}`)
  }

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
        <button type="button" className="topbar-menu" aria-label="Abrir menu" onClick={onOpenMenu}>
          <Icon name="menu" size={22} weight="bold" />
        </button>
        <strong>{currentPage?.name ?? 'Início'}</strong>
      </div>
      <form className="topbar-search no-print" role="search" onSubmit={search}>
        <Icon name="search" size={18} />
        <input
          type="search"
          aria-label="Pesquisar no sistema"
          placeholder="Pesquisar protocolo, solicitação, material..."
          maxLength={120}
          value={term}
          onChange={(event) => setTerm(event.target.value)}
        />
      </form>
      <div className="topbar-right">
        {logoutError && (
          <span className="topbar-logout-error" role="alert">
            {logoutError}
          </span>
        )}
        <span
          className="environment-badge"
          role="status"
          aria-label={apiOnline === null ? 'Verificando conexão' : apiOnline ? 'API conectada' : 'API indisponível'}
        >
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
        <NotificationBell />
        <button
          className="topbar-logout"
          type="button"
          onClick={() => void handleLogout()}
          disabled={loggingOut}
        >
          <Icon name="logout" size={18} />
          {loggingOut ? 'Saindo...' : 'Sair'}
        </button>
      </div>
    </header>
  )
}

export default Topbar
