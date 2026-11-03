import ServiceRequestsPage from '../components/ServiceRequestsPage'

const airTravelStatuses = [
  'EM COTAÇÃO',
  'AGUARDANDO APROVAÇÃO',
  'EM EMISSÃO',
  'EMITIDA',
  'CANCELADA',
] as const

const airTravelColumns = [
  'Identificação',
  'Passageiro',
  'Solicitante',
  'Destino',
  'Data de ida',
  'Data de volta',
  'Status',
  'Ações',
] as const

function AirTravelPage() {
  return (
    <ServiceRequestsPage
      className="maintenance-page air-travel-page"
      pageTitle="Passagens Aéreas"
      pageDescription="Consulte e acompanhe as solicitações de passagens aéreas."
      searchPlaceholder="Pesquisar solicitações"
      listDescription="Pesquise e consulte as solicitações de passagens aéreas."
      statusOptions={airTravelStatuses}
      columns={airTravelColumns}
      emptyDescription="As solicitações serão exibidas aqui quando houver dados reais disponíveis."
      statusFilterStyle="tabs"
      emptyActionLabel="Visualizar"
      newRequestTo="/passagens-aereas/nova"
      createPermission="flights:create"
    />
  )
}

export default AirTravelPage
