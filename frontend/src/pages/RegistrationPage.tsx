import { useState, type FormEvent } from 'react'
import { PasswordField } from '../components/PasswordField'

interface RegistrationPageProps {
  onSubmit: (data: {
    fullName: string
    email: string
    sector: string
    password: string
    passwordConfirmation: string
  }) => Promise<string>
  onLogin: () => void
}

export function RegistrationPage({ onSubmit, onLogin }: RegistrationPageProps) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [sector, setSector] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setConfirmation('')
    if (password !== passwordConfirmation) {
      setError('A confirmação de senha não corresponde.')
      return
    }
    if (password.length < 12) {
      setError('A senha deve ter ao menos 12 caracteres.')
      return
    }

    setSubmitting(true)
    try {
      const message = await onSubmit({ fullName, email, sector, password, passwordConfirmation })
      setConfirmation(message)
      setPassword('')
      setPasswordConfirmation('')
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : 'Falha no cadastro.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel auth-panel-wide">
        <div className="auth-brand">
          <strong className="auth-wordmark">JUCESP</strong>
          <span className="auth-brand-divider" aria-hidden="true" />
          <span>GESTÃO DE SERVIÇOS</span>
        </div>
        <p className="eyebrow">SOLICITAÇÃO DE ACESSO</p>
        <h1>Criar minha conta</h1>
        <p className="auth-system-name">Sistema de Serviços de Logística e Manutenção</p>
        <p className="auth-intro">Esta solicitação de acesso será analisada por um administrador. O acesso só será liberado após aprovação.</p>
        <form className="auth-form registration-form" onSubmit={handleSubmit}>
          <label className="auth-field" htmlFor="register-full-name">
            Nome completo
            <input id="register-full-name" value={fullName} onChange={(event) => setFullName(event.target.value)} required minLength={2} maxLength={120} autoComplete="name" />
          </label>
          <label className="auth-field" htmlFor="register-email">
            E-mail institucional
            <input id="register-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} autoComplete="email" />
          </label>
          <label className="auth-field" htmlFor="register-sector">
            Setor
            <input id="register-sector" value={sector} onChange={(event) => setSector(event.target.value)} required minLength={2} maxLength={120} autoComplete="organization-title" />
          </label>
          <PasswordField id="register-password" label="Senha" value={password} onChange={setPassword} required minLength={12} maxLength={512} autoComplete="new-password" />
          <PasswordField id="register-password-confirmation" label="Confirmar senha" value={passwordConfirmation} onChange={setPasswordConfirmation} required minLength={12} maxLength={512} autoComplete="new-password" />
          {error && <p className="form-error" role="alert">{error}</p>}
          {confirmation && <p className="form-success" role="status">{confirmation}</p>}
          <button className="primary-button" type="submit" disabled={submitting}>
            {submitting ? 'Enviando...' : 'Enviar solicitação'}
          </button>
        </form>
        <div className="auth-alternative">
          <span>Já possui conta?</span>
          <button type="button" className="text-button" onClick={onLogin}>Voltar ao acesso</button>
        </div>
      </section>
    </main>
  )
}