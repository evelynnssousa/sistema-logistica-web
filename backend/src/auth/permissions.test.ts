import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  allPermissions,
  computeEffectivePermissions,
  grantsFromLegacyPermissions,
  isPermission,
  onlyKnownPermissions,
  permissionsForProfile,
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

test('o operador SLM atende, mas não administra usuários nem configurações', () => {
  const permissions = permissionsForProfile('slm_operator')

  for (const permission of [
    'requests:read_all', 'requests:update', 'requests:schedule', 'requests:create_on_behalf',
  ] as const) {
    assert.ok(permissions.includes(permission), permission)
  }
  for (const permission of ['users:read', 'users:manage', 'settings:manage', 'audit:read'] as const) {
    assert.equal(permissions.includes(permission), false, permission)
  }
})

test('concessão soma ao perfil, sem promover, e a retirada prevalece', () => {
  const granted = computeEffectivePermissions('requester', ['reports:read'])
  assert.ok(granted.includes('reports:read'))
  assert.equal(granted.includes('users:manage'), false)

  const denied = computeEffectivePermissions('slm_operator', [], ['requests:schedule'])
  assert.equal(denied.includes('requests:schedule'), false)
  assert.ok(denied.includes('requests:update'))

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

test('converte as permissões antigas que não vêm do perfil', () => {
  assert.deepEqual(
    grantsFromLegacyPermissions(['maintenance:write', 'flights:cpf:read', 'settings:write']),
    ['flights:cpf:read', 'settings:manage'],
  )
  assert.deepEqual(grantsFromLegacyPermissions(null), [])
})
