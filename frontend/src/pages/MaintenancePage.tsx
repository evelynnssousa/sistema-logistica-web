import { formatDateTime } from '../api/modulesApi'
import ServiceRequestsPage from '../components/ServiceRequestsPage'

const statuses = [
  'aguardando_agendamento',
  'agendado',
  'reagendado',
  'em_andamento',
  'concluido',
  'cancelado',
] as const

function MaintenancePage() {
  return (
    <ServiceRequestsPage
      module="maintenance"
      basePath="/manutencao"
      pageTitle="Manutenção"
      pageDescription="Gerencie as solicitações e acompanhe os serviços de manutenção."
      searchPlaceholder="Pesquisar por protocolo, descrição ou solicitante"
      statusOptions={statuses}
      columns={[
        { label: 'Solicitação', render: (request) => request.title },
        { label: 'Solicitante', render: (request) => request.requester.name },
        { label: 'Setor', render: (request) => request.sector ?? '—' },
        { label: 'Data da solicitação', render: (request) => formatDateTime(request.createdAt) },
      ]}
      extraAction={{ to: '/manutencao/equipamentos', label: 'Equipamentos', icon: 'maintenance', permission: 'maintenance:update' }}
      createPermission="maintenance:create"
    />
  )
}

export default MaintenancePage
