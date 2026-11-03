import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveAccess } from './accessSchema.js'
import type { AccessRow } from './accessSchema.js'

const legacy: AccessRow = {
  role: 'operator',
  permissions: [],
  access_profile: null,
  access_slm_member: null,
  access_granted: null,
  access_denied: null,
}

test('sem a tabela nova, o acesso vem das colunas antigas', () => {
  const admin = resolveAccess({ ...legacy, role: 'admin' })
  assert.equal(admin?.role, 'administrator')
  assert.ok(admin?.permissions.includes('users:manage'))
  assert.equal(admin?.permissions.includes('flights:cpf:read'), false)

  const operator = resolveAccess({ ...legacy, permissions: ['maintenance:write'] })
  assert.equal(operator?.role, 'slm_operator')
  assert.equal(operator?.slmMember, true)

  const requester = resolveAccess({ ...legacy, permissions: ['maintenance:read'] })
  assert.equal(requester?.role, 'requester')
  assert.equal(requester?.slmMember, false)
})

test('uma permissão de CPF antiga continua valendo, sem promover a conta', () => {
  const access = resolveAccess({ ...legacy, permissions: ['flights:cpf:read'] })

  assert.equal(access?.role, 'requester')
  assert.ok(access?.permissions.includes('flights:cpf:read'))
})

test('a linha nova prevalece sobre as colunas antigas', () => {
  const access = resolveAccess({
    role: 'operator',
    permissions: ['flights:cpf:read', 'maintenance:write'],
    access_profile: 'requester',
    access_slm_member: false,
    access_granted: ['reports:read'],
    access_denied: ['fleet:read'],
  })

  assert.equal(access?.role, 'requester')
  assert.equal(access?.slmMember, false)
  assert.ok(access?.permissions.includes('reports:read'))
  assert.equal(access?.permissions.includes('fleet:read'), false)
  assert.equal(access?.permissions.includes('flights:cpf:read'), false)
})

test('valores inválidos não concedem acesso', () => {
  assert.equal(resolveAccess({ ...legacy, access_profile: 'superusuario' }), null)
  assert.equal(resolveAccess({ ...legacy, role: 'outro' }), null)
  assert.equal(resolveAccess({ ...legacy, role: null }), null)

  const access = resolveAccess({
    ...legacy,
    access_profile: 'requester',
    access_slm_member: false,
    access_granted: ['nao-existe'],
    access_denied: [],
  })
  assert.deepEqual(access?.grantedPermissions, [])
})
