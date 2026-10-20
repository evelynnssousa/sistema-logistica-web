import type { ReactNode } from 'react'
import { appRoutes, type AppRouteId } from '../app/routes'
import type { AuthUser } from '../services/auth'

interface AppShellProps {
  activeRoute: AppRouteId | null
  apiOnline: boolean | null
  user: AuthUser
  pageLabel?: string
  accessibleRoutes: AppRouteId[]
  children: ReactNode
  onNavigate: (route: AppRouteId) => void
  onOpenAdmin: () => void
  onLogout: () => void
  logoutBusy: boolean
  actionError?: string
}

export function AppShell({
  activeRoute,
  apiOnline,
  user,
  pageLabel,
  accessibleRoutes,
  children,
  onNavigate,
  onOpenAdmin,
  onLogout,
  logoutBusy,
  actionError,
}: AppShellProps) {
  const currentRoute = appRoutes.find((route) => route.id === activeRoute)

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-symbol" aria-hidden="true">J</div>
          <div className="brand-text">
            <strong>GESTÃO DE SERVIÇOS</strong>
            <span>LOGÍSTICA E MANUTENÇÃO</span>
          </div>
        </div>

        <div className="menu-label">MENU PRINCIPAL</div>

        <nav className="navigation" aria-label="Navegação principal">
          {appRoutes.filter((route) => accessibleRoutes.includes(route.id)).map((route) => {
            const isActive = activeRoute === route.id

            return (
              <button
                key={route.id}
                type="button"
                className={`nav-item ${isActive ? 'active' : ''}`}
                aria-label={route.label}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onNavigate(route.id)}
              >
                <span className="nav-icon" aria-hidden="true">{route.icon}</span>
                <span>{route.label}</span>
                {isActive && <span className="active-indicator" />}
              </button>
            )
          })}
        </nav>

        <div className="sidebar-bottom">
          <div className="help-card">
            <span className="help-icon" aria-hidden="true">i</span>
            <strong>Precisa de ajuda?</strong>
            <p>Consulte a equipe responsável pelo sistema.</p>
          </div>
          <div className="user-profile">
            <div className="avatar" aria-hidden="true">J</div>
            <div className="user-info">
              <strong>{user.fullName}</strong>
              <span>{user.sector} · {user.role === 'admin' ? 'Administrador' : 'Operacional'}</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Início</span>
            <span className="breadcrumb-separator" aria-hidden="true">/</span>
            <strong>{pageLabel ?? currentRoute?.label}</strong>
          </div>
          <div className="topbar-right">
            {user.role === 'admin' && (
              <button className="shell-action" type="button" onClick={onOpenAdmin}>
                Administração
              </button>
            )}
            <span className="environment-badge" role="status" aria-live="polite">
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
            <div className="topbar-avatar" aria-hidden="true">
              {user.fullName.charAt(0).toUpperCase()}
            </div>
            <button className="shell-action logout-action" type="button" onClick={onLogout} disabled={logoutBusy}>
              {logoutBusy ? 'Saindo...' : 'Sair'}
            </button>
          </div>
        </header>

        <div className="page-content">
          {actionError && <p className="form-error action-error" role="alert">{actionError}</p>}
          {children}
          <footer className="page-footer">
            <span>Sistema de Serviços de Logística e Manutenção</span>
            <span>Nova plataforma · Versão inicial</span>
          </footer>
        </div>
      </main>
    </div>
  )
}