import { useCallback, useEffect, useState } from 'react'
import { errorMessage, formatDateTime, listOwnSessions, revokeOtherSessions, revokeOwnSession } from '../api/modulesApi'
import { useAuthenticatedUser } from '../auth/UserContext'
import { Alert, Loading } from '../components/ui/Feedback'
import PageHeader from '../components/ui/PageHeader'

type Session = Awaited<ReturnType<typeof listOwnSessions>>['sessions'][number]

function AccountPage() {
  const user = useAuthenticatedUser()
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const reload = useCallback(async () => {
    const data = await listOwnSessions()
    setSessions(data.sessions)
  }, [])

  useEffect(() => {
    let active = true
    listOwnSessions()
      .then((data) => {
        if (active) setSessions(data.sessions)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível consultar as sessões.'))
      })
    return () => {
      active = false
    }
  }, [])

  async function revokeOne(id: string) {
    setError('')
    setNotice('')
    try {
      await revokeOwnSession(id)
      setNotice('Sessão encerrada.')
      await reload()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível encerrar a sessão.'))
    }
  }

  async function revoke() {
    setError('')
    setNotice('')
    try {
      const { total } = await revokeOtherSessions()
      setNotice(total === 1 ? '1 sessão encerrada.' : `${total} sessões encerradas.`)
      await reload()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível encerrar as sessões.'))
    }
  }

  return (
    <section className="page-section admin-module-page">
      <PageHeader eyebrow="Minha conta" title={user?.name ?? 'Minha conta'} description={`${user?.email ?? ''} · ${user?.sector ?? ''}`} />

      <section className="ui-card ui-stacked" aria-labelledby="account-sessions">
      <h2 id="account-sessions">Sessões ativas</h2>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {!sessions && !error && <Loading label="Carregando sessões..." />}

      {sessions && (
        <>
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Início</th>
                  <th>Último uso</th>
                  <th>Expira em</th>
                  <th>Situação</th>
                  <th>
                    <span className="visually-hidden">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td>{formatDateTime(session.createdAt)}</td>
                    <td>{formatDateTime(session.lastSeenAt)}</td>
                    <td>{formatDateTime(session.expiresAt)}</td>
                    <td>{session.current ? 'Esta sessão' : 'Outra sessão'}</td>
                    <td>
                      {!session.current && (
                        <button type="button" className="maintenance-secondary-button" onClick={() => void revokeOne(session.id)}>
                          Encerrar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ui-card-actions">
            <button
              type="button"
              className="maintenance-secondary-button"
              disabled={sessions.length <= 1}
              onClick={() => void revoke()}
            >
              Encerrar as outras sessões
            </button>
          </div>
        </>
      )}
      </section>
    </section>
  )
}

export default AccountPage
