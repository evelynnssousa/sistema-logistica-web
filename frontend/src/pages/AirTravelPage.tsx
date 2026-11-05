import { ticketStatusLabels } from '../api/communicationsApi'
import { formatDateTime } from '../api/modulesApi'
import { useHasPermission } from '../auth/UserContext'
import ServiceRequestsPage from '../components/ServiceRequestsPage'

const statuses = ['em_cotacao', 'aguardando_aprovacao', 'em_emissao', 'emitida', 'cancelada'] as const

const tripLabels: Record<string, string> = {
  ida_volta: 'Ida e volta',
  somente_ida: 'Somente ida',
  somente_volta: 'Somente volta',
}

function AirTravelPage() {
  const readsCommunications = useHasPermission('communications:read')
  const attendsFlights = useHasPermission('flights:update')
  const seesTicket = readsCommunications && attendsFlights

  return (
    <ServiceRequestsPage
      className="maintenance-page air-travel-page"
      module="flights"
      basePath="/passagens-aereas"
      pageTitle="Passagens Aéreas"
      pageDescription="Consulte e acompanhe as solicitações de passagens aéreas."
      searchPlaceholder="Pesquisar por protocolo, trecho ou solicitante"
      statusOptions={statuses}
      tripTypeOptions={Object.entries(tripLabels).map(([value, label]) => ({ value, label }))}
      columns={[
        { label: 'Trecho', render: (request) => request.title },
        { label: 'Tipo', render: (request) => tripLabels[String(request.details.tipoViagem)] ?? '—' },
        { label: 'Solicitante', render: (request) => request.requester.name },
        { label: 'Data da solicitação', render: (request) => formatDateTime(request.createdAt) },
        ...(seesTicket
          ? [{ label: 'Bilhete', render: (request: { ticketStatus?: keyof typeof ticketStatusLabels }) => ticketStatusLabels[request.ticketStatus ?? 'nao_enviado'] }]
          : []),
      ]}
      createPermission="flights:create"
    />
  )
}

export default AirTravelPage
