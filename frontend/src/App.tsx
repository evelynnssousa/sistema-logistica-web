import { Suspense, lazy, useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import AuthGate from './auth/AuthGate'
import { useAuthenticatedUser } from './auth/UserContext'
import RequirePermission from './auth/RequirePermission'
import AppLayout from './components/layout/AppLayout'
import { Loading } from './components/ui/Feedback'
import HomePage from './pages/HomePage'
// Ordem da cascata igual à de antes do carregamento sob demanda: o estilo do portal do motorista
// vem antes dos estilos gerais, e não junto da tela (o que o colocaria depois do theme.css).
import './styles/driver-portal.css'
import './App.css'
import './modules.css'
import './styles/theme.css'
import './styles/integrations.css'
import './styles/operations.css'
import './styles/transparency.css'
import './styles/demands.css'

/*
 * Cada tela é baixada só quando aberta: o pacote inicial fica com o login, o menu e o início.
 * As rotas, permissões e componentes são os mesmos; o que muda é quando o código chega.
 */
const named = <T extends Record<string, unknown>>(load: () => Promise<T>, name: keyof T) =>
  lazy(() => load().then((module) => ({ default: module[name] as ComponentType })))

const AirTravelPage = lazy(() => import('./pages/AirTravelPage'))
const SlmCentralPage = lazy(() => import('./pages/SlmCentralPage'))
const SearchPage = lazy(() => import('./pages/SearchPage'))
const MonitoringPage = lazy(() => import('./pages/MonitoringPage'))
const AccessReviewPage = lazy(() => import('./pages/AccessReviewPage'))
const VehiclesPage = lazy(() => import('./pages/VehiclesPage'))
const VehicleDetailPage = named(() => import('./pages/VehiclesPage'), 'VehicleDetailPage')
const EquipmentsPage = lazy(() => import('./pages/EquipmentsPage'))
const StockTab = named(() => import('./pages/WarehouseStock'), 'StockTab')
const WarehouseFinanceTab = named(() => import('./pages/WarehouseFinance'), 'WarehouseFinanceTab')
const ControlTab = named(() => import('./pages/WarehouseControl'), 'ControlTab')
const CalendarPage = lazy(() => import('./pages/CalendarPage'))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const DriverPortalPage = lazy(() => import('./pages/DriverPortalPage'))
const DriversPage = lazy(() => import('./pages/DriversPage'))
const FleetPage = lazy(() => import('./pages/FleetPage'))
const FleetRequestPage = lazy(() => import('./pages/FleetRequestPage'))
const AccountPage = lazy(() => import('./pages/AccountPage'))
const InventoryCheckPage = lazy(() => import('./pages/InventoryCheckPage'))
const IntegrationsPage = lazy(() => import('./pages/IntegrationsPage'))
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'))
const InventoryPage = lazy(() => import('./pages/InventoryPage'))
const ChecksTab = named(() => import('./pages/InventoryPage'), 'ChecksTab')
const ExternalRequestTab = named(() => import('./pages/InventoryPage'), 'ExternalRequestTab')
const MaterialsTab = named(() => import('./pages/InventoryPage'), 'MaterialsTab')
const RequestsTab = named(() => import('./pages/InventoryPage'), 'RequestsTab')
const WarehouseOverviewTab = named(() => import('./pages/WarehouseInsights'), 'WarehouseOverviewTab')
const WarehouseReportsTab = named(() => import('./pages/WarehouseInsights'), 'WarehouseReportsTab')
const RequestDetailPage = lazy(() => import('./pages/RequestDetailPage'))
const WarehouseRequestPage = lazy(() => import('./pages/WarehouseRequestPage'))
const MaintenancePage = lazy(() => import('./pages/MaintenancePage'))
const MaintenanceRequestPage = lazy(() => import('./pages/MaintenanceRequestPage'))
const AirTravelRequestPage = lazy(() => import('./pages/AirTravelRequestPage'))
const ReportsPage = lazy(() => import('./pages/ReportsPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const WarehousePortalPage = lazy(() => import('./pages/WarehousePortalPage'))
const DemandAgenda = lazy(() => import('./pages/demands/DemandAgenda'))
const DemandDashboard = lazy(() => import('./pages/demands/DemandDashboard'))
const DemandDetail = lazy(() => import('./pages/demands/DemandDetail'))
const DemandForm = lazy(() => import('./pages/demands/DemandForm'))
const DemandList = lazy(() => import('./pages/demands/DemandList'))
const DemandReports = lazy(() => import('./pages/demands/DemandReports'))
const DemandsLayout = lazy(() => import('./pages/demands/DemandsLayout'))
const InstrumentList = named(() => import('./pages/demands/InstrumentList'), 'InstrumentList')
const InstrumentForm = named(() => import('./pages/demands/InstrumentForm'), 'InstrumentForm')
const InstrumentDetail = named(() => import('./pages/demands/InstrumentDetail'), 'InstrumentDetail')
const PendingRegistrationsPage = lazy(() => import('./pages/PendingRegistrationsPage'))
const AuditPage = lazy(() => import('./pages/AuditPage'))
const UserDetailPage = lazy(() => import('./pages/UserDetailPage'))
const UsersPage = lazy(() => import('./pages/UsersPage'))

function guarded(anyOf: string[], page: React.ReactNode) {
  return <RequirePermission anyOf={anyOf}>{page}</RequirePermission>
}

/** O motorista entra direto no próprio portal, sem o menu nem as telas da administração. */
function AuthenticatedShell({ apiOnline }: { apiOnline: boolean | null }) {
  const user = useAuthenticatedUser()
  if (user?.role === 'driver') {
    return (
      <Suspense fallback={<Loading label="Carregando o portal..." />}>
        <DriverPortalPage />
      </Suspense>
    )
  }
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
            <Route path="valores" element={guarded(['warehouse:finance'], <WarehouseFinanceTab />)} />
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
            <Route path="atas" element={<InstrumentList />} />
            <Route path="atas/nova" element={<InstrumentForm key="nova" />} />
            <Route path="atas/:instrumentId" element={<InstrumentDetail />} />
            <Route path="atas/:instrumentId/editar" element={<InstrumentForm />} />
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
