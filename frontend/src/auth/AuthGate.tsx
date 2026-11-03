import { useCallback, useEffect, useState } from 'react'
import {
  getCurrentUser,
  type AuthenticatedUser,
} from './auth'
import LoginPage from '../pages/LoginPage'
import RegistrationPage from '../pages/RegistrationPage'
import PasswordRecoveryPage from '../pages/PasswordRecoveryPage'
import { UserContext } from './UserContext'

type AuthGateProps = {
  children: React.ReactNode
}

function AuthGate({ children }: AuthGateProps) {
  const [user, setUser] = useState<AuthenticatedUser | null>(null)
  const [checking, setChecking] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [authView, setAuthView] = useState<'login' | 'register' | 'recovery'>('login')

  const refreshSession = useCallback(async () => {
    setChecking(true)
    setUnavailable(false)

    try {
      const currentUser = await getCurrentUser()
      setUser(currentUser)
    } catch {
      setUser(null)
      setUnavailable(true)
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void refreshSession()
  }, [refreshSession])

  if (checking) {
    return (
      <main className="auth-loading">
        <div className="auth-loading-indicator" />
        <p>Verificando acesso ao sistema...</p>
      </main>
    )
  }

  if (unavailable) {
    return (
      <main className="auth-loading">
        <h1>Não foi possível verificar seu acesso</h1>
        <p>Verifique se a API está iniciada e tente novamente.</p>
        <button type="button" onClick={() => void refreshSession()}>
          Tentar novamente
        </button>
      </main>
    )
  }

  if (!user) {
    if (authView === 'register') {
      return (
        <RegistrationPage
          onBackToLogin={() => setAuthView('login')}
        />
      )
    }

    if (authView === 'recovery') {
      return (
        <PasswordRecoveryPage
          onBackToLogin={() => setAuthView('login')}
        />
      )
    }

    return (
      <LoginPage
        onLogin={async () => {
          await refreshSession()
        }}
        onRegister={() => setAuthView('register')}
        onRecoverPassword={() => setAuthView('recovery')}
      />
    )
  }

  return (
    <UserContext.Provider value={user}>
      {children}
    </UserContext.Provider>
  )
}

export default AuthGate
