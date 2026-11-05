import { Fragment, useEffect, useState } from 'react'
import { statusLabels } from '../api/modulesApi'
import { usePeriodFilter } from '../app/period'
import { auditActionLabels, auditDetailEntries, listAuditEvents } from '../auth/usersApi'
import type { AuditEntry } from '../auth/usersApi'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, FilterSelect, SearchField, PeriodFields } from '../components/ui/Filters'
import Icon from '../components/ui/Icon'
import type { IconName } from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'
import Pagination from '../components/ui/Pagination'
import StatusBadge from '../components/ui/StatusBadge'

const resultLabels: Record<string, string> = {
  success: 'Sucesso',
  failure: 'Falha',
  denied: 'Negado',
}

const auditCategories: Record<string, string> = {
  'auth.': 'Entradas e sessões',
  'registration.': 'Cadastros',
  'user.': 'Perfis e permissões',
  'account.': 'Ativação de contas',
  'flights.': 'Passagens e CPF',
  'request.': 'Solicitações e agendamentos',
  'settings.': 'Configurações',
  'warehouse.': 'Almoxarifado',
  'attachment.': 'Anexos',
  'fleet.': 'Veículos',
  'maintenance.': 'Equipamentos',
}

const categoryIcons: { prefix: string; icon: IconName }[] = [
  { prefix: 'auth.', icon: 'locked' },
  { prefix: 'registration.', icon: 'registrations' },
  { prefix: 'user.', icon: 'users' },
  { prefix: 'account.', icon: 'account' },
  { prefix: 'administrator.', icon: 'audit' },
  { prefix: 'flights.', icon: 'flights' },
  { prefix: 'request.', icon: 'requests' },
  { prefix: 'settings.', icon: 'settings' },
  { prefix: 'warehouse.', icon: 'warehouse' },
  { prefix: 'attachment.', icon: 'attachment' },
  { prefix: 'fleet.', icon: 'vehicle' },
  { prefix: 'maintenance.', icon: 'maintenance' },
]

// Eventos que merecem atenção de quem revisa, mesmo quando bem-sucedidos.
const importantActions = new Set([
  'flights.cpf_read',
  'user.role_changed',
  'user.permissions_changed',
  'user.cpf_access_granted',
  'user.cpf_access_revoked',
  'user.slm_added',
  'user.slm_removed',
  'account.inactive',
  'administrator.bootstrap',
  'administrator.recovered',
  'auth.sessions_revoked',
])

function iconFor(action: string): IconName {
  return categoryIcons.find((item) => action.startsWith(item.prefix))?.icon ?? 'info'
}

function rowClass(event: AuditEntry) {
  if (event.result !== 'success') return 'audit-row-refused'
  return importantActions.has(event.action) ? 'audit-row-important' : ''
}

function Person({ name, fallback }: { name: string | null; fallback: string }) {
  if (!name) return <span>{fallback}</span>
  return (
    <span className="audit-person">
      <span className="audit-avatar" aria-hidden="true">
        {name.trim().charAt(0).toUpperCase()}
      </span>
      {name}
    </span>
  )
}

/** Mudança de/para em destaque; o restante, como lista de campos. Somente leitura. */
function EventDetails({ event }: { event: AuditEntry }) {
  const entries = auditDetailEntries(event.details)
  const from = event.details.from
  const to = event.details.to

  return (
    <dl className="audit-details">
      {typeof from === 'string' && typeof to === 'string' && (
        <div>
          <dt>Alteração</dt>
          <dd className="audit-change">
            <s>{statusLabels[from] ?? from}</s>
            <Icon name="next" size={14} weight="bold" />
            <b>{statusLabels[to] ?? to}</b>
          </dd>
        </div>
      )}
      {entries
        .filter((entry) => !(entry.key === 'from' || entry.key === 'to') || typeof from !== 'string' || typeof to !== 'string')
        .map((entry) => (
          <div key={entry.key}>
            <dt>{entry.label}</dt>
            <dd>{entry.value}</dd>
          </div>
        ))}
      {entries.length === 0 && (typeof from !== 'string' || typeof to !== 'string') && (
        <div>
          <dd>Sem detalhes adicionais.</dd>
        </div>
      )}
    </dl>
  )
}

function AuditPage() {
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ events: AuditEntry[]; hasMore: boolean } | null>(null)
  const [error, setError] = useState('')
  const [category, setCategory] = useState('')
  const [result, setResult] = useState('')
  const [person, setPerson] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const period = usePeriodFilter()
  const { from, to } = period.range

  useEffect(() => {
    let active = true

    listAuditEvents(page, { action: category, result, person, from: from ?? '', to: to ?? '' })
      .then((response) => {
        if (!active) return
        setData(response)
        setError('')
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Não foi possível carregar a auditoria.')
        }
      })

    return () => {
      active = false
    }
  }, [page, category, result, person, from, to])

  const filter = (setter: (value: string) => void) => (value: string) => {
    setter(value)
    setPage(1)
  }

  return (
    <div className="audit-page">
      <PageHeader
        title="Auditoria"
        description="Registros de acesso e de ações, do mais recente ao mais antigo. Somente consulta: não podem ser alterados nem apagados."
      />

      <section className="ui-card" aria-label="Registros de auditoria">
        <FilterBar
          label="Filtros da auditoria"
          canClear={Boolean(category || result || person) || period.isActive}
          onClear={() => {
            setCategory('')
            setResult('')
            setPerson('')
            period.clear()
            setPage(1)
          }}
        >
          <FilterSelect
            label="Assunto"
            value={category}
            onChange={filter(setCategory)}
            allLabel="Todos os assuntos"
            options={Object.entries(auditCategories).map(([value, label]) => ({ value, label }))}
          />
          <FilterSelect
            label="Resultado"
            value={result}
            onChange={filter(setResult)}
            allLabel="Todos os resultados"
            options={Object.entries(resultLabels).map(([value, label]) => ({ value, label }))}
          />
          <SearchField label="Pessoa" value={person} onChange={filter(setPerson)} />
          <PeriodFields filter={period} onChange={() => setPage(1)} />
        </FilterBar>

        {error && <Alert tone="error">{error}</Alert>}
        {!data && !error && <Loading label="Carregando registros..." />}

        {data && data.events.length === 0 && (
          <EmptyState icon="audit" title="Nenhum registro encontrado">
            Não há eventos para os filtros selecionados.
          </EmptyState>
        )}

        {data && data.events.length > 0 && (
          <>
            <div className="data-table-wrapper">
              <table className="data-table audit-table">
                <thead>
                  <tr>
                    <th scope="col">Data e hora</th>
                    <th scope="col">Ação</th>
                    <th scope="col">Resultado</th>
                    <th scope="col">Feita por</th>
                    <th scope="col">Conta afetada</th>
                    <th scope="col">
                      <span className="visually-hidden">Detalhes</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((event) => {
                    const occurred = new Date(event.occurredAt)
                    const open = openId === event.id
                    return (
                      <Fragment key={event.id}>
                        <tr className={rowClass(event)}>
                          <td className="audit-when">
                            <strong>{occurred.toLocaleDateString('pt-BR')}</strong>
                            <span>{occurred.toLocaleTimeString('pt-BR')}</span>
                          </td>
                          <td>
                            <span className="audit-action">
                              <span className="audit-action-icon">
                                <Icon name={iconFor(event.action)} size={18} />
                              </span>
                              <span>{auditActionLabels[event.action] ?? event.action}</span>
                            </span>
                          </td>
                          <td data-label="Resultado">
                            <StatusBadge status={event.result} label={resultLabels[event.result] ?? event.result} />
                          </td>
                          <td data-label="Feita por">
                            <Person name={event.actorName} fallback="Sistema" />
                          </td>
                          <td data-label="Conta afetada">
                            <Person name={event.targetName} fallback="—" />
                          </td>
                          <td>
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-label={`${open ? 'Ocultar' : 'Ver'} detalhes: ${auditActionLabels[event.action] ?? event.action}`}
                              onClick={() => setOpenId(open ? null : event.id)}
                            >
                              {open ? 'Ocultar' : 'Detalhes'}
                            </button>
                          </td>
                        </tr>
                        {open && (
                          <tr className="audit-details-row">
                            <td colSpan={6}>
                              <EventDetails event={event} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={page} hasNext={data.hasMore} onChange={setPage} />
          </>
        )}
      </section>
    </div>
  )
}

export default AuditPage
