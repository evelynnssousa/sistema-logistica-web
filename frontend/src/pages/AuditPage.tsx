import { useEffect, useState } from 'react'
import {
  auditActionLabels,
  describeAuditDetails,
  listAuditEvents,
} from '../auth/usersApi'
import type { AuditEntry } from '../auth/usersApi'

const resultLabels: Record<string, string> = {
  success: 'Sucesso',
  failure: 'Falha',
  denied: 'Negado',
}

function AuditPage() {
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ events: AuditEntry[]; hasMore: boolean } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    listAuditEvents(page)
      .then((result) => {
        if (!active) return
        setData(result)
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
  }, [page])

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <p className="eyebrow">ADMINISTRAÇÃO</p>
          <h1>Auditoria</h1>
          <p>Registros de acesso e de ações administrativas, do mais recente ao mais antigo.</p>
        </div>
      </div>

      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>Carregando registros...</p>}

      {data && (
        <>
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Ação</th>
                  <th>Resultado</th>
                  <th>Feita por</th>
                  <th>Conta afetada</th>
                  <th>Detalhes</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((event) => (
                  <tr key={event.id}>
                    <td>{new Date(event.occurredAt).toLocaleString('pt-BR')}</td>
                    <td>{auditActionLabels[event.action] ?? event.action}</td>
                    <td>{resultLabels[event.result] ?? event.result}</td>
                    <td>{event.actorName ?? 'Sistema'}</td>
                    <td>{event.targetName ?? '—'}</td>
                    <td>{describeAuditDetails(event.details)}</td>
                  </tr>
                ))}
                {data.events.length === 0 && (
                  <tr>
                    <td colSpan={6}>Nenhum registro encontrado.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="users-pagination">
            <span>Página {page}</span>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
            >
              Anterior
            </button>
            <button
              type="button"
              disabled={!data.hasMore}
              onClick={() => setPage((current) => current + 1)}
            >
              Próxima
            </button>
          </div>
        </>
      )}
    </section>
  )
}

export default AuditPage
