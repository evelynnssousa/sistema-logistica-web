import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  formatBRL,
  formatDay,
  instrumentCategoryLabels,
  instrumentShortLabels,
  listInstruments,
  situationLabels,
} from '../../api/instrumentsApi'
import type { InstrumentSituation, InstrumentSummary } from '../../api/instrumentsApi'
import { errorMessage } from '../../api/modulesApi'
import StatCard from '../../components/StatCard'
import { Alert, EmptyState, Loading } from '../../components/ui/Feedback'
import { FilterBar, FilterSelect, SearchField } from '../../components/ui/Filters'
import Icon from '../../components/ui/Icon'
import { useDemands } from './useDemands'

const situationTone: Record<InstrumentSituation, string> = {
  vigente: 'central-flag',
  vencendo: 'central-flag central-flag-late',
  vencido: 'central-flag central-flag-late',
  futuro: 'central-flag',
  encerrado: 'central-flag',
}

export function SituationFlag({ item }: { item: Pick<InstrumentSummary, 'situation' | 'daysLeft'> }) {
  const days =
    item.situation === 'vencendo' && item.daysLeft !== null
      ? item.daysLeft === 0
        ? ' (vence hoje)'
        : ` (${item.daysLeft} ${item.daysLeft === 1 ? 'dia' : 'dias'})`
      : item.situation === 'vencido' && item.daysLeft !== null
        ? ` (há ${-item.daysLeft} ${item.daysLeft === -1 ? 'dia' : 'dias'})`
        : ''
  return <span className={situationTone[item.situation]}>{situationLabels[item.situation]}{days}</span>
}

/** Acompanhamento de atas e contratos: do setor da pessoa e os compartilhados com ele. */
export function InstrumentList() {
  const { context, options } = useDemands()
  const [items, setItems] = useState<InstrumentSummary[] | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [type, setType] = useState('')
  const [category, setCategory] = useState('')
  const [situation, setSituation] = useState('')
  const [sectorId, setSectorId] = useState('')

  useEffect(() => {
    let active = true
    listInstruments({ search, type, category, situation, sectorId })
      .then((result) => {
        if (!active) return
        setItems(result.instruments)
        setError('')
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar as atas e contratos.'))
      })
    return () => {
      active = false
    }
  }, [search, type, category, situation, sectorId])

  const count = (value: InstrumentSituation) => items?.filter((item) => item.situation === value).length ?? 0
  const active = items?.filter((item) => item.situation === 'vigente' || item.situation === 'vencendo') ?? []
  const total = active.reduce((sum, item) => sum + item.total, 0)
  const spent = active.reduce((sum, item) => sum + item.spent, 0)

  return (
    <>
      <div className="ui-card-actions spreadsheet-download">
        <p className="demand-muted">
          Atas de registro de preços e contratos de materiais, serviços e cursos. Você vê os do seu setor e os compartilhados com
          ele. Ao entrar no prazo de aviso, o sistema abre uma demanda de renovação para o setor responsável.
        </p>
        {context.canCreate && (
          <Link className="maintenance-primary-button" to="/demandas/atas/nova">
            <Icon name="add" size={18} />
            Nova ata ou contrato
          </Link>
        )}
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {items && (
        <section className="ui-metrics" aria-label="Resumo das atas e contratos">
          <StatCard icon="success" tone="white" label="Vigentes" value={String(count('vigente'))} description="Fora do prazo de aviso" />
          <StatCard icon="waiting" tone="white" label="Vencendo" value={String(count('vencendo'))} description="Dentro do prazo de aviso" />
          <StatCard icon="warning" tone="white" label="Vencidos" value={String(count('vencido'))} description="Sem prorrogação registrada" />
          <StatCard
            icon="money"
            tone="white"
            label="Saldo dos vigentes"
            value={formatBRL(total - spent)}
            description={`Utilizado ${total > 0 ? Math.round((spent / total) * 100) : 0}% de ${formatBRL(total)}`}
          />
        </section>
      )}

      <FilterBar
        label="Filtros das atas e contratos"
        canClear={Boolean(search || type || category || situation || sectorId)}
        onClear={() => {
          setSearch('')
          setType('')
          setCategory('')
          setSituation('')
          setSectorId('')
        }}
      >
        <SearchField label="Pesquisar" value={search} placeholder="Número, objeto, fornecedor ou processo" onChange={setSearch} />
        <FilterSelect label="Tipo" value={type} onChange={setType} allLabel="Todos" options={[{ value: 'ata', label: 'Atas' }, { value: 'contrato', label: 'Contratos' }]} />
        <FilterSelect
          label="Categoria"
          value={category}
          onChange={setCategory}
          allLabel="Todas"
          options={Object.entries(instrumentCategoryLabels).map(([value, label]) => ({ value, label }))}
        />
        <FilterSelect
          label="Situação"
          value={situation}
          onChange={setSituation}
          allLabel="Todas"
          options={Object.entries(situationLabels).map(([value, label]) => ({ value, label }))}
        />
        <FilterSelect
          label="Setor"
          value={sectorId}
          onChange={setSectorId}
          allLabel="Todos"
          options={options.sectors.map((sector) => ({ value: sector.id, label: sector.name }))}
        />
      </FilterBar>

      {!items && !error && <Loading label="Carregando atas e contratos..." />}
      {items && (
        <section className="ui-card" aria-label="Atas e contratos">
          {items.length === 0 ? (
            <EmptyState icon="lists" title="Nenhuma ata ou contrato encontrado">
              Cadastre as atas e os contratos do seu setor para acompanhar vigência, saldo, aditivos e renovação.
            </EmptyState>
          ) : (
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Número</th>
                    <th>Objeto</th>
                    <th>Setor</th>
                    <th>Vigência</th>
                    <th>Situação</th>
                    <th>Valor</th>
                    <th>Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <Link to={`/demandas/atas/${item.id}`}>
                          {instrumentShortLabels[item.type]} {item.number}
                        </Link>
                        <small className="central-subtext">{instrumentCategoryLabels[item.category]}</small>
                      </td>
                      <td>
                        {item.subject}
                        {item.supplier && <small className="central-subtext">{item.supplier}</small>}
                      </td>
                      <td>
                        {item.responsibleSector.name}
                        {item.sharedSectors.length > 0 && (
                          <small className="central-subtext">Compartilhado com {item.sharedSectors.map((sector) => sector.name).join(', ')}</small>
                        )}
                      </td>
                      <td>
                        {formatDay(item.validFrom)} a {formatDay(item.validUntil)}
                      </td>
                      <td>
                        <SituationFlag item={item} />
                      </td>
                      <td>{formatBRL(item.total)}</td>
                      <td>
                        {formatBRL(item.balance)}
                        {item.usedPercent !== null && <small className="central-subtext">{item.usedPercent.toLocaleString('pt-BR')}% utilizado</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  )
}
