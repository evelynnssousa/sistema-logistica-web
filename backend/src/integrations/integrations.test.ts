import assert from 'node:assert/strict'
import { test } from 'node:test'
import { retryDelayMinutes } from '../database/integrationRepository.js'
import {
  eventCatalog,
  flightEventFor,
  listTemplates,
  renderEmail,
  renderNotification,
  renderSubject,
  resourcePath,
  teamPermissions,
  warehouseEventFor,
} from './catalog.js'
import type { EventType } from './catalog.js'
import {
  carbonCopies,
  emailMode,
  integrationStatus,
  internalRecipients,
  pendingReminderDays,
  publicLink,
  shouldRunIntegrationWorker,
} from './config.js'
import { maskEmail, redactForOutbound, redactValidCpf } from './redaction.js'
import {
  createResendTransport,
  IntegrationError,
  resolveEmailTransport,
} from './transports.js'

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv

const validCpf = '00000000191'

test('redação: o que sai do sistema mascara qualquer formato de CPF', () => {
  for (const text of [`CPF ${validCpf}`, 'CPF 000.000.001-91', 'CPF 123.456.789-00']) {
    const result = redactForOutbound(text)
    assert.equal(result, 'CPF ***.***.***-**')
  }
  assert.equal(redactForOutbound('Protocolo 1234'), 'Protocolo 1234')
})

test('redação: no histórico, só CPF válido é mascarado, para manter telefones', () => {
  assert.equal(redactValidCpf(`CPF ${validCpf}`), 'CPF ***.***.***-**')
  assert.equal(redactValidCpf('Motorista: 11987654321'), 'Motorista: 11987654321')
})

test('e-mail mascarado não revela o endereço', () => {
  assert.equal(maskEmail('pessoa@orgao.sp.gov.br'), 'pe***@orgao.sp.gov.br')
  assert.equal(maskEmail('a@b.br'), 'a***@b.br')
  assert.equal(maskEmail('invalido'), '***')
})

const everyType = Object.keys(eventCatalog) as EventType[]

const sensitiveContext = {
  module: 'maintenance',
  protocol: '77',
  title: `Sala ${validCpf}`,
  reason: `Pedido de 000.000.001-91 <script>alert(1)</script>`,
  scheduledAt: '2030-01-15T13:00:00.000Z',
  delayMinutes: 5,
  total: 2,
  days: 3,
  channel: 'email',
} as const

test('nenhum modelo deixa passar CPF, e o HTML é sempre escapado', () => {
  for (const type of everyType) {
    const email = renderEmail(type, sensitiveContext, 'https://sistema.example.gov.br/x')
    const notification = renderNotification(type, sensitiveContext)
    for (const text of [email.subject, email.text, email.html, notification.title, notification.message]) {
      assert.ok(!text.includes(validCpf), `${type} expôs CPF`)
      assert.ok(!text.includes('000.000.001-91'), `${type} expôs CPF formatado`)
    }
    assert.ok(!email.html.includes('<script>'), `${type} não escapou o HTML`)
  }
})

test('a notificação interna não repete motivos nem assunto', () => {
  const notification = renderNotification('request_cancelled', sensitiveContext)
  assert.ok(!notification.message.includes('Pedido'))
  assert.ok(!notification.message.includes('Sala'))
})

test('o assunto identifica o evento, o módulo e o protocolo', () => {
  assert.equal(
    renderSubject('request_received', { module: 'fleet', protocol: '12' }),
    'Solicitação recebida - Frota #12 - JUCESP',
  )
})

test('o e-mail só leva link quando há endereço público', () => {
  const withoutLink = renderEmail('request_received', { module: 'fleet', protocol: '1' }, null)
  assert.ok(!withoutLink.text.includes('Acompanhe'))
  assert.equal(publicLink('/frota/1', env({})), null)
  assert.equal(publicLink('/frota/1', env({ APP_PUBLIC_URL: 'http://inseguro.example' })), null)
  assert.equal(
    publicLink('/frota/1', env({ APP_PUBLIC_URL: 'https://sistema.example.gov.br/' })),
    'https://sistema.example.gov.br/frota/1',
  )
})

test('os fluxos pedidos têm modelo em cada módulo', () => {
  const coverage = (module: string) =>
    everyType.filter((type) => (eventCatalog[type].modules as readonly string[]).includes(module))

  for (const module of ['maintenance', 'fleet']) {
    for (const type of [
      'request_received',
      'request_scheduled',
      'request_rescheduled',
      'request_started',
      'request_completed',
      'request_cancelled',
    ] as EventType[]) {
      assert.ok(coverage(module).includes(type), `${module} sem ${type}`)
    }
  }
  assert.ok(coverage('fleet').includes('request_occurrence'))
  for (const type of ['request_received', 'flight_approval_needed', 'flight_approved', 'flight_issued', 'request_cancelled', 'pending_reminder'] as EventType[]) {
    assert.ok(coverage('flights').includes(type), `Passagens sem ${type}`)
  }
  for (const type of ['warehouse_received', 'warehouse_in_review', 'warehouse_partial', 'warehouse_ready', 'warehouse_delivered', 'pending_reminder'] as EventType[]) {
    assert.ok(coverage('warehouse').includes(type), `Almoxarifado sem ${type}`)
  }
})

test('as mudanças de status geram o acontecimento certo', () => {
  assert.equal(flightEventFor('aguardando_aprovacao'), 'flight_approval_needed')
  assert.equal(flightEventFor('em_emissao'), 'flight_approved')
  assert.equal(flightEventFor('emitida'), 'flight_issued')
  assert.equal(flightEventFor('em_cotacao'), null)
  assert.equal(warehouseEventFor('atendido_parcial'), 'warehouse_partial')
  assert.equal(warehouseEventFor('atendido'), 'warehouse_ready')
  assert.equal(warehouseEventFor('entregue'), 'warehouse_delivered')
  assert.equal(warehouseEventFor('pendente'), null)
})

test('a equipe notificada precisa conseguir abrir o registro', () => {
  assert.deepEqual(teamPermissions('fleet'), ['fleet:update', 'fleet:read', 'requests:read_all'])
  assert.deepEqual(teamPermissions('warehouse'), ['warehouse:manage'])
  assert.deepEqual(teamPermissions('system'), ['integrations:manage'])
  assert.equal(resourcePath('warehouse', 'abc'), '/almoxarifado/pedidos/abc')
  assert.equal(resourcePath('fleet', null), '/frota')
  assert.equal(resourcePath('system', null), '/integracoes')
})

test('os modelos consultáveis usam só exemplos fictícios', () => {
  const templates = listTemplates()
  assert.equal(templates.length, everyType.length)
  assert.ok(templates.every((template) => template.subject && template.body))
})

test('sem autorização explícita, nenhum e-mail é enviado, mesmo com as credenciais', () => {
  const keys = { RESEND_API_KEY: 'chave', RESEND_FROM: 'remetente@example.gov.br' }
  assert.equal(emailMode(env({})), 'none')
  assert.equal(emailMode(env(keys)), 'none')
  assert.equal(resolveEmailTransport(env(keys)), null)
  assert.equal(emailMode(env({ ...keys, NOTIFICATION_EMAILS_ENABLED: 'true' })), 'provider')
  assert.equal(emailMode(env({ NOTIFICATION_EMAILS_ENABLED: 'true' })), 'none')
})

test('em ambiente de teste, o provedor real nunca é escolhido', () => {
  const real = {
    NODE_ENV: 'test',
    RESEND_API_KEY: 'chave',
    RESEND_FROM: 'remetente@example.gov.br',
    NOTIFICATION_EMAILS_ENABLED: 'true',
  }
  assert.equal(emailMode(env(real)), 'none')
})

test('o transporte simulado nunca vale em produção', () => {
  const production = { NODE_ENV: 'production', EMAIL_TRANSPORT: 'simulated' }
  assert.equal(emailMode(env(production)), 'none')
})

test('o worker não roda sozinho fora de produção', () => {
  assert.equal(shouldRunIntegrationWorker(env({})), false)
  assert.equal(shouldRunIntegrationWorker(env({ NODE_ENV: 'development' })), false)
  assert.equal(shouldRunIntegrationWorker(env({ NODE_ENV: 'production' })), true)
  assert.equal(shouldRunIntegrationWorker(env({ NODE_ENV: 'production', INTEGRATIONS_WORKER_ENABLED: 'false' })), false)
  assert.equal(shouldRunIntegrationWorker(env({ INTEGRATIONS_WORKER_ENABLED: 'true' })), true)
})

test('destinatários vêm só da configuração, e o que for inválido é ignorado', (context) => {
  context.mock.method(console, 'warn', () => {})
  assert.deepEqual(internalRecipients('fleet', env({})), [])
  assert.deepEqual(carbonCopies('fleet', env({})), [])
  assert.deepEqual(
    internalRecipients('fleet', env({ EMAIL_INTERNAL_TO_FLEET: 'A@orgao.gov.br, invalido, a@orgao.gov.br' })),
    ['a@orgao.gov.br'],
  )
})

test('o lembrete de pendências só existe com um prazo definido', () => {
  assert.equal(pendingReminderDays(env({})), null)
  assert.equal(pendingReminderDays(env({ NOTIFICATION_PENDING_DAYS: 'x' })), null)
  assert.equal(pendingReminderDays(env({ NOTIFICATION_PENDING_DAYS: '5' })), 5)
})

test('a situação das integrações nunca devolve os valores configurados', () => {
  const secret = 'valor-secreto-de-teste'
  const status = integrationStatus(
    env({
      RESEND_API_KEY: secret,
      RESEND_FROM: `${secret}@example.gov.br`,
      EMAIL_INTERNAL_TO_FLEET: `${secret}@example.gov.br`,
    }),
  )
  assert.ok(!JSON.stringify(status).includes(secret))
  assert.equal(status.email.internalRecipients.fleet, 1)
  // A integração com o Google Calendar foi removida: a situação não fala mais em calendário externo.
  assert.equal('calendar' in status, false)
})

test('as esperas entre tentativas crescem e têm limite', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(retryDelayMinutes), [1, 5, 30, 120, 120, 120])
})

// ---------------------------------------------------------------------------
// Resend: cliente falso, sem rede.
// ---------------------------------------------------------------------------
function fakeResend(reply: () => unknown) {
  const calls: { payload: Record<string, unknown>; options: Record<string, unknown> }[] = []
  return {
    calls,
    client: {
      emails: {
        send: async (payload: Record<string, unknown>, options: Record<string, unknown>) => {
          calls.push({ payload, options })
          return reply()
        },
        get: async () => ({ data: { last_event: 'delivered' }, error: null }),
      },
    } as never,
  }
}

const outgoing = {
  idempotencyKey: 'slm-1',
  to: 'pessoa@orgao.sp.gov.br',
  cc: [],
  subject: 'Assunto',
  text: 'Texto',
  html: '<p>Texto</p>',
}

test('Resend: envia com chave de idempotência e lê a situação de entrega', async () => {
  const fake = fakeResend(() => ({ data: { id: 'msg-1' }, error: null }))
  const transport = createResendTransport(fake.client, 'remetente@orgao.sp.gov.br')

  assert.deepEqual(await transport.send(outgoing), { messageId: 'msg-1' })
  assert.equal(fake.calls[0].options.idempotencyKey, 'slm-1')
  assert.equal(fake.calls[0].payload.cc, undefined)
  assert.equal(await transport.deliveryStatus!('msg-1'), 'delivered')
})

test('Resend: endereços de teste nunca chegam ao provedor', async () => {
  const fake = fakeResend(() => ({ data: { id: 'x' }, error: null }))
  const transport = createResendTransport(fake.client, 'remetente@orgao.sp.gov.br')

  for (const message of [
    { ...outgoing, to: 'pessoa@example.gov.br' },
    { ...outgoing, cc: ['copia@teste.invalid'] },
  ]) {
    await assert.rejects(transport.send(message), (error: IntegrationError) => {
      assert.equal(error.code, 'RESERVED_ADDRESS')
      assert.equal(error.retryable, false)
      return true
    })
  }
  assert.equal(fake.calls.length, 0)
})

test('Resend: separa falha temporária de definitiva, sem guardar a mensagem do provedor', async () => {
  const cases: [number | null, string, boolean][] = [
    [429, 'RESEND_429', true],
    [500, 'RESEND_500', true],
    [null, 'RESEND_ERROR', true],
    [422, 'RESEND_422', false],
    [403, 'RESEND_403', false],
  ]
  for (const [statusCode, code, retryable] of cases) {
    const fake = fakeResend(() => ({
      data: null,
      error: { statusCode, message: 'pessoa@orgao.sp.gov.br recusado', name: 'erro' },
    }))
    const transport = createResendTransport(fake.client, 'remetente@orgao.sp.gov.br')
    await assert.rejects(transport.send(outgoing), (error: IntegrationError) => {
      assert.equal(error.code, code)
      assert.equal(error.retryable, retryable)
      assert.ok(!error.message.includes('pessoa@'))
      return true
    })
  }
})

test('Resend: falha de rede é repetida', async () => {
  const transport = createResendTransport(
    fakeResend(() => {
      throw new Error('pessoa@orgao.sp.gov.br')
    }).client,
    'remetente@orgao.sp.gov.br',
  )
  await assert.rejects(transport.send(outgoing), (error: IntegrationError) => {
    assert.equal(error.code, 'NETWORK')
    assert.equal(error.retryable, true)
    return true
  })
})
