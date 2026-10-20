import { useEffect, useState } from 'react'
import { AppShell } from './components/AppShell'
import { pathForRoute, routeFromPath, type AppRouteId, type AppScreenId } from './app/routes'
import { AdminApprovalsPage } from './pages/AdminApprovalsPage'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { RegistrationPage } from './pages/RegistrationPage'
import {
  decideRegistration,
  getCurrentSession,
  getPendingRequests,
  registerAccount,
  signIn,
  signOut,
  type AuthUser,
} from './services/auth'
import { getApiHealth } from './services/api'
import './App.css'

function App() {
  const [screen, setScreen] = useState<AppScreenId>(() => routeFromPath(window.location.pathname))
  const [user, setUser] = useState<AuthUser | null>(null)
  const [csrfToken, setCsrfToken] = useState('')
  const [apiOnline, setApiOnline] = useState<boolean | null>(null)
  const [sessionChecked, setSessionChecked] = useState(false)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [authNotice, setAuthNotice] = useState('')

  const navigate = (nextScreen: AppScreenId) => {
    const path = pathForRoute(nextScreen)
    if (window.location.pathname !== path) window.history.pushState({}, '', path)
    setScreen(nextScreen)
  }

  useEffect(() => {
    let active = true
    getApiHealth()
      .then((online) => {
        if (active) setApiOnline(online)
      })
      .catch(() => {
        if (active) setApiOnline(false)
      })

    getCurrentSession()
      .then((session) => {
        if (active) {
          setUser(session.user)
          setCsrfToken(session.csrfToken)
        }
      })
      .catch(() => {
        if (active) {
          setUser(null)
          setCsrfToken('')
        }
      })
      .finally(() => {
        if (active) setSessionChecked(true)
      })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const syncRoute = () => setScreen(routeFromPath(window.location.pathname))
    window.addEventListener('popstate', syncRoute)
    return () => window.removeEventListener('popstate', syncRoute)
  }, [])

  useEffect(() => {
    if (!sessionChecked) return
    const redirectTo = user
      ? screen === 'login' || screen === 'register' || (screen === 'admin' && user.role !== 'admin')
        ? '/'
        : null
      : screen !== 'register'
        ? '/login'
        : null
    if (redirectTo && window.location.pathname !== redirectTo) {
      window.history.replaceState({}, '', redirectTo)
    }
  }, [screen, sessionChecked, user])

  async function handleSignIn(email: string, password: string) {
    const session = await signIn(email, password)
    setUser(session.user)
    setCsrfToken(session.csrfToken)
    setAuthNotice('')
    navigate('overview')
  }

  async function handleRegister(input: {
    fullName: string
    email: string
    sector: string
    password: string
    passwordConfirmation: string
  }) {
    const result = await registerAccount(input)
    setAuthNotice(result.message)
    navigate('login')
    return result.message
  }

  async function handleLogout() {
    setLogoutBusy(true)
    setLogoutError('')
    try {
      await signOut(csrfToken)
      setUser(null)
      setCsrfToken('')
      navigate('login')
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : 'Não foi possível encerrar a sessão.')
    } finally {
      setLogoutBusy(false)
    }
  }

  if (!sessionChecked) {
    return <main className="auth-loading" role="status">Verificando sessão...</main>
  }

  const effectiveScreen: AppScreenId = user
    ? screen === 'login' || screen === 'register' || (screen === 'admin' && user.role !== 'admin')
      ? 'overview'
      : screen
    : screen === 'register'
      ? 'register'
      : 'login'

  if (!user) {
    if (effectiveScreen === 'register') {
      return <RegistrationPage onSubmit={handleRegister} onLogin={() => navigate('login')} />
    }
    return (
      <>
        {authNotice && <p className="auth-notice" role="status">{authNotice}</p>}
        <LoginPage onSubmit={handleSignIn} onRegister={() => navigate('register')} />
      </>
    )
  }

  const accessibleRoutes: AppRouteId[] = user.role === 'admin'
    ? ['overview', 'manutencao', 'frota', 'passagens-aereas']
    : [
        'overview',
        ...(user.permissions.some((permission) => permission.startsWith('maintenance:')) ? ['manutencao' as const] : []),
        ...(user.permissions.some((permission) => permission.startsWith('fleet:')) ? ['frota' as const] : []),
        ...(user.permissions.some((permission) => permission.startsWith('flights:')) ? ['passagens-aereas' as const] : []),
      ]
  const visibleRoute: AppRouteId = accessibleRoutes.includes(screen as AppRouteId)
    ? screen as AppRouteId
    : 'overview'

  return (
    <AppShell
      activeRoute={effectiveScreen === 'admin' ? null : visibleRoute}
      apiOnline={apiOnline}
      user={user}
      accessibleRoutes={accessibleRoutes}
      pageLabel={effectiveScreen === 'admin' ? 'Administração' : undefined}
      onNavigate={(route) => navigate(route)}
      onOpenAdmin={() => navigate('admin')}
      onLogout={() => void handleLogout()}
      logoutBusy={logoutBusy}
      actionError={logoutError}
    >
      {effectiveScreen === 'admin' && user.role === 'admin' ? (
        <AdminApprovalsPage
          csrfToken={csrfToken}
          loadRequests={getPendingRequests}
          decide={decideRegistration}
        />
      ) : (
        <DashboardPage
          activeRoute={visibleRoute}
          onNavigate={(route) => navigate(route)}
          accessibleRoutes={accessibleRoutes}
        />
      )}
    </AppShell>
  )
}

export default App
