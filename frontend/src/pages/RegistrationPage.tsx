import { useState, type FormEvent } from 'react'
import { register } from '../auth/auth'
import logoJucesp from '../assets/logoJucespNovo.png'
import '../App.css'

type RegistrationPageProps = {
  onBackToLogin: () => void
}

function RegistrationPage({ onBackToLogin }: RegistrationPageProps) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [sector, setSector] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSuccess('')

    if (password !== passwordConfirmation) {
      setError('As senhas não correspondem.')
      return
    }

    if (password.length < 12) {
      setError('A senha deve ter pelo menos 12 caracteres.')
      return
    }

    setLoading(true)

    try {
      const message = await register({
        fullName: fullName.trim(),
        email: email.trim(),
        sector: sector.trim(),
        password,
        passwordConfirmation,
      })
      setSuccess(message)
      setFullName('')
      setEmail('')
      setSector('')
      setPassword('')
      setPasswordConfirmation('')
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Não foi possível enviar a solicitação. Tente novamente.',
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
        <h1>Criar minha conta</h1>
        <p className="login-description">
          Solicite acesso ao Sistema de Serviços de Logística e Manutenção.
        </p>

        {success ? (
          <div role="status">
            <p>{success}</p>
            <p>
              Sua conta só poderá acessar o sistema após a aprovação de um
              administrador.
            </p>
            <button
              className="login-submit"
              type="button"
              onClick={onBackToLogin}
            >
              Voltar para o login
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="login-form">
            <label htmlFor="register-name">Nome completo</label>
            <input
              id="register-name"
              type="text"
              autoComplete="name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Digite seu nome completo"
              minLength={2}
              maxLength={120}
              required
              disabled={loading}
            />

            <label htmlFor="register-email">E-mail</label>
            <input
              id="register-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Digite seu e-mail"
              maxLength={254}
              required
              disabled={loading}
            />

            <label htmlFor="register-sector">Setor</label>
            <input
              id="register-sector"
              type="text"
              value={sector}
              onChange={(event) => setSector(event.target.value)}
              placeholder="Digite seu setor"
              minLength={2}
              maxLength={120}
              required
              disabled={loading}
            />

            <label htmlFor="register-password">Senha</label>
            <input
              id="register-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Mínimo de 12 caracteres"
              minLength={12}
              maxLength={512}
              required
              disabled={loading}
            />

            <label htmlFor="register-confirm-password">
              Confirmar senha
            </label>
            <input
              id="register-confirm-password"
              type="password"
              autoComplete="new-password"
              value={passwordConfirmation}
              onChange={(event) =>
                setPasswordConfirmation(event.target.value)
              }
              placeholder="Digite a senha novamente"
              minLength={12}
              maxLength={512}
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
              {loading ? 'Enviando solicitação...' : 'Solicitar acesso'}
            </button>

            <p className="login-register-link">
              Já tem uma conta?{' '}
              <button
                type="button"
                onClick={onBackToLogin}
                disabled={loading}
              >
                Entre aqui
              </button>
            </p>
          </form>
        )}

        <p className="login-footer">
          O acesso depende da aprovação de um administrador.
        </p>
      </section>
    </main>
  )
}

export default RegistrationPage
