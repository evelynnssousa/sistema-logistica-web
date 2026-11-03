import type { AuthRole } from './roles.js'

export const permissionGroups = [
  {
    key: 'requests',
    label: 'Solicitações',
    permissions: [
      { key: 'requests:create', label: 'Criar solicitações para o próprio setor' },
      { key: 'requests:create_on_behalf', label: 'Abrir solicitações em nome de outros setores (exige equipe SLM)' },
      { key: 'requests:read_own', label: 'Consultar as próprias solicitações' },
      { key: 'requests:read_all', label: 'Consultar solicitações de todos os setores' },
      { key: 'requests:update', label: 'Atender e atualizar solicitações' },
      { key: 'requests:schedule', label: 'Realizar agendamentos' },
      { key: 'requests:cancel', label: 'Cancelar solicitações' },
      { key: 'requests:manage', label: 'Administrar solicitações' },
    ],
  },
  {
    key: 'maintenance',
    label: 'Manutenção',
    permissions: [
      { key: 'maintenance:read', label: 'Acessar o módulo' },
      { key: 'maintenance:create', label: 'Criar solicitações' },
      { key: 'maintenance:update', label: 'Atualizar solicitações' },
      { key: 'maintenance:schedule', label: 'Agendar serviços' },
      { key: 'maintenance:manage', label: 'Administrar o módulo' },
    ],
  },
  {
    key: 'fleet',
    label: 'Frota',
    permissions: [
      { key: 'fleet:read', label: 'Acessar o módulo' },
      { key: 'fleet:create', label: 'Criar solicitações' },
      { key: 'fleet:update', label: 'Atualizar solicitações' },
      { key: 'fleet:schedule', label: 'Agendar serviços' },
      { key: 'fleet:manage', label: 'Administrar o módulo' },
    ],
  },
  {
    key: 'flights',
    label: 'Passagens aéreas',
    permissions: [
      { key: 'flights:read', label: 'Acessar o módulo' },
      { key: 'flights:create', label: 'Criar solicitações' },
      { key: 'flights:update', label: 'Atualizar solicitações' },
      { key: 'flights:manage', label: 'Administrar o módulo' },
      { key: 'flights:cpf:read', label: 'Consultar o CPF completo dos passageiros (auditado)' },
    ],
  },
  {
    key: 'settings',
    label: 'Configurações',
    permissions: [
      { key: 'settings:read', label: 'Consultar configurações' },
      { key: 'settings:manage', label: 'Alterar configurações' },
    ],
  },
  {
    key: 'warehouse',
    label: 'Almoxarifado',
    permissions: [
      { key: 'warehouse:read', label: 'Acessar o módulo' },
      { key: 'warehouse:manage', label: 'Administrar o módulo' },
    ],
  },
  {
    key: 'users',
    label: 'Usuários',
    permissions: [
      { key: 'users:read', label: 'Consultar usuários' },
      { key: 'users:approve', label: 'Aprovar e rejeitar cadastros' },
      { key: 'users:manage', label: 'Editar dados e ativar ou desativar contas' },
    ],
  },
  {
    key: 'reports',
    label: 'Relatórios, agenda e auditoria',
    permissions: [
      { key: 'reports:read', label: 'Consultar relatórios' },
      { key: 'calendar:read', label: 'Consultar a agenda' },
      { key: 'calendar:manage', label: 'Administrar a agenda' },
      { key: 'audit:read', label: 'Consultar registros de auditoria' },
    ],
  },
] as const

export type Permission =
  (typeof permissionGroups)[number]['permissions'][number]['key']

export const allPermissions: readonly Permission[] = permissionGroups.flatMap(
  (group) => group.permissions.map((permission) => permission.key),
)

const knownPermissions = new Set<string>(allPermissions)

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && knownPermissions.has(value)
}

/**
 * Nenhum perfil recebe flights:cpf:read, nem o de administrador: o acesso ao CPF
 * completo precisa ser sempre concedido de forma individual e explícita.
 */
const profilePermissions: Record<AuthRole, readonly Permission[]> = {
  administrator: allPermissions.filter(
    (permission) => permission !== 'flights:cpf:read',
  ),
  slm_operator: [
    'requests:create',
    'requests:create_on_behalf',
    'requests:read_own',
    'requests:read_all',
    'requests:update',
    'requests:schedule',
    'requests:cancel',
    'maintenance:read',
    'maintenance:create',
    'maintenance:update',
    'maintenance:schedule',
    'fleet:read',
    'fleet:create',
    'fleet:update',
    'fleet:schedule',
    'flights:read',
    'flights:create',
    'flights:update',
    'warehouse:read',
    'reports:read',
    'calendar:read',
    'calendar:manage',
  ],
  // "read" dá acesso à tela do módulo; ver dados de terceiros exige requests:read_all.
  requester: [
    'requests:create',
    'requests:read_own',
    'maintenance:read',
    'maintenance:create',
    'fleet:read',
    'fleet:create',
    'flights:read',
    'flights:create',
    'warehouse:read',
  ],
}

export function permissionsForProfile(role: AuthRole): readonly Permission[] {
  return profilePermissions[role]
}

/** A retirada individual sempre prevalece sobre o perfil e sobre as concessões. */
export function computeEffectivePermissions(
  role: AuthRole,
  granted: readonly Permission[] = [],
  denied: readonly Permission[] = [],
): Permission[] {
  const refused = new Set<Permission>(denied)
  const available = new Set<Permission>([
    ...profilePermissions[role],
    ...granted,
  ])

  return allPermissions.filter(
    (permission) => available.has(permission) && !refused.has(permission),
  )
}

/** Valores desconhecidos gravados no banco nunca concedem acesso. */
export function onlyKnownPermissions(value: unknown): Permission[] {
  return Array.isArray(value) ? value.filter(isPermission) : []
}

/** Permissões da estrutura anterior que não vêm dos perfis. Ver migração 003. */
export function grantsFromLegacyPermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) return []

  const grants = new Set<Permission>()
  for (const permission of value) {
    if (permission === 'flights:cpf:read') grants.add('flights:cpf:read')
    if (permission === 'settings:read') grants.add('settings:read')
    if (permission === 'settings:write') grants.add('settings:manage')
    if (permission === 'warehouse:write') grants.add('warehouse:manage')
  }
  return allPermissions.filter((permission) => grants.has(permission))
}
