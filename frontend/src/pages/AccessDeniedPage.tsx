import { Link } from 'react-router-dom'

function AccessDeniedPage() {
  return (
    <section className="placeholder-card access-denied" role="alert">
      <div className="placeholder-icon" aria-hidden="true">
        ⛔
      </div>
      <h2>Acesso não autorizado</h2>
      <p>
        Seu perfil não tem permissão para acessar esta página. Se você precisa
        deste acesso, fale com um administrador do sistema.
      </p>
      <Link className="back-button" to="/">
        ← Voltar ao painel
      </Link>
    </section>
  )
}

export default AccessDeniedPage
