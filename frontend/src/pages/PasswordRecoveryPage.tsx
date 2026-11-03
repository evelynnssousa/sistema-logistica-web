import { useState, type FormEvent } from 'react'
import logoJucesp from '../assets/logoJucespNovo.png'
import { requestPasswordRecovery, resetPassword } from '../auth/auth'
import '../App.css'

type PasswordRecoveryPageProps = {
  onBackToLogin: () => void
}

function PasswordRecoveryPage({ onBackToLogin }: PasswordRecoveryPageProps) {
  const [step, setStep] = useState<'email' | 'reset'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setMessage('')
    setLoading(true)

    try {
      const result = await requestPasswordRecovery(email.trim())
      setMessage(result)
      setStep('reset')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível solicitar o código.')
    } finally {
      setLoading(false)
    }
  }

  async function handleReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setMessage('')

    if (password !== passwordConfirmation) {
      setError('A confirmação de senha não corresponde.')
      return
    }

    setLoading(true)
    try {
      const result = await resetPassword({
        email: email.trim(),
        code,
        password,
        passwordConfirmation,
      })
      setMessage(result)
      setPassword('')
      setPasswordConfirmation('')
      setCode('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível redefinir a senha.')
    } finally {
      setLoading(false)
    }
  }

  const resetCompleted = message.startsWith('Senha alterada com sucesso')

  return (
    <main className="login-page">
      <section className="login-card">
        <img
          className="login-logo"
          src={logoJucesp}
          alt="JUCESP"
          onError={(event) => { event.currentTarget.style.display = 'none' }}
        />

        <span className="login-eyebrow">SISTEMA INTERNO</span>
        <h1>{resetCompleted ? 'Senha redefinida' : 'Recuperar senha'}</h1>
        <p className="login-description">
          {step === 'email'
            ? 'Informe seu e-mail cadastrado para receber as instruções de recuperação.'
            : 'Informe o código de seis dígitos recebido por e-mail e escolha uma nova senha.'}
        </p>

        {step === 'email' ? (
          <form className="login-form" onSubmit={handleRequest}>
            <label htmlFor="recovery-email">E-mail cadastrado</label>
            <input
              id="recovery-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Digite seu e-mail"
              maxLength={254}
              required
              disabled={loading}
            />
            {message && <p className="recovery-success" role="status">{message}</p>}
            {error && <p className="login-error" role="alert">{error}</p>}
            <button className="login-submit" type="submit" disabled={loading}>
              {loading ? 'Solicitando...' : 'Enviar código'}
            </button>
          </form>
        ) : (
          <form className="login-form" onSubmit={handleReset}>
            <label htmlFor="recovery-code">Código de verificação</label>
            <input
              id="recovery-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="Digite os 6 números"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              disabled={loading || resetCompleted}
            />

            <label htmlFor="recovery-new-password">Nova senha</label>
            <input
              id="recovery-new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Mínimo de 12 caracteres"
              minLength={12}
              maxLength={512}
              required
              disabled={loading || resetCompleted}
            />

            <label htmlFor="recovery-confirm-password">Confirme a nova senha</label>
            <input
              id="recovery-confirm-password"
              type="password"
              autoComplete="new-password"
              value={passwordConfirmation}
              onChange={(event) => setPasswordConfirmation(event.target.value)}
              placeholder="Digite a senha novamente"
              minLength={12}
              maxLength={512}
              required
              disabled={loading || resetCompleted}
            />

            {message && <p className="recovery-success" role="status">{message}</p>}
            {error && <p className="login-error" role="alert">{error}</p>}

            {!resetCompleted && (
              <button className="login-submit" type="submit" disabled={loading}>
                {loading ? 'Salvando...' : 'Redefinir senha'}
              </button>
            )}
            {!resetCompleted && (
              <button
                className="recovery-link recovery-resend"
                type="button"
                onClick={() => {
                  setStep('email')
                  setMessage('')
                  setError('')
                }}
                disabled={loading}
              >
                Voltar para solicitar outro código
              </button>
            )}
          </form>
        )}

        <p className="login-register-link">
          <button type="button" onClick={onBackToLogin} disabled={loading}>
            Voltar ao login
          </button>
        </p>
        <p className="login-footer">O código expira em 10 minutos e só pode ser usado uma vez.</p>
      </section>
    </main>
  )
}

export default PasswordRecoveryPage
