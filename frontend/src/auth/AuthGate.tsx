import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { accessRefusedEvent } from './apiClient'
import {
  getCurrentUser,
  logout,
  type AuthenticatedUser,
} from './auth'
import LoginPage from '../pages/LoginPage'
import RegistrationPage from '../pages/RegistrationPage'
import PasswordRecoveryPage from '../pages/PasswordRecoveryPage'
import { LogoutContext, UserContext } from './UserContext'

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

  // Primeira verificação: "checking" já começa verdadeiro e os estados só mudam
  // quando a resposta chega, e não durante o efeito.
  useEffect(() => {
    let active = true

    getCurrentUser()
      .then((currentUser) => {
        if (active) setUser(currentUser)
      })
      .catch(() => {
        if (active) setUnavailable(true)
      })
      .finally(() => {
        if (active) setChecking(false)
      })

    return () => {
      active = false
    }
  }, [])

  // Mantém menus e rotas alinhados às permissões atuais, que podem mudar durante a
  // sessão. Se a conta foi desativada, volta para o login.
  const { pathname } = useLocation()
  const firstPath = useRef(true)

  useEffect(() => {
    let active = true

    const refresh = () => {
      getCurrentUser()
        .then((currentUser) => {
          if (active) setUser(currentUser)
        })
        .catch(() => {
          // Falha momentânea: o backend continua validando cada requisição.
        })
    }

    if (firstPath.current) {
      firstPath.current = false
    } else {
      refresh()
    }

    window.addEventListener('focus', refresh)
    window.addEventListener(accessRefusedEvent, refresh)
    return () => {
      active = false
      window.removeEventListener('focus', refresh)
      window.removeEventListener(accessRefusedEvent, refresh)
    }
  }, [pathname])

  // Só considera a saída concluída depois de o backend encerrar a sessão.
  const handleLogout = useCallback(async () => {
    await logout()
    setUser(null)
    setAuthView('login')
  }, [])

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
      <LogoutContext.Provider value={handleLogout}>
        {children}
      </LogoutContext.Provider>
    </UserContext.Provider>
  )
}

export default AuthGate
