
import { useConfirm } from '../components/ui/useConfirm'
import { useCallback, useEffect, useState } from 'react'
import { apiRequest } from '../auth/apiClient'
import { useAuthenticatedUser } from '../auth/UserContext'
import {
  getInstitutionalOptions,
  getPermissionCatalog,
} from '../auth/usersApi'
import type { InstitutionalLinks, InstitutionalOptions, PermissionCatalog } from '../auth/usersApi'
import PermissionDescription, { PermissionScopeNotice } from '../components/PermissionDescription'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import Icon from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'
import InstitutionalLinksEditor from '../components/InstitutionalLinksEditor'
import Modal from '../components/ui/Modal'

type PendingRegistration = {
  id: string
  name: string
  email: string
  sector: string
  createdAt: string
  additional?: { label: string; value: string }[]
}

type ApprovalRole = 'requester' | 'slm_operator' | 'administrator' | 'driver'

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

type ApprovalSetup = {
  lotation: string
  slmMember: boolean
  links: InstitutionalLinks
  grantedPermissions: string[]
}

const emptySetup = (sector: string): ApprovalSetup => ({
  lotation: sector,
  slmMember: false,
  links: { directorate: null, sectors: [] },
  grantedPermissions: [],
})

function describeSetup(setup: ApprovalSetup | undefined, sector: string) {
  if (!setup) return ''
  return [
    setup.lotation !== sector ? `Lotação: ${setup.lotation}` : '',
    setup.links.directorate ? 'DA' : '',
    setup.slmMember ? 'SLM' : '',
    setup.links.sectors.length ? `${setup.links.sectors.length} setor(es)` : '',
    setup.grantedPermissions.length ? `${setup.grantedPermissions.length} permissão(ões)` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

function ApprovalSetupDialog({
  registration,
  role,
  initial,
  options,
  catalog,
  onClose,
  onSave,
}: {
  registration: PendingRegistration
  role: ApprovalRole
  initial: ApprovalSetup
  options: InstitutionalOptions
  catalog: PermissionCatalog | null
  onClose: () => void
  onSave: (setup: ApprovalSetup, role: ApprovalRole) => void
}) {
  const [setup, setSetup] = useState(initial)
  const [selectedRole, setSelectedRole] = useState(role)

  // Só Administrador e Operador SLM integram a equipe, então o perfil acompanha.
  function changeSlm(next: boolean) {
    setSetup((current) => ({ ...current, slmMember: next }))
    if (next && (selectedRole === 'requester' || selectedRole === 'driver')) setSelectedRole('slm_operator')
    if (!next && selectedRole === 'slm_operator') setSelectedRole('requester')
  }

  const eligible = new Set(
    catalog?.eligibility.find((entry) => entry.role === selectedRole && entry.slmMember === setup.slmMember)?.eligible,
  )
  const blocked = (permission: string) => Boolean(catalog?.restricted.includes(permission)) && !eligible.has(permission)
  const fromProfile = new Set(catalog?.profiles.find((profile) => profile.key === selectedRole)?.permissions)

  return (
    <Modal title={`Vínculos de ${registration.name}`} onClose={onClose}>
      <form
        className="demand-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          onSave(
            { ...setup, grantedPermissions: setup.grantedPermissions.filter((permission) => !blocked(permission)) },
            selectedRole,
          )
          onClose()
        }}
      >
        <label className="maintenance-form-field">
          <span>Setor de lotação</span>
          <input
            required
            minLength={2}
            maxLength={120}
            list="approval-lotations"
            value={setup.lotation}
            onChange={(event) => setSetup((current) => ({ ...current, lotation: event.target.value }))}
          />
          <datalist id="approval-lotations">
            {options.lotations.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <small className="demand-muted">Participar da DA ou do SLM não muda a lotação: os vínculos somam.</small>
        </label>

        <label className="demand-check">
          <input type="checkbox" checked={setup.slmMember} onChange={(event) => changeSlm(event.target.checked)} />
          Integra a equipe SLM (o perfil de Solicitante passa a Operador SLM)
        </label>

        {options.available ? (
          <InstitutionalLinksEditor
            options={options}
            value={setup.links}
            onChange={(links) => setSetup((current) => ({ ...current, links }))}
          />
        ) : (
          <Alert tone="warning">
            Os vínculos com a DA e os setores dependem de uma atualização do banco de dados ainda não aplicada.
          </Alert>
        )}

        {selectedRole === 'slm_operator' && (
          <Alert tone="info">
            O perfil Operador SLM já inclui agendar serviços de Manutenção e Frota, gerenciar o Almoxarifado e registrar a
            previsão de entrega, que só valem enquanto a pessoa integrar a equipe SLM. CPF completo, abertura em nome de
            outros setores e a Central de Operações continuam por concessão individual.
          </Alert>
        )}

        {catalog && (
          <details className="demand-details">
            <summary>Permissões adicionais</summary>
            <p className="demand-muted">
              As permissões que o perfil escolhido já inclui não aparecem aqui. Marque só o que esta pessoa precisa a mais.
            </p>
            <PermissionScopeNotice />
            {catalog.groups.map((group) => (
              <fieldset className="demand-checks demand-checks-inline" key={group.key}>
                <legend>{group.label}</legend>
                {group.permissions
                  .filter((permission) => !fromProfile.has(permission.key))
                  .map((permission) => (
                    <label key={permission.key} className="permission-check">
                      <input
                        type="checkbox"
                        disabled={blocked(permission.key)}
                        checked={setup.grantedPermissions.includes(permission.key)}
                        onChange={(event) =>
                          setSetup((current) => ({
                            ...current,
                            grantedPermissions: event.target.checked
                              ? [...current.grantedPermissions, permission.key]
                              : current.grantedPermissions.filter((item) => item !== permission.key),
                          }))
                        }
                      />
                      <PermissionDescription permission={permission} />
                    </label>
                  ))}
              </fieldset>
            ))}
          </details>
        )}

        <div className="demand-dialog-actions">
          <button type="button" className="maintenance-secondary-button" onClick={onClose}>Voltar</button>
          <button type="submit" className="maintenance-primary-button">Usar estes vínculos</button>
        </div>
      </form>
    </Modal>
  )
}

function PendingRegistrationsPage() {
  const { confirm, confirmDialog } = useConfirm()
  const currentUser = useAuthenticatedUser()
  const canAssignAnyProfile = currentUser?.role === 'administrator'
  const [registrations, setRegistrations] = useState<PendingRegistration[]>([])
  const [selectedRoles, setSelectedRoles] = useState<Record<string, ApprovalRole>>({})
  const [loading, setLoading] = useState(true)
  const [processingId, setProcessingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [setups, setSetups] = useState<Record<string, ApprovalSetup>>({})
  const [editing, setEditing] = useState<PendingRegistration | null>(null)
  const [options, setOptions] = useState<InstitutionalOptions | null>(null)
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null)

  // Só o administrador define vínculos: o servidor recusa os demais.
  useEffect(() => {
    if (!canAssignAnyProfile) return
    let active = true
    getInstitutionalOptions()
      .then((data) => {
        if (active) setOptions(data)
      })
      .catch(() => undefined)
    getPermissionCatalog()
      .then((data) => {
        if (active) setCatalog(data)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [canAssignAnyProfile])

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

  function approvalBody(registration: PendingRegistration, role: ApprovalRole) {
    const setup = setups[registration.id]
    if (!setup) return { role }
    const hasLinks = setup.links.directorate !== null || setup.links.sectors.length > 0
    return {
      role,
      setup: {
        ...(setup.slmMember ? { slmMember: true } : {}),
        ...(setup.lotation !== registration.sector ? { lotation: setup.lotation } : {}),
        ...(setup.grantedPermissions.length ? { grantedPermissions: setup.grantedPermissions } : {}),
        ...(hasLinks ? { institutional: setup.links } : {}),
      },
    }
  }

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

    if (!(await confirm(confirmation, { danger: action === 'reject' }))) return

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
          ? { body: JSON.stringify(approvalBody(registration, role)) }
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
    <section className="page-section admin-module-page">
      <PageHeader
        title="Cadastros pendentes"
        description="Analise as solicitações e defina o perfil de acesso de cada usuário."
        actions={
          <button
            type="button"
            className="maintenance-secondary-button"
            onClick={() => void loadRegistrations()}
            disabled={loading}
          >
            <Icon name="repeat" size={18} />
            Atualizar lista
          </button>
        }
      />

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {loading ? (
        <Loading label="Carregando solicitações..." />
      ) : registrations.length === 0 ? (
        <section className="ui-card">
          <EmptyState icon="users" title="Nenhum cadastro pendente">
            Quando houver novas solicitações, elas aparecerão aqui.
          </EmptyState>
        </section>
      ) : (
        <section className="ui-card" aria-label="Cadastros pendentes">
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>E-mail</th>
                <th>Setor</th>
                <th>Solicitado em</th>
                <th>Perfil ao aprovar</th>
                {canAssignAnyProfile && <th>Vínculos</th>}
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {registrations.map((registration) => (
                <tr key={registration.id}>
                  <td>{registration.name}</td>
                  <td>{registration.email}</td>
                  <td>
                    {registration.sector}
                    {registration.additional?.map((item) => (
                      <small className="central-subtext" key={item.label}>
                        {item.label}: {item.value}
                      </small>
                    ))}
                  </td>
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
                          <option value="driver">Motorista</option>
                        </>
                      )}
                    </select>
                  </td>
                  {canAssignAnyProfile && (
                    <td>
                      <button
                        type="button"
                        disabled={!options || processingId === registration.id}
                        onClick={() => setEditing(registration)}
                      >
                        Definir vínculos
                      </button>
                      <small className="central-subtext">
                        {describeSetup(setups[registration.id], registration.sector) || 'Nenhum vínculo definido'}
                      </small>
                    </td>
                  )}
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
        </section>
      )}
      {editing && options && (
        <ApprovalSetupDialog
          registration={editing}
          role={selectedRoles[editing.id] ?? 'requester'}
          initial={setups[editing.id] ?? emptySetup(editing.sector)}
          options={options}
          catalog={catalog}
          onClose={() => setEditing(null)}
          onSave={(setup, role) => {
            setSetups((current) => ({ ...current, [editing.id]: setup }))
            setSelectedRoles((current) => ({ ...current, [editing.id]: role }))
          }}
        />
      )}
      {confirmDialog}
    </section>
  )
}

export default PendingRegistrationsPage
