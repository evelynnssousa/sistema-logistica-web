import ServiceRequestsPage from '../components/ServiceRequestsPage'

const maintenanceStatuses = [
  'Todos',
  'Pendente',
  'Agendada',
  'Em andamento',
  'Concluída',
  'Cancelada',
] as const

const maintenanceColumns = [
  'Identificação',
  'Solicitação ou descrição',
  'Solicitante',
  'Data da solicitação',
  'Status',
  'Ações',
] as const

function MaintenancePage() {
  return (
    <ServiceRequestsPage
      pageTitle="Manutenção"
      pageDescription="Gerencie as solicitações e acompanhe os serviços de manutenção."
      searchPlaceholder="Pesquisar por identificação ou descrição"
      listDescription="Pesquise e consulte as solicitações de manutenção."
      statusOptions={maintenanceStatuses}
      columns={maintenanceColumns}
      emptyDescription="As solicitações aparecerão aqui quando a integração com os dados estiver disponível."
      newRequestTo="/manutencao/nova"
      createPermission="maintenance:create"
    />
  )
}

export default MaintenancePage
