import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeEffectivePermissions } from './permissions.js'
import type { Permission } from './permissions.js'
import {
  canActOnBehalfOfOtherSectors,
  canCancelOwnRequest,
  canCancelRequest,
  canCreateRequest,
  canReadFullCpf,
  canReadRequest,
  canScheduleRequest,
  canUpdateRequest,
  hasCpfAuthorization,
  maskCpf,
  resolveRequestOwnership,
} from './requestPolicy.js'
import type { AuthRole, AuthenticatedIdentity } from './roles.js'

function identity(
  role: AuthRole,
  options: { granted?: Permission[]; denied?: Permission[]; slmMember?: boolean } = {},
): AuthenticatedIdentity {
  const slmMember = options.slmMember ?? role === 'slm_operator'
  return {
    userId: 'eu',
    role,
    permissions: computeEffectivePermissions(role, options.granted, options.denied, slmMember),
    slmMember,
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

test('abrir em nome de outro setor exige equipe, perfil elegível e concessão, juntos', () => {
  const grant = { granted: ['requests:create_on_behalf'] as Permission[] }

  assert.equal(canCreateRequest(identity('slm_operator', grant), otherSector), true)
  assert.equal(
    canCreateRequest(identity('slm_operator'), otherSector),
    false,
    'o perfil Operador SLM não concede',
  )
  assert.equal(
    canCreateRequest(identity('requester', grant), otherSector),
    false,
    'concessão sem equipe',
  )
  assert.equal(
    canCreateRequest(identity('requester', { ...grant, slmMember: true }), otherSector),
    false,
    'solicitante não é elegível, mesmo marcado como SLM',
  )
  assert.equal(
    canCreateRequest(identity('administrator'), otherSector),
    false,
    'administrador sem equipe nem concessão',
  )
  assert.equal(
    canCreateRequest(identity('administrator', grant), otherSector),
    false,
    'administrador com concessão, fora da equipe',
  )
  assert.equal(
    canCreateRequest(identity('administrator', { slmMember: true }), otherSector),
    false,
    'administrador na equipe, sem concessão',
  )
  assert.equal(
    canCreateRequest(identity('administrator', { ...grant, slmMember: true }), otherSector),
    true,
    'administrador na equipe, com concessão',
  )
  assert.equal(
    canCreateRequest(
      identity('slm_operator', { ...grant, denied: ['requests:create_on_behalf'] }),
      otherSector,
    ),
    false,
    'permissão retirada',
  )
})

test('agendar: administrador e operador da SLM pelo perfil, fora da equipe não, solicitante nunca', () => {
  const grant = { granted: ['requests:schedule'] as Permission[] }

  // P-08: ser administrador fora da SLM não basta, nem com concessão gravada.
  assert.equal(canScheduleRequest(identity('administrator'), 'maintenance'), false, 'fora da SLM')
  assert.equal(canScheduleRequest(identity('administrator'), 'fleet'), false, 'fora da SLM')
  assert.equal(canScheduleRequest(identity('administrator', grant), 'maintenance'), false, 'concessão fora da SLM')
  assert.equal(canScheduleRequest(identity('administrator', { slmMember: true }), 'maintenance'), true, 'na SLM')
  assert.equal(canScheduleRequest(identity('administrator', { slmMember: true }), 'fleet'), true, 'na SLM')

  // Operador SLM na equipe agenda pelo perfil, sem concessão manual.
  assert.equal(canScheduleRequest(identity('slm_operator'), 'maintenance'), true, 'pelo perfil')
  assert.equal(canScheduleRequest(identity('slm_operator'), 'fleet'), true, 'pelo perfil')
  assert.equal(canScheduleRequest(identity('slm_operator', grant), 'maintenance'), true)
  // Mesmo perfil fora da equipe (por exemplo, conta anterior à migração 003): não agenda.
  assert.equal(
    canScheduleRequest(identity('slm_operator', { slmMember: false }), 'maintenance'),
    false,
    'operador fora da equipe',
  )
  assert.equal(
    canScheduleRequest(identity('slm_operator', { ...grant, slmMember: false }), 'fleet'),
    false,
    'operador fora da equipe, com concessão',
  )
  // A retirada individual prevalece sobre o padrão do perfil.
  assert.equal(
    canScheduleRequest(identity('slm_operator', { denied: ['requests:schedule'] }), 'maintenance'),
    false,
    'retirada individual',
  )

  assert.equal(canScheduleRequest(identity('requester'), 'maintenance'), false)
  assert.equal(
    canScheduleRequest(
      identity('requester', { granted: ['requests:schedule', 'maintenance:schedule'] }),
      'maintenance',
    ),
    false,
    'concessão não supera a elegibilidade',
  )
  assert.equal(
    canScheduleRequest(
      identity('requester', { granted: ['requests:schedule', 'maintenance:schedule'], slmMember: true }),
      'maintenance',
    ),
    false,
    'solicitante marcado como SLM',
  )
})

test('agendar exige a permissão do módulo, e ela sozinha não basta', () => {
  const grant: Permission[] = ['requests:schedule']

  assert.equal(
    canScheduleRequest(identity('slm_operator', { granted: grant, denied: ['fleet:schedule'] }), 'fleet'),
    false,
  )
  assert.equal(
    canScheduleRequest(identity('slm_operator', { granted: grant, denied: ['fleet:schedule'] }), 'maintenance'),
    true,
  )
  assert.equal(
    canScheduleRequest(identity('slm_operator', { granted: grant, denied: ['maintenance:schedule'] }), 'maintenance'),
    false,
  )
  assert.equal(
    canScheduleRequest(identity('administrator', { slmMember: true, denied: ['maintenance:schedule'] }), 'maintenance'),
    false,
  )
  assert.equal(
    canScheduleRequest(identity('administrator', { slmMember: true, denied: ['maintenance:schedule'] }), 'fleet'),
    true,
  )

  // Só a permissão do módulo, sem a permissão geral de agendar.
  const moduleOnly = identity('slm_operator', { denied: ['requests:schedule'] })
  assert.ok(moduleOnly.permissions.includes('maintenance:schedule'))
  assert.equal(canScheduleRequest(moduleOnly, 'maintenance'), false)
})

test('o operador SLM vê e atende todos os setores', () => {
  const operator = identity('slm_operator')

  assert.equal(canReadRequest(operator, others), true)
  assert.equal(canUpdateRequest(operator, 'flights'), true)
  assert.equal(canCancelRequest(operator, others), true)
  assert.equal(canUpdateRequest(identity('requester'), 'flights'), false)
  assert.equal(canCancelRequest(identity('requester'), own), false)
})

test('cancelar a própria: só com a concessão, só a própria e só antes do atendimento', () => {
  const waiting = { ...own, status: 'aguardando_agendamento' }
  // Sem a concessão, nada muda: o Solicitante continua sem cancelar.
  assert.equal(canCancelOwnRequest(identity('requester'), waiting), false)

  const allowed = identity('requester', { granted: ['requests:cancel_own'] })
  assert.equal(canCancelOwnRequest(allowed, waiting), true)
  assert.equal(canCancelOwnRequest(allowed, { ...others, status: 'aguardando_agendamento' }), false, 'de outra pessoa')
  for (const status of ['agendado', 'reagendado', 'em_andamento', 'concluido', 'cancelado']) {
    assert.equal(canCancelOwnRequest(allowed, { ...own, status }), false, status)
  }
  assert.equal(canCancelOwnRequest(allowed, { module: 'flights', requesterId: 'eu', status: 'em_cotacao' }), true)
  assert.equal(canCancelOwnRequest(allowed, { module: 'flights', requesterId: 'eu', status: 'em_emissao' }), false)
  // A concessão não amplia o cancelamento geral nem a leitura.
  assert.equal(canCancelRequest(allowed, own), false)
  assert.equal(canReadRequest(allowed, others), false)
  // Sem acesso ao módulo, não vale.
  const noFleet = identity('requester', { granted: ['requests:cancel_own'], denied: ['fleet:read'] })
  assert.equal(canCancelOwnRequest(noFleet, { module: 'fleet', requesterId: 'eu', status: 'aguardando_agendamento' }), false)
})

test('nenhum perfil de quem solicita recebe o cancelamento da própria por padrão', () => {
  assert.equal(identity('requester').permissions.includes('requests:cancel_own'), false)
  assert.equal(identity('driver').permissions.includes('requests:cancel_own'), false)
})

test('leitura ampla concedida sem acesso ao módulo não libera o módulo', () => {
  const partial = identity('requester', {
    granted: ['requests:read_all'],
    denied: ['fleet:read'],
  })

  assert.equal(canReadRequest(partial, others), true)
  assert.equal(canReadRequest(partial, { module: 'fleet', requesterId: 'outra-pessoa' }), false)
})

test('CPF completo exige concessão individual, elegibilidade, módulo e acesso à solicitação', () => {
  const grant = { granted: ['flights:cpf:read'] as Permission[] }
  const anyRequest = { requesterId: 'outra-pessoa' }
  const ownRequest = { requesterId: 'eu' }

  assert.equal(canReadFullCpf(identity('administrator'), anyRequest), false, 'perfil não concede')
  assert.equal(canReadFullCpf(identity('slm_operator'), anyRequest), false, 'perfil não concede')
  assert.equal(
    canReadFullCpf(identity('administrator', { ...grant, slmMember: true }), anyRequest),
    true,
    'administrador na equipe, com concessão',
  )
  assert.equal(
    canReadFullCpf(identity('administrator', grant), anyRequest),
    false,
    'administrador fora da equipe',
  )
  assert.equal(
    canReadFullCpf(identity('administrator', { slmMember: true }), anyRequest),
    false,
    'administrador na equipe, sem concessão',
  )
  assert.equal(canReadFullCpf(identity('slm_operator', grant), anyRequest), true)

  assert.equal(canReadFullCpf(identity('requester', grant), ownRequest), false, 'não elegível')
  assert.equal(
    canReadFullCpf(identity('slm_operator', { ...grant, slmMember: false }), anyRequest),
    false,
    'fora da equipe',
  )
  assert.equal(
    canReadFullCpf(identity('slm_operator', { ...grant, denied: ['flights:cpf:read'] }), anyRequest),
    false,
    'retirada prevalece',
  )
  assert.equal(
    canReadFullCpf(identity('slm_operator', { ...grant, denied: ['flights:read'] }), anyRequest),
    false,
    'sem acesso ao módulo',
  )

  const withoutReadAll = identity('slm_operator', { ...grant, denied: ['requests:read_all'] })
  assert.equal(hasCpfAuthorization(withoutReadAll), true)
  assert.equal(canReadFullCpf(withoutReadAll, anyRequest), false, 'solicitação de terceiro')
  assert.equal(canReadFullCpf(withoutReadAll, ownRequest), true)
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
    resolveRequestOwnership(
      identity('slm_operator', { granted: ['requests:create_on_behalf'] }),
      { ...manipulated, targetSector: 'RH' },
    ),
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
