import test from 'node:test'
import assert from 'node:assert/strict'
import {
  authRoles,
  databaseRoleFor,
  isAuthRole,
  resolveDatabaseAuthRole,
} from './roles.js'

test('valida apenas os perfis internos definidos', () => {
  assert.deepEqual(authRoles, [
    'administrator',
    'slm_operator',
    'requester',
  ])
  assert.equal(isAuthRole('administrator'), true)
  assert.equal(isAuthRole('requester'), true)
  assert.equal(isAuthRole('admin'), false)
  assert.equal(isAuthRole('operator'), false)
})

test('mapeia admin para administrator', () => {
  assert.equal(
    resolveDatabaseAuthRole('admin', []),
    'administrator',
  )
})

test('mapeia operator com permissão de escrita para slm_operator', () => {
  assert.equal(
    resolveDatabaseAuthRole('operator', ['maintenance:write']),
    'slm_operator',
  )
})

test('mapeia operator sem permissões de escrita para requester', () => {
  assert.equal(
    resolveDatabaseAuthRole('operator', ['maintenance:read']),
    'requester',
  )
})

test('rejeita perfis desconhecidos e permissões inválidas', () => {
  assert.equal(resolveDatabaseAuthRole('unknown', []), null)
  assert.equal(resolveDatabaseAuthRole('operator', null), null)
  assert.equal(
    resolveDatabaseAuthRole('operator', ['invalid']),
    null,
  )
})

test('cada perfil interno é gravado de forma que volte ao mesmo perfil', () => {
  for (const role of authRoles) {
    const stored = databaseRoleFor(role)
    assert.equal(resolveDatabaseAuthRole(stored.role, stored.permissions), role)
  }
})

test('nenhum perfil recebe acesso ao CPF completo por padrão', () => {
  for (const role of authRoles) {
    assert.equal(databaseRoleFor(role).permissions.includes('flights:cpf:read'), false)
  }
})
