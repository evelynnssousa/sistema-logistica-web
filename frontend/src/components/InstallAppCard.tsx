import { useState, useSyncExternalStore } from 'react'
import { canPromptInstall, isInstalled, isIos, promptInstall, subscribeInstall } from '../app/installPrompt'
import Icon from './ui/Icon'

/** Convite para instalar o sistema no celular. Some quando já está instalado. */
function InstallAppCard() {
  const available = useSyncExternalStore(subscribeInstall, canPromptInstall, () => false)
  const [dismissed, setDismissed] = useState(false)
  if (dismissed || isInstalled() || (!available && !isIos())) return null
  return (
    <section className="install-app-card" aria-labelledby="install-app-title">
      <span className="install-app-icon" aria-hidden="true">
        <Icon name="download" size={22} />
      </span>
      <div>
        <h2 id="install-app-title">Instale no celular</h2>
        {available ? (
          <p>Abra o portal direto da tela inicial, como um aplicativo, mesmo com sinal fraco.</p>
        ) : (
          <p>
            No iPhone: toque em <strong>Compartilhar</strong> (o quadrado com a seta) e depois em{' '}
            <strong>Adicionar à Tela de Início</strong>.
          </p>
        )}
      </div>
      <div className="install-app-actions">
        {available && (
          <button type="button" className="maintenance-primary-button" onClick={() => void promptInstall()}>
            Instalar
          </button>
        )}
        <button type="button" className="maintenance-secondary-button" onClick={() => setDismissed(true)}>
          Agora não
        </button>
      </div>
    </section>
  )
}

export default InstallAppCard
