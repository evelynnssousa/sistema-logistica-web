import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import AuthGate from './auth/AuthGate'
import RequirePermission from './auth/RequirePermission'
import AppLayout from './components/layout/AppLayout'
import AirTravelPage from './pages/AirTravelPage'
import CalendarPage from './pages/CalendarPage'
import DashboardPage from './pages/DashboardPage'
import FleetPage from './pages/FleetPage'
import FleetRequestPage from './pages/FleetRequestPage'
import InventoryPage from './pages/InventoryPage'
import MaintenancePage from './pages/MaintenancePage'
import MaintenanceRequestPage from './pages/MaintenanceRequestPage'
import AirTravelRequestPage from './pages/AirTravelRequestPage'
import ReportsPage from './pages/ReportsPage'
import SettingsPage from './pages/SettingsPage'
import WarehousePortalPage from './pages/WarehousePortalPage'
import './App.css'
import PendingRegistrationsPage from './pages/PendingRegistrationsPage'
import AuditPage from './pages/AuditPage'
import UserDetailPage from './pages/UserDetailPage'
import UsersPage from './pages/UsersPage'

function guarded(anyOf: string[], page: React.ReactNode) {
  return <RequirePermission anyOf={anyOf}>{page}</RequirePermission>
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
        <Route
          path="/portal/almoxarifado"
          element={
            <AuthGate>
              {guarded(['warehouse:read'], <WarehousePortalPage />)}
            </AuthGate>
          }
        />

        <Route
          path="/*"
          element={
            <AuthGate>
              <AppLayout apiOnline={apiOnline} />
            </AuthGate>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="manutencao" element={guarded(['maintenance:read'], <MaintenancePage />)} />
          <Route path="manutencao/nova" element={guarded(['maintenance:create'], <MaintenanceRequestPage />)} />
          <Route path="frota" element={guarded(['fleet:read'], <FleetPage />)} />
          <Route path="frota/nova" element={guarded(['fleet:create'], <FleetRequestPage />)} />
          <Route path="passagens-aereas" element={guarded(['flights:read'], <AirTravelPage />)} />
          <Route path="passagens-aereas/nova" element={guarded(['flights:create'], <AirTravelRequestPage />)} />
          <Route path="almoxarifado" element={guarded(['warehouse:read'], <InventoryPage />)} />
          <Route path="calendario" element={guarded(['calendar:read'], <CalendarPage />)} />
          <Route path="relatorios" element={guarded(['reports:read'], <ReportsPage />)} />
          <Route path="configuracoes" element={guarded(['settings:read', 'settings:manage'], <SettingsPage />)} />
          <Route path="cadastros-pendentes" element={guarded(['users:approve'], <PendingRegistrationsPage />)} />
          <Route path="usuarios" element={guarded(['users:read'], <UsersPage />)} />
          <Route path="usuarios/:userId" element={guarded(['users:read'], <UserDetailPage />)} />
          <Route path="auditoria" element={guarded(['audit:read'], <AuditPage />)} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
