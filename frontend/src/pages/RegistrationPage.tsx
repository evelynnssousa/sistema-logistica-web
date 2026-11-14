import { useEffect, useState, type FormEvent } from 'react'
import { PASSWORD_MIN_LENGTH } from '../auth/passwordPolicy'
import { getPublicRegistrationForm } from '../api/configApi'
import type { FormContent } from '../api/configApi'
import { isManagedFieldVisible } from '../app/requestForm'
import { register } from '../auth/auth'
import logoJucesp from '../assets/logoJucespNovo.png'
import '../App.css'
import AuthBackButton from '../components/AuthBackButton'
import AuthBrand from '../components/AuthBrand'
import PasswordField from '../components/PasswordField'

type RegistrationPageProps = {
  onBackToLogin: () => void
  /** Volta à página inicial. */
  onBack: () => void
}

function RegistrationPage({ onBackToLogin, onBack }: RegistrationPageProps) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [sector, setSector] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [form, setForm] = useState<FormContent | null>(null)
  const [extra, setExtra] = useState<Record<string, string>>({})

  // Sem resposta, vale o formulário padrão: entrar com a conta não depende disto.
  useEffect(() => {
    let active = true
    getPublicRegistrationForm()
      .then((data) => {
        if (active) setForm(data.form)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const labelOf = (id: string, fallback: string) => form?.fields.find((field) => field.id === id)?.label ?? fallback
  const customFields = (form?.fields ?? []).filter(
    (field) => field.id.startsWith('custom-') && isManagedFieldVisible(field, { ...extra, fullName, email, sector }, false),
  )

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSuccess('')

    if (password !== passwordConfirmation) {
      setError('As senhas não correspondem.')
      return
    }

    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`A senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`)
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
        customFields: Object.fromEntries(
          customFields.filter((field) => extra[field.id]).map((field) => [field.id, extra[field.id]]),
        ),
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
    <main className="login-page auth-split">
      <AuthBrand />
      <section className="login-card">
        <AuthBackButton onClick={onBack} disabled={loading} label="Voltar para a página inicial" />
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
            <label htmlFor="register-name">{labelOf('fullName', 'Nome completo')}</label>
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

            <label htmlFor="register-email">{labelOf('email', 'E-mail')}</label>
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

            <label htmlFor="register-sector">{labelOf('sector', 'Setor')}</label>
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

            {customFields.map((field) => (
              <div key={field.id}>
                <label htmlFor={`register-${field.id}`}>{field.label}{field.required && <span aria-hidden="true"> *</span>}</label>
                {field.type === 'singleSelect' ? (
                  <select
                    id={`register-${field.id}`}
                    required={field.required}
                    disabled={loading}
                    value={extra[field.id] ?? ''}
                    onChange={(event) => setExtra((current) => ({ ...current, [field.id]: event.target.value }))}
                  >
                    <option value="">Selecione</option>
                    {field.options.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`register-${field.id}`}
                    type={field.type === 'number' ? 'number' : field.type === 'phone' ? 'tel' : field.type === 'date' ? 'date' : 'text'}
                    required={field.required}
                    disabled={loading}
                    minLength={field.minLength ?? undefined}
                    maxLength={field.maxLength ?? undefined}
                    value={extra[field.id] ?? ''}
                    onChange={(event) => setExtra((current) => ({ ...current, [field.id]: event.target.value }))}
                  />
                )}
                {(field.help || field.description) && <small>{field.help || field.description}</small>}
              </div>
            ))}

            <label htmlFor="register-password">{labelOf('password', 'Senha')}</label>
            <PasswordField
              id="register-password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={`Mínimo de ${PASSWORD_MIN_LENGTH} caracteres`}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={512}
              required
              disabled={loading}
            />

            <label htmlFor="register-confirm-password">
              Confirmar senha
            </label>
            <PasswordField
              id="register-confirm-password"
              autoComplete="new-password"
              value={passwordConfirmation}
              onChange={(event) =>
                setPasswordConfirmation(event.target.value)
              }
              placeholder="Digite a senha novamente"
              minLength={PASSWORD_MIN_LENGTH}
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
