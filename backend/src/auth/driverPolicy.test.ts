import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultJourney, effectiveMinutes, exceedsJourney, isDriverApiPath, isOutsideJourney, journeyOfRecord } from './driverPolicy.js'
import { computeEffectivePermissions, isEligibleForRestrictedPermission, permissionsForProfile } from './permissions.js'
import { databaseRoleFor, isAuthRole } from './roles.js'

test('o motorista só alcança o portal, a própria sessão e os próprios avisos', () => {
  for (const allowed of ['/api/driver/trips', '/api/driver', '/api/auth/me', '/api/notifications', '/driver/trips?group=proximas', '/api/notifications/unread-count']) {
    assert.equal(isDriverApiPath(allowed), true, allowed)
  }
  for (const denied of [
    '/api/fleet/requests',
    '/api/dashboard/summary',
    '/api/maintenance/requests',
    '/api/settings',
    '/api/demands',
    '/api/warehouse/materials',
    '/api/search',
    '/api/attachments/files/x/content',
    '/api/operations/capabilities',
    '/api/catalog',
    '/api/driverless',
    '/api/fleet/drivers',
  ]) {
    assert.equal(isDriverApiPath(denied), false, denied)
  }
})

test('o perfil Motorista tem só a permissão do portal, e concessões gravadas não valem', () => {
  assert.deepEqual([...permissionsForProfile('driver')], ['driver_portal:access'])
  assert.deepEqual(
    computeEffectivePermissions('driver', ['users:manage', 'fleet:schedule', 'requests:schedule'], [], true),
    ['driver_portal:access'],
  )
  // Retirada gravada também não muda o perfil: quem deve deixar de ser motorista muda de perfil.
  assert.deepEqual(computeEffectivePermissions('driver', [], ['driver_portal:access']), ['driver_portal:access'])
  assert.equal(isEligibleForRestrictedPermission('requests:schedule', 'driver', true), false)
})

test('nenhum outro perfil recebe a permissão do portal, nem por concessão', () => {
  for (const role of ['administrator', 'slm_operator', 'requester'] as const) {
    assert.equal(permissionsForProfile(role).includes('driver_portal:access'), false, role)
    assert.equal(computeEffectivePermissions(role, ['driver_portal:access'], [], true).includes('driver_portal:access'), false, role)
  }
})

test('no banco, o motorista é uma conta comum, sem permissões antigas', () => {
  assert.equal(isAuthRole('driver'), true)
  assert.deepEqual(databaseRoleFor('driver'), { role: 'operator', permissions: [] })
})

test('a referência das 7h às 19h usa o horário de São Paulo, seja qual for o do servidor', () => {
  assert.equal(isOutsideJourney(new Date('2031-05-10T10:00:00Z')), false, '07:00 em São Paulo')
  assert.equal(isOutsideJourney(new Date('2031-05-10T09:59:00Z')), true, '06:59 em São Paulo')
  assert.equal(isOutsideJourney(new Date('2031-05-10T22:00:00Z')), false, '19:00 em São Paulo')
  assert.equal(isOutsideJourney(new Date('2031-05-10T22:01:00Z')), true, '19:01 em São Paulo')
  assert.equal(isOutsideJourney(new Date('2031-05-10T02:00:00Z')), true, '23:00 do dia anterior')
})

test('identifica a viagem que ultrapassa a referência, sem presumir nada antes do início', () => {
  const inside = (hour: number) => new Date(`2031-05-10T${String(hour).padStart(2, '0')}:00:00Z`)
  assert.equal(exceedsJourney({ startedAt: null, finishedAt: null }), false)
  assert.equal(exceedsJourney({ startedAt: inside(12), finishedAt: inside(14) }), false)
  assert.equal(exceedsJourney({ startedAt: inside(9), finishedAt: inside(14) }), true, 'começou antes das 7h')
  assert.equal(exceedsJourney({ startedAt: inside(12), finishedAt: inside(23) }), true, 'terminou depois das 19h')
  assert.equal(
    exceedsJourney({ startedAt: inside(12), finishedAt: new Date('2031-05-11T12:00:00Z') }),
    true,
    'atravessou a noite, mesmo começando e terminando na faixa',
  )
  assert.equal(exceedsJourney({ startedAt: inside(12), finishedAt: null }, inside(13)), false, 'em andamento, dentro da faixa')
  assert.equal(exceedsJourney({ startedAt: inside(12), finishedAt: null }, inside(23)), true, 'em andamento, depois das 19h')
})

test('o tempo efetivo sai do início e do fim registrados', () => {
  assert.equal(effectiveMinutes({ startedAt: null, finishedAt: null }), null)
  assert.equal(effectiveMinutes({ startedAt: new Date('2031-05-10T12:00:00Z'), finishedAt: null }), null)
  assert.equal(effectiveMinutes({ startedAt: new Date('2031-05-10T12:00:00Z'), finishedAt: new Date('2031-05-10T13:30:20Z') }), 90)
})

test('a jornada editada vale para horário, dias e duração prevista', () => {
  const journey = { start: '08:00', end: '17:00', weekdays: [1, 2, 3, 4, 5], breakMinutes: 60, expectedMinutes: 240 }
  // 2031-05-12 é uma segunda-feira.
  assert.equal(isOutsideJourney(new Date('2031-05-12T11:00:00Z'), journey), false, '08:00 de segunda')
  assert.equal(isOutsideJourney(new Date('2031-05-12T10:59:00Z'), journey), true, '07:59 de segunda')
  assert.equal(isOutsideJourney(new Date('2031-05-12T20:01:00Z'), journey), true, '17:01 de segunda')
  assert.equal(isOutsideJourney(new Date('2031-05-11T15:00:00Z'), journey), true, 'domingo, no meio da faixa')
  // O dia é o de São Paulo: 01h UTC de terça ainda é segunda, 22h, fora da faixa, mas o dia confere.
  assert.equal(isOutsideJourney(new Date('2031-05-13T01:00:00Z'), { ...journey, start: '00:00', end: '23:59' }), false)
  assert.equal(isOutsideJourney(new Date('2031-05-12T01:00:00Z'), { ...journey, start: '00:00', end: '23:59' }), true, 'ainda domingo em São Paulo')

  const at = (time: string) => new Date(`2031-05-12T${time}:00Z`)
  assert.equal(exceedsJourney({ startedAt: at('12:00'), finishedAt: at('17:00') }, at('17:00'), journey), false, 'cinco horas: quatro previstas e uma de intervalo')
  assert.equal(exceedsJourney({ startedAt: at('12:00'), finishedAt: at('17:01') }, at('17:01'), journey), true, 'passou da duração prevista')
})

test('a viagem usa a jornada guardada nela, e a antiga, a referência da época', () => {
  const stored = { start: '06:00', end: '14:00', weekdays: [1], breakMinutes: 0, expectedMinutes: null }
  assert.deepEqual(journeyOfRecord({ jornada: stored }), stored)
  for (const old of [null, undefined, {}, { inicio: {} }, { jornada: { start: 1 } }]) {
    assert.deepEqual(journeyOfRecord(old), defaultJourney)
  }
})
