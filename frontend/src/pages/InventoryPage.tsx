import StatCard from '../components/StatCard'

const inventoryColumns = [
  'Código',
  'Material',
  'Categoria',
  'Unidade',
  'Quantidade disponível',
  'Estoque mínimo',
  'Situação',
  'Ações',
]

function InventoryPage() {
  return (
    <div className="admin-module-page inventory-page">
      <section className="admin-page-heading">
        <div>
          <div className="eyebrow">JUCESP · GESTÃO OPERACIONAL</div>
          <h1>Almoxarifado</h1>
          <p>
            Acompanhe os materiais, os níveis de estoque e suas movimentações.
          </p>
        </div>
        <div className="admin-actions">
          <button type="button" disabled>
            Cadastrar material
          </button>
          <button type="button" disabled>
            Registrar entrada
          </button>
          <button type="button" disabled>
            Registrar saída
          </button>
          <span>Operações disponíveis após integração com os dados.</span>
        </div>
      </section>

      <section className="admin-stat-grid" aria-label="Indicadores de estoque">
        <StatCard
          icon="▤"
          tone="blue"
          tag="MATERIAIS"
          label="Total de materiais"
          value="—"
          description="Aguardando integração com os dados"
        />
        <StatCard
          icon="◷"
          tone="orange"
          tag="ATENÇÃO"
          label="Itens com estoque baixo"
          value="—"
          description="Aguardando integração com os dados"
        />
        <StatCard
          icon="!"
          tone="purple"
          tag="INDISPONÍVEIS"
          label="Itens sem estoque"
          value="—"
          description="Aguardando integração com os dados"
        />
        <StatCard
          icon="↔"
          tone="green"
          tag="MOVIMENTAÇÕES"
          label="Movimentações"
          value="—"
          description="Aguardando integração com os dados"
        />
      </section>

      <section className="admin-data-card" aria-labelledby="inventory-list-title">
        <div className="admin-card-heading">
          <div>
            <h2 id="inventory-list-title">Materiais em estoque</h2>
            <p>Pesquise e filtre os materiais cadastrados.</p>
          </div>
        </div>
        <div className="admin-filter-row">
          <label className="admin-search">
            <span aria-hidden="true">⌕</span>
            <span className="visually-hidden">Pesquisar materiais</span>
            <input type="search" placeholder="Pesquisar por código ou material" />
          </label>
          <label className="admin-filter">
            <span>Categoria</span>
            <select disabled defaultValue="">
              <option value="">Nenhuma categoria cadastrada</option>
            </select>
          </label>
          <label className="admin-filter">
            <span>Situação</span>
            <select disabled defaultValue="">
              <option value="">Indisponível sem dados de estoque</option>
            </select>
          </label>
        </div>
        <div className="admin-table-wrapper">
          <table className="admin-table inventory-table">
            <caption className="visually-hidden">
              Materiais, quantidades em estoque, situação e ações
            </caption>
            <thead>
              <tr>
                {inventoryColumns.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={inventoryColumns.length}>
                  <div className="admin-empty-state">
                    <span aria-hidden="true">▤</span>
                    <strong>Nenhum material disponível</strong>
                    <p>
                      Os materiais e as movimentações serão exibidos após a
                      integração com os dados reais.
                    </p>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

export default InventoryPage
