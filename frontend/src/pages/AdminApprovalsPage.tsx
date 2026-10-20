import { useEffect, useState } from 'react'
import type { ModulePermission, RegistrationDecisionResult, RegistrationRequest } from '../services/auth'

interface AdminApprovalsPageProps {
  csrfToken: string
  loadRequests: (csrfToken: string) => Promise<RegistrationRequest[]>
  decide: (
    id: string,
    csrfToken: string,
    decision:
      | { action: 'reject' }
      | { action: 'approve'; role: 'admin' | 'operator'; permissions: ModulePermission[] },
  ) => Promise<RegistrationDecisionResult>
}

const permissionOptions: { value: ModulePermission; label: string }[] = [
  { value: 'maintenance:read', label: 'Consultar manutenção' },
  { value: 'maintenance:write', label: 'Operar manutenção' },
  { value: 'fleet:read', label: 'Consultar frota' },
  { value: 'fleet:write', label: 'Operar frota' },
  { value: 'flights:read', label: 'Consultar passagens' },
  { value: 'flights:write', label: 'Operar passagens' },
  { value: 'flights:cpf:read', label: 'Acessar CPF completo de passageiros' },
  { value: 'warehouse:read', label: 'Consultar almoxarifado' },
  { value: 'warehouse:write', label: 'Operar almoxarifado' },
  { value: 'settings:read', label: 'Consultar configurações' },
  { value: 'settings:write', label: 'Alterar configurações' },
]

export function AdminApprovalsPage({ csrfToken, loadRequests, decide }: AdminApprovalsPageProps) {
  const [requests, setRequests] = useState<RegistrationRequest[]>([])
  const [roles, setRoles] = useState<Record<string, 'admin' | 'operator'>>({})
  const [permissions, setPermissions] = useState<Record<string, ModulePermission[]>>({})
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [recentDecisions, setRecentDecisions] = useState<RegistrationDecisionResult['user'][]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function refresh() {
    setError('')
    setLoading(true)
    try {
      setRequests(await loadRequests(csrfToken))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Falha ao consultar solicitações.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    loadRequests(csrfToken)
      .then((result) => {
        if (active) setRequests(result)
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : 'Falha ao consultar solicitações.')
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [csrfToken, loadRequests])

  async function submitDecision(id: string, decision: Parameters<typeof decide>[2]) {
    setBusyId(id)
    setError('')
    setStatus('')
    try {
      const result = await decide(id, csrfToken, decision)
      setRecentDecisions((current) => [result.user, ...current.filter((user) => user.id !== result.user.id)].slice(0, 5))
      setStatus(decision.action === 'approve' ? 'Solicitação aprovada.' : 'Solicitação rejeitada.')
      await refresh()
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : 'Falha ao registrar decisão.')
    } finally {
      setBusyId(null)
    }
  }

  const normalizedSearch = search.trim().toLocaleLowerCase('pt-BR')
  const filteredRequests = requests.filter((request) =>
    [request.fullName, request.email, request.sector]
      .some((value) => value.toLocaleLowerCase('pt-BR').includes(normalizedSearch)),
  )

  function togglePermission(id: string, permission: ModulePermission) {
    setPermissions((current) => {
      const selected = current[id] ?? []
      return {
        ...current,
        [id]: selected.includes(permission)
          ? selected.filter((item) => item !== permission)
          : [...selected, permission],
      }
    })
  }

  return (
    <section className="admin-page">
      <div className="admin-heading">
        <div>
          <p className="eyebrow">GESTÃO DE ACESSO</p>
          <h1>Solicitações pendentes</h1>
          <p>O acesso só é liberado após uma decisão administrativa explícita.</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>
          Atualizar lista
        </button>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {status && <p className="form-success" role="status">{status}</p>}
      <div className="admin-toolbar">
        <label className="admin-search" htmlFor="approval-search">
          <span>Pesquisar solicitações</span>
          <input
            id="approval-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Nome, e-mail ou setor"
          />
        </label>
        <span className="queue-count">{filteredRequests.length} resultados</span>
      </div>

      {recentDecisions.length > 0 && (
        <section className="decision-history" aria-label="Decisões recentes desta sessão">
          <h2>Decisões recentes</h2>
          {recentDecisions.map((decision) => (
            <div className="decision-row" key={decision.id}>
              <span>{decision.fullName}</span>
              <span className={`status-badge status-${decision.status}`}>
                {decision.status === 'approved' ? 'Aprovado' : 'Rejeitado'}
              </span>
            </div>
          ))}
        </section>
      )}
      {loading ? (
        <p className="admin-empty">Carregando solicitações...</p>
      ) : requests.length === 0 ? (
        <p className="admin-empty">Não há solicitações pendentes.</p>
      ) : filteredRequests.length === 0 ? (
        <p className="admin-empty">Nenhuma solicitação corresponde à pesquisa.</p>
      ) : (
        <div className="approval-list">
          {filteredRequests.map((request) => (
            <article className="approval-item" key={request.id}>
              <div className="approval-identity">
                <h2>{request.fullName}</h2>
                <span className="status-badge status-pending">Pendente</span>
                <p>{request.email}</p>
                <p>Setor: {request.sector}</p>
                <time dateTime={request.createdAt}>
                  Solicitado em {new Date(request.createdAt).toLocaleString('pt-BR')}
                </time>
              </div>

              <div className="approval-controls">
                <label>
                  Perfil a atribuir
                  <select
                    value={roles[request.id] ?? 'operator'}
                    onChange={(event) => setRoles((current) => ({
                      ...current,
                      [request.id]: event.target.value as 'admin' | 'operator',
                    }))}
                  >
                    <option value="operator">Operacional</option>
                    <option value="admin">Administrador</option>
                  </select>
                </label>
                <fieldset className="permission-fieldset">
                  <legend>Permissões para esta conta</legend>
                  <div className="permission-grid">
                    {permissionOptions.map((option) => (
                      <label className="permission-option" key={option.value}>
                        <input
                          type="checkbox"
                          checked={(permissions[request.id] ?? []).includes(option.value)}
                          onChange={() => togglePermission(request.id, option.value)}
                        />
                        <span>{option.label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="approval-actions">
                  <button
                    className="primary-button"
                    type="button"
                    disabled={busyId === request.id}
                    onClick={() => void submitDecision(request.id, {
                      action: 'approve',
                      role: roles[request.id] ?? 'operator',
                      permissions: permissions[request.id] ?? [],
                    })}
                  >
                    Aprovar e atribuir acesso
                  </button>
                  <button
                    className="danger-button"
                    type="button"
                    disabled={busyId === request.id}
                    onClick={() => void submitDecision(request.id, { action: 'reject' })}
                  >
                    Rejeitar
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}