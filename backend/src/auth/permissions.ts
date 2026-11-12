import type { AuthRole } from './roles.js'

/**
 * Natureza de cada permissão, mostrada na tela de usuários: consulta, criação, alteração,
 * agendamento ou administração.
 */
export const permissionKinds = ['read', 'create', 'update', 'schedule', 'manage'] as const

export type PermissionKind = (typeof permissionKinds)[number]

const SLM_ONLY =
  'Atribuição da equipe SLM: só vale para quem integra a equipe SLM, inclusive para o Administrador.'
const UNUSED =
  'Reservada: nenhuma operação do sistema a verifica hoje, então concedê-la ou retirá-la não muda o acesso.'

/**
 * Catálogo das permissões. A chave é a que o servidor verifica e não muda; nome,
 * explicação, natureza e observação existem só para a tela de usuários. As explicações
 * nunca citam chaves técnicas, para que a tela e os testes de navegador localizem cada
 * permissão pela própria chave sem ambiguidade.
 */
export const permissionGroups = [
  {
    key: 'requests',
    label: 'Solicitações (todos os módulos)',
    permissions: [
      {
        key: 'requests:create',
        label: 'Criar solicitações',
        kind: 'create',
        description:
          'Permite registrar novas solicitações para o próprio setor de lotação, nos módulos em que o usuário também pode criar.',
      },
      {
        key: 'requests:create_on_behalf',
        label: 'Abrir solicitações em nome de outros setores',
        kind: 'create',
        description:
          'Permite registrar uma solicitação indicando outro setor como solicitante, por exemplo ao receber um pedido por telefone ou e-mail.',
        note:
          'Só vale para Administrador ou Operador SLM que integre a equipe SLM, e sempre por concessão individual. Pertencer à CPC ou a qualquer outro setor não basta.',
      },
      {
        key: 'requests:read_own',
        label: 'Consultar as próprias solicitações',
        kind: 'read',
        description: 'Permite acompanhar as solicitações abertas pelo próprio usuário.',
      },
      {
        key: 'requests:read_all',
        label: 'Consultar solicitações de todos os setores',
        kind: 'read',
        description:
          'Permite visualizar as solicitações de todos os solicitantes nos módulos que o usuário acessa. É necessária para o atendimento.',
      },
      {
        key: 'requests:update',
        label: 'Atender e atualizar solicitações',
        kind: 'update',
        description:
          'Permite registrar o andamento dos serviços: alterar dados, iniciar, concluir, devolver ao solicitante e registrar ocorrências, nos módulos em que o usuário também pode atualizar.',
      },
      {
        key: 'requests:schedule',
        label: 'Agendar serviços',
        kind: 'schedule',
        description:
          'Permite definir e alterar a data e o horário de execução das solicitações e, na Frota, designar o motorista da viagem. Também exige a permissão de agendamento do módulo.',
        note: SLM_ONLY,
      },
      {
        key: 'requests:cancel',
        label: 'Cancelar solicitações',
        kind: 'update',
        description: 'Permite cancelar as solicitações que o usuário pode consultar.',
      },
      {
        key: 'requests:cancel_own',
        label: 'Cancelar as próprias solicitações antes do atendimento',
        kind: 'update',
        description:
          'Permite cancelar, com motivo, uma solicitação aberta pelo próprio usuário enquanto ela ainda aguarda agendamento (Manutenção e Frota) ou está em cotação (Passagens aéreas). Depois disso, só quem pode cancelar solicitações cancela. Não vem em nenhum perfil: é concedida individualmente.',
      },
      {
        key: 'requests:manage',
        label: 'Administrar solicitações',
        kind: 'manage',
        description: 'Prevista para a administração geral das solicitações.',
        note: UNUSED,
      },
    ],
  },
  {
    key: 'maintenance',
    label: 'Manutenção',
    permissions: [
      {
        key: 'maintenance:read',
        label: 'Acessar o módulo Manutenção',
        kind: 'read',
        description:
          'Permite abrir o módulo. Quais solicitações aparecem depende de consultar as próprias ou as de todos os setores.',
      },
      {
        key: 'maintenance:create',
        label: 'Criar solicitações de Manutenção',
        kind: 'create',
        description: 'Permite registrar solicitações de manutenção, junto com a permissão geral de criar solicitações.',
      },
      {
        key: 'maintenance:update',
        label: 'Atualizar solicitações de Manutenção',
        kind: 'update',
        description:
          'Permite registrar o andamento e as execuções das solicitações de manutenção, junto com a permissão geral de atender e atualizar.',
      },
      {
        key: 'maintenance:schedule',
        label: 'Agendar serviços de Manutenção',
        kind: 'schedule',
        description:
          'Libera o agendamento no módulo Manutenção. Sozinha não permite agendar: exige também a permissão geral de agendar serviços.',
      },
      {
        key: 'maintenance:manage',
        label: 'Administrar o cadastro de equipamentos',
        kind: 'manage',
        description: 'Permite cadastrar e alterar os equipamentos atendidos pela Manutenção.',
      },
    ],
  },
  {
    key: 'fleet',
    label: 'Frota',
    permissions: [
      {
        key: 'fleet:read',
        label: 'Acessar o módulo Frota',
        kind: 'read',
        description:
          'Permite abrir o módulo. Quais solicitações aparecem depende de consultar as próprias ou as de todos os setores.',
      },
      {
        key: 'fleet:create',
        label: 'Criar solicitações de Frota',
        kind: 'create',
        description: 'Permite registrar solicitações de transporte, junto com a permissão geral de criar solicitações.',
      },
      {
        key: 'fleet:update',
        label: 'Atualizar solicitações de Frota',
        kind: 'update',
        description:
          'Permite registrar o andamento e as ocorrências das viagens, junto com a permissão geral de atender e atualizar.',
      },
      {
        key: 'fleet:schedule',
        label: 'Agendar viagens da Frota',
        kind: 'schedule',
        description:
          'Libera o agendamento no módulo Frota e a consulta dos motoristas disponíveis. Para agendar ou designar o motorista, exige também a permissão geral de agendar serviços.',
      },
      {
        key: 'fleet:manage',
        label: 'Administrar veículos e motoristas',
        kind: 'manage',
        description: 'Permite cadastrar e alterar os veículos, seus registros e o cadastro de motoristas.',
      },
      {
        key: 'fleet:execution_correct',
        label: 'Corrigir horários de execução das viagens',
        kind: 'update',
        description: 'Permite corrigir os horários de saída e chegada registrados nas viagens.',
        note: 'Cada correção fica registrada na auditoria.',
      },
    ],
  },
  {
    key: 'driver_portal',
    label: 'Portal do Motorista',
    permissions: [
      {
        key: 'driver_portal:access',
        label: 'Usar o Portal do Motorista',
        kind: 'update',
        description: 'Permite ao motorista consultar as viagens designadas a ele e registrar a execução.',
        note: 'Exclusiva do perfil Motorista: não pode ser concedida a outros perfis.',
      },
    ],
  },
  {
    key: 'flights',
    label: 'Passagens aéreas',
    permissions: [
      {
        key: 'flights:read',
        label: 'Acessar o módulo Passagens aéreas',
        kind: 'read',
        description:
          'Permite abrir o módulo. Quais solicitações aparecem depende de consultar as próprias ou as de todos os setores.',
      },
      {
        key: 'flights:create',
        label: 'Criar solicitações de passagens',
        kind: 'create',
        description: 'Permite registrar solicitações de passagens aéreas, junto com a permissão geral de criar solicitações.',
      },
      {
        key: 'flights:update',
        label: 'Atender solicitações de passagens',
        kind: 'update',
        description:
          'Permite avançar as etapas, alterar passageiros e registrar e escolher cotações, junto com a permissão geral de atender e atualizar.',
      },
      {
        key: 'flights:manage',
        label: 'Administrar o módulo Passagens aéreas',
        kind: 'manage',
        description: 'Prevista para a administração do módulo.',
        note: UNUSED,
      },
      {
        key: 'flights:cpf:read',
        label: 'Consultar o CPF completo dos passageiros',
        kind: 'read',
        description:
          'Permite exibir o CPF sem máscara dos passageiros nas solicitações que o usuário pode consultar. Sem ela, o CPF aparece mascarado.',
        note:
          'Dado pessoal: exige a equipe SLM e concessão individual, inclusive para o Administrador. Nenhum perfil a concede, e cada consulta fica na auditoria.',
      },
    ],
  },
  {
    key: 'settings',
    label: 'Configurações',
    permissions: [
      {
        key: 'settings:read',
        label: 'Consultar configurações',
        kind: 'read',
        description: 'Permite visualizar as listas de opções e os parâmetros do sistema, sem alterá-los.',
      },
      {
        key: 'settings:manage',
        label: 'Alterar configurações',
        kind: 'manage',
        description: 'Permite criar, alterar, ativar e desativar opções e parâmetros do sistema.',
      },
    ],
  },
  {
    key: 'email_templates',
    label: 'Modelos de e-mail',
    permissions: [
      {
        key: 'email_templates:read',
        label: 'Consultar modelos de e-mail',
        kind: 'read',
        description: 'Permite ver os modelos de e-mail usados pelo sistema.',
      },
      {
        key: 'email_templates:edit',
        label: 'Editar modelos de e-mail',
        kind: 'update',
        description: 'Permite alterar modelos e salvar rascunhos, sem colocá-los em uso.',
      },
      {
        key: 'email_templates:publish',
        label: 'Publicar modelos de e-mail',
        kind: 'manage',
        description: 'Permite colocar em uso uma nova versão de um modelo de e-mail.',
      },
    ],
  },
  {
    key: 'forms',
    label: 'Gerenciador de formulários',
    permissions: [
      {
        key: 'forms:read',
        label: 'Consultar formulários',
        kind: 'read',
        description: 'Permite ver a definição dos formulários do sistema.',
      },
      {
        key: 'forms:edit',
        label: 'Editar formulários',
        kind: 'update',
        description: 'Permite alterar formulários e salvar rascunhos, sem colocá-los em uso.',
      },
      {
        key: 'forms:publish',
        label: 'Publicar formulários',
        kind: 'manage',
        description: 'Permite colocar em uso uma nova versão de um formulário.',
      },
    ],
  },
  {
    key: 'config_versions',
    label: 'Versões de configuração',
    permissions: [
      {
        key: 'config_versions:restore',
        label: 'Restaurar versões anteriores',
        kind: 'manage',
        description: 'Permite restaurar uma versão anterior de modelos de e-mail e formulários.',
      },
    ],
  },
  {
    key: 'communications',
    label: 'Central de comunicação',
    permissions: [
      {
        key: 'communications:read',
        label: 'Consultar o histórico de e-mails',
        kind: 'read',
        description: 'Permite ver os e-mails enviados pelo sistema nas solicitações que o usuário atende.',
      },
      {
        key: 'communications:send',
        label: 'Enviar e-mails pelo sistema',
        kind: 'create',
        description: 'Permite redigir e enviar e-mails, com anexos, a partir das solicitações, e reenviar os que falharam.',
      },
    ],
  },
  {
    key: 'warehouse',
    label: 'Almoxarifado',
    permissions: [
      {
        key: 'warehouse:read',
        label: 'Acessar o módulo Almoxarifado',
        kind: 'read',
        description:
          'Permite abrir o módulo, pedir materiais e acompanhar os pedidos. Sozinha não mostra quantidades em estoque nem valores.',
      },
      {
        key: 'warehouse:manage',
        label: 'Gerenciar o Almoxarifado',
        kind: 'manage',
        description:
          'Permite as operações internas: cadastrar materiais, consultar e movimentar o estoque, registrar pedidos externos, alterar itens e situação dos pedidos, registrar entregas e fazer conferências de inventário.',
        note:
          'Revela quantidades e saldos do estoque: só vale para o Administrador e para o Operador SLM da equipe SLM. Solicitante e Motorista nunca a recebem.',
      },
      {
        key: 'warehouse:forecast',
        label: 'Registrar previsão de entrega',
        kind: 'update',
        description:
          'Permite informar e alterar, com justificativa, a data prevista para a disponibilidade ou a entrega dos materiais de um pedido. Exige também a permissão de gerenciar o Almoxarifado.',
        note: SLM_ONLY,
      },
    ],
  },
  {
    key: 'users',
    label: 'Usuários e permissões',
    permissions: [
      {
        key: 'users:read',
        label: 'Consultar usuários',
        kind: 'read',
        description: 'Permite ver a lista de usuários, seus perfis, permissões e histórico de acesso.',
      },
      {
        key: 'users:approve',
        label: 'Aprovar usuários',
        kind: 'manage',
        description: 'Permite aprovar ou rejeitar cadastros de acesso ao sistema.',
        note: 'Sem o perfil Administrador, só aprova cadastros como Solicitante.',
      },
      {
        key: 'users:manage',
        label: 'Gerenciar usuários',
        kind: 'manage',
        description: 'Permite editar dados cadastrais, ativar e desativar contas e encerrar sessões.',
        note:
          'Alterar perfil, equipe SLM e permissões de outras pessoas exige também o perfil Administrador. Ninguém altera o próprio acesso.',
      },
    ],
  },
  {
    key: 'reports',
    label: 'Relatórios, agenda e auditoria',
    permissions: [
      {
        key: 'reports:read',
        label: 'Consultar relatórios',
        kind: 'read',
        description: 'Permite ver os painéis e relatórios operacionais e de desempenho.',
      },
      {
        key: 'calendar:read',
        label: 'Consultar a agenda',
        kind: 'read',
        description: 'Permite ver a agenda dos serviços agendados.',
      },
      {
        key: 'calendar:manage',
        label: 'Administrar a agenda',
        kind: 'manage',
        description: 'Prevista para a administração da agenda.',
        note: UNUSED,
      },
      {
        key: 'audit:read',
        label: 'Consultar a auditoria',
        kind: 'read',
        description: 'Permite ver os registros de auditoria do sistema: quem fez o quê, quando e com qual resultado.',
      },
    ],
  },
  {
    key: 'integrations',
    label: 'Integrações',
    permissions: [
      {
        key: 'integrations:read',
        label: 'Consultar envios e sincronizações',
        kind: 'read',
        description: 'Permite acompanhar a fila de e-mails automáticos e a sincronização da agenda.',
      },
      {
        key: 'integrations:manage',
        label: 'Reprocessar envios e sincronizações',
        kind: 'manage',
        description: 'Permite repetir os envios de e-mail e as sincronizações de agenda que falharam.',
      },
    ],
  },
  {
    key: 'slm_central',
    label: 'Central de Operações da SLM',
    permissions: [
      {
        key: 'slm_central:read',
        label: 'Acessar a Central de Operações',
        kind: 'read',
        description: 'Permite acompanhar, em uma só tela, as solicitações de todos os módulos atendidos pela SLM.',
        note: 'Exige a equipe SLM e concessão individual, inclusive para o Administrador.',
      },
      {
        key: 'slm_central:manage',
        label: 'Distribuir o atendimento pela Central',
        kind: 'update',
        description: 'Permite atribuir responsáveis, prioridades e prazos às solicitações pela Central de Operações.',
        note: 'Exige a equipe SLM e concessão individual, inclusive para o Administrador.',
      },
    ],
  },
  {
    key: 'monitoring',
    label: 'Monitoramento',
    permissions: [
      {
        key: 'monitoring:read',
        label: 'Consultar o monitoramento',
        kind: 'read',
        description: 'Permite ver a saúde dos serviços e os registros técnicos do sistema.',
      },
    ],
  },
  {
    key: 'demands',
    label: 'Controle de Demandas',
    permissions: [
      {
        key: 'demands:directorate',
        label: 'Acesso da Diretoria às demandas',
        kind: 'manage',
        description:
          'Permite ver, cadastrar e editar as demandas de todos os setores e configurar setores, integrantes e categorias do módulo.',
        note:
          'Destinada à Diretoria Administrativa. Nenhum perfil a concede, nem o de Administrador. A chefia de setor vem dos vínculos institucionais, e não desta lista.',
      },
      {
        key: 'demands:configure',
        label: 'Configurar o Controle de Demandas',
        kind: 'manage',
        description: 'Permite configurar setores, integrantes e categorias do módulo, sem dar acesso ao conteúdo das demandas.',
      },
    ],
  },
] as const satisfies readonly {
  key: string
  label: string
  permissions: readonly {
    key: string
    label: string
    kind: PermissionKind
    description: string
    note?: string
  }[]
}[]

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
 * informar ou alterar a previsão de entrega são atribuições da SLM: os perfis Administrador
 * e Operador SLM só as concedem a quem integra a equipe SLM (auditoria de 05/11/2026, P-08).
 * A administração do Almoxarifado (warehouse:manage: materiais, estoque, inventário, situação,
 * entrega) é do Administrador, dentro ou fora da SLM, e do Operador SLM na equipe; Solicitante
 * e Motorista nunca a recebem, porque ela revela o saldo do estoque. Desde 08/11/2026, o perfil
 * Operador SLM inclui agendamento, gestão do Almoxarifado e previsão de entrega, e a equipe SLM
 * continua sendo condição: sem ela, as três não valem. O restante depende de concessão individual.
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
  // Conjunto operacional da SLM. Agendar, gerir o Almoxarifado e registrar a previsão de
  // entrega vêm do perfil, mas só valem com a equipe SLM (isEligibleForRestrictedPermission):
  // um operador fora da equipe, como as contas anteriores à migração 003, não as recebe.
  // maintenance:schedule e fleet:schedule delimitam os módulos do agendamento. Abrir em nome
  // de outro setor, CPF completo e a Central continuam por concessão individual.
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
    'requests:schedule',
    'flights:read',
    'flights:create',
    'flights:update',
    'warehouse:read',
    'warehouse:manage',
    'warehouse:forecast',
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
