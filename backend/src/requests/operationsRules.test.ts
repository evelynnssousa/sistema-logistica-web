import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  computeEffectivePermissions,
  isEligibleForRestrictedPermission,
  permissionsForProfile,
} from '../auth/permissions.js'
import { renderSubject } from '../integrations/catalog.js'
import { describeChanges, requiresJustification } from './changeRules.js'
import {
  defaultDeadline,
  defaultSettings,
  mergeSettings,
  missingRequiredCustomField,
  validateSettings,
} from './settingsRules.js'
import { RequestValidationError } from './validation.js'
import { normalizedStatusSql } from './workflow.js'

test('Central da SLM: nenhum perfil concede; exige equipe SLM e concessão individual', () => {
  for (const profile of ['administrator', 'slm_operator', 'requester'] as const) {
    assert.equal(permissionsForProfile(profile).includes('slm_central:read'), false, profile)
    assert.equal(permissionsForProfile(profile).includes('slm_central:manage'), false, profile)
  }
  assert.equal(isEligibleForRestrictedPermission('slm_central:read', 'administrator', false), false)
  assert.equal(isEligibleForRestrictedPermission('slm_central:read', 'slm_operator', true), true)
  assert.equal(isEligibleForRestrictedPermission('slm_central:read', 'requester', false), false)

  assert.equal(
    computeEffectivePermissions('administrator', ['slm_central:read'], [], false).includes('slm_central:read'),
    false,
    'gravada no banco, sem a equipe, não vale',
  )
  assert.equal(
    computeEffectivePermissions('administrator', ['slm_central:read'], [], true).includes('slm_central:read'),
    true,
  )
})

test('monitoramento é do Administrador, sem depender da equipe', () => {
  assert.equal(permissionsForProfile('administrator').includes('monitoring:read'), true)
  assert.equal(permissionsForProfile('slm_operator').includes('monitoring:read'), false)
})

test('justificativa: prioridade sempre; dados de atendimento só depois de combinado', () => {
  assert.equal(requiresJustification('aguardando_agendamento', ['prioridade']), true)
  assert.equal(requiresJustification('aguardando_agendamento', ['localServico']), false)
  assert.equal(requiresJustification('agendado', ['localServico']), true)
  assert.equal(requiresJustification('em_andamento', ['destino']), true)
  assert.equal(requiresJustification('agendado', ['observacoes']), false)
  assert.equal(requiresJustification('em_cotacao', ['ida']), false)
  assert.equal(requiresJustification('aguardando_aprovacao', ['ida']), true)
})

test('de→para: não repete nomes de passageiros, mascara CPF e encurta textos longos', () => {
  const changes = describeChanges(
    { passageiros: [{ nome: 'Pessoa' }], descricao: 'CPF 123.456.789-09', sala: null, observacoes: 'x'.repeat(500), ida: { a: 1 } },
    { passageiros: [{ nome: 'Outra' }], descricao: 'corrigido', sala: '12', observacoes: 'y', ida: { a: 2 } },
    ['passageiros', 'descricao', 'sala', 'observacoes', 'ida'],
  )
  assert.deepEqual(changes[0], { campo: 'Passageiros', de: null, para: null })
  assert.deepEqual(changes[1], { campo: 'Descrição', de: 'CPF ***', para: 'corrigido' })
  assert.deepEqual(changes[2], { campo: 'Sala', de: null, para: '12' })
  assert.equal(changes[3].de?.length, 301)
  assert.deepEqual(changes[4], { campo: 'Ida', de: '(dados estruturados)', para: '(dados estruturados)' })
})

test('parâmetros: validam intervalo, descartam o desconhecido e têm padrão seguro', () => {
  assert.throws(() => validateSettings('operations', { staleDays: 0 }), RequestValidationError)
  assert.throws(() => validateSettings('operations', { staleDays: 1.5 }), RequestValidationError)
  assert.throws(() => validateSettings('operations', { staleDays: 5, deadlineDays: { alta: -1 } }), RequestValidationError)
  assert.deepEqual(validateSettings('operations', { staleDays: '7', deadlineDays: { alta: 2, normal: '' }, extra: 1 }), {
    staleDays: 7,
    deadlineDays: { baixa: null, normal: null, alta: 2, urgente: null },
  })

  assert.throws(() => validateSettings('attachments', { maxFileMb: 10, maxTotalMb: 5, allowedKinds: ['pdf'] }), /capacidade/)
  assert.throws(() => validateSettings('attachments', { maxFileMb: 1, maxTotalMb: 5, allowedKinds: ['exe'] }), /tipo/)

  assert.throws(() => validateSettings('calendar', { workdayStart: '18:00', workdayEnd: '08:00' }), /depois/)
  assert.throws(() => validateSettings('calendar', { workdayStart: '8h', workdayEnd: '18:00' }), /HH:MM/)

  assert.throws(() => validateSettings('emailTemplates', { overrides: { inventado: { subject: 'x' } } }, ['a']), /desconhecido/)
  assert.throws(() => validateSettings('emailTemplates', { overrides: { a: { intro: '<b>x</b>' } } }, ['a']), /caracteres/)
  assert.deepEqual(validateSettings('emailTemplates', { overrides: { a: { subject: ' Novo ', intro: '' }, b: {} } }, ['a', 'b']), {
    overrides: { a: { subject: 'Novo' } },
  })

  // Sem valor institucional definido, nenhum prazo é presumido.
  assert.equal(defaultDeadline(defaultSettings, 'normal'), null)
  const merged = mergeSettings([
    { secao: 'operations', valor: { staleDays: 9, deadlineDays: { normal: 2 } } },
    { secao: 'desconhecida', valor: { qualquer: true } },
  ])
  assert.equal(merged.operations.staleDays, 9)
  assert.equal(merged.attachments.maxFileMb, 10)
  assert.equal('desconhecida' in merged, false)
  const now = new Date('2030-01-01T00:00:00Z')
  assert.equal(defaultDeadline(merged, 'normal', now)?.toISOString(), '2030-01-03T00:00:00.000Z')

  // Padrões não vazam entre leituras.
  merged.operations.staleDays = 100
  assert.equal(defaultSettings.operations.staleDays, 5)
})

test('formulários: campos conferidos no servidor, sem presumir personalização', () => {
  const field = { id: 'custom-1', label: 'Ramal', description: '', type: 'shortText', required: true, active: true, protected: false, options: [] }
  const definitions = { maintenance: [field], fleet: [field], airTravel: [field] }

  assert.deepEqual(validateSettings('forms', {}), { definitions: null })
  assert.deepEqual(validateSettings('forms', { definitions }), { definitions })
  const invalid = (change: Record<string, unknown>) => ({ definitions: { ...definitions, fleet: [{ ...field, ...change }] } })
  for (const change of [{ id: 'com espaço' }, { label: ' ' }, { type: 'html' }, { options: [1] }, { protected: true, active: false }]) {
    assert.throws(() => validateSettings('forms', invalid(change)), RequestValidationError, JSON.stringify(change))
  }
  assert.throws(() => validateSettings('forms', { definitions: { ...definitions, fleet: [] } }), RequestValidationError)
  assert.throws(() => validateSettings('forms', { definitions: { ...definitions, fleet: [field, { ...field, id: 'custom-2' }] } }), /nome diferente/)

  assert.equal(missingRequiredCustomField(null, 'fleet', {}), undefined)
  assert.equal(missingRequiredCustomField(definitions, 'fleet', {})?.label, 'Ramal')
  assert.equal(missingRequiredCustomField(definitions, 'fleet', { 'custom-1': '  ' })?.label, 'Ramal')
  assert.equal(missingRequiredCustomField(definitions, 'fleet', { 'custom-1': '123' }), undefined)
  // Inativo ou campo próprio do formulário não é conferido aqui.
  assert.equal(missingRequiredCustomField({ ...definitions, fleet: [{ ...field, active: false }] }, 'fleet', {}), undefined)
  assert.equal(missingRequiredCustomField({ ...definitions, fleet: [{ ...field, id: 'sala' }] }, 'fleet', {}), undefined)
})

test('aviso de paradas: sem valor na tela nem no ambiente, não há lembrete', () => {
  const save = (pendingReminderDays: unknown) => validateSettings('notifications', { pendingReminderDays })
  assert.deepEqual(save(''), {
    disabled: { administrator: [], slm_operator: [], requester: [] },
    pendingReminderDays: null,
    // O resumo semanal do robô só liga com a escolha expressa.
    warehouseWeeklySummary: false,
    // Sem valor enviado, os e-mails de segurança ficam no padrão.
    securityEmails: { newLogin: false, lockout: true, sessionsRevoked: true, adminAlerts: true },
  })
  assert.equal((save('7') as { pendingReminderDays: number }).pendingReminderDays, 7)
  assert.throws(() => save(0), RequestValidationError)
  assert.equal(defaultSettings.notifications.pendingReminderDays, null)
})

test('assunto do e-mail: código novo sem "#", número antigo com "#"', () => {
  assert.ok(renderSubject('request_received', { module: 'fleet', protocol: 'FRO-2026-00001' }).includes(' FRO-2026-00001 '))
  assert.ok(renderSubject('request_received', { module: 'fleet', protocol: '123' }).includes(' #123 '))
})

test('tradução de status em SQL cobre valores antigos por módulo', () => {
  const sql = normalizedStatusSql('r')
  assert.ok(sql.includes(`WHEN 'pendente' THEN 'em_cotacao'`))
  assert.ok(sql.includes(`WHEN 'pendente' THEN 'aguardando_agendamento'`))
})
