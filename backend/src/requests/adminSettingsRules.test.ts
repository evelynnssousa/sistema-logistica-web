import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activeAnnouncement, registrationDomains, skipHolidays, validateAdminSettings } from './adminSettingsRules.js'

test('domínios: normaliza, remove repetidos e recusa o que não é domínio', () => {
  assert.deepEqual(validateAdminSettings('registration', { allowedDomains: ['@JUCESP.sp.gov.br', 'jucesp.sp.gov.br', ' sp.gov.br '] }), {
    allowedDomains: ['jucesp.sp.gov.br', 'sp.gov.br'],
  })
  assert.throws(() => validateAdminSettings('registration', { allowedDomains: ['nao é domínio'] }), /não é um domínio válido/)
  assert.deepEqual(registrationDomains([], { INSTITUTIONAL_EMAIL_DOMAINS: 'a.gov.br, b.gov.br' }), ['a.gov.br', 'b.gov.br'])
  assert.deepEqual(registrationDomains(['c.gov.br'], { INSTITUTIONAL_EMAIL_DOMAINS: 'a.gov.br' }), ['c.gov.br'])
})

test('feriados: ordenados, sem datas repetidas e sem marcação', () => {
  const saved = validateAdminSettings('holidays', { list: [{ date: '2026-12-25', name: 'Natal' }, { date: '2026-11-20', name: 'Consciência Negra' }] })
  assert.deepEqual(saved, { list: [{ date: '2026-11-20', name: 'Consciência Negra' }, { date: '2026-12-25', name: 'Natal' }] })
  assert.throws(() => validateAdminSettings('holidays', { list: [{ date: '2026-12-25', name: 'A' }, { date: '2026-12-25', name: 'B' }] }), /repetidos/)
  assert.throws(() => validateAdminSettings('holidays', { list: [{ date: '2026-12-25', name: '<b>x</b>' }] }), /< >/)
  // Meio-dia de 25/12 em Brasília é feriado: o prazo passa para o dia 26.
  const moved = skipHolidays(new Date('2026-12-25T15:00:00Z'), ['2026-12-25'])
  assert.equal(moved.toISOString(), '2026-12-26T15:00:00.000Z')
})

test('aviso geral: só ativo, com texto e dentro da data', () => {
  const announcement = validateAdminSettings('announcement', { active: true, text: 'Inventário dia 20', tone: 'warning', until: '2026-11-20' }) as {
    active: boolean; text: string; tone: 'info' | 'warning'; until: string | null
  }
  assert.deepEqual(activeAnnouncement(announcement, '2026-11-20'), { text: 'Inventário dia 20', tone: 'warning', until: '2026-11-20' })
  assert.equal(activeAnnouncement(announcement, '2026-11-21'), null)
  assert.throws(() => validateAdminSettings('announcement', { active: true, text: '' }), /Escreva o texto/)
})

test('permissões padrão: só as comuns de cada módulo, nunca administrativas', () => {
  assert.deepEqual(validateAdminSettings('profileDefaults', { requester: { add: ['reports:read'], remove: ['flights:create'] } }), {
    requester: { add: ['reports:read'], remove: ['flights:create'] },
    slm_operator: { add: [], remove: [] },
  })
  for (const permission of ['users:manage', 'settings:manage', 'flights:cpf:read', 'requests:schedule', 'warehouse:manage']) {
    assert.throws(() => validateAdminSettings('profileDefaults', { requester: { add: [permission] } }), /não pode ser ajustada/)
  }
  assert.throws(() => validateAdminSettings('profileDefaults', { requester: { add: ['reports:read'], remove: ['reports:read'] } }), /ao mesmo tempo/)
})

test('módulos e padrões das atas', () => {
  assert.deepEqual(validateAdminSettings('modules', { flights: false }), { maintenance: true, fleet: true, flights: false, warehouse: true, demands: true })
  assert.throws(() => validateAdminSettings('contracts', { defaultNoticeDays: 400, lowBalancePercent: 20 }), /entre 0 e 365/)
})
