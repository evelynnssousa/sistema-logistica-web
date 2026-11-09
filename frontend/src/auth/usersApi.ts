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
  revokedPermissions?: string[]
}

export type PermissionKind = 'read' | 'create' | 'update' | 'schedule' | 'manage'

export type PermissionEntry = {
  key: string
  label: string
  kind: PermissionKind
  description: string
  note?: string
}

export const permissionKindLabels: Record<PermissionKind, string> = {
  read: 'Consulta',
  create: 'Criação',
  update: 'Alteração',
  schedule: 'Agendamento',
  manage: 'Administração',
}

export type PermissionCatalog = {
  groups: Array<{
    key: string
    label: string
    permissions: PermissionEntry[]
  }>
  profiles: Array<{ key: UserRole; permissions: string[] }>
  restricted: string[]
  essentialAdministrator: string[]
  eligibility: Array<{ role: UserRole; slmMember: boolean; eligible: string[] }>
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

export function listAuditEvents(
  page: number,
  filters: { action: string; result: string; person: string; from: string; to: string },
) {
  const query = new URLSearchParams({ page: String(page) })
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value)
  }
  return apiRequest<Envelope & { events: AuditEntry[]; page: number; hasMore: boolean }>(
    `/admin/audit?${query}`,
  )
}

export type SectorLink = {
  sectorId: string
  sectorName?: string
  role: 'colaborador' | 'responsavel'
  chefia: boolean
  function: string | null
  canCreate: boolean
  seesSector: boolean
}

export type InstitutionalLinks = {
  directorate: { role: 'diretor'; function: string | null } | null
  sectors: SectorLink[]
}

export type InstitutionalOptions = {
  available: boolean
  lotations: string[]
  sectors: { id: string; name: string; isSlm: boolean }[]
}

export const directorateRoleLabels: Record<NonNullable<InstitutionalLinks['directorate']>['role'], string> = {
  diretor: 'Diretor: vê, cadastra e edita as demandas de todos os setores',
}

export const getInstitutionalOptions = async () =>
  (await apiRequest<Envelope & { options: InstitutionalOptions }>('/admin/registrations/institutional-options')).options

export const getUserInstitutionalLinks = (userId: string) =>
  apiRequest<Envelope & { options: InstitutionalOptions; links: InstitutionalLinks }>(
    `/admin/users/${encodeURIComponent(userId)}/institutional-links`,
  )

export const updateUserInstitutionalLinks = (userId: string, links: InstitutionalLinks) =>
  apiRequest<Envelope & { options: InstitutionalOptions; links: InstitutionalLinks }>(
    `/admin/users/${encodeURIComponent(userId)}/institutional-links`,
    { method: 'PUT', body: JSON.stringify(links) },
  )

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
  'auth.password_recovery_email_sent': 'E-mail de recuperação de senha enviado',
  'auth.password_recovery_email_failed': 'Falha no envio do e-mail de recuperação de senha',
  'config.email_test_sent': 'Teste de modelo de e-mail enviado',
  'config.email_test_failed': 'Falha no envio de teste de modelo de e-mail',
  'email.recipient_blocked': 'E-mail bloqueado: destinatário fora da lista de testes',
  'administrator.bootstrap': 'Administrador inicial criado',
  'administrator.recovered': 'Senha de administrador redefinida por CLI',
  'flights.cpf_read': 'CPF completo consultado',
  'flights.cpf_read_denied': 'Consulta de CPF recusada',
  'flights.passengers_changed': 'Passageiros alterados',
  'auth.sessions_revoked': 'Sessões encerradas',
  'request.created': 'Solicitação criada',
  'request.updated': 'Solicitação alterada',
  'request.scheduled': 'Agendamento realizado',
  'request.rescheduled': 'Reagendamento',
  'request.started': 'Atendimento iniciado',
  'request.completed': 'Atendimento concluído',
  'request.cancelled': 'Solicitação cancelada',
  'request.status_changed': 'Status alterado',
  'request.occurrence': 'Ocorrência registrada',
  'request.assigned': 'Responsável alterado',
  'request.priority_changed': 'Prioridade alterada',
  'request.deadline_changed': 'Prazo alterado',
  'request.complexity_changed': 'Complexidade alterada',
  'request.note_added': 'Observação interna registrada',
  'attachment.uploaded': 'Anexo enviado',
  'attachment.downloaded': 'Anexo baixado',
  'attachment.removed': 'Anexo removido',
  'user.access_reviewed': 'Revisão de acesso registrada',
  'auth.session_revoked': 'Sessão encerrada',
  'fleet.vehicle_changed': 'Veículo alterado',
  'fleet.vehicle_log_added': 'Registro de veículo incluído',
  'maintenance.equipment_changed': 'Equipamento alterado',
  'flights.quote_changed': 'Cotação registrada ou escolhida',
  'warehouse.stock_movement': 'Movimentação de estoque',
  'settings.created': 'Opção de configuração criada',
  'settings.updated': 'Opção de configuração alterada',
  'settings.activated': 'Opção de configuração ativada',
  'settings.deactivated': 'Opção de configuração desativada',
  'warehouse.material_created': 'Material cadastrado',
  'warehouse.material_updated': 'Material alterado',
  'warehouse.request_created': 'Pedido de material registrado',
  'warehouse.request_updated': 'Pedido de material alterado',
  'warehouse.status_changed': 'Situação de pedido alterada',
  'warehouse.delivered': 'Entrega registrada',
  'warehouse.forecast_set': 'Previsão de entrega informada',
  'warehouse.forecast_changed': 'Previsão de entrega alterada',
  'warehouse.inventory_created': 'Conferência criada',
  'warehouse.inventory_item_updated': 'Contagem registrada',
  'warehouse.inventory_closed': 'Conferência encerrada',
  'user.institutional_link_changed': 'Vínculo institucional alterado',
  'demand.created': 'Demanda cadastrada',
  'demand.changed': 'Demanda alterada',
  'fleet.driver_changed': 'Cadastro de motorista alterado',
  'fleet.trip_driver_assigned': 'Motorista de viagem alterado',
  'fleet.execution_corrected': 'Horários de viagem corrigidos',
  'demand.restriction_changed': 'Restrição de demanda alterada',
  'demand.config_changed': 'Configuração do Controle de Demandas alterada',
  'demand.report_exported': 'Relatório de demandas exportado',
  'demand.admin_access': 'Consulta administrativa de demanda restrita',
}

const detailLabels: Record<string, string> = {
  alteracao: 'Alteração',
  demanda: 'Demanda',
  campos: 'Campos alterados',
  grantedAdded: 'Concedidas',
  grantedRemoved: 'Concessões retiradas',
  deniedAdded: 'Retiradas',
  deniedRemoved: 'Retiradas desfeitas',
  from: 'De',
  to: 'Para',
  role: 'Perfil',
  fields: 'Campos',
  automaticallyRevoked: 'Revogadas automaticamente',
  effectiveAdded: 'Acessos ganhos',
  effectiveRemoved: 'Acessos perdidos',
  effectivePermissions: 'Acessos efetivos',
  slmMember: 'Equipe SLM',
  channel: 'Canal',
  template: 'Modelo',
  domains: 'Domínios',
  reason: 'Motivo',
  operation: 'Operação',
  module: 'Módulo',
  protocol: 'Protocolo',
  onBehalfOf: 'Em nome do setor',
  scheduledAt: 'Agendado para',
  category: 'Lista',
  label: 'Opção',
  name: 'Material',
  origin: 'Origem',
  outcome: 'Encerramento',
  total: 'Total',
  type: 'Tipo',
  link: 'Vínculo',
  linkRole: 'Papel',
  item: 'Item',
  action: 'Ação',
}

const reasonLabels: Record<string, string> = {
  slm_removed: 'saída da equipe SLM',
  profile_changed: 'mudança de perfil',
  account_deactivated: 'conta desativada',
  ineligible: 'perfil sem elegibilidade',
}

/** Campos conhecidos, com rótulo. O que não está na lista nunca aparece na tela. */
export function auditDetailEntries(details: Record<string, unknown>) {
  return Object.entries(details)
    .filter(([key, value]) =>
      key in detailLabels &&
      (Array.isArray(value) ? value.length > 0 : Boolean(value)),
    )
    .map(([key, value]) => ({
      key,
      label: detailLabels[key],
      value: Array.isArray(value)
        ? value.join(', ')
        : (key === 'reason' && reasonLabels[String(value)]) ||
          (key === 'slmMember' && (value === 'true' ? 'sim' : 'não')) ||
          String(value),
    }))
}

export function describeAuditDetails(details: Record<string, unknown>) {
  return auditDetailEntries(details)
    .map((entry) => `${entry.label}: ${entry.value}`)
    .join(' · ')
}
