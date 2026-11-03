
import { useCallback, useEffect, useState } from 'react'
import { apiRequest } from '../auth/apiClient'
import { useAuthenticatedUser } from '../auth/UserContext'

type PendingRegistration = {
  id: string
  name: string
  email: string
  sector: string
  createdAt: string
}

type ApprovalRole = 'requester' | 'slm_operator' | 'administrator'

type PendingResponse = {
  success: boolean
  message?: string
  registrations?: PendingRegistration[]
}

function registrationRequest(
  path: string,
  options: RequestInit = {},
): Promise<PendingResponse> {
  return apiRequest<PendingResponse>(`/admin/registrations${path}`, options)
}

function PendingRegistrationsPage() {
  const currentUser = useAuthenticatedUser()
  const canAssignAnyProfile = currentUser?.role === 'administrator'
  const [registrations, setRegistrations] = useState<PendingRegistration[]>([])
  const [selectedRoles, setSelectedRoles] = useState<Record<string, ApprovalRole>>({})
  const [loading, setLoading] = useState(true)
  const [processingId, setProcessingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadRegistrations = useCallback(async () => {
    setLoading(true)
    setError('')

    try {
      const data = await registrationRequest('/pending')
      setRegistrations(data.registrations ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar os cadastros.')
    } finally {
      setLoading(false)
    }
  }, [])

  // Primeira carga: "loading" já começa verdadeiro e os estados só mudam quando a
  // resposta chega, e não durante o efeito.
  useEffect(() => {
    let active = true

    registrationRequest('/pending')
      .then((data) => {
        if (active) setRegistrations(data.registrations ?? [])
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Erro ao carregar os cadastros.')
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  async function decideRegistration(
    registration: PendingRegistration,
    action: 'approve' | 'reject',
  ) {
    const approvesAdministrator =
      action === 'approve' &&
      selectedRoles[registration.id] === 'administrator'
    const confirmation =
      approvesAdministrator
        ? `Aprovar ${registration.name} como ADMINISTRADOR? Essa pessoa poderá aprovar cadastros, inclusive de outros administradores.`
        : action === 'approve'
        ? `Aprovar o cadastro de ${registration.name}?`
        : `Rejeitar o cadastro de ${registration.name}?`

    if (!window.confirm(confirmation)) return

    setProcessingId(registration.id)
    setError('')
    setNotice('')

    try {
      const role = selectedRoles[registration.id] ?? 'requester'
      const path =
        action === 'approve'
          ? `/${encodeURIComponent(registration.id)}/approve`
          : `/${encodeURIComponent(registration.id)}/reject`

      await registrationRequest(path, {
        method: 'POST',
        ...(action === 'approve'
          ? { body: JSON.stringify({ role }) }
          : {}),
      })

      setNotice(
        action === 'approve'
          ? `Cadastro de ${registration.name} aprovado.`
          : `Cadastro de ${registration.name} rejeitado.`,
      )

      await loadRegistrations()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível processar o cadastro.')
    } finally {
      setProcessingId(null)
    }
  }

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <p className="eyebrow">ADMINISTRAÇÃO</p>
          <h1>Cadastros pendentes</h1>
          <p>Analise as solicitações e defina o perfil de acesso de cada usuário.</p>
        </div>
        <button type="button" onClick={() => void loadRegistrations()} disabled={loading}>
          Atualizar lista
        </button>
      </div>

      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      {loading ? (
        <p>Carregando solicitações...</p>
      ) : registrations.length === 0 ? (
        <div className="empty-state">
          <h2>Nenhum cadastro pendente</h2>
          <p>Quando houver novas solicitações, elas aparecerão aqui.</p>
        </div>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>E-mail</th>
                <th>Setor</th>
                <th>Solicitado em</th>
                <th>Perfil ao aprovar</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {registrations.map((registration) => (
                <tr key={registration.id}>
                  <td>{registration.name}</td>
                  <td>{registration.email}</td>
                  <td>{registration.sector}</td>
                  <td>
                    {new Date(registration.createdAt).toLocaleString('pt-BR')}
                  </td>
                  <td>
                    <select
                      aria-label={`Perfil para ${registration.name}`}
                      value={selectedRoles[registration.id] ?? 'requester'}
                      onChange={(event) =>
                        setSelectedRoles((current) => ({
                          ...current,
                          [registration.id]: event.target.value as ApprovalRole,
                        }))
                      }
                      disabled={processingId === registration.id}
                    >
                      <option value="requester">Solicitante</option>
                      {canAssignAnyProfile && (
                        <>
                          <option value="slm_operator">Operador SLM</option>
                          <option value="administrator">Administrador</option>
                        </>
                      )}
                    </select>
                  </td>
                  <td>
                    <div className="table-actions">
                      <button
                        type="button"
                        onClick={() => void decideRegistration(registration, 'approve')}
                        disabled={processingId === registration.id}
                      >
                        {processingId === registration.id ? 'Processando...' : 'Aprovar'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void decideRegistration(registration, 'reject')}
                        disabled={processingId === registration.id}
                      >
                        Rejeitar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default PendingRegistrationsPage
