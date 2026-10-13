import { useEffect, useState } from 'react'
import './App.css'

type Modulo = 'Visão geral' | 'Manutenção' | 'Frota' | 'Passagens aéreas'

function App() {
  const [moduloAtivo, setModuloAtivo] = useState<Modulo>('Visão geral')

  const [apiOnline, setApiOnline] = useState<boolean | null>(null)

useEffect(() => {
  let ativo = true

  fetch('/api/health')
    .then((resposta) => {
      if (!resposta.ok) {
        throw new Error('API indisponível')
      }
      return resposta.json()
    })
    .then((dados) => {
      if (ativo) setApiOnline(dados.success === true)
    })
    .catch(() => {
      if (ativo) setApiOnline(false)
    })

  return () => {
    ativo = false
  }
}, [])

  const modulos: { nome: Modulo; icone: string }[] = [
    { nome: 'Visão geral', icone: '▦' },
    { nome: 'Manutenção', icone: '⚙' },
    { nome: 'Frota', icone: '▣' },
    { nome: 'Passagens aéreas', icone: '✈' },
  ]

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-symbol">J</div>
          <div className="brand-text">
            <strong>GESTÃO DE SERVIÇOS</strong>
            <span>LOGÍSTICA E MANUTENÇÃO</span>
          </div>
        </div>

        <div className="menu-label">MENU PRINCIPAL</div>

        <nav className="navigation">
          {modulos.map((modulo) => (
            <button
              key={modulo.nome}
              className={`nav-item ${
                moduloAtivo === modulo.nome ? 'active' : ''
              }`}
              onClick={() => setModuloAtivo(modulo.nome)}
            >
              <span className="nav-icon">{modulo.icone}</span>
              <span>{modulo.nome}</span>
              {moduloAtivo === modulo.nome && (
                <span className="active-indicator" />
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="help-card">
            <span className="help-icon">i</span>
            <strong>Precisa de ajuda?</strong>
            <p>Consulte a equipe responsável pelo sistema.</p>
          </div>
          <div className="user-profile">
            <div className="avatar">U</div>
            <div className="user-info">
              <strong>Usuário</strong>
              <span>Ambiente de desenvolvimento</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Início</span>
            <span className="breadcrumb-separator">/</span>
            <strong>{moduloAtivo}</strong>
          </div>
          <div className="topbar-right">
            <span className="environment-badge">
              <span
  className={`status-dot ${
    apiOnline === true
      ? 'online'
      : apiOnline === false
        ? 'offline'
        : ''
  }`}
/>
{apiOnline === null
  ? 'Verificando conexão...'
  : apiOnline
    ? 'API conectada'
    : 'API indisponível'}
            </span>
            <div className="topbar-avatar">U</div>
          </div>
        </header>

        <div className="page-content">
          <section className="welcome-section">
            <div>
              <div className="eyebrow">JUCESP · GESTÃO OPERACIONAL</div>
              <h1>
                {moduloAtivo === 'Visão geral'
                  ? 'Painel de controle'
                  : moduloAtivo}
              </h1>
              <p>
                Acompanhe as solicitações e os serviços em um só lugar.
              </p>
            </div>
            <div className="date-label">
              <span className="date-icon">▦</span>
              <span>Visão geral do sistema</span>
            </div>
          </section>

          {moduloAtivo === 'Visão geral' ? (
            <>
              <section className="stats-grid">
                <article className="stat-card">
                  <div className="stat-top">
                    <span className="stat-icon blue">▤</span>
                    <span className="stat-tag">GERAL</span>
                  </div>
                  <p className="stat-label">Total de solicitações</p>
                  <div className="stat-value">—</div>
                  <p className="stat-description">
                    Aguardando integração com a base de dados
                  </p>
                </article>

                <article className="stat-card">
                  <div className="stat-top">
                    <span className="stat-icon orange">◷</span>
                    <span className="stat-tag">PENDÊNCIAS</span>
                  </div>
                  <p className="stat-label">Em andamento</p>
                  <div className="stat-value">—</div>
                  <p className="stat-description">
                    Solicitações em processamento
                  </p>
                </article>

                <article className="stat-card">
                  <div className="stat-top">
                    <span className="stat-icon green">✓</span>
                    <span className="stat-tag">CONCLUÍDOS</span>
                  </div>
                  <p className="stat-label">Serviços concluídos</p>
                  <div className="stat-value">—</div>
                  <p className="stat-description">
                    Serviços finalizados no sistema
                  </p>
                </article>

                <article className="stat-card">
                  <div className="stat-top">
                    <span className="stat-icon purple">✈</span>
                    <span className="stat-tag">VIAGENS</span>
                  </div>
                  <p className="stat-label">Passagens aéreas</p>
                  <div className="stat-value">—</div>
                  <p className="stat-description">
                    Módulo independente em preparação
                  </p>
                </article>
              </section>

              <section className="section-heading">
                <div>
                  <h2>Módulos do sistema</h2>
                  <p>Acesse a área que deseja consultar.</p>
                </div>
              </section>

              <section className="modules-grid">
                <button
                  className="module-card"
                  onClick={() => setModuloAtivo('Manutenção')}
                >
                  <div className="module-icon maintenance">⚙</div>
                  <div className="module-card-content">
                    <h3>Manutenção</h3>
                    <p>
                      Solicitações, agendamentos e acompanhamento dos serviços
                      de manutenção.
                    </p>
                    <span className="module-link">
                      Acessar módulo <span>→</span>
                    </span>
                  </div>
                </button>

                <button
                  className="module-card"
                  onClick={() => setModuloAtivo('Frota')}
                >
                  <div className="module-icon fleet">▣</div>
                  <div className="module-card-content">
                    <h3>Gestão de frota</h3>
                    <p>
                      Controle de solicitações, veículos, motoristas e
                      agendamentos.
                    </p>
                    <span className="module-link">
                      Acessar módulo <span>→</span>
                    </span>
                  </div>
                </button>

                <button
                  className="module-card"
                  onClick={() => setModuloAtivo('Passagens aéreas')}
                >
                  <div className="module-icon flights">✈</div>
                  <div className="module-card-content">
                    <h3>Passagens aéreas</h3>
                    <p>
                      Organização das solicitações de viagens e acompanhamento
                      dos pedidos.
                    </p>
                    <span className="module-link">
                      Acessar módulo <span>→</span>
                    </span>
                  </div>
                </button>
              </section>

              <section className="notice-card">
                <div className="notice-icon">i</div>
                <div>
                  <strong>Nova plataforma em desenvolvimento</strong>
                  <p>
                    Esta interface é a base visual da nova plataforma. Os
                    indicadores serão preenchidos quando a integração com os
                    dados for implementada e validada.
                  </p>
                </div>
              </section>
            </>
          ) : (
            <section className="placeholder-card">
              <div className="placeholder-icon">
                {modulos.find((item) => item.nome === moduloAtivo)?.icone}
              </div>
              <h2>Módulo de {moduloAtivo}</h2>
              <p>
                A estrutura visual está preparada. As funcionalidades serão
                desenvolvidas por etapas e testadas antes da migração do
                sistema atual.
              </p>
              <button
                className="back-button"
                onClick={() => setModuloAtivo('Visão geral')}
              >
                ← Voltar ao painel
              </button>
            </section>
          )}

          <footer className="page-footer">
            <span>Sistema de Serviços de Logística e Manutenção</span>
            <span>Nova plataforma · Versão inicial</span>
          </footer>
        </div>
      </main>
    </div>
  )
}

export default App