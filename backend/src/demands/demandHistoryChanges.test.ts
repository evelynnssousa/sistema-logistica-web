import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionForField, collaborationChanges, demandFieldChanges } from './demandHistoryChanges.js'

const row = {
  titulo: 'Levantamento',
  descricao: 'Texto',
  categoria_id: 'cat-1',
  setor_origem_id: 'set-1',
  setor_responsavel_id: 'set-1',
  inicio_previsto: null,
  prazo: '2026-11-10',
  prioridade: 'alta',
  restrita: false,
  observacoes: null,
  referencias: null,
  lembrete_dias: 3,
  gestor_id: null,
}

test('prazo: valor anterior e novo', () => {
  assert.deepEqual(demandFieldChanges(row, { dueDate: '2026-11-12' }), [{ campo: 'prazo', de: '2026-11-10', para: '2026-11-12' }])
  assert.equal(actionForField('prazo'), 'prazo_alterado')
  assert.equal(actionForField('titulo'), 'campo_alterado')
})

test('vários campos ao mesmo tempo: um item por campo', () => {
  const changes = demandFieldChanges(row, { title: 'Novo', priority: 'urgente', startDate: '2026-11-08', reminderDays: 5, notes: 'Obs' })
  assert.deepEqual(
    changes.map((item) => item.campo),
    ['titulo', 'inicioPrevisto', 'prioridade', 'observacoes', 'lembreteDias'],
  )
  assert.deepEqual(changes.find((item) => item.campo === 'lembreteDias'), { campo: 'lembreteDias', de: 3, para: 5 })
})

test('mesmo valor reenviado não gera alteração', () => {
  assert.deepEqual(
    demandFieldChanges(row, { title: 'Levantamento', dueDate: '2026-11-10', priority: 'alta', restricted: false, notes: null, categoryId: 'cat-1' }),
    [],
  )
})

test('referências guardam o identificador para a busca do nome', () => {
  const [change] = demandFieldChanges(row, { categoryId: 'cat-2' })
  assert.equal(change.campo, 'categoria')
  assert.equal(change.deId, 'cat-1')
  assert.equal(change.paraId, 'cat-2')
  assert.equal(change.reference, 'category')
})

test('CPF em texto livre é comparado já mascarado, como é gravado', () => {
  const [change] = demandFieldChanges(row, { notes: 'CPF 529.982.247-25' })
  assert.ok(!String(change.para).includes('529.982.247-25'))
})

test('colaboração: inclusão, retirada e alteração individualizadas', () => {
  const events = collaborationChanges(
    { collaborators: [{ userId: 'a', activity: 'Revisar', dueDate: null }, { userId: 'b', activity: null, dueDate: null }], collaboratorSectorIds: ['s1'], authorizedUserIds: ['x'] },
    { collaborators: [{ userId: 'a', activity: 'Revisar e enviar', dueDate: null }, { userId: 'c', activity: 'Apoiar', dueDate: '2026-11-20' }], collaboratorSectorIds: ['s2'], authorizedUserIds: ['x', 'y'] },
  )
  assert.deepEqual(events, [
    { action: 'colaborador_alterado', userId: 'a', alteracoes: [{ campo: 'atividade', de: 'Revisar', para: 'Revisar e enviar' }] },
    { action: 'colaborador_adicionado', userId: 'c', atividade: 'Apoiar', prazo: '2026-11-20' },
    { action: 'colaborador_removido', userId: 'b' },
    { action: 'setor_colaborador_adicionado', sectorId: 's2' },
    { action: 'setor_colaborador_removido', sectorId: 's1' },
    { action: 'autorizado_adicionado', userId: 'y' },
  ])
})

test('colaboração idêntica não gera registro', () => {
  const state = { collaborators: [{ userId: 'a', activity: 'Revisar', dueDate: null }], collaboratorSectorIds: ['s1'], authorizedUserIds: [] }
  assert.deepEqual(collaborationChanges(state, state), [])
})
