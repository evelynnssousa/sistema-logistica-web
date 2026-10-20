import { useState, type FormEvent } from 'react'
import { PasswordField } from '../components/PasswordField'

interface LoginPageProps {
  onSubmit: (email: string, password: string) => Promise<void>
  onRegister: () => void
}

export function LoginPage({ onSubmit, onRegister }: LoginPageProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await onSubmit(email, password)
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : 'Falha no acesso.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="auth-brand">
          <strong className="auth-wordmark">JUCESP</strong>
          <span className="auth-brand-divider" aria-hidden="true" />
          <span>GESTÃO DE SERVIÇOS</span>
        </div>
        <p className="eyebrow">ACESSO RESTRITO</p>
        <h1>Entrar no sistema</h1>
        <p className="auth-system-name">Sistema de Serviços de Logística e Manutenção</p>
        <p className="auth-intro">Use sua conta institucional aprovada para continuar.</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-field" htmlFor="login-email">
            E-mail institucional
            <input
              id="login-email"
              autoComplete="username"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              maxLength={254}
            />
          </label>
          <PasswordField
            id="login-password"
            label="Senha"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            maxLength={512}
          />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button" type="submit" disabled={submitting}>
            {submitting ? 'Verificando...' : 'Entrar'}
          </button>
        </form>
        <div className="auth-alternative">
          <span>Não tem conta?</span>
          <button type="button" className="text-button" onClick={onRegister}>
            Criar minha conta
          </button>
        </div>
      </section>
    </main>
  )
}