import Icon from './ui/Icon'
import type { IconName } from './ui/Icon'

const services: { icon: IconName; title: string; text: string }[] = [
  { icon: 'maintenance', title: 'Manutenção predial', text: 'Peça reparos e acompanhe o agendamento.' },
  { icon: 'fleet', title: 'Frota', text: 'Reserve veículos com motorista.' },
  { icon: 'flights', title: 'Passagens aéreas', text: 'Solicite viagens e receba os bilhetes.' },
  { icon: 'warehouse', title: 'Almoxarifado', text: 'Peça materiais e veja a entrega.' },
]

/** Painel de apresentação ao lado dos formulários de acesso, em telas largas. */
function AuthBrand() {
  return (
    <aside className="auth-brand" aria-label="Sobre o sistema">
      <p className="auth-brand-kicker">JUCESP · SLM</p>
      <h2>Gestão de Serviços de Logística e Manutenção</h2>
      <p className="auth-brand-lead">Tudo o que você pede à SLM em um só lugar, com protocolo e acompanhamento até o fim.</p>
      <ul>
        {services.map((service) => (
          <li key={service.title}>
            <span className="auth-brand-icon">
              <Icon name={service.icon} size={22} weight="duotone" />
            </span>
            <span>
              <strong>{service.title}</strong>
              {service.text}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  )
}

export default AuthBrand
