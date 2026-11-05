import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { errorMessage, formatDateTime } from '../api/modulesApi'
import { addAccessReview, getAccessReview, listUserSessions } from '../api/operationsApi'
import type { ReviewedUser } from '../api/operationsApi'
import { roleLabels } from '../app/roleLabels'
import { useHasPermission } from '../auth/UserContext'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, FilterSelect, SearchField } from '../components/ui/Filters'
import Icon from '../components/ui/Icon'
import Modal from '../components/ui/Modal'
import PageHeader from '../components/ui/PageHeader'

const statusLabels: Record<string, string> = { approved: 'Ativa', inactive: 'Inativa', blocked: 'Bloqueada' }

const views: Record<string, { label: string; matches: (user: ReviewedUser) => boolean }> = {
  review: { label: 'Precisam de revisão', matches: (user) => user.reasons.length > 0 },
  active: { label: 'Ativos', matches: (user) => user.status === 'approved' },
  inactive: { label: 'Inativos ou bloqueados', matches: (user) => user.status !== 'approved' },
  administrators: { label: 'Administradores', matches: (user) => user.administrator },
  restricted: { label: 'Com acesso a dados restritos', matches: (user) => user.restrictedPermissions.length > 0 },
}

function AccessReviewPage() {
  const canManage = useHasPermission('users:manage')
  const [data, setData] = useState<Awaited<ReturnType<typeof getAccessReview>> | null>(null)
  const [view, setView] = useState('review')
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reviewing, setReviewing] = useState<ReviewedUser | null>(null)
  const [result, setResult] = useState('mantido')
  const [note, setNote] = useState('')
  const [sessions, setSessions] = useState<{
    user: ReviewedUser
    list: { id: string; createdAt: string; lastSeenAt: string; expiresAt: string }[]
  } | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await getAccessReview())
      setError('')
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível carregar a revisão de acessos.'))
    }
  }, [])

  useEffect(() => {
    let active = true
    getAccessReview()
      .then((response) => {
        if (active) setData(response)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar a revisão de acessos.'))
      })
    return () => {
      active = false
    }
  }, [])

  const users = useMemo(() => {
    if (!data) return []
    const term = search.trim().toLowerCase()
    return data.users.filter(
      (user) =>
        (!view || views[view].matches(user)) &&
        (!term || user.name.toLowerCase().includes(term) || user.sector.toLowerCase().includes(term)),
    )
  }, [data, view, search])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!reviewing) return
    setError('')
    try {
      await addAccessReview(reviewing.id, result, note)
      setNotice(`Revisão de ${reviewing.name} registrada.`)
      setReviewing(null)
      setNote('')
      await load()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível registrar a revisão.'))
      setReviewing(null)
    }
  }

  async function openSessions(user: ReviewedUser) {
    setError('')
    try {
      setSessions({ user, list: (await listUserSessions(user.id)).sessions })
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível consultar as sessões.'))
    }
  }

  return (
    <div className="admin-module-page access-review-page">
      <PageHeader
        title="Revisão de acessos"
        description={
          data
            ? `Acessos sensíveis são revisados a cada ${data.criteria.reviewIntervalDays} dias. Sem uso há ${data.criteria.inactivityDays} dias, entram na lista.`
            : 'Contas, permissões e revisões periódicas.'
        }
        actions={
          <Link className="maintenance-secondary-button" to="/usuarios">
            <Icon name="back" size={18} weight="bold" />
            Usuários
          </Link>
        }
      />
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {!data && !error && <Loading label="Carregando acessos..." />}

      {data && (
        <>
          <FilterBar label="Filtros da revisão" canClear={Boolean(view || search)} onClear={() => { setView(''); setSearch('') }}>
            <FilterSelect
              label="Mostrar"
              value={view}
              onChange={setView}
              allLabel="Todas as contas"
              options={Object.entries(views).map(([value, item]) => ({ value, label: item.label }))}
            />
            <SearchField label="Pesquisar" value={search} placeholder="Nome ou setor" onChange={setSearch} />
          </FilterBar>

          <section className="ui-card ui-stacked" aria-label="Contas">
            {users.length === 0 ? (
              <EmptyState icon="review" title="Nenhuma conta nesta lista" />
            ) : (
              <div className="data-table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Pessoa</th>
                      <th>Situação</th>
                      <th>Perfil</th>
                      <th>Permissões especiais</th>
                      <th>Último acesso</th>
                      <th>Última revisão</th>
                      <th>
                        <span className="visually-hidden">Ações</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id}>
                        <td>
                          <Link to={`/usuarios/${user.id}`}>{user.name}</Link>
                          <small className="central-subtext">{user.sector}</small>
                          {user.reasons.map((reason) => (
                            <span key={reason} className="central-flag central-flag-late">{reason}</span>
                          ))}
                        </td>
                        <td>{statusLabels[user.status] ?? user.status}</td>
                        <td>
                          {user.role ? roleLabels[user.role as keyof typeof roleLabels] : '—'}
                          {user.slmMember && <small className="central-subtext">Equipe SLM</small>}
                        </td>
                        <td>{user.restrictedPermissions.length > 0 ? user.restrictedPermissions.join(', ') : '—'}</td>
                        <td>{formatDateTime(user.lastAccess)}</td>
                        <td>
                          {formatDateTime(user.lastReview)}
                          {user.lastReviewBy && <small className="central-subtext">{user.lastReviewBy}</small>}
                        </td>
                        <td>
                          {canManage && (
                            <div className="action-row">
                              <button type="button" className="central-link-button" onClick={() => setReviewing(user)}>
                                Revisar
                              </button>
                              <button type="button" className="central-link-button" onClick={() => void openSessions(user)}>
                                Sessões
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {reviewing && (
        <Modal title={`Revisar ${reviewing.name}`} onClose={() => setReviewing(null)}>
          <form className="ui-stacked" onSubmit={(event) => void submit(event)}>
            <p>Para alterar as permissões, abra a conta. Aqui fica registrado o resultado da revisão.</p>
            <label className="maintenance-form-field">
              <span>Resultado</span>
              <select value={result} onChange={(event) => setResult(event.target.value)}>
                <option value="mantido">Acesso mantido</option>
                <option value="ajustado">Acesso ajustado</option>
              </select>
            </label>
            <label className="maintenance-form-field">
              <span>Observação</span>
              <textarea rows={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
            <button type="submit" className="maintenance-primary-button">
              Registrar revisão
            </button>
          </form>
        </Modal>
      )}

      {sessions && (
        <Modal title={`Sessões de ${sessions.user.name}`} onClose={() => setSessions(null)}>
          {sessions.list.length === 0 ? (
            <p>Nenhuma sessão ativa.</p>
          ) : (
            <ul className="detail-history">
              {sessions.list.map((session) => (
                <li key={session.id}>
                  <span>Início: {formatDateTime(session.createdAt)}</span>
                  <span>Último uso: {formatDateTime(session.lastSeenAt)}</span>
                  <small>Expira em {formatDateTime(session.expiresAt)}</small>
                </li>
              ))}
            </ul>
          )}
          <p className="management-hint">Para encerrar, abra a conta da pessoa.</p>
        </Modal>
      )}
    </div>
  )
}

export default AccessReviewPage
