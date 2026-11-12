import { Suspense, useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import Topbar from './Topbar'
import { Loading } from '../ui/Feedback'

type AppLayoutProps = {
  apiOnline: boolean | null
}

function AppLayout({ apiOnline }: AppLayoutProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [menuOpen])

  return (
    <div className="app-layout">
      <a className="skip-link" href="#conteudo-principal">Ir para o conteúdo principal</a>
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      {menuOpen && (
        <button
          type="button"
          className="sidebar-overlay"
          aria-label="Fechar menu"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <main className="main-content">
        <Topbar apiOnline={apiOnline} onOpenMenu={() => setMenuOpen(true)} />
        <div className="page-content" id="conteudo-principal" tabIndex={-1}>
          {/* As telas chegam sob demanda (App.tsx): o menu e o topo ficam visíveis enquanto isso. */}
          <Suspense fallback={<Loading label="Carregando a tela..." />}>
            <Outlet />
          </Suspense>
          <footer className="page-footer">
            <span>Sistema de Serviços de Logística e Manutenção</span>
          </footer>
        </div>
      </main>
    </div>
  )
}

export default AppLayout
