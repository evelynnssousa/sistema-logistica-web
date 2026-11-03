import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { roleLabels } from '../app/roleLabels'
import { useAuthenticatedUser, useHasPermission } from '../auth/UserContext'
import {
  auditActionLabels,
  describeAuditDetails,
  getPermissionCatalog,
  getUser,
  getUserHistory,
  setUserActive,
  statusLabels,
  updateUserAccess,
  updateUserData,
} from '../auth/usersApi'
import type {
  AuditEntry,
  ManagedUser,
  PermissionCatalog,
  UserRole,
} from '../auth/usersApi'

const cpfPermission = 'flights:cpf:read'

type Override = 'profile' | 'grant' | 'deny'

function overridesFrom(user: ManagedUser) {
  const overrides: Record<string, Override> = {}
  user.grantedPermissions.forEach((permission) => {
    overrides[permission] = 'grant'
  })
  user.deniedPermissions.forEach((permission) => {
    overrides[permission] = 'deny'
  })
  return overrides
}

function UserDetailPage() {
  const { userId = '' } = useParams()
  const currentUser = useAuthenticatedUser()
  const canManage = useHasPermission('users:manage')

  const [user, setUser] = useState<ManagedUser | null>(null)
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null)
  const [history, setHistory] = useState<AuditEntry[]>([])
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [sector, setSector] = useState('')
  const [role, setRole] = useState<UserRole>('requester')
  const [slmMember, setSlmMember] = useState(false)
  const [overrides, setOverrides] = useState<Record<string, Override>>({})

  function applyUser(next: ManagedUser) {
    setUser(next)
    setName(next.name)
    setEmail(next.email)
    setSector(next.sector)
    setRole(next.role ?? 'requester')
    setSlmMember(next.slmMember)
    setOverrides(overridesFrom(next))
  }

  useEffect(() => {
    let active = true

    Promise.all([getUser(userId), getPermissionCatalog(), getUserHistory(userId)])
      .then(([loadedUser, loadedCatalog, loadedHistory]) => {
        if (!active) return
        applyUser(loadedUser)
        setCatalog(loadedCatalog)
        setHistory(loadedHistory)
      })
      .catch((err: unknown) => {
        if (active) {
          setLoadError(err instanceof Error ? err.message : 'Não foi possível carregar o usuário.')
        }
      })

    return () => {
      active = false
    }
  }, [userId])

  const profilePermissions = useMemo(
    () =>
      new Set(catalog?.profiles.find((profile) => profile.key === role)?.permissions),
    [catalog, role],
  )

  const isSelf = currentUser?.id === userId
  const canEditAccess =
    canManage && !isSelf && currentUser?.role === 'administrator'
  const targetIsAdministrator = user?.role === 'administrator'
  const canEditAccount =
    canManage && (currentUser?.role === 'administrator' || !targetIsAdministrator)
  const decided = user?.role !== null

  async function run(action: () => Promise<ManagedUser>, success: string) {
    setSaving(true)
    setError('')
    setNotice('')

    try {
      applyUser(await action())
      setHistory(await getUserHistory(userId))
      setNotice(success)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar.')
    } finally {
      setSaving(false)
    }
  }

  function saveData(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void run(
      () => updateUserData(userId, { name, email, sector }),
      'Dados cadastrais atualizados.',
    )
  }

  function saveAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const grantedPermissions = Object.keys(overrides).filter(
      (permission) => overrides[permission] === 'grant',
    )
    const deniedPermissions = Object.keys(overrides).filter(
      (permission) => overrides[permission] === 'deny',
    )

    if (
      grantedPermissions.includes(cpfPermission) &&
      !user?.grantedPermissions.includes(cpfPermission) &&
      !window.confirm(
        `Conceder a ${user?.name} acesso ao CPF completo dos passageiros? Cada consulta ficará registrada na auditoria.`,
      )
    ) {
      return
    }

    void run(
      () =>
        updateUserAccess(userId, {
          role,
          slmMember,
          grantedPermissions,
          deniedPermissions,
        }),
      'Acesso atualizado. A alteração já vale para as sessões abertas.',
    )
  }

  function toggleActive() {
    if (!user) return
    const activating = user.status !== 'approved'

    if (
      !activating &&
      !window.confirm(`Desativar a conta de ${user.name}? As sessões abertas serão encerradas.`)
    ) {
      return
    }

    void run(
      () => setUserActive(userId, activating),
      activating ? 'Conta ativada.' : 'Conta desativada.',
    )
  }

  function changeRole(next: UserRole) {
    setRole(next)
    if (next === 'slm_operator') setSlmMember(true)
  }

  // O perfil operacional só existe dentro da equipe: sair dela volta a Solicitante.
  function changeSlmMember(next: boolean) {
    setSlmMember(next)
    if (!next && role === 'slm_operator') setRole('requester')
  }

  if (loadError) {
    return (
      <section className="page-section">
        <p role="alert">{loadError}</p>
        <Link className="users-link" to="/usuarios">
          ← Voltar aos usuários
        </Link>
      </section>
    )
  }

  if (!user || !catalog) {
    return (
      <section className="page-section">
        <p>Carregando usuário...</p>
      </section>
    )
  }

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <p className="eyebrow">ADMINISTRAÇÃO · USUÁRIOS</p>
          <h1>{user.name}</h1>
          <p>
            {user.role ? roleLabels[user.role] : 'Sem perfil'} ·{' '}
            {statusLabels[user.status] ?? user.status}
            {user.slmMember ? ' · Equipe SLM' : ''}
          </p>
        </div>
        <Link className="users-link" to="/usuarios">
          ← Voltar aos usuários
        </Link>
      </div>

      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      {isSelf && (
        <p className="users-note" role="note">
          Esta é a sua conta. Por segurança, seu perfil, suas permissões e sua
          situação só podem ser alterados por outro administrador.
        </p>
      )}

      {!decided && (
        <p className="users-note" role="note">
          Este cadastro ainda não foi aprovado e é tratado em Cadastros pendentes.
        </p>
      )}

      <form className="users-card" onSubmit={saveData}>
        <h2>Dados cadastrais</h2>
        <div className="users-form-grid">
          <label>
            <span>Nome</span>
            <input
              value={name}
              maxLength={120}
              required
              disabled={!canEditAccount || !decided || saving}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span>E-mail</span>
            <input
              type="email"
              value={email}
              maxLength={254}
              required
              disabled={
                !canEditAccount ||
                !decided ||
                saving ||
                currentUser?.role !== 'administrator'
              }
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            <span>Setor</span>
            <input
              value={sector}
              maxLength={120}
              required
              disabled={!canEditAccount || !decided || saving}
              onChange={(event) => setSector(event.target.value)}
            />
          </label>
        </div>
        {canEditAccount && decided && (
          <button type="submit" disabled={saving}>
            Salvar dados
          </button>
        )}
      </form>

      {decided && (
        <div className="users-card">
          <h2>Situação da conta</h2>
          <p>
            Conta {(statusLabels[user.status] ?? user.status).toLowerCase()}. Uma
            conta desativada perde o acesso na hora, e o histórico é mantido.
          </p>
          {canEditAccount && !isSelf && (
            <button
              type="button"
              className={user.status === 'approved' ? 'danger' : ''}
              disabled={saving}
              onClick={toggleActive}
            >
              {user.status === 'approved' ? 'Desativar conta' : 'Ativar conta'}
            </button>
          )}
        </div>
      )}

      {decided && (
        <form className="users-card" onSubmit={saveAccess}>
          <h2>Perfil e equipe SLM</h2>
          {!canEditAccess && !isSelf && (
            <p>Somente um administrador pode alterar o acesso de um usuário.</p>
          )}
          <div className="users-form-grid">
            <label>
              <span>Perfil</span>
              <select
                value={role}
                disabled={!canEditAccess || saving}
                onChange={(event) => changeRole(event.target.value as UserRole)}
              >
                <option value="requester">{roleLabels.requester}</option>
                <option value="slm_operator">{roleLabels.slm_operator}</option>
                <option value="administrator">{roleLabels.administrator}</option>
              </select>
            </label>
            <label className="users-checkbox">
              <input
                type="checkbox"
                checked={slmMember}
                disabled={!canEditAccess || saving}
                onChange={(event) => changeSlmMember(event.target.checked)}
              />
              <span>
                Integra a equipe SLM. Não depende do setor cadastrado, e a
                retirada não apaga o histórico. Retirar um Operador SLM da equipe
                muda o perfil para Solicitante.
              </span>
            </label>
          </div>

          <h2>Permissões individuais</h2>
          <p>
            Somam ou retiram em relação ao perfil, sem promover o usuário. A
            retirada sempre prevalece.
          </p>

          {catalog.groups.map((group) => (
            <fieldset className="users-permission-group" key={group.key}>
              <legend>{group.label}</legend>
              {group.permissions.map((permission) => {
                const fromProfile = profilePermissions.has(permission.key)
                const override = overrides[permission.key] ?? 'profile'
                const effective =
                  override === 'grant' ||
                  (override === 'profile' && fromProfile)

                return (
                  <div
                    className={`users-permission${permission.key === cpfPermission ? ' sensitive' : ''}`}
                    key={permission.key}
                  >
                    <div>
                      <strong>{permission.label}</strong>
                      <small>
                        {permission.key} ·{' '}
                        {effective ? 'Com acesso' : 'Sem acesso'}
                        {fromProfile ? ' · incluída no perfil' : ''}
                      </small>
                    </div>
                    <select
                      aria-label={permission.label}
                      value={override}
                      disabled={!canEditAccess || saving}
                      onChange={(event) =>
                        setOverrides((current) => ({
                          ...current,
                          [permission.key]: event.target.value as Override,
                        }))
                      }
                    >
                      <option value="profile">Conforme o perfil</option>
                      <option value="grant">Conceder</option>
                      <option value="deny">Retirar</option>
                    </select>
                  </div>
                )
              })}
            </fieldset>
          ))}

          {canEditAccess && (
            <button type="submit" disabled={saving}>
              {saving ? 'Salvando...' : 'Salvar acesso'}
            </button>
          )}
        </form>
      )}

      <div className="users-card">
        <h2>Histórico de alterações</h2>
        {history.length === 0 ? (
          <p>Nenhuma alteração registrada.</p>
        ) : (
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Alteração</th>
                  <th>Feita por</th>
                  <th>Detalhes</th>
                </tr>
              </thead>
              <tbody>
                {history.map((event) => (
                  <tr key={event.id}>
                    <td>{new Date(event.occurredAt).toLocaleString('pt-BR')}</td>
                    <td>{auditActionLabels[event.action] ?? event.action}</td>
                    <td>{event.actorName ?? 'Sistema'}</td>
                    <td>{describeAuditDetails(event.details)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

export default UserDetailPage
