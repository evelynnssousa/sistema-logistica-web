import ServiceRequestsPage from '../components/ServiceRequestsPage'

const fleetStatuses = [
  'Todos',
  'Pendente',
  'Agendada',
  'Em andamento',
  'Concluída',
  'Cancelada',
] as const

const fleetColumns = [
  'Identificação',
  'Serviço solicitado',
  'Veículo',
  'Solicitante',
  'Data da solicitação',
  'Status',
  'Ações',
] as const

function FleetPage() {
  return (
    <ServiceRequestsPage
      className="maintenance-page fleet-page"
      pageTitle="Frota"
      pageDescription="Gerencie as solicitações e os serviços relacionados à frota de veículos."
      searchPlaceholder="Pesquisar solicitações"
      listDescription="Pesquise e consulte as solicitações relacionadas à frota."
      statusOptions={fleetStatuses}
      columns={fleetColumns}
      emptyDescription="Os registros serão exibidos aqui após a integração com os dados reais."
      newRequestTo="/frota/nova"
      createPermission="fleet:create"
    />
  )
}

export default FleetPage
