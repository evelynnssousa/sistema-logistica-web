import { apiRequest } from './apiClient'
import type { AuthenticatedUser } from './auth'

export type UserRole = AuthenticatedUser['role']

export type ManagedUser = {
  id: string
  name: string
  email: string
  sector: string
  status: string
  role: UserRole | null
  slmMember: boolean
  permissions: string[]
  grantedPermissions: string[]
  deniedPermissions: string[]
  createdAt: string
  updatedAt: string
}

export type PermissionCatalog = {
  groups: Array<{
    key: string
    label: string
    permissions: Array<{ key: string; label: string }>
  }>
  profiles: Array<{ key: UserRole; permissions: string[] }>
}

export type AuditEntry = {
  id: string
  occurredAt: string
  action: string
  result: string
  actorName: string | null
  targetName: string | null
  details: Record<string, unknown>
}

export type UserFilters = {
  search: string
  role: string
  status: string
  slm: string
  page: number
}

type Envelope = { success: boolean; message?: string }

export async function listUsers(filters: UserFilters) {
  const query = new URLSearchParams()
  if (filters.search) query.set('search', filters.search)
  if (filters.role) query.set('role', filters.role)
  if (filters.status) query.set('status', filters.status)
  if (filters.slm) query.set('slm', filters.slm)
  query.set('page', String(filters.page))

  return apiRequest<
    Envelope & { users: ManagedUser[]; total: number; page: number; pageSize: number }
  >(`/admin/users?${query}`)
}

export async function getUser(userId: string) {
  const data = await apiRequest<Envelope & { user: ManagedUser }>(
    `/admin/users/${encodeURIComponent(userId)}`,
  )
  return data.user
}

export function getPermissionCatalog() {
  return apiRequest<Envelope & PermissionCatalog>('/admin/permissions')
}

export async function getUserHistory(userId: string) {
  const data = await apiRequest<Envelope & { events: AuditEntry[] }>(
    `/admin/users/${encodeURIComponent(userId)}/history`,
  )
  return data.events
}

export async function updateUserData(
  userId: string,
  input: { name: string; email: string; sector: string },
) {
  const data = await apiRequest<Envelope & { user: ManagedUser }>(
    `/admin/users/${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  )
  return data.user
}

export async function updateUserAccess(
  userId: string,
  input: {
    role: UserRole
    slmMember: boolean
    grantedPermissions: string[]
    deniedPermissions: string[]
  },
) {
  const data = await apiRequest<Envelope & { user: ManagedUser }>(
    `/admin/users/${encodeURIComponent(userId)}/access`,
    { method: 'PUT', body: JSON.stringify(input) },
  )
  return data.user
}

export async function setUserActive(userId: string, isActive: boolean) {
  const data = await apiRequest<Envelope & { user: ManagedUser }>(
    `/admin/users/${encodeURIComponent(userId)}/${isActive ? 'activate' : 'deactivate'}`,
    { method: 'POST' },
  )
  return data.user
}

export function listAuditEvents(page: number) {
  return apiRequest<Envelope & { events: AuditEntry[]; page: number; hasMore: boolean }>(
    `/admin/audit?page=${page}`,
  )
}

export const statusLabels: Record<string, string> = {
  approved: 'Ativa',
  inactive: 'Inativa',
  blocked: 'Bloqueada',
  pending: 'Pendente',
  rejected: 'Rejeitada',
}

export const auditActionLabels: Record<string, string> = {
  'registration.requested': 'Cadastro solicitado',
  'registration.resubmitted': 'Cadastro solicitado novamente',
  'registration.duplicate': 'Cadastro repetido recusado',
  'registration.approve': 'Cadastro aprovado',
  'registration.reject': 'Cadastro rejeitado',
  'user.updated': 'Dados cadastrais alterados',
  'user.role_changed': 'Perfil alterado',
  'user.permissions_changed': 'Permissões individuais alteradas',
  'user.slm_added': 'Incluído na equipe SLM',
  'user.slm_removed': 'Retirado da equipe SLM',
  'user.cpf_access_granted': 'Acesso ao CPF concedido',
  'user.cpf_access_revoked': 'Acesso ao CPF retirado',
  'account.activated': 'Conta ativada',
  'account.inactive': 'Conta desativada',
  'auth.login': 'Entrada no sistema',
  'auth.logout': 'Sessão encerrada',
  'auth.login_failed': 'Tentativa de entrada recusada',
  'auth.login_rate_limited': 'Entrada bloqueada por excesso de tentativas',
  'auth.password_changed': 'Senha alterada',
  'auth.password_recovery_requested': 'Recuperação de senha solicitada',
  'auth.password_recovery_completed': 'Recuperação de senha concluída',
  'auth.password_recovery_failed': 'Código de recuperação incorreto',
  'administrator.bootstrap': 'Administrador inicial criado',
  'administrator.recovered': 'Senha de administrador redefinida por CLI',
  'flights.cpf_read': 'CPF completo consultado',
  'flights.cpf_read_denied': 'Consulta de CPF recusada',
}

const detailLabels: Record<string, string> = {
  grantedAdded: 'Concedidas',
  grantedRemoved: 'Concessões retiradas',
  deniedAdded: 'Retiradas',
  deniedRemoved: 'Retiradas desfeitas',
  from: 'De',
  to: 'Para',
  role: 'Perfil',
  fields: 'Campos',
  reason: 'Motivo',
  operation: 'Operação',
}

export function describeAuditDetails(details: Record<string, unknown>) {
  return Object.entries(details)
    .filter(([key, value]) =>
      key in detailLabels &&
      (Array.isArray(value) ? value.length > 0 : Boolean(value)),
    )
    .map(([key, value]) =>
      `${detailLabels[key]}: ${Array.isArray(value) ? value.join(', ') : String(value)}`,
    )
    .join(' · ')
}
