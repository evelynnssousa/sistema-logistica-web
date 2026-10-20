import { useState, type FormEvent } from 'react'
import { login } from '../auth/auth'
import logoJucesp from '../assets/logoJucespNovo.png'
import '../App.css'

type LoginPageProps = {
  onLogin: () => Promise<void>
}

function LoginPage({ onLogin }: LoginPageProps) {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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

        <form onSubmit={handleSubmit} className="login-form">
          <label htmlFor="login-identifier">Usuário ou e-mail</label>
          <input
            id="login-identifier"
            type="text"
            autoComplete="username"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder="Digite seu usuário ou e-mail"
            required
            disabled={loading}
          />

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

          {error && (
            <p className="login-error" role="alert">
              {error}
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

        <p className="login-footer">
          Acesso restrito a usuários autorizados.
        </p>
      </section>
    </main>
  )
}

export default LoginPage
