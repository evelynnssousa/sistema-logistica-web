import test from 'node:test'
import assert from 'node:assert/strict'
import {
  authRoles,
  isAuthRole,
  normalizeAuthRole,
} from './roles.js'
import { resolveDatabaseAuthRole } from './roles.js'

test('mapeia o perfil admin do banco para administrator', () => {
  assert.equal(normalizeAuthRole('admin'), 'administrator')
})

test('mapeia o perfil operator do banco para slm_operator', () => {
  assert.equal(normalizeAuthRole('operator'), 'slm_operator')
})

test('reconhece os perfis internos já utilizados pelo sistema', () => {
  assert.equal(normalizeAuthRole('administrator'), 'administrator')
  assert.equal(normalizeAuthRole('slm_operator'), 'slm_operator')
  assert.equal(normalizeAuthRole('requester'), 'requester')
})

test('rejeita perfis desconhecidos ou valores inválidos', () => {
  assert.equal(normalizeAuthRole('unknown'), null)
  assert.equal(normalizeAuthRole(null), null)
  assert.equal(normalizeAuthRole(undefined), null)
})

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
