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

// O token vem depois do "#": nunca é enviado ao servidor de páginas nem aparece no Referer.
function readRecoveryToken() {
  const match = window.location.hash.match(/^#recuperar-senha=([A-Za-z0-9_-]{43})$/)
  if (!match) return null
  window.history.replaceState(null, '', window.location.pathname)
  return match[1]
}

// Dentro de uma pré-visualização embutida, o navegador recusa o cookie de sessão.
function isEmbedded() {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

const sessionNotKept = () =>
  isEmbedded()
    ? 'Seus dados foram aceitos, mas o navegador não guarda a sessão quando o sistema está embutido em outra página, como a pré-visualização do editor. Abra o endereço em uma aba própria do navegador.'
    : 'Seus dados foram aceitos, mas o navegador não manteve a sessão. Confira se os cookies estão permitidos para este endereço e apague cookies antigos do sistema antes de entrar de novo.'

function AuthGate({ children }: AuthGateProps) {
  const [user, setUser] = useState<AuthenticatedUser | null>(null)
  const [checking, setChecking] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [linkToken, setLinkToken] = useState(readRecoveryToken)
  const [authView, setAuthView] = useState<'login' | 'register' | 'recovery'>(
    linkToken ? 'recovery' : 'login',
  )

  const [loginNotice, setLoginNotice] = useState('')

  // Muda a cada login e logout. Resposta de consulta iniciada antes disso é de outra sessão.
  const sessionEpoch = useRef(0)
  const authenticated = useRef(false)

  const applyUser = useCallback((currentUser: AuthenticatedUser | null) => {
    authenticated.current = currentUser !== null
    setUser(currentUser)
  }, [])

  const refreshSession = useCallback(async () => {
    sessionEpoch.current += 1
    setChecking(true)
    setUnavailable(false)
    setLoginNotice('')

    try {
      applyUser(await getCurrentUser())
    } catch {
      applyUser(null)
      setUnavailable(true)
    } finally {
      setChecking(false)
    }
  }, [applyUser])

  // O login foi aceito: se a sessão não se confirmar, a pessoa precisa saber o motivo.
  const confirmLogin = useCallback(async () => {
    sessionEpoch.current += 1
    setChecking(true)
    setUnavailable(false)
    setLoginNotice('')

    try {
      const currentUser = await getCurrentUser()
      applyUser(currentUser)
      if (!currentUser) setLoginNotice(sessionNotKept())
    } catch {
      applyUser(null)
      setUnavailable(true)
    } finally {
      setChecking(false)
    }
  }, [applyUser])

  // Primeira verificação: "checking" já começa verdadeiro e os estados só mudam
  // quando a resposta chega, e não durante o efeito.
  useEffect(() => {
    let active = true

    getCurrentUser()
      .then((currentUser) => {
        if (active) applyUser(currentUser)
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
  }, [applyUser])

  // Mantém menus e rotas alinhados às permissões atuais, que podem mudar durante a
  // sessão. Se a conta foi desativada, volta para o login.
  const { pathname } = useLocation()
  const firstPath = useRef(true)

  useEffect(() => {
    let active = true

    const refresh = () => {
      // Na tela de login não há sessão para conferir, e a consulta poderia cruzar com o login.
      if (!authenticated.current) return
      const epoch = sessionEpoch.current

      getCurrentUser()
        .then((currentUser) => {
          if (!active || epoch !== sessionEpoch.current) return
          applyUser(currentUser)
          if (!currentUser) setLoginNotice('Sua sessão foi encerrada. Entre novamente para continuar.')
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
  }, [pathname, applyUser])

  // Só considera a saída concluída depois de o backend encerrar a sessão.
  const handleLogout = useCallback(async () => {
    await logout()
    sessionEpoch.current += 1
    applyUser(null)
    setLoginNotice('')
    setAuthView('login')
  }, [applyUser])

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
          linkToken={linkToken}
          onBackToLogin={() => {
            setLinkToken(null)
            setAuthView('login')
          }}
        />
      )
    }

    return (
      <LoginPage
        notice={loginNotice}
        onLogin={confirmLogin}
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
