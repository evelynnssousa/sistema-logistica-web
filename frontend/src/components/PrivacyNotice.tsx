import { privacyNotices } from '../app/privacyNotices'
import Icon from './ui/Icon'

/** Sempre visível antes do envio. É informativo: não há nada a marcar. */
function PrivacyNotice({ module }: { module: keyof typeof privacyNotices }) {
  const notice: (typeof privacyNotices)[keyof typeof privacyNotices] & { protection?: string } =
    privacyNotices[module]

  return (
    <aside className="privacy-notice" aria-label="Aviso de privacidade">
      <h3>
        <Icon name="locked" size={18} />
        Como seus dados são usados
      </h3>
      <dl>
        <div>
          <dt>Finalidade</dt>
          <dd>{notice.purpose}</dd>
        </div>
        <div>
          <dt>Dados necessários</dt>
          <dd>{notice.data}</dd>
        </div>
        <div>
          <dt>Uso no serviço</dt>
          <dd>{notice.use}</dd>
        </div>
        {notice.protection && (
          <div>
            <dt>Proteção</dt>
            <dd>{notice.protection}</dd>
          </div>
        )}
      </dl>
    </aside>
  )
}

export default PrivacyNotice
