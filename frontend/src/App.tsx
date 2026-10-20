import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import AuthGate from './auth/AuthGate'
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
import './App.css'

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
      <AuthGate>
        <Routes>
          <Route element={<AppLayout apiOnline={apiOnline} />}>
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
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthGate>
    </BrowserRouter>
  )
}

export default App
