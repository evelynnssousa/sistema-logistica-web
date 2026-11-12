import { formatDateTime } from '../api/modulesApi'
import { useHasPermission } from '../auth/UserContext'
import ServiceRequestsPage from '../components/ServiceRequestsPage'
import SpreadsheetDownload from '../components/SpreadsheetDownload'

const statuses = [
  'aguardando_agendamento',
  'agendado',
  'reagendado',
  'em_andamento',
  'concluido',
  'cancelado',
] as const

function MaintenancePage() {
  // A planilha exige consultar relatórios, como a da Frota.
  const canDownload = useHasPermission('reports:read')
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
      footer={
        canDownload && (
          <SpreadsheetDownload
            kind="maintenance"
            title="Planilha da Manutenção"
            description="Solicitações com local, tipo de serviço, prazos, agendamento e tempo de execução, mais resumos por tipo de serviço, setor, andar e mês."
          />
        )
      }
    />
  )
}

export default MaintenancePage
