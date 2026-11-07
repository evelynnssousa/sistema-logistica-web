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
      { key: 'fleet:manage', label: 'Administrar o módulo e o cadastro de motoristas' },
      { key: 'fleet:execution_correct', label: 'Corrigir horários de execução das viagens (auditado)' },
    ],
  },
  {
    key: 'driver_portal',
    label: 'Portal do Motorista',
    permissions: [
      { key: 'driver_portal:access', label: 'Usar o Portal do Motorista (exclusiva do perfil Motorista)' },
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
      { key: 'flights:cpf:read', label: 'Consultar o CPF completo dos passageiros (auditado; exige equipe SLM)' },
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
    key: 'email_templates',
    label: 'Modelos de e-mail',
    permissions: [
      { key: 'email_templates:read', label: 'Consultar modelos' },
      { key: 'email_templates:edit', label: 'Editar modelos e salvar rascunhos' },
      { key: 'email_templates:publish', label: 'Publicar modelos' },
    ],
  },
  {
    key: 'forms',
    label: 'Gerenciador de formulários',
    permissions: [
      { key: 'forms:read', label: 'Consultar formulários' },
      { key: 'forms:edit', label: 'Editar formulários e salvar rascunhos' },
      { key: 'forms:publish', label: 'Publicar formulários' },
    ],
  },
  {
    key: 'config_versions',
    label: 'Versões de configuração',
    permissions: [{ key: 'config_versions:restore', label: 'Restaurar versões anteriores de modelos e formulários' }],
  },
  {
    key: 'communications',
    label: 'Central de comunicação',
    permissions: [
      { key: 'communications:read', label: 'Consultar o histórico de e-mails das solicitações que atende' },
      { key: 'communications:send', label: 'Enviar e-mails e anexos pelo sistema' },
    ],
  },
  {
    key: 'warehouse',
    label: 'Almoxarifado',
    permissions: [
      { key: 'warehouse:read', label: 'Acessar o módulo' },
      { key: 'warehouse:manage', label: 'Administrar o módulo (só Administrador e Operador SLM)' },
      { key: 'warehouse:forecast', label: 'Informar e alterar a previsão de entrega (exige equipe SLM)' },
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
  {
    key: 'integrations',
    label: 'Integrações e comunicações',
    permissions: [
      { key: 'integrations:read', label: 'Consultar envios de e-mail e sincronização de agenda' },
      { key: 'integrations:manage', label: 'Reprocessar envios e sincronizações com falha' },
    ],
  },
  {
    key: 'slm_central',
    label: 'Central de Operações da SLM',
    permissions: [
      { key: 'slm_central:read', label: 'Acessar a Central de Operações (exige equipe SLM)' },
      { key: 'slm_central:manage', label: 'Atribuir responsáveis, prioridades e prazos pela Central (exige equipe SLM)' },
    ],
  },
  {
    key: 'monitoring',
    label: 'Monitoramento',
    permissions: [
      { key: 'monitoring:read', label: 'Consultar a saúde dos serviços e os registros técnicos' },
    ],
  },
  {
    key: 'demands',
    label: 'Controle de Demandas',
    permissions: [
      { key: 'demands:directorate', label: 'Diretor: vê, cadastra e edita as demandas de todos os setores, e configura setores, integrantes e categorias' },
      { key: 'demands:configure', label: 'Configurar setores, integrantes e categorias do módulo' },
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
 * Permissões especiais: só valem para quem é elegível, seja qual for a origem. Nenhum
 * perfil concede abertura em nome de outro setor, CPF nem a Central da SLM. Agendar e
 * informar ou alterar a previsão de entrega são atribuições da SLM: o perfil Administrador
 * só as concede a quem integra a equipe SLM (auditoria de 05/11/2026, P-08). A administração
 * do Almoxarifado (warehouse:manage: materiais, estoque, inventário, situação, entrega) é do
 * Administrador, dentro ou fora da SLM, e do Operador SLM com concessão individual; Solicitante
 * e Motorista nunca a recebem, porque ela revela o saldo do estoque. Para os demais elegíveis,
 * tudo depende de concessão individual.
 */
export const restrictedPermissions = [
  'requests:schedule',
  'warehouse:manage',
  'warehouse:forecast',
  'requests:create_on_behalf',
  'flights:cpf:read',
  'slm_central:read',
  'slm_central:manage',
] as const satisfies readonly Permission[]

const restrictedSet = new Set<Permission>(restrictedPermissions)

export function isRestrictedPermission(permission: Permission) {
  return restrictedSet.has(permission)
}

/** Regra central de elegibilidade. Pertencer a um setor nunca conta. */
export function isEligibleForRestrictedPermission(
  permission: Permission,
  role: AuthRole,
  slmMember: boolean,
): boolean {
  const isSlmStaff = (role === 'administrator' || role === 'slm_operator') && slmMember

  if (
    permission === 'requests:create_on_behalf' ||
    permission === 'flights:cpf:read' ||
    permission === 'slm_central:read' ||
    permission === 'slm_central:manage'
  ) {
    return isSlmStaff
  }
  if (permission === 'requests:schedule' || permission === 'warehouse:forecast') {
    return isSlmStaff
  }
  // Fora da SLM, só o Administrador. Solicitante e Motorista nunca, qualquer que seja a origem.
  if (permission === 'warehouse:manage') {
    return role === 'administrator' || isSlmStaff
  }
  return true
}

/**
 * Verificação efetiva de uma permissão: além de constar da identidade, a permissão especial
 * exige perfil elegível. Assim, nenhuma identidade montada por outro caminho (dado gravado
 * diretamente no banco, sessão antiga, rota nova) faz um Solicitante administrar o Almoxarifado.
 */
export function holdsPermission(
  identity: { permissions: readonly Permission[]; role: AuthRole; slmMember: boolean },
  permission: Permission,
): boolean {
  return (
    identity.permissions.includes(permission) &&
    (!isRestrictedPermission(permission) ||
      isEligibleForRestrictedPermission(permission, identity.role, identity.slmMember))
  )
}

/** Um administrador nunca perde estas permissões, nem por retirada gravada no banco. */
export const essentialAdministratorPermissions = [
  'users:read',
  'users:approve',
  'users:manage',
  'audit:read',
  'settings:read',
  'settings:manage',
] as const satisfies readonly Permission[]

const essentialSet = new Set<Permission>(essentialAdministratorPermissions)

export function isEssentialAdministratorPermission(permission: Permission) {
  return essentialSet.has(permission)
}

const profilePermissions: Record<AuthRole, readonly Permission[]> = {
  // Administrar o sistema não dá acesso à Central da SLM: as duas funções são independentes.
  administrator: allPermissions.filter(
    (permission) =>
      permission !== 'flights:cpf:read' &&
      permission !== 'requests:create_on_behalf' &&
      permission !== 'slm_central:read' &&
      permission !== 'slm_central:manage' &&
      permission !== 'driver_portal:access' &&
      // Configurar o Controle de Demandas não dá acesso ao conteúdo das demandas.
      permission !== 'demands:directorate',
  ),
  // maintenance:schedule e fleet:schedule só delimitam os módulos: sem a concessão
  // individual de requests:schedule, não permitem agendar.
  slm_operator: [
    'requests:create',
    'requests:read_own',
    'requests:read_all',
    'requests:update',
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
    'communications:read',
    'communications:send',
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
  // Perfil fechado: só o portal. Ver driverPolicy.ts.
  driver: ['driver_portal:access'],
}

export function permissionsForProfile(role: AuthRole): readonly Permission[] {
  return profilePermissions[role]
}

/**
 * Perfil + concessões − retiradas. A retirada prevalece, exceto sobre as permissões
 * essenciais do administrador, e nenhuma permissão especial passa sem elegibilidade,
 * mesmo que tenha sido gravada diretamente no banco.
 */
export function computeEffectivePermissions(
  role: AuthRole,
  granted: readonly Permission[] = [],
  denied: readonly Permission[] = [],
  slmMember = false,
): Permission[] {
  // O perfil Motorista é exclusivo: concessão ou retirada gravada no banco não muda nada,
  // e a permissão do portal não passa para nenhum outro perfil.
  if (role === 'driver') return [...profilePermissions.driver]
  const refused = new Set<Permission>(
    denied.filter(
      (permission) =>
        role !== 'administrator' || !isEssentialAdministratorPermission(permission),
    ),
  )
  const available = new Set<Permission>([
    ...profilePermissions[role],
    ...granted,
  ])

  return allPermissions.filter(
    (permission) =>
      permission !== 'driver_portal:access' &&
      available.has(permission) &&
      !refused.has(permission) &&
      isEligibleForRestrictedPermission(permission, role, slmMember),
  )
}

/** Valores desconhecidos gravados no banco nunca concedem acesso. */
export function onlyKnownPermissions(value: unknown): Permission[] {
  return Array.isArray(value) ? value.filter(isPermission) : []
}

/**
 * Permissões da estrutura anterior que continuam valendo. CPF e armazém não são
 * convertidos: precisam de nova concessão individual. Ver migração 003.
 */
export function grantsFromLegacyPermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) return []

  const grants = new Set<Permission>()
  for (const permission of value) {
    if (permission === 'settings:read') grants.add('settings:read')
    if (permission === 'settings:write') grants.add('settings:manage')
  }
  return allPermissions.filter((permission) => grants.has(permission))
}
