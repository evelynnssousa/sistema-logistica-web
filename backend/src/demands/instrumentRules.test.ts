import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DemandContext } from './demandPolicy.js'
import {
  canCreateInstrumentFor,
  instrumentAccess,
  instrumentSituation,
  instrumentTotals,
  itemBalance,
  renewalDue,
  renewalTitle,
} from './instrumentRules.js'

const base: DemandContext = { userId: 'u', administrator: false, directorate: false, memberships: [] }
const member = (sectorId: string, role: 'colaborador' | 'responsavel' = 'colaborador') => ({ sectorId, sectorName: sectorId, role })
const instrument = { responsibleSectorId: 'A', sharedSectorIds: ['B'] }

test('acesso: setor responsável e compartilhado alteram; outro setor não vê; administrador só consulta', () => {
  assert.deepEqual(instrumentAccess({ ...base, memberships: [member('A')] }, instrument), { read: true, edit: true })
  assert.deepEqual(instrumentAccess({ ...base, memberships: [member('B')] }, instrument), { read: true, edit: true })
  assert.deepEqual(instrumentAccess({ ...base, memberships: [member('C', 'responsavel')] }, instrument), { read: false, edit: false })
  assert.deepEqual(instrumentAccess({ ...base, administrator: true, memberships: [member('A')] }, instrument), { read: true, edit: false })
  assert.deepEqual(instrumentAccess({ ...base, directorate: true }, instrument), { read: true, edit: true })
})

test('cadastro: só para setor que a pessoa integra, ou qualquer um para o Diretor', () => {
  assert.equal(canCreateInstrumentFor({ ...base, memberships: [member('A')] }, 'A'), true)
  assert.equal(canCreateInstrumentFor({ ...base, memberships: [member('A')] }, 'B'), false)
  assert.equal(canCreateInstrumentFor({ ...base, directorate: true }, 'B'), true)
  assert.equal(canCreateInstrumentFor({ ...base, administrator: true, memberships: [member('A')] }, 'A'), false)
})

test('situação: vigente, vencendo dentro do aviso, vencida, futura e encerrada', () => {
  const ata = { closed: false, validFrom: '2026-01-01', validUntil: '2026-12-31', noticeDays: 90 }
  assert.deepEqual(instrumentSituation(ata, '2026-06-01'), { situation: 'vigente', daysLeft: 213 })
  assert.deepEqual(instrumentSituation(ata, '2026-10-02'), { situation: 'vencendo', daysLeft: 90 })
  assert.deepEqual(instrumentSituation(ata, '2027-01-01'), { situation: 'vencido', daysLeft: -1 })
  assert.equal(instrumentSituation(ata, '2025-12-31').situation, 'futuro')
  assert.equal(instrumentSituation({ ...ata, closed: true }, '2026-06-01').situation, 'encerrado')
  assert.deepEqual(instrumentSituation({ ...ata, validUntil: null }, '2026-06-01'), { situation: 'vigente', daysLeft: null })
})

test('renovação: uma vez por vigência, ao entrar no prazo de aviso', () => {
  const ata = { closed: false, validUntil: '2026-12-31', noticeDays: 90, renewalDemandId: null }
  assert.equal(renewalDue(ata, '2026-10-01'), false)
  assert.equal(renewalDue(ata, '2026-10-02'), true)
  assert.equal(renewalDue(ata, '2027-02-01'), true)
  assert.equal(renewalDue({ ...ata, renewalDemandId: 'x' }, '2026-12-01'), false)
  assert.equal(renewalDue({ ...ata, closed: true }, '2026-12-01'), false)
  assert.equal(renewalDue({ ...ata, validUntil: null }, '2026-12-01'), false)
})

test('saldos e título', () => {
  assert.deepEqual(itemBalance({ registered: 100, used: 30, unitPrice: 2.5 }), { balance: 70, registeredValue: 250, usedValue: 75 })
  assert.deepEqual(instrumentTotals(1000, 250), { spent: 250, balance: 750, usedPercent: 25 })
  assert.deepEqual(instrumentTotals(0, 0), { spent: 0, balance: 0, usedPercent: null })
  assert.equal(renewalTitle({ type: 'ata', number: '12/2026', subject: 'Papel' }), 'Renovar ata 12/2026: Papel')
  assert.equal(renewalTitle({ type: 'contrato', number: '1', subject: 'x'.repeat(300) }).length, 200)
})
