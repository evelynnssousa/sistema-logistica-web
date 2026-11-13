import { useEffect, useState } from 'react'
import { getPublicHome } from '../api/configApi'
import type { PublicHome } from '../api/configApi'
import logoJucesp from '../assets/logoJucespNovo.png'
import { ContactBlock, FaqList, NewsList, TeamList } from '../components/PublicContent'
import Icon from '../components/ui/Icon'
import type { IconName } from '../components/ui/Icon'

/**
 * Página inicial pública: o que é o sistema, como pedir acesso, perguntas frequentes, a JUCESP e a
 * SLM, a equipe, as novidades e o contato. Os textos vêm de Configurações → Página inicial.
 */

const services: { module: string; icon: IconName; title: string; text: string }[] = [
  { module: 'maintenance', icon: 'maintenance', title: 'Manutenção', text: 'Reparos e serviços no prédio: elétrica, hidráulica, ar-condicionado e outros.' },
  { module: 'fleet', icon: 'fleet', title: 'Frota', text: 'Pedido de veículo com motorista para deslocamentos a serviço.' },
  { module: 'flights', icon: 'flights', title: 'Passagens aéreas', text: 'Solicitação e acompanhamento de passagens para viagens a serviço.' },
  { module: 'warehouse', icon: 'warehouse', title: 'Almoxarifado', text: 'Pedido de materiais de expediente e acompanhamento da entrega.' },
  { module: 'demands', icon: 'demands', title: 'Controle de Demandas', text: 'Acompanhamento das demandas e prazos de cada setor.' },
]

const steps = [
  { title: 'Crie sua conta', text: 'Use o seu e-mail institucional e informe o seu setor.' },
  { title: 'Aguarde a aprovação', text: 'A equipe da SLM confere o cadastro e libera o acesso.' },
  { title: 'Peça e acompanhe', text: 'Abra a solicitação e acompanhe cada etapa pelo número de protocolo.' },
]

function WelcomePage({ onLogin, onRegister }: { onLogin: () => void; onRegister: () => void }) {
  const [home, setHome] = useState<PublicHome | null>(null)

  useEffect(() => {
    let active = true
    getPublicHome()
      .then((result) => {
        if (active) setHome(result)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const page = home?.page
  const enabled = services.filter((service) => home?.modules[service.module] !== false)

  return (
    <div className="public-page">
      <header className="public-header">
        <div className="public-brand">
          <img src={logoJucesp} alt="JUCESP" />
          <span>
            Gestão de Serviços
            <small>Logística e Manutenção</small>
          </span>
        </div>
        <nav aria-label="Acesso">
          <button type="button" className="public-button-ghost" onClick={onRegister}>
            Criar conta
          </button>
          <button type="button" className="public-button" onClick={onLogin}>
            Entrar
          </button>
        </nav>
      </header>

      <main>
        <section className="public-hero">
          <p className="public-eyebrow">JUCESP · Serviços de Logística e Manutenção</p>
          <h1>{page?.heroTitle || 'Serviços de Logística e Manutenção'}</h1>
          {page?.heroText && <p className="public-lead">{page.heroText}</p>}
          {home?.announcement && (
            <p className={`public-announcement${home.announcement.tone === 'warning' ? ' is-warning' : ''}`} role="status">
              <Icon name={home.announcement.tone === 'warning' ? 'warning' : 'info'} size={20} /> {home.announcement.text}
            </p>
          )}
          <div className="public-hero-actions">
            <button type="button" className="public-button public-button-large" onClick={onLogin}>
              Entrar no sistema
            </button>
            <button type="button" className="public-button-ghost public-button-large" onClick={onRegister}>
              Criar uma conta
            </button>
          </div>
        </section>

        <section className="public-section" aria-labelledby="public-services">
          <h2 id="public-services">O que você pode pedir aqui</h2>
          <ul className="public-cards">
            {enabled.map((service) => (
              <li key={service.module}>
                <Icon name={service.icon} size={28} weight="duotone" />
                <strong>{service.title}</strong>
                <p>{service.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="public-section" aria-labelledby="public-steps">
          <h2 id="public-steps">Como funciona</h2>
          <ol className="public-steps">
            {steps.map((step, index) => (
              <li key={step.title}>
                <span aria-hidden="true">{index + 1}</span>
                <strong>{step.title}</strong>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {page && page.faq.length > 0 && (
          <section className="public-section" aria-labelledby="public-faq">
            <h2 id="public-faq">Perguntas frequentes</h2>
            <FaqList items={page.faq} />
          </section>
        )}

        {page && (page.aboutOrgan || page.aboutSlm) && (
          <section className="public-section public-about" aria-labelledby="public-about">
            <h2 id="public-about">Quem somos</h2>
            <div className="public-columns">
              {page.aboutOrgan && (
                <article>
                  <h3>A JUCESP</h3>
                  <p>{page.aboutOrgan}</p>
                </article>
              )}
              {page.aboutSlm && (
                <article>
                  <h3>A SLM</h3>
                  <p>{page.aboutSlm}</p>
                </article>
              )}
            </div>
          </section>
        )}

        {page && page.team.length > 0 && (
          <section className="public-section" aria-labelledby="public-team">
            <h2 id="public-team">Nossa equipe</h2>
            <TeamList members={page.team} />
          </section>
        )}

        {page && page.news.length > 0 && (
          <section className="public-section" aria-labelledby="public-news">
            <h2 id="public-news">Novidades</h2>
            <NewsList items={page.news} />
          </section>
        )}

        {page && (page.contactEmail || page.serviceHours || page.location) && (
          <section className="public-section" aria-labelledby="public-contact">
            <h2 id="public-contact">Fale com a SLM</h2>
            <ContactBlock page={page} />
          </section>
        )}
      </main>

      <footer className="public-footer">
        <p>Junta Comercial do Estado de São Paulo · Serviços de Logística e Manutenção</p>
        <p>Acesso às solicitações restrito a usuários autorizados.</p>
      </footer>
    </div>
  )
}

export default WelcomePage
