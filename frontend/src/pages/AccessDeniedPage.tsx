import { Link } from 'react-router-dom'
import Icon from '../components/ui/Icon'

function AccessDeniedPage() {
  return (
    <section className="placeholder-card access-denied" role="alert">
      <div className="placeholder-icon" aria-hidden="true">
        <Icon name="denied" size={44} weight="duotone" />
      </div>
      <h2>Acesso não autorizado</h2>
      <p>
        Seu perfil não tem permissão para acessar esta página. Se você precisa
        deste acesso, fale com um administrador do sistema.
      </p>
      <Link className="back-button" to="/">
        Voltar ao início
      </Link>
    </section>
  )
}

export default AccessDeniedPage
