
import { useCallback, useEffect, useState } from 'react'

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

async function registrationRequest(
  path: string,
  options: RequestInit = {},
): Promise<PendingResponse> {
  const response = await fetch(`/api/admin/registrations${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  let data: PendingResponse | null = null

  try {
    data = (await response.json()) as PendingResponse
  } catch {
    // A resposta pode estar vazia ou não conter JSON válido.
  }

  if (!response.ok || !data?.success) {
    let message = data?.message

    if (!message && response.status === 401) {
      message = 'Sua sessão expirou. Entre novamente no sistema.'
    } else if (!message && response.status === 403) {
      message = 'Você não tem permissão para realizar esta ação.'
    } else if (!message && response.status === 404) {
      message = 'O cadastro solicitado não foi encontrado.'
    } else if (!message && response.status === 409) {
      message = 'Este cadastro já foi decidido. Atualize a lista.'
    } else if (!message) {
      message = 'Não foi possível comunicar com o servidor. Tente novamente.'
    }

    throw new Error(message)
  }

  return data
}

function PendingRegistrationsPage() {
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

  useEffect(() => {
    void loadRegistrations()
  }, [loadRegistrations])

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
                      <option value="slm_operator">Operador SLM</option>
                      <option value="administrator">Administrador</option>
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
