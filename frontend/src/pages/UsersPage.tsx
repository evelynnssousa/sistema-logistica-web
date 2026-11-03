import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { roleLabels } from '../app/roleLabels'
import { useHasPermission } from '../auth/UserContext'
import { listUsers, statusLabels } from '../auth/usersApi'
import type { ManagedUser, UserFilters } from '../auth/usersApi'

const initialFilters: UserFilters = {
  search: '',
  role: '',
  status: '',
  slm: '',
  page: 1,
}

function UsersPage() {
  const canManage = useHasPermission('users:manage')
  const [filters, setFilters] = useState(initialFilters)
  const [searchDraft, setSearchDraft] = useState('')
  const [result, setResult] = useState<{
    users: ManagedUser[]
    total: number
    pageSize: number
  } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    listUsers(filters)
      .then((data) => {
        if (!active) return
        setResult(data)
        setError('')
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Não foi possível carregar os usuários.')
        }
      })

    return () => {
      active = false
    }
  }, [filters])

  function changeFilter(name: 'role' | 'status' | 'slm', value: string) {
    setFilters((current) => ({ ...current, [name]: value, page: 1 }))
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFilters((current) => ({ ...current, search: searchDraft.trim(), page: 1 }))
  }

  const lastPage = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <p className="eyebrow">ADMINISTRAÇÃO</p>
          <h1>Usuários</h1>
          <p>
            {canManage
              ? 'Consulte as contas e gerencie perfis, permissões e a equipe SLM.'
              : 'Consulte as contas cadastradas.'}
          </p>
        </div>
      </div>

      <form className="users-filters" onSubmit={submitSearch} role="search">
        <label className="users-search">
          <span>Nome ou e-mail</span>
          <input
            type="search"
            value={searchDraft}
            maxLength={200}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Pesquisar"
          />
        </label>
        <label>
          <span>Perfil</span>
          <select
            value={filters.role}
            onChange={(event) => changeFilter('role', event.target.value)}
          >
            <option value="">Todos</option>
            <option value="administrator">{roleLabels.administrator}</option>
            <option value="slm_operator">{roleLabels.slm_operator}</option>
            <option value="requester">{roleLabels.requester}</option>
          </select>
        </label>
        <label>
          <span>Situação</span>
          <select
            value={filters.status}
            onChange={(event) => changeFilter('status', event.target.value)}
          >
            <option value="">Ativas, inativas e bloqueadas</option>
            <option value="approved">{statusLabels.approved}</option>
            <option value="inactive">{statusLabels.inactive}</option>
            <option value="blocked">{statusLabels.blocked}</option>
            <option value="pending">{statusLabels.pending}</option>
            <option value="rejected">{statusLabels.rejected}</option>
          </select>
        </label>
        <label>
          <span>Equipe SLM</span>
          <select
            value={filters.slm}
            onChange={(event) => changeFilter('slm', event.target.value)}
          >
            <option value="">Todos</option>
            <option value="true">Integrantes</option>
            <option value="false">Não integrantes</option>
          </select>
        </label>
        <button type="submit">Pesquisar</button>
      </form>

      {error && <p role="alert">{error}</p>}

      {!result && !error && <p>Carregando usuários...</p>}

      {result && (
        <>
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>E-mail</th>
                  <th>Setor</th>
                  <th>Perfil</th>
                  <th>Situação</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {result.users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      {user.name}
                      {user.slmMember && (
                        <span className="user-badge slm"> Equipe SLM</span>
                      )}
                    </td>
                    <td>{user.email}</td>
                    <td>{user.sector}</td>
                    <td>{user.role ? roleLabels[user.role] : '—'}</td>
                    <td>
                      <span className={`user-badge status-${user.status}`}>
                        {statusLabels[user.status] ?? user.status}
                      </span>
                    </td>
                    <td>
                      <Link className="users-link" to={`/usuarios/${user.id}`}>
                        {canManage ? 'Gerenciar' : 'Consultar'}
                      </Link>
                    </td>
                  </tr>
                ))}
                {result.users.length === 0 && (
                  <tr>
                    <td colSpan={6}>Nenhum usuário encontrado com esses filtros.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="users-pagination">
            <span>
              {result.total} {result.total === 1 ? 'usuário' : 'usuários'} · página{' '}
              {filters.page} de {lastPage}
            </span>
            <button
              type="button"
              disabled={filters.page <= 1}
              onClick={() =>
                setFilters((current) => ({ ...current, page: current.page - 1 }))
              }
            >
              Anterior
            </button>
            <button
              type="button"
              disabled={filters.page >= lastPage}
              onClick={() =>
                setFilters((current) => ({ ...current, page: current.page + 1 }))
              }
            >
              Próxima
            </button>
          </div>
        </>
      )}
    </section>
  )
}

export default UsersPage
