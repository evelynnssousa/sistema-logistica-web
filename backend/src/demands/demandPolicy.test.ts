import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canCreateAgendaEvents,
  canConfigureModule,
  canCreateDemands,
  canSeeReports,
  contextFromIdentity,
  creationScope,
  demandProfiles,
  hasDemandAccess,
  isConsultationOnly,
  resolveDemandAccess,
  visibilityLevel,
} from './demandPolicy.js'
import type { DemandAccess, DemandContext, DemandFacts, DemandMembership } from './demandPolicy.js'

// A matriz definitiva de permissões do Controle de Demandas, perfil por perfil.

const sectorA = 'setor-a'
const sectorB = 'setor-b'

function servidorDe(sectorId: string): DemandMembership {
  return { sectorId, sectorName: sectorId, role: 'colaborador' }
}

function chefeDe(sectorId: string): DemandMembership {
  return { sectorId, sectorName: sectorId, role: 'responsavel' }
}

function context(overrides: Partial<DemandContext> = {}): DemandContext {
  return { userId: 'pessoa', administrator: false, directorate: false, memberships: [], ...overrides }
}

const servidor = context({ memberships: [servidorDe(sectorA)] })
const chefe = context({ memberships: [chefeDe(sectorA)] })
const diretor = context({ directorate: true })
const administrador = context({ administrator: true })

function demand(overrides: Partial<DemandFacts> = {}): DemandFacts {
  return {
    createdBy: 'criadora',
    requesterId: 'solicitante',
    responsibleId: 'responsavel',
    draft: false,
    restricted: false,
    originSectorId: sectorA,
    responsibleSectorId: sectorA,
    collaboratorSectorIds: [],
    participantIds: [],
    subtaskAssigneeIds: [],
    ...overrides,
  }
}

const doSetorA = demand()
const doSetorB = demand({ originSectorId: sectorB, responsibleSectorId: sectorB })

const writes: (keyof DemandAccess)[] = ['edit', 'assign', 'transfer', 'comment', 'attach', 'subtasksManage']

function assertNoWrites(access: DemandAccess, label: string) {
  for (const capability of writes) assert.equal(access[capability], false, `${label}: ${capability}`)
}

// 1. Servidor do setor
test('servidor vê só o próprio setor e cadastra só para ele', () => {
  assert.equal(resolveDemandAccess(servidor, doSetorA).read, true)
  assert.equal(resolveDemandAccess(servidor, doSetorB).read, false)
  assert.equal(visibilityLevel(servidor), 0)
  assert.deepEqual(creationScope(servidor), { anywhere: false, sectorIds: [sectorA] })
  assert.equal(canCreateDemands(servidor), true)
})

test('servidor edita as demandas do próprio setor, e não transfere', () => {
  const access = resolveDemandAccess(servidor, doSetorA)
  assert.equal(access.read, true)
  assert.equal(access.edit, true)
  assert.equal(access.assign, true)
  assert.equal(access.comment, true)
  assert.equal(access.attach, true)
  assert.equal(access.subtasksManage, true)
  assert.equal(access.readOnly, false)
  assert.equal(access.transfer, false)
  assert.equal(canCreateAgendaEvents(servidor), false)
  assert.equal(canSeeReports(servidor), false)
})

test('servidor do setor solicitante ou colaborador também edita, e não transfere', () => {
  for (const facts of [
    demand({ originSectorId: sectorA, responsibleSectorId: sectorB }),
    demand({ originSectorId: sectorB, responsibleSectorId: sectorB, collaboratorSectorIds: [sectorA] }),
  ]) {
    const access = resolveDemandAccess(servidor, facts)
    assert.equal(access.read, true)
    assert.equal(access.edit, true)
    assert.equal(access.assign, true)
    assert.equal(access.readOnly, false)
    assert.equal(access.transfer, false)
  }
})

test('envolvimento nominal não abre demanda de outro setor', () => {
  for (const facts of [
    { createdBy: 'pessoa' },
    { responsibleId: 'pessoa' },
    { requesterId: 'pessoa' },
    { participantIds: ['pessoa'] },
    { subtaskAssigneeIds: ['pessoa'] },
  ]) {
    assert.equal(resolveDemandAccess(servidor, { ...doSetorB, ...facts }).read, false)
  }
  // Sem nenhum setor, nem o módulo abre.
  assert.equal(hasDemandAccess(context()), false)
})

test('servidor vê demanda restrita do setor só se estiver nominalmente envolvido', () => {
  assert.equal(resolveDemandAccess(servidor, demand({ restricted: true })).read, false)
  assert.equal(resolveDemandAccess(servidor, demand({ restricted: true, participantIds: ['pessoa'] })).read, true)
})

// 2. Chefe do setor
test('chefe vê tudo do próprio setor e edita, sem alcançar outros setores', () => {
  for (const facts of [doSetorA, demand({ restricted: true })]) {
    const access = resolveDemandAccess(chefe, facts)
    assert.equal(access.read, true)
    assert.equal(access.edit, true)
    assert.equal(access.assign, true)
    assert.equal(access.attach, true)
    assert.equal(access.comment, true)
    assert.equal(access.subtasksManage, true)
    assert.equal(access.readOnly, false)
  }
  assert.equal(resolveDemandAccess(chefe, doSetorB).read, false)
  assert.deepEqual(creationScope(chefe), { anywhere: false, sectorIds: [sectorA] })
  assert.equal(canSeeReports(chefe), true)
  assert.equal(canCreateAgendaEvents(chefe), true)
})

test('chefe não transfere a demanda para outro setor', () => {
  assert.equal(resolveDemandAccess(chefe, doSetorA).transfer, false)
})

test('chefe do setor solicitante ou colaborador também edita, inclusive restritas, e não transfere', () => {
  for (const facts of [
    demand({ originSectorId: sectorA, responsibleSectorId: sectorB }),
    demand({ originSectorId: sectorB, responsibleSectorId: sectorB, collaboratorSectorIds: [sectorA], restricted: true }),
  ]) {
    const access = resolveDemandAccess(chefe, facts)
    assert.equal(access.read, true)
    assert.equal(access.edit, true)
    assert.equal(access.transfer, false)
  }
})

test('demanda restrita de setor colaborador continua fechada para o servidor não envolvido', () => {
  const restricted = demand({ originSectorId: sectorB, responsibleSectorId: sectorB, collaboratorSectorIds: [sectorA], restricted: true })
  assert.equal(resolveDemandAccess(servidor, restricted).read, false)
  assert.equal(resolveDemandAccess(servidor, restricted).edit, false)
})

// 3. Diretor da DA
test('diretor vê, cadastra e edita em todos os setores, inclusive restritas', () => {
  for (const facts of [doSetorA, doSetorB, demand({ restricted: true })]) {
    const access = resolveDemandAccess(diretor, facts)
    assert.equal(access.read, true)
    assert.equal(access.edit, true)
    assert.equal(access.assign, true)
    assert.equal(access.transfer, true)
    assert.equal(access.readOnly, false)
    assert.equal(access.administrativeRead, false)
  }
  assert.equal(creationScope(diretor).anywhere, true)
  assert.equal(visibilityLevel(diretor), 1)
  assert.equal(canSeeReports(diretor), true)
})

test('diretor configura o módulo; servidor e chefe, só com a permissão', () => {
  assert.equal(canConfigureModule(diretor, []), true)
  assert.equal(canConfigureModule(servidor, []), false)
  assert.equal(canConfigureModule(chefe, []), false)
  assert.equal(canConfigureModule(servidor, ['demands:configure']), true)
})

// 4. Administrador do sistema
test('administrador consulta tudo e não altera nem cadastra nada', () => {
  assert.equal(hasDemandAccess(administrador), true)
  assert.equal(visibilityLevel(administrador), 1)
  assert.equal(canSeeReports(administrador), true)
  assert.equal(canCreateDemands(administrador), false)
  assert.equal(canCreateAgendaEvents(administrador), false)
  for (const facts of [doSetorA, doSetorB, demand({ restricted: true })]) {
    const access = resolveDemandAccess(administrador, facts)
    assert.equal(access.read, true)
    assert.equal(access.readOnly, true)
    assert.equal(access.follow, false)
    assertNoWrites(access, 'administrador')
  }
  assert.equal(resolveDemandAccess(administrador, demand({ restricted: true })).administrativeRead, true)
  assert.equal(resolveDemandAccess(administrador, doSetorA).administrativeRead, false)
})

// 5. Acúmulo de perfis
test('servidor + chefe: os poderes de chefe valem só no setor que chefia', () => {
  const both = context({ memberships: [chefeDe(sectorA), servidorDe(sectorB)] })
  assert.equal(resolveDemandAccess(both, doSetorA).edit, true)
  assert.equal(resolveDemandAccess(both, doSetorB).edit, true, 'como servidor do setor B')
  assert.equal(resolveDemandAccess(both, demand({ restricted: true })).read, true, 'como chefe do setor A')
  assert.equal(resolveDemandAccess(both, demand({ restricted: true, originSectorId: sectorB, responsibleSectorId: sectorB })).read, false, 'no setor B é servidor')
  assert.deepEqual(demandProfiles(both), ['chefe', 'servidor'])
})

test('servidor + diretor: prevalece diretor em toda a DA', () => {
  const both = context({ directorate: true, memberships: [servidorDe(sectorA)] })
  assert.equal(resolveDemandAccess(both, doSetorB).edit, true)
  assert.equal(creationScope(both).anywhere, true)
})

test('administrador + diretor: prevalece diretor para editar', () => {
  const both = context({ administrator: true, directorate: true })
  assert.equal(isConsultationOnly(both), false)
  assert.equal(resolveDemandAccess(both, doSetorA).edit, true)
  assert.equal(canCreateDemands(both), true)
  assert.equal(resolveDemandAccess(both, demand({ restricted: true })).administrativeRead, false)
})

test('administrador sem perfil de diretor: somente consulta, mesmo chefiando um setor', () => {
  const both = context({ administrator: true, memberships: [chefeDe(sectorA)] })
  assert.equal(isConsultationOnly(both), true)
  assert.equal(canCreateDemands(both), false)
  assert.equal(canCreateAgendaEvents(both), false)
  assertNoWrites(resolveDemandAccess(both, doSetorA), 'administrador + chefe')
})

// Rascunho
test('rascunho é só de quem criou, que o conclui até publicar', () => {
  const draft = demand({ draft: true, createdBy: 'pessoa' })
  const own = resolveDemandAccess(servidor, draft)
  assert.equal(own.edit, true)
  assert.equal(own.attach, true)
  assert.equal(own.transfer, true)
  const someoneElses = demand({ draft: true })
  for (const other of [chefe, diretor, administrador]) {
    assert.equal(resolveDemandAccess(other, someoneElses).read, false)
  }
})

// Identificação
test('o perfil vem da identidade do servidor e dos vínculos no banco', () => {
  const identity = { userId: 'u', role: 'requester' as const, permissions: [], slmMember: true, sector: 'X' }
  const asDirector = contextFromIdentity(identity, { memberships: [], directorateRole: 'diretor' })
  assert.equal(asDirector.directorate, true)
  assert.equal(asDirector.administrator, false)

  const byPermission = contextFromIdentity(
    { ...identity, permissions: ['demands:directorate'] },
    { memberships: [], directorateRole: null },
  )
  assert.equal(byPermission.directorate, true)

  const administrator = contextFromIdentity(
    { ...identity, role: 'administrator' as const },
    { memberships: [], directorateRole: null },
  )
  assert.equal(administrator.administrator, true)
  assert.equal(administrator.directorate, false)
})

test('não há outros níveis de acesso: equipe SLM e papéis antigos da DA não dão nada', () => {
  const identity = { userId: 'u', role: 'requester' as const, permissions: [], slmMember: true, sector: 'X' }
  for (const directorateRole of ['integrante', 'consulta', null]) {
    const other = contextFromIdentity(identity, { memberships: [], directorateRole })
    assert.equal(hasDemandAccess(other), false, String(directorateRole))
    assert.equal(canCreateDemands(other), false, String(directorateRole))
  }
})
