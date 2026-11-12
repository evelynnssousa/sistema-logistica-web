import { formatDateTime } from '../api/modulesApi'
import type { ServiceRequest } from '../api/modulesApi'
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

function FleetPage() {
  // A API só informa o motorista a quem atende a Frota.
  const seesDriver = useHasPermission('fleet:update')
  // A planilha exige consultar relatórios; as horas dos motoristas, administrar a Frota.
  const canDownload = useHasPermission('reports:read')
  const seesWorkload = useHasPermission('fleet:manage')
  return (
    <ServiceRequestsPage
      className="maintenance-page fleet-page"
      module="fleet"
      basePath="/frota"
      pageTitle="Frota"
      pageDescription="Gerencie as solicitações e os serviços relacionados à frota de veículos."
      searchPlaceholder="Pesquisar por protocolo, trajeto ou solicitante"
      statusOptions={statuses}
      columns={[
        { label: 'Trajeto', render: (request) => request.title },
        { label: 'Solicitante', render: (request) => request.requester.name },
        { label: 'Saída prevista', render: (request) => formatDateTime(request.details.dataHora as string) },
        { label: 'Agendado para', render: (request) => formatDateTime(request.scheduledAt) },
        ...(seesDriver ? [{ label: 'Motorista', render: (request: ServiceRequest) => request.driverName ?? '—' }] : []),
      ]}
      createPermission="fleet:create"
      extraAction={{ to: '/frota/veiculos', label: 'Veículos', icon: 'vehicle', permission: 'fleet:update' }}
      secondExtraAction={{ to: '/frota/motoristas', label: 'Motoristas', icon: 'users', permission: 'fleet:manage' }}
      footer={
        canDownload && (
          <SpreadsheetDownload
            kind="fleet"
            title="Planilha da Frota"
            description={
              seesWorkload
                ? 'Viagens com motorista, veículo e quilometragem, resumo por veículo e carga horária estimada dos motoristas (horas extras e horas a menos).'
                : 'Viagens com motorista, veículo e quilometragem do período.'
            }
          />
        )
      }
    />
  )
}

export default FleetPage
