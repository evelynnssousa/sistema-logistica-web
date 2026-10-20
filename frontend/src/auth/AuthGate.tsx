import { useCallback, useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import {
  getCurrentUser,
  type AuthenticatedUser,
} from './auth'
import LoginPage from '../pages/LoginPage'

type AuthGateProps = {
  children: React.ReactNode
}

function AuthGate({ children }: AuthGateProps) {
  const [user, setUser] = useState<AuthenticatedUser | null>(null)
  const [checking, setChecking] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const location = useLocation()

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
    return (
      <LoginPage
        onLogin={async () => {
          await refreshSession()
        }}
      />
    )
  }

  if (user.role !== 'administrator' && user.role !== 'slm_operator') {
    return <Navigate to="/" replace state={{ from: location }} />
  }

  return <>{children}</>
}

export default AuthGate
