import { useMemo, useState } from 'react'
import logoJucesp from '../assets/logoJucespNovo.png'
import './WarehousePortalPage.css'

type Material = {
  id: number
  name: string
  category: string
  unit: string
  available: boolean
}

const demonstrationMaterials: Material[] = [
  {
    id: 1,
    name: 'Papel sulfite A4',
    category: 'Papelaria',
    unit: 'Resma',
    available: true,
  },
  {
    id: 2,
    name: 'Caneta esferográfica azul',
    category: 'Papelaria',
    unit: 'Unidade',
    available: true,
  },
  {
    id: 3,
    name: 'Pasta para documentos',
    category: 'Organização',
    unit: 'Unidade',
    available: false,
  },
  {
    id: 4,
    name: 'Detergente',
    category: 'Limpeza',
    unit: 'Frasco',
    available: true,
  },
  {
    id: 5,
    name: 'Papel-toalha',
    category: 'Limpeza',
    unit: 'Pacote',
    available: false,
  },
  {
    id: 6,
    name: 'Envelope para documentos',
    category: 'Papelaria',
    unit: 'Unidade',
    available: true,
  },
]

function WarehousePortalPage() {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('Todas')
  const [availability, setAvailability] = useState('Todos')

  const categories = useMemo(
    () => ['Todas', ...new Set(demonstrationMaterials.map((item) => item.category))],
    [],
  )

  const filteredMaterials = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('pt-BR')

    return demonstrationMaterials.filter((item) => {
      const matchesSearch =
        item.name.toLocaleLowerCase('pt-BR').includes(term) ||
        item.category.toLocaleLowerCase('pt-BR').includes(term)

      const matchesCategory =
        category === 'Todas' || item.category === category

      const matchesAvailability =
        availability === 'Todos' ||
        (availability === 'Disponíveis' && item.available) ||
        (availability === 'Indisponíveis' && !item.available)

      return matchesSearch && matchesCategory && matchesAvailability
    })
  }, [search, category, availability])

  return (
    <main className="warehouse-portal">
      <header className="warehouse-portal-header">
        <a className="warehouse-brand" href="/" aria-label="JUCESP - página inicial">
          <img src={logoJucesp} alt="Logo oficial da JUCESP" />
          <span>
            <strong>JUCESP</strong>
            <small>Junta Comercial do Estado de São Paulo</small>
          </span>
        </a>
        <span className="warehouse-header-label">PORTAL DE MATERIAIS</span>
      </header>

      <section className="warehouse-hero">
        <div className="warehouse-hero-content">
          <span className="warehouse-eyebrow">ALMOXARIFADO · PORTAL DE SOLICITAÇÕES</span>
          <h1>Materiais para o seu setor</h1>
          <p>
            Consulte o catálogo de materiais e verifique a disponibilidade
            antes de iniciar uma solicitação.
          </p>
        </div>
        <div className="warehouse-hero-symbol" aria-hidden="true">▤</div>
      </section>

      <section className="warehouse-catalog" aria-labelledby="warehouse-catalog-title">
        <div className="warehouse-catalog-heading">
          <div>
            <h2 id="warehouse-catalog-title">Catálogo de materiais</h2>
            <p>Pesquise pelo nome ou filtre por categoria e disponibilidade.</p>
          </div>
          <span className="warehouse-result-count">
            {filteredMaterials.length} {filteredMaterials.length === 1 ? 'material' : 'materiais'}
          </span>
        </div>

        <div className="warehouse-demo-notice" role="status">
          <strong>Prévia demonstrativa</strong>
          <span>
            Os itens e as disponibilidades abaixo são exemplos. O estoque real
            ainda não está integrado; não utilize esta página para solicitar materiais.
          </span>
        </div>

        <div className="warehouse-filters">
          <label className="warehouse-search">
            <span aria-hidden="true">⌕</span>
            <span className="visually-hidden">Pesquisar materiais</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar material..."
            />
          </label>

          <label>
            <span>Categoria</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              {categories.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </label>

          <label>
            <span>Disponibilidade</span>
            <select
              value={availability}
              onChange={(event) => setAvailability(event.target.value)}
            >
              <option value="Todos">Todas</option>
              <option value="Disponíveis">Disponíveis</option>
              <option value="Indisponíveis">Indisponíveis</option>
            </select>
          </label>
        </div>

        {filteredMaterials.length > 0 ? (
          <div className="warehouse-material-grid">
            {filteredMaterials.map((material) => (
              <article className="warehouse-material-card" key={material.id}>
                <div className="warehouse-material-icon" aria-hidden="true">▤</div>
                <div className="warehouse-material-category">{material.category}</div>
                <h3>{material.name}</h3>
                <p className="warehouse-material-unit">Unidade de fornecimento: {material.unit}</p>
                <div className="warehouse-material-footer">
                  <span className={`warehouse-availability ${material.available ? 'is-available' : 'is-unavailable'}`}>
                    <span aria-hidden="true">●</span>
                    {material.available ? 'Disponível' : 'Indisponível'}
                  </span>
                  <button type="button" disabled title="Aguardando integração com o estoque real">
                    Solicitar
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="warehouse-empty">
            <span aria-hidden="true">⌕</span>
            <h3>Nenhum material encontrado</h3>
            <p>Tente alterar os termos da pesquisa ou os filtros selecionados.</p>
          </div>
        )}
      </section>

      <footer className="warehouse-portal-footer">
        JUCESP · Portal de materiais
        <span>As quantidades internas de estoque não são exibidas neste portal.</span>
      </footer>
    </main>
  )
}

export default WarehousePortalPage
