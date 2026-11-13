import { useEffect, useState, type FormEvent } from 'react'
import { getPublicScreen } from '../api/configApi'
import { login } from '../auth/auth'
import logoJucesp from '../assets/logoJucespNovo.png'
import '../App.css'

type LoginPageProps = {
  /** Explica por que a pessoa está de volta a esta tela. */
  notice?: string
  onLogin: () => Promise<void>
  onRegister: () => void
  onRecoverPassword: () => void
}

function LoginPage({ notice = '', onLogin, onRegister, onRecoverPassword }: LoginPageProps) {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [screen, setScreen] = useState<Awaited<ReturnType<typeof getPublicScreen>> | null>(null)

  // Mensagem e aviso definidos em Configurações. Sem resposta, a tela segue igual.
  useEffect(() => {
    let active = true
    getPublicScreen()
      .then((result) => {
        if (active) setScreen(result)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setLoading(true)

    try {
      await login(identifier.trim(), password)
      await onLogin()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Não foi possível entrar. Tente novamente.',
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <img
          className="login-logo"
          src={logoJucesp}
          alt="JUCESP"
          onError={(event) => {
            event.currentTarget.style.display = 'none'
          }}
        />

        <span className="login-eyebrow">SISTEMA INTERNO</span>
        <h1>Acesse sua conta</h1>
        <p className="login-description">
          Sistema de Serviços de Logística e Manutenção
        </p>
        {screen?.announcement && (
          <p className={`login-notice${screen.announcement.tone === 'warning' ? ' login-notice-warning' : ''}`} role="status">
            {screen.announcement.text}
          </p>
        )}
        {screen?.loginMessage && <p className="login-notice">{screen.loginMessage}</p>}

        <form onSubmit={handleSubmit} className="login-form">
          <label htmlFor="login-identifier">E-mail</label>
          <input
            id="login-identifier"
            type="email"
            autoComplete="username"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder="Digite seu e-mail"
            maxLength={254}
            required
            disabled={loading}
          />

          <div className="recovery-link-row">
            <button
              className="recovery-link"
              type="button"
              onClick={onRecoverPassword}
              disabled={loading}
            >
              Esqueci minha senha
            </button>
          </div>

          <label htmlFor="login-password">Senha</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Digite sua senha"
            required
            disabled={loading}
          />

          {(error || notice) && (
            <p className="login-error" role="alert">
              {error || notice}
            </p>
          )}

          <button
            className="login-submit"
            type="submit"
            disabled={loading}
          >
            {loading ? 'Entrando...' : 'Entrar no sistema'}
          </button>
        </form>

        <p className="login-register-link">
          Ainda não tem uma conta?{' '}
          <button
            type="button"
            onClick={onRegister}
            disabled={loading}
          >
            Crie aqui
          </button>
        </p>

        <p className="login-footer">
          Acesso restrito a usuários autorizados.
        </p>
      </section>
    </main>
  )
}

export default LoginPage
