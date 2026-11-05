import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  defaultDriverSettings,
  driverPortalView,
  defaultOccurrenceTypes,
  occurrenceTypeKey,
  portalAttachmentKinds,
  readExecutionRecord,
  readOccurrenceType,
  validateDriverSettings,
} from './driverPortalRules.js'
import { defaultSettings, mergeSettings, validateSettings } from './settingsRules.js'
import { RequestValidationError } from './validation.js'

const journey = (patch: object) => ({ ...defaultDriverSettings.driverJourney, ...patch })
const rejects = (action: () => unknown) => assert.throws(action, RequestValidationError)

test('os padrões são os do sistema anterior e reproduzem o portal como ele já funcionava', () => {
  assert.equal(defaultSettings.driverJourney.start, '07:00')
  assert.equal(defaultSettings.driverJourney.end, '19:00')
  assert.deepEqual(defaultSettings.driverJourney.weekdays, [0, 1, 2, 3, 4, 5, 6])
  assert.equal(defaultSettings.driverJourney.allowOutsideStart, true)
  assert.deepEqual(defaultSettings.driverExecution.startFields, [])
  assert.equal(defaultSettings.driverAccess.portalEnabled, true)
  assert.equal(defaultSettings.driverNotifications.rules.trip_assigned.driver, true)
  assert.equal(defaultSettings.driverNotifications.rules.trip_started.team, false)
})

test('sem nada cadastrado valem os padrões, e um campo novo nunca fica indefinido', () => {
  assert.deepEqual(mergeSettings([]).driverDisplay, defaultDriverSettings.driverDisplay)
  const merged = mergeSettings([{ secao: 'driverJourney', valor: { start: '06:00' } }])
  assert.equal(merged.driverJourney.start, '06:00')
  assert.equal(merged.driverJourney.end, '19:00')
  assert.equal(defaultDriverSettings.driverJourney.start, '07:00', 'o padrão não é alterado')
})

test('jornada: recusa horários, dias e durações incoerentes', () => {
  const read = (patch: object) => validateSettings('driverJourney', journey(patch))
  assert.equal((read({ start: '08:00', end: '17:00' }) as { start: string }).start, '08:00')
  rejects(() => read({ start: '19:00', end: '07:00' }))
  rejects(() => read({ start: '07:00', end: '07:00' }))
  rejects(() => read({ start: '7h' }))
  rejects(() => read({ weekdays: [] }))
  rejects(() => read({ weekdays: [9] }))
  rejects(() => read({ breakMinutes: 720 }))
  rejects(() => read({ start: '08:00', end: '12:00', expectedMinutes: 300 }))
  rejects(() => read({ start: '08:00', end: '12:00', expectedMinutes: 200, breakMinutes: 60 }))
  rejects(() => read({ outsideStart: 'bloquear' }))
  rejects(() => read({ allowOutsideStart: undefined }))
})

test('execução: em andamento e próximas continuam visíveis, mesmo que venham desmarcadas', () => {
  const read = validateDriverSettings('driverExecution', {
    startFields: ['odometer', 'senha'],
    finishFields: ['vehicle', 'notes'],
    upcomingDays: 3,
    visibleGroups: ['concluidas'],
  }) as typeof defaultDriverSettings.driverExecution
  assert.deepEqual(read.visibleGroups, ['proximas', 'em_andamento', 'concluidas'])
  assert.deepEqual(read.startFields, ['odometer'], 'campo desconhecido é descartado')
  assert.deepEqual(read.finishFields, ['notes'], 'veículo só faz sentido ao iniciar')
  rejects(() => validateDriverSettings('driverExecution', { startFields: [], finishFields: [], upcomingDays: 0, visibleGroups: [] }))
  rejects(() => validateDriverSettings('driverExecution', { startFields: [], finishFields: [], upcomingDays: "1 days'; DROP TABLE x;--", visibleGroups: [] }))
})

test('notificações: a célula do motorista não vale onde ele mesmo registra', () => {
  const rules = structuredClone(defaultDriverSettings.driverNotifications.rules)
  rules.trip_started.driver = true
  const read = validateDriverSettings('driverNotifications', { rules }) as typeof defaultDriverSettings.driverNotifications
  assert.equal(read.rules.trip_started.driver, false)
  rejects(() => validateDriverSettings('driverNotifications', { rules: { ...rules, occurrence: 'sim' } }))
})

test('visualização: o destino não some, e só campos conhecidos são gravados', () => {
  const display = structuredClone(defaultDriverSettings.driverDisplay)
  const read = (patch: object) => validateDriverSettings('driverDisplay', { ...display, ...patch })
  rejects(() => read({ fields: { ...display.fields, destination: 'hidden' } }))
  const stored = read({ fields: { ...display.fields, internalNotes: 'card', cancelReason: 'card' } }) as typeof display
  assert.equal(Object.hasOwn(stored.fields, 'internalNotes'), false)
  assert.equal(Object.hasOwn(stored.fields, 'cancelReason'), false)
  rejects(() => read({ notices: [{ text: '<script>', active: true }] }))
  rejects(() => read({ notices: [{ text: 'ok', active: true }] }))
  rejects(() => read({ guidance: { active: true, text: '' } }))
  rejects(() => read({ contact: { active: true, name: 'Frota', phone: '', email: '', hours: '' } }))
  rejects(() => read({ contact: { active: false, name: '', phone: 'abc', email: '', hours: '' } }))
  rejects(() => read({ contact: { active: false, name: '', phone: '', email: 'sem-arroba', hours: '' } }))
})

test('o motorista só recebe o necessário: sem regras internas, itens inativos ou tipos desativados', () => {
  const settings = structuredClone(defaultDriverSettings)
  settings.driverDisplay.notices = [{ text: 'Vale', active: true }, { text: 'Rascunho interno', active: false }]
  settings.driverDisplay.guidance = { active: false, text: 'Orientação inativa' }
  settings.driverDisplay.contact = { active: false, name: 'Interno', phone: '11', email: '', hours: '' }
  const types = defaultOccurrenceTypes.map((type) => ({ ...type, active: type.key !== 'veiculo' }))
  const view = driverPortalView(settings, types)
  assert.deepEqual(view.display.notices, ['Vale'])
  assert.equal(view.display.guidance, null)
  assert.equal(view.display.contact, null)
  assert.equal(view.occurrences.types.some((type) => type.key === 'veiculo'), false)
  const text = JSON.stringify(view)
  for (const secret of ['rules', 'Rascunho interno', 'Orientação inativa', 'Interno', 'upcomingDays']) {
    assert.equal(text.includes(secret), false, secret)
  }
  settings.driverAccess.occurrencesEnabled = false
  assert.deepEqual(driverPortalView(settings, types).occurrences.types, [])
})

test('anexos do portal: nunca abrem o que os parâmetros gerais fecham', () => {
  const access = defaultDriverSettings.driverAccess
  assert.deepEqual(portalAttachmentKinds(access, ['pdf', 'png']), ['pdf', 'png'])
  assert.deepEqual(portalAttachmentKinds({ ...access, allowPhotos: false }, ['pdf', 'png', 'jpeg', 'webp']), ['pdf'])
  assert.deepEqual(portalAttachmentKinds({ ...access, allowDocuments: false }, ['pdf', 'png', 'docx']), ['png'])
  assert.deepEqual(portalAttachmentKinds({ ...access, attachmentsEnabled: false }, ['pdf']), [])
  assert.deepEqual(portalAttachmentKinds({ ...access, occurrencesEnabled: false }, ['pdf']), [])
})

test('dados da execução: só o que a configuração pede é lido, e horários enviados não entram', () => {
  const body = { hodometro: '1200', observacao: ' Tudo certo ', veiculo: 'Van', inicioReal: '2001-01-01', justificativa: 'x' }
  assert.deepEqual(readExecutionRecord(body, []), {})
  assert.deepEqual(readExecutionRecord(body, ['odometer', 'notes']), { hodometro: 1200, observacao: 'Tudo certo' })
  assert.deepEqual(readExecutionRecord(body, ['vehicle']), { veiculo: 'Van' })
  assert.deepEqual(readExecutionRecord({}, ['vehicle'], { tripHasVehicle: true }), {})
  rejects(() => readExecutionRecord({}, ['odometer']))
  rejects(() => readExecutionRecord({ hodometro: -1 }, ['odometer']))
  rejects(() => readExecutionRecord({ hodometro: { valor: 1 } }, ['odometer']))
  rejects(() => readExecutionRecord({ observacao: ' ' }, ['notes']))
})

test('tipos de ocorrência: valida o nome e gera chave estável', () => {
  assert.equal(readOccurrenceType({ label: ' Pneu furado ' }).label, 'Pneu furado')
  assert.equal(readOccurrenceType({ label: 'Pneu' }).allowsAttachments, true)
  rejects(() => readOccurrenceType({ label: 'x' }))
  rejects(() => readOccurrenceType({ label: '<b>Pneu</b>' }))
  rejects(() => readOccurrenceType({ label: 'Pneu', active: 'sim' }))
  assert.equal(occurrenceTypeKey('Acidente de Trânsito!'), 'acidente_de_transito')
  assert.equal(occurrenceTypeKey('---'), 'tipo')
})
