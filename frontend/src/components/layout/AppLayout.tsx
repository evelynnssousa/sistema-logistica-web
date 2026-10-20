import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import Topbar from './Topbar'

type AppLayoutProps = {
  apiOnline: boolean | null
}

function AppLayout({ apiOnline }: AppLayoutProps) {
  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <Topbar apiOnline={apiOnline} />
        <div className="page-content">
          <Outlet />
          <footer className="page-footer">
            <span>Sistema de Serviços de Logística e Manutenção</span>
            <span>Nova plataforma · Versão inicial</span>
          </footer>
        </div>
      </main>
    </div>
  )
}

export default AppLayout
