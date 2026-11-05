import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import AuthGate from './auth/AuthGate'
import { useAuthenticatedUser } from './auth/UserContext'
import RequirePermission from './auth/RequirePermission'
import AppLayout from './components/layout/AppLayout'
import AirTravelPage from './pages/AirTravelPage'
import SlmCentralPage from './pages/SlmCentralPage'
import SearchPage from './pages/SearchPage'
import MonitoringPage from './pages/MonitoringPage'
import AccessReviewPage from './pages/AccessReviewPage'
import VehiclesPage, { VehicleDetailPage } from './pages/VehiclesPage'
import EquipmentsPage from './pages/EquipmentsPage'
import { StockTab } from './pages/WarehouseStock'
import { ControlTab } from './pages/WarehouseControl'
import CalendarPage from './pages/CalendarPage'
import DashboardPage from './pages/DashboardPage'
import DriverPortalPage from './pages/DriverPortalPage'
import DriversPage from './pages/DriversPage'
import FleetPage from './pages/FleetPage'
import FleetRequestPage from './pages/FleetRequestPage'
import AccountPage from './pages/AccountPage'
import InventoryCheckPage from './pages/InventoryCheckPage'
import IntegrationsPage from './pages/IntegrationsPage'
import NotificationsPage from './pages/NotificationsPage'
import HomePage from './pages/HomePage'
import InventoryPage, {
  ChecksTab,
  ExternalRequestTab,
  MaterialsTab,
  RequestsTab,
} from './pages/InventoryPage'
import { WarehouseOverviewTab, WarehouseReportsTab } from './pages/WarehouseInsights'
import RequestDetailPage from './pages/RequestDetailPage'
import WarehouseRequestPage from './pages/WarehouseRequestPage'
import MaintenancePage from './pages/MaintenancePage'
import MaintenanceRequestPage from './pages/MaintenanceRequestPage'
import AirTravelRequestPage from './pages/AirTravelRequestPage'
import ReportsPage from './pages/ReportsPage'
import SettingsPage from './pages/SettingsPage'
import WarehousePortalPage from './pages/WarehousePortalPage'
import './App.css'
import './modules.css'
import './styles/theme.css'
import './styles/integrations.css'
import './styles/operations.css'
import './styles/transparency.css'
import './styles/demands.css'
import DemandAgenda from './pages/demands/DemandAgenda'
import DemandDashboard from './pages/demands/DemandDashboard'
import DemandDetail from './pages/demands/DemandDetail'
import DemandForm from './pages/demands/DemandForm'
import DemandList from './pages/demands/DemandList'
import DemandReports from './pages/demands/DemandReports'
import DemandsLayout from './pages/demands/DemandsLayout'
import PendingRegistrationsPage from './pages/PendingRegistrationsPage'
import AuditPage from './pages/AuditPage'
import UserDetailPage from './pages/UserDetailPage'
import UsersPage from './pages/UsersPage'

function guarded(anyOf: string[], page: React.ReactNode) {
  return <RequirePermission anyOf={anyOf}>{page}</RequirePermission>
}

/** O motorista entra direto no próprio portal, sem o menu nem as telas da administração. */
function AuthenticatedShell({ apiOnline }: { apiOnline: boolean | null }) {
  const user = useAuthenticatedUser()
  if (user?.role === 'driver') return <DriverPortalPage />
  return <AppLayout apiOnline={apiOnline} />
}

function App() {
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

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/portal/almoxarifado" element={<Navigate to="/almoxarifado/nova" replace />} />

        <Route
          path="/*"
          element={
            <AuthGate>
              <AuthenticatedShell apiOnline={apiOnline} />
            </AuthGate>
          }
        >
          <Route index element={<HomePage />} />
          {/* Quem não é motorista e chega aqui volta ao início. O portal é decidido em AuthenticatedShell. */}
          <Route path="motorista" element={<Navigate to="/" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="manutencao" element={guarded(['maintenance:read'], <MaintenancePage />)} />
          <Route path="manutencao/equipamentos" element={guarded(['maintenance:update'], <EquipmentsPage />)} />
          <Route path="manutencao/nova" element={guarded(['maintenance:create'], <MaintenanceRequestPage />)} />
          <Route path="manutencao/:requestId" element={guarded(['maintenance:read'], <RequestDetailPage module="maintenance" />)} />
          <Route path="frota" element={guarded(['fleet:read'], <FleetPage />)} />
          <Route path="frota/veiculos" element={guarded(['fleet:update'], <VehiclesPage />)} />
          <Route path="frota/veiculos/:vehicleId" element={guarded(['fleet:update'], <VehicleDetailPage />)} />
          <Route path="frota/motoristas" element={guarded(['fleet:manage'], <DriversPage />)} />
          <Route path="frota/nova" element={guarded(['fleet:create'], <FleetRequestPage />)} />
          <Route path="frota/:requestId" element={guarded(['fleet:read'], <RequestDetailPage module="fleet" />)} />
          <Route path="passagens-aereas" element={guarded(['flights:read'], <AirTravelPage />)} />
          <Route path="passagens-aereas/nova" element={guarded(['flights:create'], <AirTravelRequestPage />)} />
          <Route path="passagens-aereas/:requestId" element={guarded(['flights:read'], <RequestDetailPage module="flights" />)} />
          <Route path="almoxarifado" element={guarded(['warehouse:read'], <InventoryPage />)}>
            <Route index element={<WarehouseOverviewTab />} />
            <Route path="solicitacoes" element={<RequestsTab />} />
            <Route path="nova" element={guarded(['requests:create'], <WarehousePortalPage />)} />
            <Route path="externo" element={guarded(['warehouse:manage'], <ExternalRequestTab />)} />
            <Route path="materiais" element={guarded(['warehouse:manage'], <MaterialsTab />)} />
            <Route path="estoque" element={guarded(['warehouse:manage'], <StockTab />)} />
            <Route path="controle" element={guarded(['warehouse:manage'], <ControlTab />)} />
            <Route path="inventario" element={guarded(['warehouse:manage'], <ChecksTab />)} />
            <Route path="relatorios" element={guarded(['reports:read'], <WarehouseReportsTab />)} />
            <Route path="pedidos/:requestId" element={<WarehouseRequestPage />} />
            <Route path="conferencias/:checkId" element={guarded(['warehouse:manage'], <InventoryCheckPage />)} />
          </Route>
          {/* O acesso depende de integrar um setor: DemandsLayout decide, e o backend confere. */}
          <Route path="demandas" element={<DemandsLayout />}>
            <Route index element={<DemandDashboard />} />
            <Route path="todas" element={<DemandList key="todas" scope="all" />} />
            <Route path="minhas" element={<DemandList key="minhas" scope="mine" />} />
            <Route path="setores" element={<DemandList key="setores" scope="sector" />} />
            <Route path="compartilhadas" element={<DemandList key="compartilhadas" scope="shared" />} />
            <Route path="agenda" element={<DemandAgenda />} />
            <Route path="relatorios" element={<DemandReports />} />
            <Route path="nova" element={<DemandForm key="nova" />} />
            <Route path=":demandId" element={<DemandDetail />} />
            <Route path=":demandId/editar" element={<DemandForm />} />
          </Route>
          <Route path="central-slm" element={guarded(['slm_central:read'], <SlmCentralPage />)} />
          <Route path="pesquisa" element={<SearchPage />} />
          <Route path="minha-conta" element={<AccountPage />} />
          <Route path="notificacoes" element={<NotificationsPage />} />
          <Route path="integracoes" element={guarded(['integrations:read'], <IntegrationsPage />)} />
          <Route path="calendario" element={guarded(['calendar:read'], <CalendarPage />)} />
          <Route path="relatorios" element={guarded(['reports:read'], <ReportsPage />)} />
          {/* O Diretor configura o módulo sem ter uma permissão: SettingsPage decide, e o backend confere. */}
          <Route path="configuracoes" element={<SettingsPage />} />
          <Route path="cadastros-pendentes" element={guarded(['users:approve'], <PendingRegistrationsPage />)} />
          <Route path="usuarios" element={guarded(['users:read'], <UsersPage />)} />
          <Route path="usuarios/:userId" element={guarded(['users:read'], <UserDetailPage />)} />
          <Route path="usuarios/revisao-de-acessos" element={guarded(['users:read'], <AccessReviewPage />)} />
          <Route path="monitoramento" element={guarded(['monitoring:read'], <MonitoringPage />)} />
          <Route path="auditoria" element={guarded(['audit:read'], <AuditPage />)} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
