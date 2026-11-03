import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeEffectivePermissions } from './permissions.js'
import type { Permission } from './permissions.js'
import {
  canActOnBehalfOfOtherSectors,
  canCancelRequest,
  canCreateRequest,
  canReadFullCpf,
  canReadRequest,
  canScheduleRequest,
  canUpdateRequest,
  maskCpf,
  resolveRequestOwnership,
} from './requestPolicy.js'
import type { AuthRole, AuthenticatedIdentity } from './roles.js'

function identity(
  role: AuthRole,
  options: { granted?: Permission[]; denied?: Permission[]; slmMember?: boolean } = {},
): AuthenticatedIdentity {
  return {
    userId: 'eu',
    role,
    permissions: computeEffectivePermissions(role, options.granted, options.denied),
    slmMember: options.slmMember ?? role === 'slm_operator',
    sector: 'CPC',
  }
}

const own = { module: 'maintenance', requesterId: 'eu' } as const
const others = { module: 'maintenance', requesterId: 'outra-pessoa' } as const
const sameSector = { module: 'maintenance', targetSector: 'CPC' } as const
const otherSector = { module: 'maintenance', targetSector: 'RH' } as const

test('solicitante cria para o próprio setor e vê apenas o que é dele', () => {
  const requester = identity('requester')

  assert.equal(canCreateRequest(requester, sameSector), true)
  assert.equal(canReadRequest(requester, own), true)
  assert.equal(canReadRequest(requester, others), false)
})

test('estar no setor CPC não autoriza abrir em nome de outro setor', () => {
  const fromCpc = identity('requester')

  assert.equal(canCreateRequest(fromCpc, otherSector), false)
  assert.equal(canActOnBehalfOfOtherSectors(fromCpc), false)
})

test('abrir em nome de outro setor exige a permissão e a equipe SLM, juntas', () => {
  assert.equal(canCreateRequest(identity('slm_operator'), otherSector), true)

  assert.equal(
    canCreateRequest(identity('requester', { granted: ['requests:create_on_behalf'] }), otherSector),
    false,
    'permissão sem equipe',
  )
  assert.equal(
    canCreateRequest(identity('requester', { slmMember: true }), otherSector),
    false,
    'equipe sem permissão',
  )
  assert.equal(
    canCreateRequest(identity('administrator', { slmMember: false }), otherSector),
    false,
    'administrador fora da equipe',
  )
  assert.equal(
    canCreateRequest(
      identity('slm_operator', { denied: ['requests:create_on_behalf'] }),
      otherSector,
    ),
    false,
    'permissão retirada',
  )
})

test('agendar exige autorização, inclusive por módulo', () => {
  assert.equal(canScheduleRequest(identity('requester'), 'maintenance'), false)
  assert.equal(canScheduleRequest(identity('slm_operator'), 'maintenance'), true)
  assert.equal(canScheduleRequest(identity('slm_operator'), 'fleet'), true)

  assert.equal(
    canScheduleRequest(identity('slm_operator', { denied: ['fleet:schedule'] }), 'fleet'),
    false,
  )
  assert.equal(
    canScheduleRequest(identity('slm_operator', { denied: ['fleet:schedule'] }), 'maintenance'),
    true,
  )
  assert.equal(
    canScheduleRequest(
      identity('requester', { granted: ['requests:schedule', 'maintenance:schedule'] }),
      'maintenance',
    ),
    true,
    'concessão individual, sem mudar de perfil',
  )
})

test('o operador SLM vê e atende todos os setores', () => {
  const operator = identity('slm_operator')

  assert.equal(canReadRequest(operator, others), true)
  assert.equal(canUpdateRequest(operator, 'flights'), true)
  assert.equal(canCancelRequest(operator, others), true)
  assert.equal(canUpdateRequest(identity('requester'), 'flights'), false)
  assert.equal(canCancelRequest(identity('requester'), own), false)
})

test('leitura ampla concedida sem acesso ao módulo não libera o módulo', () => {
  const partial = identity('requester', {
    granted: ['requests:read_all'],
    denied: ['fleet:read'],
  })

  assert.equal(canReadRequest(partial, others), true)
  assert.equal(canReadRequest(partial, { module: 'fleet', requesterId: 'outra-pessoa' }), false)
})

test('CPF completo depende só da permissão específica', () => {
  assert.equal(canReadFullCpf(identity('administrator')), false)
  assert.equal(canReadFullCpf(identity('slm_operator')), false)
  assert.equal(canReadFullCpf(identity('requester', { granted: ['flights:cpf:read'] })), true)
  assert.equal(
    canReadFullCpf(identity('requester', { granted: ['flights:cpf:read'], denied: ['flights:cpf:read'] })),
    false,
  )
})

test('o CPF mascarado não contém os dígitos das pontas', () => {
  assert.equal(maskCpf('12345678901'), '***.456.789-**')
  assert.equal(maskCpf('123.456.789-01'), '***.456.789-**')
  assert.equal(maskCpf('123'), '***.***.***-**')
})

test('o setor próprio vem da sessão e ignora diferenças de maiúsculas e espaços', () => {
  const requester = identity('requester')

  assert.equal(canCreateRequest(requester, { module: 'fleet', targetSector: ' cpc ' }), true)
  assert.equal(canCreateRequest(requester, { module: 'fleet', targetSector: '  ' }), false)

  const withoutSector = { ...requester, sector: '' }
  assert.equal(canCreateRequest(withoutSector, { module: 'fleet', targetSector: '' }), false)
})

test('o dono da solicitação é sempre quem está na sessão', () => {
  const manipulated = {
    module: 'maintenance',
    requesterId: 'outra-pessoa',
    ownSector: 'RH',
    slmMember: true,
  } as const

  assert.deepEqual(resolveRequestOwnership(identity('requester'), manipulated), {
    requesterId: 'eu',
    sector: 'CPC',
    onBehalf: false,
  })
  assert.deepEqual(
    resolveRequestOwnership(identity('slm_operator'), { ...manipulated, targetSector: 'RH' }),
    { requesterId: 'eu', sector: 'RH', onBehalf: true },
  )
})

test('dados manipulados não abrem em nome de outro setor', () => {
  assert.equal(
    resolveRequestOwnership(identity('requester'), {
      module: 'maintenance',
      targetSector: 'RH',
      ownSector: 'RH',
      slmMember: true,
    } as never),
    null,
  )
})
