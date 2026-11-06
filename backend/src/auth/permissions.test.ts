import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  allPermissions,
  computeEffectivePermissions,
  essentialAdministratorPermissions,
  grantsFromLegacyPermissions,
  isEligibleForRestrictedPermission,
  isRestrictedPermission,
  isPermission,
  onlyKnownPermissions,
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

test('o operador SLM atende, sem permissões especiais nem administração', () => {
  const permissions = permissionsForProfile('slm_operator')

  for (const permission of [
    'requests:read_all', 'requests:update', 'requests:create',
    'maintenance:schedule', 'fleet:schedule',
  ] as const) {
    assert.ok(permissions.includes(permission), permission)
  }
  for (const permission of [
    'requests:schedule', 'requests:create_on_behalf', 'flights:cpf:read', 'calendar:manage',
    'warehouse:manage', 'users:read', 'users:manage', 'settings:read', 'settings:manage', 'audit:read',
  ] as const) {
    assert.equal(permissions.includes(permission), false, permission)
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
  assert.equal(isRestrictedPermission('warehouse:manage'), false)
  assert.equal(eligible('warehouse:manage', 'administrator', false), true)
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
  // O Operador SLM só recebe a previsão por concessão individual.
  assert.equal(computeEffectivePermissions('slm_operator', [], [], true).includes('warehouse:forecast'), false)
  assert.ok(computeEffectivePermissions('slm_operator', ['warehouse:forecast'], [], true).includes('warehouse:forecast'))
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
