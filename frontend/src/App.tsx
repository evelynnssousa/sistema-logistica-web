import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import AuthGate from './auth/AuthGate'
import { useAuthenticatedUser } from './auth/UserContext'
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

function AdministratorOnly({ children }: { children: React.ReactNode }) {
  const user = useAuthenticatedUser()

  if (user?.role !== 'administrator') {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
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
          element={<WarehousePortalPage />}
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
          <Route path="manutencao" element={<MaintenancePage />} />
          <Route
            path="manutencao/nova"
            element={<MaintenanceRequestPage />}
          />
          <Route path="frota" element={<FleetPage />} />
          <Route path="frota/nova" element={<FleetRequestPage />} />
          <Route path="passagens-aereas" element={<AirTravelPage />} />
          <Route
            path="passagens-aereas/nova"
            element={<AirTravelRequestPage />}
          />
          <Route path="almoxarifado" element={<InventoryPage />} />
          <Route path="calendario" element={<CalendarPage />} />
          <Route path="relatorios" element={<ReportsPage />} />
          <Route path="configuracoes" element={<SettingsPage />} />
          <Route
  path="cadastros-pendentes"
  element={
    <AdministratorOnly>
      <PendingRegistrationsPage />
    </AdministratorOnly>
  }
/>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
