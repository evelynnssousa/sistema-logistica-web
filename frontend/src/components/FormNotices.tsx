import { serviceNotices } from '../app/serviceNotices'
import type { ServiceNoticeModule } from '../app/serviceNotices'
import PrivacyNotice from './PrivacyNotice'
import Icon from './ui/Icon'

/**
 * Tudo o que a pessoa precisa saber antes de enviar: as condições de atendimento e o aviso de
 * privacidade. Ficam juntos para uma mudança de layout não levar um e esquecer o outro.
 */
function FormNotices({ module }: { module: ServiceNoticeModule }) {
  return (
    <div className="form-notices">
      <aside className="service-notice" aria-label="Condições de atendimento" data-notice={module}>
        <h3>
          <Icon name="info" size={18} />
          Condições de atendimento
        </h3>
        <p>{serviceNotices[module]}</p>
      </aside>
      <PrivacyNotice module={module} />
    </div>
  )
}

export default FormNotices
