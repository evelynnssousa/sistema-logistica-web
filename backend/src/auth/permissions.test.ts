import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  allPermissions,
  computeEffectivePermissions,
  essentialAdministratorPermissions,
  holdsPermission,
  grantsFromLegacyPermissions,
  isEligibleForRestrictedPermission,
  isRestrictedPermission,
  isPermission,
  onlyKnownPermissions,
  permissionGroups,
  permissionKinds,
  permissionsForProfile,
  restrictedPermissions,
} from './permissions.js'
import { authRoles } from './roles.js'

test('o catálogo mantém a granularidade pedida, sem repetições', () => {
  for (const permission of [
    'requests:create', 'requests:read_own', 'requests:read_all', 'requests:update',
    'requests:schedule', 'requests:cancel', 'requests:manage',
    'maintenance:read', 'maintenance:create', 'maintenance:update', 'maintenance:schedule', 'maintenance:manage',
    'fleet:read', 'fleet:create', 'fleet:update', 'fleet:schedule', 'fleet:manage',
    'flights:read', 'flights:create', 'flights:update', 'flights:manage', 'flights:cpf:read',
    'settings:read', 'settings:manage', 'warehouse:read', 'warehouse:manage',
    'users:read', 'users:approve', 'users:manage',
    'reports:read', 'calendar:read', 'calendar:manage',
  ]) {
    assert.ok(isPermission(permission), permission)
  }
  assert.equal(new Set(allPermissions).size, allPermissions.length)
  assert.equal(isPermission('admin:all'), false)
  assert.equal(isPermission(undefined), false)
})

test('nenhum perfil recebe o CPF completo, nem o de administrador', () => {
  for (const role of authRoles) {
    assert.equal(permissionsForProfile(role).includes('flights:cpf:read'), false, role)
  }
})

test('o solicitante não recebe privilégios por padrão', () => {
  const permissions = permissionsForProfile('requester')

  for (const permission of [
    'requests:read_all', 'requests:update', 'requests:schedule',
    'requests:create_on_behalf', 'users:read', 'users:approve', 'users:manage',
    'settings:read', 'audit:read', 'reports:read',
  ] as const) {
    assert.equal(permissions.includes(permission), false, permission)
  }
})

/** Conjunto operacional que o perfil Operador SLM concede a quem integra a equipe SLM. */
const slmOperationalDefaults = ['requests:schedule', 'warehouse:manage', 'warehouse:forecast'] as const

/** Administração do sistema e acessos que dependem de concessão individual. */
const outsideOperatorProfile = [
  'requests:create_on_behalf', 'flights:cpf:read', 'slm_central:read', 'slm_central:manage',
  'users:read', 'users:approve', 'users:manage', 'settings:read', 'settings:manage', 'audit:read',
  'maintenance:manage', 'fleet:manage', 'fleet:execution_correct', 'calendar:manage',
  'integrations:read', 'integrations:manage', 'monitoring:read', 'demands:directorate', 'demands:configure',
  'email_templates:edit', 'email_templates:publish', 'forms:edit', 'forms:publish', 'config_versions:restore',
  'driver_portal:access',
] as const

test('o operador SLM recebe o conjunto operacional da SLM, sem administração nem acessos individuais', () => {
  const permissions = permissionsForProfile('slm_operator')

  for (const permission of [
    'requests:create', 'requests:read_own', 'requests:read_all', 'requests:update', 'requests:cancel',
    'maintenance:read', 'maintenance:create', 'maintenance:update', 'maintenance:schedule',
    'fleet:read', 'fleet:create', 'fleet:update', 'fleet:schedule',
    'flights:read', 'flights:create', 'flights:update',
    'warehouse:read', 'reports:read', 'calendar:read', 'communications:read', 'communications:send',
    ...slmOperationalDefaults,
  ] as const) {
    assert.ok(permissions.includes(permission), permission)
  }
  for (const permission of outsideOperatorProfile) {
    assert.equal(permissions.includes(permission), false, permission)
  }
})

test('operador SLM na equipe agenda Manutenção e Frota e opera o Almoxarifado sem concessão manual', () => {
  const effective = computeEffectivePermissions('slm_operator', [], [], true)
  for (const permission of [
    ...slmOperationalDefaults, 'maintenance:schedule', 'fleet:schedule', 'warehouse:read',
  ] as const) {
    assert.ok(effective.includes(permission), permission)
  }
  const identity = { role: 'slm_operator' as const, slmMember: true, permissions: effective }
  for (const permission of slmOperationalDefaults) {
    assert.ok(holdsPermission(identity, permission), permission)
  }
  // Administração do sistema e acessos individuais continuam fora.
  for (const permission of outsideOperatorProfile) {
    assert.equal(effective.includes(permission), false, permission)
  }
})

test('operador fora da equipe SLM não recebe o conjunto operacional, nem pelo perfil nem por concessão', () => {
  // Caso real: contas antigas, anteriores à migração 003, têm perfil de operador sem equipe.
  const outside = computeEffectivePermissions('slm_operator', [], [], false)
  const forcedGrant = computeEffectivePermissions('slm_operator', [...slmOperationalDefaults], [], false)
  for (const permission of slmOperationalDefaults) {
    assert.equal(outside.includes(permission), false, permission)
    assert.equal(forcedGrant.includes(permission), false, `${permission}, concessão gravada`)
    // Identidade montada por outro caminho também não passa.
    assert.equal(
      holdsPermission({ role: 'slm_operator', slmMember: false, permissions: [permission] }, permission),
      false,
      `${permission}, identidade forjada`,
    )
  }
  // O restante do atendimento continua com o perfil.
  for (const permission of ['requests:read_all', 'requests:update', 'warehouse:read', 'maintenance:schedule'] as const) {
    assert.ok(outside.includes(permission), permission)
  }
})

test('incluir e retirar a equipe SLM liga e desliga o conjunto operacional, sem resíduo', () => {
  const before = computeEffectivePermissions('slm_operator', [], [], false)
  const joined = computeEffectivePermissions('slm_operator', [], [], true)
  // Ao sair da equipe, o perfil passa a Solicitante (regra do servidor), e nada fica.
  const left = computeEffectivePermissions('requester', [], [], false)
  for (const permission of slmOperationalDefaults) {
    assert.equal(before.includes(permission), false, permission)
    assert.ok(joined.includes(permission), permission)
    assert.equal(left.includes(permission), false, permission)
  }
  for (const permission of ['requests:read_all', 'requests:update', 'communications:send'] as const) {
    assert.equal(left.includes(permission), false, permission)
  }
})

test('a retirada individual prevalece sobre o conjunto operacional do perfil', () => {
  const effective = computeEffectivePermissions('slm_operator', [], ['warehouse:manage', 'requests:schedule'], true)
  assert.equal(effective.includes('warehouse:manage'), false)
  assert.equal(effective.includes('requests:schedule'), false)
  assert.ok(effective.includes('warehouse:forecast'), 'a previsão segue o perfil')
})

test('mudar o perfil não apaga concessões individuais legítimas', () => {
  const granted = ['reports:read', 'integrations:read'] as const
  const asOperator = computeEffectivePermissions('slm_operator', granted, [], true)
  const asAdministrator = computeEffectivePermissions('administrator', granted, [], true)
  const asRequester = computeEffectivePermissions('requester', granted, [], false)
  for (const permission of granted) {
    assert.ok(asOperator.includes(permission), permission)
    assert.ok(asAdministrator.includes(permission), permission)
    assert.ok(asRequester.includes(permission), permission)
  }
})

test('administrador fora da SLM não recebe atribuições operacionais exclusivas da SLM', () => {
  const outside = computeEffectivePermissions('administrator', [], [], false)
  for (const permission of ['requests:schedule', 'warehouse:forecast', 'requests:create_on_behalf', 'flights:cpf:read', 'slm_central:read', 'slm_central:manage'] as const) {
    assert.equal(outside.includes(permission), false, permission)
  }
  // E o operador SLM não recebe a administração do sistema.
  const operator = computeEffectivePermissions('slm_operator', [], [], true)
  for (const permission of essentialAdministratorPermissions) {
    assert.equal(operator.includes(permission), false, permission)
    assert.ok(outside.includes(permission), permission)
  }
})

test('o administrador agenda pelo perfil, sem CPF e sem abrir em nome de outro setor', () => {
  const permissions = permissionsForProfile('administrator')

  assert.ok(permissions.includes('requests:schedule'))
  assert.equal(permissions.includes('flights:cpf:read'), false)
  assert.equal(permissions.includes('requests:create_on_behalf'), false)
})

test('a elegibilidade segue a matriz, e a equipe só vale para os perfis previstos', () => {
  const eligible = isEligibleForRestrictedPermission

  // P-08: administrador fora da SLM não agenda nem administra o Almoxarifado.
  assert.equal(eligible('requests:schedule', 'administrator', false), false)
  assert.equal(eligible('requests:schedule', 'administrator', true), true)
  assert.equal(eligible('requests:schedule', 'slm_operator', true), true)
  // Previsão de entrega: permissão própria, só da SLM. Administrar o Almoxarifado não é restrito.
  assert.equal(eligible('warehouse:forecast', 'administrator', false), false)
  assert.equal(eligible('warehouse:forecast', 'administrator', true), true)
  assert.equal(eligible('warehouse:forecast', 'slm_operator', true), true)
  assert.equal(eligible('warehouse:forecast', 'slm_operator', false), false)
  assert.equal(eligible('warehouse:forecast', 'requester', true), false)
  // Administrar o Almoxarifado: Administrador dentro ou fora da SLM e Operador SLM; nunca
  // Solicitante nem Motorista, mesmo marcados como SLM.
  assert.equal(isRestrictedPermission('warehouse:manage'), true)
  assert.equal(eligible('warehouse:manage', 'administrator', false), true)
  assert.equal(eligible('warehouse:manage', 'administrator', true), true)
  assert.equal(eligible('warehouse:manage', 'slm_operator', true), true)
  assert.equal(eligible('warehouse:manage', 'slm_operator', false), false)
  assert.equal(eligible('warehouse:manage', 'requester', false), false)
  assert.equal(eligible('warehouse:manage', 'requester', true), false)
  assert.equal(eligible('warehouse:manage', 'driver', false), false)
  assert.equal(eligible('warehouse:manage', 'driver', true), false)
  assert.equal(eligible('requests:schedule', 'slm_operator', false), false)
  assert.equal(eligible('requests:schedule', 'requester', true), false)

  assert.equal(eligible('requests:create_on_behalf', 'administrator', false), false)
  assert.equal(eligible('requests:create_on_behalf', 'administrator', true), true)
  assert.equal(eligible('requests:create_on_behalf', 'slm_operator', true), true)
  assert.equal(eligible('requests:create_on_behalf', 'requester', true), false)

  assert.equal(eligible('flights:cpf:read', 'administrator', true), true)
  assert.equal(eligible('flights:cpf:read', 'administrator', false), false)
  assert.equal(eligible('flights:cpf:read', 'slm_operator', true), true)
  assert.equal(eligible('flights:cpf:read', 'slm_operator', false), false)
  assert.equal(eligible('flights:cpf:read', 'requester', false), false)
  assert.equal(eligible('reports:read', 'requester', false), true)
})

test('administrador fora da SLM administra o Almoxarifado, mas não agenda nem altera previsão', () => {
  const outside = computeEffectivePermissions('administrator', [], [], false)
  const inside = computeEffectivePermissions('administrator', [], [], true)
  // Só agendar e previsão de entrega são da SLM (P-08).
  for (const permission of ['requests:schedule', 'warehouse:forecast'] as const) {
    assert.equal(outside.includes(permission), false, `${permission}, fora da SLM`)
    assert.equal(inside.includes(permission), true, `${permission}, na equipe SLM`)
  }
  // Concessão gravada direto no banco também não vale fora da equipe.
  assert.equal(
    computeEffectivePermissions('administrator', ['requests:schedule', 'warehouse:forecast'], [], false)
      .some((permission) => permission === 'requests:schedule' || permission === 'warehouse:forecast'),
    false,
  )
  // Administração do Almoxarifado e do sistema continuam com o perfil, dentro ou fora da SLM.
  for (const permission of ['warehouse:manage', 'warehouse:read', 'reports:read', 'users:manage', 'settings:manage', 'audit:read'] as const) {
    assert.ok(outside.includes(permission), `${permission}, fora da SLM`)
    assert.ok(inside.includes(permission), `${permission}, na equipe SLM`)
  }
})

test('usuário comum não recebe administração do Almoxarifado nem previsão', () => {
  const requester = computeEffectivePermissions('requester', [], [], false)
  assert.equal(requester.includes('warehouse:manage'), false)
  assert.equal(requester.includes('warehouse:forecast'), false)
  assert.equal(requester.includes('requests:schedule'), false)
  // Concessão de previsão a quem não é da SLM não vale, nem marcada como SLM.
  assert.equal(computeEffectivePermissions('requester', ['warehouse:forecast'], [], true).includes('warehouse:forecast'), false)
  // O Operador SLM recebe a previsão pelo perfil, mas só na equipe SLM.
  assert.ok(computeEffectivePermissions('slm_operator', [], [], true).includes('warehouse:forecast'))
  assert.equal(computeEffectivePermissions('slm_operator', [], [], false).includes('warehouse:forecast'), false)
})

test('concessão gravada sem elegibilidade não vale, seja qual for a origem', () => {
  for (const permission of restrictedPermissions) {
    assert.equal(
      computeEffectivePermissions('requester', [permission], [], false).includes(permission),
      false,
      permission,
    )
    assert.equal(
      computeEffectivePermissions('requester', [permission], [], true).includes(permission),
      false,
      `${permission}, solicitante marcado como SLM`,
    )
    assert.equal(
      computeEffectivePermissions('slm_operator', [permission], [], false).includes(permission),
      false,
      `${permission}, operador fora da equipe`,
    )
    assert.ok(
      computeEffectivePermissions('slm_operator', [permission], [], true).includes(permission),
      `${permission}, operador elegível`,
    )
    assert.ok(
      computeEffectivePermissions('administrator', [permission], [], true).includes(permission),
      `${permission}, administrador na equipe`,
    )
  }
})

test('CPF gravado para administrador fora da equipe não vale', () => {
  assert.equal(
    computeEffectivePermissions('administrator', ['flights:cpf:read'], [], false)
      .includes('flights:cpf:read'),
    false,
  )
})

test('o administrador não perde as permissões essenciais, mesmo com retirada gravada', () => {
  assert.deepEqual([...essentialAdministratorPermissions], [
    'users:read', 'users:approve', 'users:manage', 'audit:read', 'settings:read', 'settings:manage',
  ])

  const effective = computeEffectivePermissions(
    'administrator',
    [],
    [...essentialAdministratorPermissions, 'reports:read', 'requests:schedule'],
  )
  for (const permission of essentialAdministratorPermissions) {
    assert.ok(effective.includes(permission), permission)
  }
  assert.equal(effective.includes('reports:read'), false)
  assert.equal(effective.includes('requests:schedule'), false, 'o agendamento pode ser retirado')

  // A proteção vale só para administradores.
  const operator = computeEffectivePermissions('requester', ['users:read'], ['users:read'])
  assert.equal(operator.includes('users:read'), false)
})

test('concessão soma ao perfil, sem promover, e a retirada prevalece', () => {
  const granted = computeEffectivePermissions('requester', ['reports:read'])
  assert.ok(granted.includes('reports:read'))
  assert.equal(granted.includes('users:manage'), false)

  const denied = computeEffectivePermissions('slm_operator', [], ['requests:update'], true)
  assert.equal(denied.includes('requests:update'), false)
  assert.ok(denied.includes('requests:read_all'))

  assert.equal(
    computeEffectivePermissions('requester', ['reports:read'], ['reports:read'])
      .includes('reports:read'),
    false,
  )
})

test('valores desconhecidos gravados no banco não concedem nada', () => {
  assert.deepEqual(onlyKnownPermissions(['users:manage', 'superusuario', 1]), ['users:manage'])
  assert.deepEqual(onlyKnownPermissions(null), [])
})

test('das permissões antigas, só configurações são convertidas: CPF e armazém não', () => {
  assert.deepEqual(
    grantsFromLegacyPermissions([
      'maintenance:write', 'flights:cpf:read', 'warehouse:write', 'settings:write',
    ]),
    ['settings:manage'],
  )
  assert.deepEqual(grantsFromLegacyPermissions(null), [])
})

test('Solicitante e Motorista nunca administram o Almoxarifado, nem por dado gravado no banco', () => {
  for (const slmMember of [false, true]) {
    assert.equal(
      computeEffectivePermissions('requester', ['warehouse:manage'], [], slmMember).includes('warehouse:manage'),
      false,
      `solicitante, slmMember=${slmMember}`,
    )
    assert.equal(
      computeEffectivePermissions('driver', ['warehouse:manage'], [], slmMember).includes('warehouse:manage'),
      false,
      `motorista, slmMember=${slmMember}`,
    )
  }
  // Operador SLM: pelo perfil, e só na equipe.
  assert.ok(computeEffectivePermissions('slm_operator', [], [], true).includes('warehouse:manage'))
  assert.equal(computeEffectivePermissions('slm_operator', [], [], false).includes('warehouse:manage'), false)
  assert.equal(computeEffectivePermissions('slm_operator', ['warehouse:manage'], [], false).includes('warehouse:manage'), false)
})

test('a verificação efetiva recusa identidade montada com warehouse:manage sem elegibilidade', () => {
  const forged = (role: 'requester' | 'driver' | 'slm_operator' | 'administrator', slmMember: boolean) => ({
    role,
    slmMember,
    permissions: ['warehouse:read', 'warehouse:manage', 'warehouse:forecast'] as const,
  })
  assert.equal(holdsPermission(forged('requester', false), 'warehouse:manage'), false)
  assert.equal(holdsPermission(forged('requester', true), 'warehouse:manage'), false)
  assert.equal(holdsPermission(forged('driver', true), 'warehouse:manage'), false)
  assert.equal(holdsPermission(forged('slm_operator', false), 'warehouse:manage'), false)
  assert.ok(holdsPermission(forged('slm_operator', true), 'warehouse:manage'))
  assert.ok(holdsPermission(forged('administrator', false), 'warehouse:manage'))
  // A previsão continua só da SLM, mesmo para o Administrador.
  assert.equal(holdsPermission(forged('administrator', false), 'warehouse:forecast'), false)
  assert.ok(holdsPermission(forged('administrator', true), 'warehouse:forecast'))
  // Permissão comum segue só a identidade.
  assert.ok(holdsPermission(forged('requester', false), 'warehouse:read'))
})

test('toda permissão tem nome, explicação, natureza e grupo, sem chaves técnicas no texto', () => {
  const keyPattern = /\b[a-z_]+:[a-z_]+(?::[a-z_]+)?\b/
  const seen = new Set<string>()
  for (const group of permissionGroups) {
    assert.ok(group.label.trim(), group.key)
    for (const permission of group.permissions) {
      seen.add(permission.key)
      assert.ok(permission.label.trim().length > 3, permission.key)
      assert.ok(permission.description.trim().length > 20, `${permission.key}: explicação`)
      assert.ok(permissionKinds.includes(permission.kind), `${permission.key}: natureza`)
      const texts = [permission.label, permission.description, 'note' in permission ? permission.note : '']
      for (const text of texts) {
        assert.equal(keyPattern.test(text), false, `${permission.key}: o texto não cita chaves técnicas`)
      }
    }
  }
  assert.deepEqual([...seen].sort(), [...allPermissions].sort())
})

test('as permissões especiais e as atribuições da SLM explicam a restrição na própria tela', () => {
  const entries = new Map<string, { note?: string; kind: string }>(
    permissionGroups.flatMap((group) => group.permissions.map((permission) => [permission.key, permission] as const)),
  )
  for (const permission of restrictedPermissions) {
    assert.ok(entries.get(permission)?.note, `${permission}: observação de restrição`)
  }
  assert.match(entries.get('requests:schedule')?.note ?? '', /equipe SLM/)
  assert.match(entries.get('warehouse:forecast')?.note ?? '', /equipe SLM/)
  assert.match(entries.get('flights:cpf:read')?.note ?? '', /concessão individual/)
  assert.equal(entries.get('requests:schedule')?.kind, 'schedule')
  assert.equal(entries.get('warehouse:manage')?.kind, 'manage')
  assert.equal(entries.get('users:approve')?.kind, 'manage')
})
