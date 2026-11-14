import { useEffect, useState } from 'react'
import { getPublicHome } from '../api/configApi'
import type { PublicHome } from '../api/configApi'
import logoJucesp from '../assets/logoJucespNovo.png'
import { ContactBlock, FaqList, ManualList, NewsList, TeamList } from '../components/PublicContent'
import Icon from '../components/ui/Icon'
import type { IconName } from '../components/ui/Icon'

/**
 * Página inicial pública: o que é o sistema, como pedir acesso, perguntas frequentes, a JUCESP e a
 * SLM, a equipe, as novidades e o contato. Os textos vêm de Configurações → Página inicial.
 * A prévia da abertura é ilustrativa (nenhum dado real).
 */

const services: { module: string; icon: IconName; title: string; text: string }[] = [
  { module: 'maintenance', icon: 'maintenance', title: 'Manutenção', text: 'Reparos e serviços no prédio: elétrica, hidráulica, ar-condicionado e outros.' },
  { module: 'fleet', icon: 'fleet', title: 'Frota', text: 'Veículo com motorista para deslocamentos a serviço.' },
  { module: 'flights', icon: 'flights', title: 'Passagens aéreas', text: 'Solicitação e acompanhamento de passagens para viagens a serviço.' },
  { module: 'warehouse', icon: 'warehouse', title: 'Almoxarifado', text: 'Materiais de expediente, com acompanhamento até a entrega.' },
  { module: 'demands', icon: 'demands', title: 'Controle de Demandas', text: 'Demandas, prazos e recorrências de cada setor em um só painel.' },
]

const steps = [
  { title: 'Crie sua conta', text: 'Use o seu e-mail institucional e informe o seu setor.' },
  { title: 'Aguarde a aprovação', text: 'A equipe da SLM confere o cadastro e libera o acesso.' },
  { title: 'Peça e acompanhe', text: 'Abra a solicitação e siga cada etapa pelo número de protocolo.' },
]

const previewSteps = [
  { label: 'Solicitação recebida', time: '09:12', done: true },
  { label: 'Agendada com a equipe', time: '10:40', done: true },
  { label: 'Em atendimento', time: 'agora', done: false },
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
  const hasAbout = Boolean(page && (page.aboutOrgan || page.aboutSlm))
  const hasContact = Boolean(page && (page.contactEmail || page.serviceHours || page.location))

  return (
    <div className="public-page">
      <header className="public-header">
        <a className="public-brand" href="#inicio" aria-label="JUCESP, Gestão de Serviços: início da página">
          <img src={logoJucesp} alt="JUCESP" width={104} height={68} />
          <span>
            Gestão de Serviços
            <small>Logística e Manutenção</small>
          </span>
        </a>
        <nav className="public-links" aria-label="Seções da página">
          <a href="#servicos">Serviços</a>
          <a href="#como-funciona">Como funciona</a>
          {page?.manuals && page.manuals.length > 0 && <a href="#manuais">Manuais</a>}
          {page && page.faq.length > 0 && <a href="#duvidas">Dúvidas</a>}
          {hasContact && <a href="#contato">Contato</a>}
        </nav>
        <div className="public-header-actions">
          <button type="button" className="public-button-outline" onClick={onRegister}>
            Criar conta
          </button>
          <button type="button" className="public-button" onClick={onLogin}>
            Entrar
          </button>
        </div>
      </header>

      <main id="inicio">
        <section className="public-hero">
          <div className="public-hero-text">
            <p className="public-eyebrow">
              <span aria-hidden="true" /> Junta Comercial do Estado de São Paulo
            </p>
            <h1>{page?.heroTitle || 'Serviços de Logística e Manutenção'}</h1>
            {page?.heroText && <p className="public-lead">{page.heroText}</p>}
            {home?.announcement && (
              <p className={`public-announcement${home.announcement.tone === 'warning' ? ' is-warning' : ''}`} role="status">
                <Icon name={home.announcement.tone === 'warning' ? 'warning' : 'info'} size={20} /> {home.announcement.text}
              </p>
            )}
            <div className="public-hero-actions">
              <button type="button" className="public-button public-button-large" onClick={onLogin}>
                Entrar no sistema <span aria-hidden="true">→</span>
              </button>
              <button type="button" className="public-button-ghost public-button-large" onClick={onRegister}>
                Criar uma conta
              </button>
            </div>
            <ul className="public-trust">
              <li>
                <Icon name="locked" size={18} /> Acesso com e-mail institucional
              </li>
              <li>
                <Icon name="success" size={18} /> Cada pedido com número de protocolo
              </li>
            </ul>
          </div>

          <div className="public-hero-visual" aria-hidden="true">
            <div className="public-logo-card">
              <img src={logoJucesp} alt="" width={168} height={110} />
            </div>
            <div className="public-preview">
              <div className="public-preview-head">
                <span className="public-preview-icon">
                  <Icon name="maintenance" size={20} />
                </span>
                <div>
                  <strong>Ar-condicionado da sala 12</strong>
                  <small>Manutenção · MAN-2026-00012</small>
                </div>
                <span className="public-chip">Em atendimento</span>
              </div>
              <ol>
                {previewSteps.map((step) => (
                  <li key={step.label} className={step.done ? 'is-done' : 'is-current'}>
                    <span />
                    {step.label}
                    <time>{step.time}</time>
                  </li>
                ))}
              </ol>
            </div>
            <div className="public-float">
              <Icon name="warehouse" size={18} /> Pedido de materiais entregue
            </div>
          </div>
        </section>

        <section className="public-section" id="servicos" aria-labelledby="public-services">
          <header className="public-section-head">
            <p className="public-kicker">Serviços</p>
            <h2 id="public-services">O que você pode pedir aqui</h2>
            <p>Tudo o que a SLM atende, em um só lugar e com o mesmo acompanhamento.</p>
          </header>
          <ul className="public-cards">
            {enabled.map((service) => (
              <li key={service.module}>
                <span className="public-card-icon">
                  <Icon name={service.icon} size={26} weight="duotone" />
                </span>
                <strong>{service.title}</strong>
                <p>{service.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="public-band" id="como-funciona" aria-labelledby="public-steps">
          <div className="public-section">
            <header className="public-section-head">
              <p className="public-kicker">Como funciona</p>
              <h2 id="public-steps">Três passos para começar</h2>
            </header>
            <ol className="public-steps">
              {steps.map((step, index) => (
                <li key={step.title}>
                  <span aria-hidden="true">{index + 1}</span>
                  <strong>{step.title}</strong>
                  <p>{step.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {page?.manuals && page.manuals.length > 0 && (
          <section className="public-section" id="manuais" aria-labelledby="public-manuals">
            <header className="public-section-head">
              <p className="public-kicker">Manuais</p>
              <h2 id="public-manuals">Aprenda a usar o sistema</h2>
              <p>Escolha o manual do seu perfil. Ele abre em PDF, para ler ou salvar.</p>
            </header>
            <ManualList items={page.manuals} />
          </section>
        )}

        {page && page.faq.length > 0 && (
          <section className="public-section public-faq-layout" id="duvidas" aria-labelledby="public-faq">
            <header className="public-section-head">
              <p className="public-kicker">Dúvidas</p>
              <h2 id="public-faq">Perguntas frequentes</h2>
              <p>Não achou a resposta? Fale com a equipe da SLM.</p>
              {page.contactEmail && (
                <a className="public-button-outline public-inline-button" href={`mailto:${page.contactEmail}`}>
                  <Icon name="mail" size={18} /> Escrever para a SLM
                </a>
              )}
            </header>
            <FaqList items={page.faq} />
          </section>
        )}

        {hasAbout && page && (
          <section className="public-band public-band-light" aria-labelledby="public-about">
            <div className="public-section">
              <header className="public-section-head">
                <p className="public-kicker">Quem somos</p>
                <h2 id="public-about">A JUCESP e a SLM</h2>
              </header>
              <div className="public-columns">
                {page.aboutOrgan && (
                  <article>
                    <img src={logoJucesp} alt="" width={84} height={55} />
                    <h3>A JUCESP</h3>
                    <p>{page.aboutOrgan}</p>
                  </article>
                )}
                {page.aboutSlm && (
                  <article>
                    <span className="public-card-icon">
                      <Icon name="maintenance" size={26} weight="duotone" />
                    </span>
                    <h3>A SLM</h3>
                    <p>{page.aboutSlm}</p>
                  </article>
                )}
              </div>
            </div>
          </section>
        )}

        {page && page.team.length > 0 && (
          <section className="public-section" aria-labelledby="public-team">
            <header className="public-section-head">
              <p className="public-kicker">Equipe</p>
              <h2 id="public-team">Quem atende você</h2>
            </header>
            <TeamList members={page.team} />
          </section>
        )}

        {page && page.news.length > 0 && (
          <section className="public-section" aria-labelledby="public-news">
            <header className="public-section-head">
              <p className="public-kicker">Novidades</p>
              <h2 id="public-news">O que mudou no sistema</h2>
            </header>
            <NewsList items={page.news} />
          </section>
        )}

        {hasContact && page && (
          <section className="public-cta" id="contato" aria-labelledby="public-contact">
            <div className="public-cta-inner">
              <div>
                <p className="public-kicker">Contato</p>
                <h2 id="public-contact">Ainda com dúvida? Fale com a SLM</h2>
                {page.contactEmail && (
                  <a className="public-button public-button-large" href={`mailto:${page.contactEmail}`}>
                    <Icon name="mail" size={20} /> {page.contactEmail}
                  </a>
                )}
              </div>
              <ContactBlock page={{ ...page, contactEmail: '' }} />
            </div>
          </section>
        )}
      </main>

      <footer className="public-footer">
        <div className="public-footer-brand">
          <img src={logoJucesp} alt="JUCESP" width={92} height={60} />
          <p>
            Junta Comercial do Estado de São Paulo
            <small>Serviços de Logística e Manutenção</small>
          </p>
        </div>
        <p>Acesso às solicitações restrito a usuários autorizados.</p>
      </footer>
    </div>
  )
}

export default WelcomePage
