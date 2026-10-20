import StatCard from '../components/StatCard'

const reportSections = [
  {
    title: 'Solicitações por período',
    description: 'Visualização da quantidade de solicitações ao longo do tempo.',
  },
  {
    title: 'Distribuição por status',
    description: 'Visualização da distribuição das solicitações por status.',
  },
  {
    title: 'Movimentações do almoxarifado',
    description: 'Visualização das entradas e saídas de materiais.',
  },
] as const

function ReportsPage() {
  return (
    <div className="admin-module-page reports-page">
      <section className="admin-page-heading">
        <div>
          <div className="eyebrow">JUCESP · GESTÃO OPERACIONAL</div>
          <h1>Relatórios</h1>
          <p>
            Consulte indicadores e acompanhe os dados operacionais do sistema.
          </p>
        </div>
        <button className="admin-secondary-action" type="button" disabled>
          Exportar relatório
        </button>
      </section>

      <section className="admin-data-card" aria-label="Filtros de relatórios">
        <div className="admin-filter-row reports-filters">
          <label className="admin-filter">
            <span>Período</span>
            <select disabled defaultValue="">
              <option value="">Disponível após integração</option>
            </select>
          </label>
          <label className="admin-filter">
            <span>Módulo</span>
            <select disabled defaultValue="">
              <option value="">Todos os módulos</option>
            </select>
          </label>
          <label className="admin-filter">
            <span>Setor</span>
            <select disabled defaultValue="">
              <option value="">Nenhum setor cadastrado</option>
            </select>
          </label>
        </div>
      </section>

      <section className="admin-stat-grid reports-stat-grid" aria-label="Indicadores">
        <StatCard
          icon="▤"
          tone="blue"
          tag="SOLICITAÇÕES"
          label="Total de solicitações"
          value="—"
          description="Aguardando dados reais"
        />
        <StatCard
          icon="◷"
          tone="orange"
          tag="EM ANDAMENTO"
          label="Solicitações em andamento"
          value="—"
          description="Aguardando dados reais"
        />
        <StatCard
          icon="↔"
          tone="green"
          tag="ALMOXARIFADO"
          label="Movimentações de materiais"
          value="—"
          description="Aguardando dados reais"
        />
      </section>

      <section className="reports-chart-grid" aria-label="Áreas de relatórios">
        {reportSections.map((section) => (
          <article className="reports-chart-card" key={section.title}>
            <div>
              <h2>{section.title}</h2>
              <p>{section.description}</p>
            </div>
            <div className="reports-chart-empty">
              <span aria-hidden="true">▥</span>
              <strong>Sem dados para exibir</strong>
              <span>O relatório será preenchido após a integração.</span>
            </div>
          </article>
        ))}
      </section>
    </div>
  )
}

export default ReportsPage
