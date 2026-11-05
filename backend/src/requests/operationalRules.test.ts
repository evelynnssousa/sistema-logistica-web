import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { isInstitutionalEmailAllowed } from '../auth/institutionalEmail.js'
import {
  generatePasswordRecoveryToken,
  hashPasswordRecoveryToken,
  isPasswordRecoveryToken,
  passwordRecoveryLink,
} from '../auth/passwordRecovery.js'
import { processPasswordRecoveryRequest } from '../auth/passwordRecoveryService.js'
import {
  CpfProtectionUnavailableError,
  decryptCpf,
  encryptCpf,
  isValidCpf,
} from './cpfProtection.js'
import {
  RequestValidationError,
  likePattern,
  maxPassengers,
  readPeriod,
  validateCompletion,
  validateFleet,
  validateFlightCreation,
  validateMaintenance,
  validateOccurrence,
  validatePassengerUpdate,
  validateSchedule,
} from './validation.js'
import {
  canMoveWarehouseStatus,
  flightStatuses,
  inventoryItemSituation,
  isTerminalStatus,
  nextStatus,
  normalizeStatus,
  operationalStatuses,
  storedValuesFor,
  warehouseStatusMatchesItems,
} from './workflow.js'

// Números sem dono: base fictícia com dígitos verificadores calculados.
const fictionalCpf = '00000000191'
const otherFictionalCpf = '00000000272'
const uuid = '00000000-0000-4000-8000-000000000001'

const invalid = (action: () => unknown) => assert.throws(action, RequestValidationError)

test('o fluxo de Manutenção e Frota só aceita as transições institucionais', () => {
  const allowed: Array<[string, string, string]> = [
    ['aguardando_agendamento', 'schedule', 'agendado'],
    ['agendado', 'schedule', 'reagendado'],
    ['reagendado', 'schedule', 'reagendado'],
    ['agendado', 'start', 'em_andamento'],
    ['reagendado', 'start', 'em_andamento'],
    ['em_andamento', 'complete', 'concluido'],
    ['aguardando_agendamento', 'cancel', 'cancelado'],
    ['agendado', 'cancel', 'cancelado'],
    ['reagendado', 'cancel', 'cancelado'],
    ['em_andamento', 'cancel', 'cancelado'],
  ]

  for (const module of ['maintenance', 'fleet'] as const) {
    for (const status of operationalStatuses) {
      for (const action of ['schedule', 'start', 'complete', 'cancel', 'advance'] as const) {
        const expected = allowed.find(([from, verb]) => from === status && verb === action)?.[2] ?? null
        assert.equal(nextStatus(module, status, action), expected, `${module} ${status} ${action}`)
      }
    }
  }
})

test('passagens seguem cotação, aprovação, emissão e emitida, sem agendamento nem atalhos', () => {
  assert.equal(nextStatus('flights', 'em_cotacao', 'advance'), 'aguardando_aprovacao')
  assert.equal(nextStatus('flights', 'aguardando_aprovacao', 'advance'), 'em_emissao')
  assert.equal(nextStatus('flights', 'em_emissao', 'advance'), 'emitida')
  assert.equal(nextStatus('flights', 'emitida', 'advance'), null)
  assert.equal(nextStatus('flights', 'emitida', 'cancel'), null)
  assert.equal(nextStatus('flights', 'cancelada', 'advance'), null)
  for (const status of flightStatuses) {
    assert.equal(nextStatus('flights', status, 'schedule'), null)
    assert.equal(nextStatus('flights', status, 'start'), null)
  }
})

test('status encerrados são terminais', () => {
  for (const status of ['concluido', 'cancelado', 'emitida', 'cancelada'] as const) {
    assert.equal(isTerminalStatus(status), true)
  }
  assert.equal(isTerminalStatus('em_andamento'), false)
})

test('status antigos são traduzidos na leitura, e o filtro os alcança', () => {
  assert.equal(normalizeStatus('maintenance', 'pendente'), 'aguardando_agendamento')
  assert.equal(normalizeStatus('fleet', 'agendada'), 'agendado')
  assert.equal(normalizeStatus('maintenance', 'cancelada'), 'cancelado')
  assert.equal(normalizeStatus('flights', 'pendente'), 'em_cotacao')
  assert.equal(normalizeStatus('flights', 'cancelada'), 'cancelada')
  assert.throws(() => normalizeStatus('fleet', 'inventado'))

  assert.deepEqual(storedValuesFor('maintenance', 'concluido').sort(), ['concluida', 'concluido'])
  assert.ok(storedValuesFor('flights', 'em_cotacao').includes('pendente'))
})

test('almoxarifado: entrega só depois de atendido, e status confere com as quantidades', () => {
  assert.equal(canMoveWarehouseStatus('pendente', 'entregue'), false)
  assert.equal(canMoveWarehouseStatus('atendido', 'entregue'), true)
  assert.equal(canMoveWarehouseStatus('atendido_parcial', 'entregue'), true)
  assert.equal(canMoveWarehouseStatus('entregue', 'cancelado'), false)
  assert.equal(canMoveWarehouseStatus('rejeitado', 'pendente'), false)

  const full = [{ requested: 2, fulfilled: 2 }]
  const part = [{ requested: 2, fulfilled: 1 }]
  const none = [{ requested: 2, fulfilled: 0 }]
  assert.equal(warehouseStatusMatchesItems('atendido', full), true)
  assert.equal(warehouseStatusMatchesItems('atendido', part), false)
  assert.equal(warehouseStatusMatchesItems('atendido_parcial', part), true)
  assert.equal(warehouseStatusMatchesItems('atendido_parcial', full), false)
  assert.equal(warehouseStatusMatchesItems('atendido_parcial', none), false)
  assert.equal(warehouseStatusMatchesItems('pendente', none), true)
})

test('conferência: situação vem da comparação das quantidades', () => {
  assert.equal(inventoryItemSituation(10, null), 'pendente')
  assert.equal(inventoryItemSituation(10, 10), 'confere')
  assert.equal(inventoryItemSituation(10, 8), 'divergente')
  assert.equal(inventoryItemSituation(0, 0), 'confere')
})

test('CPF: valida os dígitos e recusa sequências', () => {
  assert.equal(isValidCpf(fictionalCpf), true)
  assert.equal(isValidCpf('00000000192'), false)
  assert.equal(isValidCpf('11111111111'), false)
  assert.equal(isValidCpf('123'), false)
})

test('CPF cifrado: o número não fica legível, e sem chave nada é cifrado nem lido', () => {
  const environment = { PASSENGER_DATA_KEY: randomBytes(32).toString('base64') }
  const encrypted = encryptCpf(fictionalCpf, environment)

  assert.ok(!encrypted.includes(fictionalCpf))
  assert.notEqual(encrypted, encryptCpf(fictionalCpf, environment))
  assert.equal(decryptCpf(encrypted, environment), fictionalCpf)

  assert.throws(() => encryptCpf(fictionalCpf, {}), CpfProtectionUnavailableError)
  assert.throws(
    () => encryptCpf(fictionalCpf, { PASSENGER_DATA_KEY: 'curta' }),
    CpfProtectionUnavailableError,
  )
  assert.throws(() => decryptCpf(encrypted, {}), CpfProtectionUnavailableError)
  assert.throws(() =>
    decryptCpf(encrypted, { PASSENGER_DATA_KEY: randomBytes(32).toString('base64') }),
  )

  const [version, iv, tag, data] = encrypted.split('.')
  const tampered = Buffer.from(data, 'base64')
  tampered[0] ^= 1
  assert.throws(() =>
    decryptCpf([version, iv, tag, tampered.toString('base64')].join('.'), environment),
  )
})

test('manutenção exige andar, tipo, local e descrição', () => {
  const body = {
    andarId: uuid,
    tipoServicoId: uuid,
    localServico: 'Sala de reuniões',
    descricao: 'Lâmpada queimada',
  }
  assert.equal(validateMaintenance(body).priority, 'normal')
  for (const key of Object.keys(body)) invalid(() => validateMaintenance({ ...body, [key]: '' }))
  invalid(() => validateMaintenance({ ...body, andarId: 'qualquer' }))
  invalid(() => validateMaintenance({ ...body, prioridade: 'máxima' }))
  invalid(() => validateMaintenance({ ...body, customFields: { 'a b': 'x' } }))
  invalid(() => validateMaintenance({ ...body, customFields: { campo: 1 } }))
})

test('frota exige origem, destino, data e serviço, com retorno depois da saída', () => {
  const body = {
    origem: 'Sede',
    destino: 'Fórum',
    dataHora: '2027-01-10T10:00:00.000Z',
    finalidade: 'Entrega de documentos',
    passageiros: [{ nome: 'Pessoa Fictícia' }],
  }
  const valid = validateFleet(body)
  assert.deepEqual(valid.details.passageiros, [{ nome: 'Pessoa Fictícia' }])
  assert.equal(valid.details.dataHoraRetorno, null)

  for (const key of ['origem', 'destino', 'dataHora', 'finalidade']) {
    invalid(() => validateFleet({ ...body, [key]: '' }))
  }
  invalid(() => validateFleet({ ...body, dataHoraRetorno: '2027-01-10T09:00:00.000Z' }))
  invalid(() => validateFleet({ ...body, passageiros: 'todos' }))
  invalid(() => validateFleet({ ...body, passageiros: [{ nome: '' }] }))
})

test('passagens: tipos de viagem, ordem das datas, passageiros e consentimento', () => {
  const ida = { origem: 'GRU', destino: 'BSB', data: '2027-02-01', horario: '08:00' }
  const volta = { origem: 'BSB', destino: 'GRU', data: '2027-02-03', horario: '18:00' }
  const passageiros = [{ nome: 'Pessoa Fictícia', cpf: '000.000.001-91' }]
  const base = { andarId: uuid, lgpdAceite: true, passageiros }

  const roundTrip = validateFlightCreation({ ...base, tipoViagem: 'ida_volta', ida, volta })
  assert.equal(roundTrip.passengers[0].cpf, fictionalCpf)
  assert.ok(!JSON.stringify(roundTrip.details).includes(fictionalCpf), 'CPF fora de dados')

  assert.equal(
    validateFlightCreation({ ...base, tipoViagem: 'somente_volta', volta }).details.ida,
    null,
  )
  assert.equal(
    validateFlightCreation({ ...base, tipoViagem: 'somente_ida', ida }).details.volta,
    null,
  )

  invalid(() => validateFlightCreation({ ...base, tipoViagem: 'somente_volta', ida }))
  invalid(() => validateFlightCreation({ ...base, tipoViagem: 'somente_ida', volta }))
  invalid(() => validateFlightCreation({ ...base, tipoViagem: 'outra', ida, volta }))
  invalid(() =>
    validateFlightCreation({
      ...base,
      tipoViagem: 'ida_volta',
      ida,
      volta: { ...volta, data: '2027-01-30' },
    }),
  )
  // O aviso de privacidade não é consentimento: enviar não depende de aceite.
  assert.equal(
    validateFlightCreation({ andarId: uuid, passageiros, tipoViagem: 'somente_ida', ida }).passengers.length,
    passageiros.length,
  )
  invalid(() => validateFlightCreation({ ...base, passageiros: [], tipoViagem: 'somente_ida', ida }))
  invalid(() =>
    validateFlightCreation({
      ...base,
      passageiros: [{ nome: 'Pessoa Fictícia', cpf: '00000000192' }],
      tipoViagem: 'somente_ida',
      ida,
    }),
  )
  invalid(() =>
    validateFlightCreation({
      ...base,
      passageiros: [passageiros[0], passageiros[0]],
      tipoViagem: 'somente_ida',
      ida,
    }),
  )
  invalid(() =>
    validateFlightCreation({
      ...base,
      passageiros: Array.from({ length: maxPassengers + 1 }, () => passageiros[0]),
      tipoViagem: 'somente_ida',
      ida,
    }),
  )
})

test('edição de passageiros: conhecido pode vir sem CPF, novo não', () => {
  const kept = validatePassengerUpdate({ passageiros: [{ id: uuid, nome: 'Pessoa Fictícia' }] })
  assert.equal(kept[0].cpf, null)
  invalid(() => validatePassengerUpdate({ passageiros: [{ nome: 'Pessoa Fictícia' }] }))
  assert.equal(
    validatePassengerUpdate({
      passageiros: [{ nome: 'Pessoa Fictícia', cpf: otherFictionalCpf }],
    })[0].cpf,
    otherFictionalCpf,
  )
})

test('agendamento e execução recusam datas incoerentes', () => {
  assert.equal(
    validateSchedule({ dataAgendada: '2027-01-10T10:00:00Z' }).responsibleId,
    null,
  )
  invalid(() => validateSchedule({ dataAgendada: 'amanhã' }))
  invalid(() => validateSchedule({ dataAgendada: '+020000-01-01T00:00:00.000Z' }))
  invalid(() =>
    validateSchedule({ dataAgendada: '2027-01-10T10:00:00Z', dataFim: '2027-01-10T09:00:00Z' }),
  )
  const now = new Date('2027-01-10T10:00:00Z')
  invalid(() => validateCompletion({ fimReal: '2027-01-10T12:00:00Z' }, now))
  assert.equal(validateCompletion({}, now).finishedAt, now)
})

test('atraso exige minutos; ocorrência comum, não', () => {
  assert.equal(validateOccurrence({ tipo: 'ocorrencia', descricao: 'Pneu furado' }).delayMinutes, null)
  assert.equal(
    validateOccurrence({ tipo: 'atraso', descricao: 'Trânsito', atrasoMinutos: 30 }).delayMinutes,
    30,
  )
  invalid(() => validateOccurrence({ tipo: 'atraso', descricao: 'Trânsito' }))
  invalid(() => validateOccurrence({ tipo: 'outro', descricao: 'Trânsito' }))
})

test('filtros: período inválido é recusado, e curingas viram texto literal', () => {
  invalid(() => readPeriod({ from: 'ontem' }))
  invalid(() => readPeriod({ from: '2027-02-01', to: '2027-01-01' }))
  assert.equal(likePattern('100%_a\\b'), '%100\\%\\_a\\\\b%')
})

test('e-mail institucional: sem lista não restringe; com lista, só os domínios dela', () => {
  assert.equal(isInstitutionalEmailAllowed('pessoa@qualquer.org', {}), true)
  const environment = { INSTITUTIONAL_EMAIL_DOMAINS: 'orgao.example, outro.example' }
  assert.equal(isInstitutionalEmailAllowed('Pessoa@ORGAO.example', environment), true)
  assert.equal(isInstitutionalEmailAllowed('pessoa@outro.example', environment), true)
  assert.equal(isInstitutionalEmailAllowed('pessoa@orgao.example.net', environment), false)
  assert.equal(isInstitutionalEmailAllowed('pessoa@sub.orgao.example', environment), false)
})

test('link de recuperação: token forte, só em https, depois de # no endereço', () => {
  const token = generatePasswordRecoveryToken()
  assert.equal(isPasswordRecoveryToken(token), true)
  assert.equal(isPasswordRecoveryToken('123456'), false)
  assert.notEqual(hashPasswordRecoveryToken(token, 'p'), hashPasswordRecoveryToken(token, 'q'))
  assert.throws(() => hashPasswordRecoveryToken(token, ''))

  assert.equal(
    passwordRecoveryLink(token, 'https://sistema.example/caminho'),
    `https://sistema.example/#recuperar-senha=${token}`,
  )
  assert.equal(passwordRecoveryLink(token, 'http://sistema.example'), null)
  assert.ok(passwordRecoveryLink(token, 'http://localhost:5173'))
  assert.equal(passwordRecoveryLink(token, ''), null)
  assert.equal(passwordRecoveryLink(token, 'qualquer coisa'), null)
})

test('com endereço público, o e-mail leva o link; sem ele, continua o código', async () => {
  process.env.PASSWORD_RESET_PEPPER = 'segredo-de-teste'
  try {
    const created: string[] = []
    const sent: string[] = []
    const base = {
      isConfigured: () => true,
      createCode: async (email: string, hash: string) => {
        created.push(hash)
        return { id: 'id', email }
      },
      invalidateCodes: async () => {},
      send: async (_recipient: string, code: string) => void sent.push(`codigo:${code}`),
    }

    await processPasswordRecoveryRequest('pessoa@orgao.example', {
      ...base,
      link: {
        build: (token) => `https://sistema.example/#recuperar-senha=${token}`,
        send: async (_recipient, link) => void sent.push(link),
      },
    })
    const token = sent[0].split('=')[1]
    assert.equal(created[0], hashPasswordRecoveryToken(token))

    await processPasswordRecoveryRequest('pessoa@orgao.example', {
      ...base,
      link: { build: () => null, send: async () => assert.fail('não envia link') },
    })
    assert.match(sent[1], /^codigo:\d{6}$/)
  } finally {
    delete process.env.PASSWORD_RESET_PEPPER
  }
})
