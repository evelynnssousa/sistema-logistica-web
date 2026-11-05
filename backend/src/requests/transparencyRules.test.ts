import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  citedVariables,
  fillLines,
  fillTemplate,
  templateTextProblem,
  variablesForEvent,
} from '../integrations/templateVariables.js'
import { renderReportCsv, renderReportPdf } from '../reports/reportDocument.js'
import type { ReportDocument } from '../reports/reportDocument.js'
import { compareDuplicate, textSimilarity } from './duplicateRules.js'
import type { DuplicateProbe } from './duplicateRules.js'
import {
  canReturnFromStatus,
  classifyScheduleChange,
  defaultReasons,
  differsFromRequest,
  pickCorrections,
  preserveOriginalRequest,
  requestedSchedule,
  requestTiming,
  resolveJustification,
  validateReturn,
} from './justificationRules.js'

const options = defaultReasons.scheduling
const required = { required: true, missingMessage: 'Informe a justificativa.' }

test('justificativa: motivo padronizado, complemento livre e "outros" exige texto', () => {
  assert.throws(() => resolveJustification(options, { code: '', text: '' }, required), /Informe a justificativa/)
  assert.equal(resolveJustification(options, { code: '', text: '' }, { ...required, required: false }), null)

  const plain = resolveJustification(options, { code: 'conflito_agenda', text: '' }, required)
  assert.equal(plain?.summary, 'Conflito de agenda')
  const complemented = resolveJustification(options, { code: 'conflito_agenda', text: 'Duas viagens' }, required)
  assert.equal(complemented?.summary, 'Conflito de agenda: Duas viagens')

  assert.throws(() => resolveJustification(options, { code: 'outro', text: '' }, required), /complemento/)
  assert.throws(() => resolveJustification(options, { code: 'inventado', text: 'x' }, required), /válido/)

  // Texto sem o seletor continua aceito, classificado como "outros".
  const free = resolveJustification(options, { code: undefined, text: 'Motivo livre' }, required)
  assert.deepEqual([free?.code, free?.summary], ['outro', 'Motivo livre'])
})

test('justificativa: motivo desativado não é mais aceito', () => {
  const list = [{ key: 'a', label: 'A', active: false }, { key: 'outro', label: 'Outros', active: true }]
  assert.throws(() => resolveJustification(list, { code: 'a', text: 'x' }, required), /válido/)
})

test('divergência: compara com o pedido, sem presumir o que não foi informado', () => {
  const requested = { start: '2031-05-10T13:00:00.000Z', end: '2031-05-10T18:00:00.000Z' }
  const start = new Date('2031-05-10T13:00:30.000Z')
  assert.equal(differsFromRequest(requested, { start, end: null }), false, 'sem término, só o início conta')
  assert.equal(differsFromRequest(requested, { start, end: new Date(requested.end) }), false)
  assert.equal(differsFromRequest(requested, { start, end: new Date('2031-05-10T19:00:00.000Z') }), true)
  assert.equal(differsFromRequest(requested, { start: new Date('2031-05-11T13:00:00.000Z'), end: null }), true)
  assert.equal(differsFromRequest({ start: null, end: null }, { start, end: null }), false, 'sem data pedida')
})

test('o pedido original sobrevive à edição da data pela equipe', () => {
  const before = { dataHora: '2031-05-10T13:00:00.000Z', dataHoraRetorno: null }
  const edited = preserveOriginalRequest('fleet', before, { dataHora: '2031-06-01T13:00:00.000Z', dataHoraRetorno: null })
  assert.deepEqual(requestedSchedule('fleet', edited), { start: before.dataHora, end: null })

  const again = preserveOriginalRequest('fleet', edited, { dataHora: '2031-07-01T13:00:00.000Z', dataHoraRetorno: null })
  assert.deepEqual(requestedSchedule('fleet', again), { start: before.dataHora, end: null })

  const unchanged = { dataHora: before.dataHora, dataHoraRetorno: null }
  assert.equal(preserveOriginalRequest('fleet', before, unchanged), unchanged)
  assert.deepEqual(requestedSchedule('maintenance', { dataPreferencial: before.dataHora }), { start: before.dataHora, end: null })
  assert.deepEqual(requestedSchedule('flights', { ida: {} }), { start: null, end: null })
})

test('classificação da mudança de agendamento', () => {
  const start = new Date('2031-05-10T13:00:00.000Z')
  const previous = { start, end: null, responsibleId: 'r1' }
  const next = { start, end: null, responsibleId: 'r1', conditions: null }
  assert.equal(classifyScheduleChange({ start: null, end: null, responsibleId: null }, next), 'schedule')
  assert.equal(classifyScheduleChange(previous, next), 'none')
  assert.equal(classifyScheduleChange(previous, { ...next, start: new Date('2031-05-11T13:00:00.000Z') }), 'reschedule')
  assert.equal(classifyScheduleChange(previous, { ...next, responsibleId: 'r2' }), 'adjust')
  assert.equal(classifyScheduleChange(previous, { ...next, end: new Date('2031-05-10T14:00:00.000Z') }), 'adjust')
  assert.equal(classifyScheduleChange(previous, { ...next, conditions: 'Outro veículo' }), 'adjust')
})

test('devolução: exige motivo e campos conhecidos, e só deixa passar o que foi indicado', () => {
  assert.throws(() => validateReturn('fleet', { tipo: 'x', motivo: 'abc' }), /tipo/)
  assert.throws(() => validateReturn('fleet', { tipo: 'correcao', motivo: '', campos: ['origem'] }), /motivo/)
  assert.throws(() => validateReturn('fleet', { tipo: 'correcao', motivo: 'abc', campos: [] }), /campos/)
  assert.throws(() => validateReturn('fleet', { tipo: 'correcao', motivo: 'abc', campos: ['status'] }), /campo/)
  assert.deepEqual(validateReturn('fleet', { tipo: 'complementacao', motivo: 'abc' }).fields, [])
  assert.deepEqual(validateReturn('fleet', { tipo: 'correcao', motivo: 'abc', campos: ['origem', 'origem'] }).fields, ['origem'])

  assert.deepEqual(
    pickCorrections(['origem'], { origem: 'A', destino: 'B', solicitanteId: 'x', status: 'concluido' }),
    { origem: 'A' },
  )
  assert.deepEqual(pickCorrections(['origem'], null), {})
  assert.equal(canReturnFromStatus('agendado'), true)
  assert.equal(canReturnFromStatus('em_andamento'), false)
  assert.equal(canReturnFromStatus('concluido'), false)
})

test('tempo: a espera do solicitante não conta como tempo interno', () => {
  const createdAt = new Date('2031-01-01T00:00:00.000Z')
  const now = new Date('2031-01-01T10:00:00.000Z')
  assert.deepEqual(requestTiming({ createdAt, closedAt: null, pausedSeconds: 3600, waitingSince: null }, now), {
    requesterWaitSeconds: 3600,
    internalSeconds: 32400,
    totalSeconds: 36000,
  })
  // Espera em aberto conta até agora; encerrada a solicitação, conta até o encerramento.
  const waiting = requestTiming({ createdAt, closedAt: null, pausedSeconds: 0, waitingSince: new Date('2031-01-01T09:00:00.000Z') }, now)
  assert.equal(waiting.requesterWaitSeconds, 3600)
  const closed = requestTiming({ createdAt, closedAt: new Date('2031-01-01T02:00:00.000Z'), pausedSeconds: 600, waitingSince: null }, now)
  assert.deepEqual([closed.totalSeconds, closed.internalSeconds], [7200, 6600])
})

const probe: DuplicateProbe = {
  requesterId: 'u1',
  sector: 'Protocolo',
  floorId: 'f1',
  serviceTypeId: 's1',
  location: 'Sala de reuniões',
  vehicle: null,
  origin: null,
  destination: null,
  date: null,
  description: 'Lâmpada queimada na sala de reuniões do terceiro andar',
}

test('duplicidade: alerta por conteúdo, sem acusar só por ser do mesmo setor', () => {
  const twin = compareDuplicate(probe, { ...probe, description: 'Lampada queimada na sala de reunioes, terceiro andar' })
  assert.equal(twin.possibleDuplicate, true)
  assert.ok(twin.reasons.includes('Mesma categoria'))
  assert.ok(twin.reasons.includes('Mesmo local'))

  const sameTeam = compareDuplicate(probe, {
    ...probe,
    serviceTypeId: 's2',
    location: 'Garagem',
    description: 'Portão não abre',
  })
  assert.equal(sameTeam.possibleDuplicate, false, 'mesma pessoa, setor e andar não bastam')

  const fleet = { ...probe, serviceTypeId: null, location: null, floorId: null, description: null, origin: 'Sede', destination: 'Fórum', date: '2031-05-10T13:00:00.000Z' }
  assert.equal(compareDuplicate(fleet, { ...fleet, requesterId: 'u2' }).possibleDuplicate, true)
  assert.equal(
    compareDuplicate(fleet, { ...fleet, requesterId: 'u2', sector: 'Outro', origin: 'Outra', date: '2031-09-10T13:00:00.000Z' }).possibleDuplicate,
    false,
  )
  assert.equal(textSimilarity(null, 'abc'), 0)
})

test('modelos: só variáveis conhecidas, sem marcação, e dado ausente some do texto', () => {
  assert.equal(templateTextProblem('Olá {{nome_solicitante}}, protocolo {{ protocolo }}'), null)
  assert.match(templateTextProblem('{{cpf}}') ?? '', /desconhecida/)
  assert.match(templateTextProblem('<b>x</b>') ?? '', /< >/)
  assert.match(templateTextProblem('{protocolo}') ?? '', /chaves/)
  assert.deepEqual(citedVariables('{{data}} e {{horario}}'), ['data', 'horario'])
  assert.equal(fillTemplate('Protocolo {{protocolo}} {{justificativa}} fim', { protocolo: 'MAN-1' }), 'Protocolo MAN-1 fim')
  assert.deepEqual(fillLines('Protocolo {{protocolo}}\nSetor: {{setor}}\n\nFim', { protocolo: 'MAN-1' }), ['Protocolo MAN-1', 'Fim'], 'linha sem dado sai inteira')
  assert.match(templateTextProblem('{{justificativa}}', ['protocolo']) ?? '', /não existe neste evento/)
})

test('variáveis: cada evento só oferece o que tem, e passagens não leva descrição', () => {
  const flight = variablesForEvent({ modules: ['flights'], reason: true })
  assert.ok(flight.includes('justificativa'))
  assert.ok(!flight.includes('descricao'))
  assert.ok(!flight.includes('responsavel'))
  assert.ok(!flight.includes('data_agendada'))
  assert.ok(variablesForEvent({ modules: ['maintenance', 'fleet'], schedule: true }).includes('data_agendada'))
  assert.ok(variablesForEvent({ modules: ['warehouse'] }).includes('quantidade_disponibilizada'))
  assert.ok(!variablesForEvent({ modules: ['system'] }).includes('nome_solicitante'))
})

const report: ReportDocument = {
  title: 'Relatório da solicitação',
  subtitle: 'Protocolo MAN-2031-00001 (teste)',
  generatedAt: new Date('2031-01-01T12:00:00.000Z'),
  generatedBy: 'Pessoa Fictícia',
  sections: [
    { heading: 'Dados principais', rows: [['Situação', 'Agendado'], ['Fórmula', '=1+1']] },
    { heading: 'Histórico', entries: Array.from({ length: 120 }, (_, index) => `Evento ${index} → com acentuação e ${'palavra '.repeat(30)}`) },
  ],
}

test('PDF: arquivo válido, com acentos, parênteses escapados e várias páginas', () => {
  const pdf = renderReportPdf(report)
  const text = pdf.toString('latin1')
  assert.ok(text.startsWith('%PDF-1.4'))
  assert.ok(text.trimEnd().endsWith('%%EOF'))
  assert.ok(text.includes('Relatório da solicitação'), 'acentos em Latin-1')
  assert.ok(text.includes('MAN-2031-00001 \\(teste\\)'), 'parênteses escapados')
  assert.ok(text.includes('->'), 'seta trocada por texto')
  assert.ok((text.match(/\/Type \/Page /g) ?? []).length > 1, 'mais de uma página')

  // A tabela de referências aponta para o início de cada objeto.
  const start = Number(/startxref\n(\d+)/.exec(text)?.[1])
  assert.ok(text.slice(start).startsWith('xref'))
  const offsets = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map(([, offset]) => Number(offset))
  offsets.forEach((offset, index) => {
    assert.ok(text.slice(offset).startsWith(`${index + 1} 0 obj`), `objeto ${index + 1}`)
  })
})

test('CSV: acentos preservados e célula de fórmula neutralizada', () => {
  const csv = renderReportCsv(report)
  assert.ok(csv.startsWith('﻿'))
  assert.ok(csv.includes('"Situação";"Agendado"'))
  assert.ok(csv.includes(`"'=1+1"`))
})

const frontendFile = (path: string) => readFileSync(resolve(process.cwd(), 'frontend/src', path), 'utf8')

test('avisos institucionais: texto exato, nos quatro formulários, antes do envio e com a LGPD', () => {
  const notices = frontendFile('app/serviceNotices.ts')
  for (const text of [
    'O atendimento das solicitações está sujeito à disponibilidade operacional do setor responsável. A data, o horário e as condições solicitadas poderão ser ajustados conforme a disponibilidade e as necessidades do serviço. O envio da solicitação não garante o atendimento nas condições inicialmente solicitadas.',
    'O atendimento das solicitações está sujeito à disponibilidade operacional do setor responsável. A data, o horário e as condições de transporte solicitadas poderão ser ajustados conforme a disponibilidade de veículos, motoristas e as necessidades do serviço. O envio da solicitação não garante o atendimento nas condições inicialmente solicitadas.',
    'As solicitações de passagens aéreas estão sujeitas à análise, disponibilidade de voos, condições tarifárias e aprovações necessárias. As opções, datas e horários inicialmente solicitados poderão sofrer alterações durante o processo de cotação e emissão. O envio da solicitação não garante a emissão da passagem nas condições inicialmente pretendidas.',
    'O fornecimento de materiais está sujeito à disponibilidade de estoque e à avaliação da necessidade apresentada. A quantidade disponibilizada poderá ser diferente da quantidade solicitada, podendo ocorrer atendimento parcial ou não fornecimento de determinados materiais, mesmo quando houver saldo em estoque. A disponibilização observará os critérios de necessidade e a gestão adequada dos materiais.',
  ]) {
    assert.ok(notices.includes(text), text.slice(0, 50))
  }
  assert.match(frontendFile('components/FormNotices.tsx'), /<PrivacyNotice module=\{module\} \/>/)

  for (const [path, module, submit] of [
    ['pages/MaintenanceRequestPage.tsx', 'maintenance', 'type="submit"'],
    ['pages/FleetRequestPage.tsx', 'fleet', 'type="submit"'],
    ['pages/AirTravelRequestPage.tsx', 'flights', 'type="submit"'],
    ['pages/WarehousePortalPage.tsx', 'warehouse', 'onClick={() => void submit()}'],
  ]) {
    const source = frontendFile(path)
    const notice = source.indexOf(`<FormNotices module="${module}" />`)
    assert.ok(notice > 0, `${path} perdeu o aviso`)
    assert.ok(notice < source.indexOf(submit), `${path}: o aviso precisa vir antes do envio`)
  }
})
