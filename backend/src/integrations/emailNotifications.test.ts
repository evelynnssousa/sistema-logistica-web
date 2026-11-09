import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPasswordRecoveryMailer, PasswordRecoveryDeliveryError } from '../auth/email.js'
import { processPasswordRecoveryRequest } from '../auth/passwordRecoveryService.js'
import type { AuthAuditEvent } from '../database/authAuditRepository.js'
import { RequestValidationError } from '../requests/validation.js'
import { validateSettings } from '../requests/settingsRules.js'
import { profileLabels } from './accountNotices.js'
import {
  allowedVariables,
  audienceOf,
  eventCatalog,
  linkPathOf,
  listTemplates,
  renderEmail,
  renderSubject,
} from './catalog.js'
import type { EventType } from './catalog.js'
import { publishIntegrationEvent } from './publisher.js'
import type { PublishInput } from './publisher.js'
import { templateTextProblem } from './templateVariables.js'

// Novos e-mails: catálogo, destinatários, recuperação de senha e parâmetros. Nada usa banco ou rede:
// o banco é um cliente falso, e o Resend também.

// ---------------------------------------------------------------------------
// Banco falso para o publicador: responde só às consultas que ele faz e guarda o que foi gravado.
// ---------------------------------------------------------------------------
type FakeUser = {
  id: string
  email: string
  status: 'approved' | 'pending' | 'inactive'
  profile: 'administrator' | 'slm_operator' | 'requester'
  slm?: boolean
  granted?: string[]
}

function fakeDatabase(users: FakeUser[]) {
  const events = new Map<string, string>()
  const deliveries: { eventId: string; templateKey: string; audience: string; recipient: string; status: string; error: string | null }[] = []
  const notifications: { userId: string; required: string[]; link: string | null }[] = []
  const unknown: string[] = []
  const accessRow = (user: FakeUser) => ({
    id: user.id,
    email: user.email,
    role: null,
    permissions: [],
    access_profile: user.profile,
    access_slm_member: user.slm ?? false,
    access_granted: user.granted ?? [],
    access_denied: [],
  })
  const client = {
    async query(sql: string, params: unknown[] = []) {
      const text = sql.replace(/\s+/g, ' ').trim()
      if (/^(SAVEPOINT|RELEASE|ROLLBACK)/.test(text)) return { rows: [] }
      if (text.includes("to_regclass('public.auth_user_access')")) return { rows: [{ present: true }] }
      // Banco sem a migração 019: o aviso administrativo segue individual, como antes do agrupamento.
      if (text.includes("to_regclass('public.email_daily_usage')")) return { rows: [{ present: false }] }
      if (text.startsWith('INSERT INTO public.integration_events')) {
        const key = String(params[0])
        if (events.has(key)) return { rows: [] }
        const id = `evento-${events.size + 1}`
        events.set(key, id)
        return { rows: [{ id }] }
      }
      if (text.startsWith('INSERT INTO public.email_deliveries')) {
        const [eventId, templateKey, audience, recipient, , , status, error] = params as string[]
        if (!deliveries.some((item) => item.eventId === eventId && item.recipient === recipient)) {
          deliveries.push({ eventId, templateKey, audience, recipient, status, error })
        }
        return { rows: [] }
      }
      if (text.startsWith('INSERT INTO public.user_notifications')) {
        notifications.push({ userId: String(params[1]), required: params[6] as string[], link: params[5] as string | null })
        return { rows: [] }
      }
      if (text.includes('FROM public.auth_users u') && text.includes("WHERE u.id = $1 AND u.status = 'approved'")) {
        const user = users.find((item) => item.id === params[0] && item.status === 'approved')
        return { rows: user ? [accessRow(user)] : [] }
      }
      if (text.includes('FROM public.auth_users u') && text.endsWith("WHERE u.status = 'approved'")) {
        return { rows: users.filter((item) => item.status === 'approved').map(accessRow) }
      }
      if (text.startsWith('SELECT email FROM public.auth_users WHERE id = $1')) {
        const user = users.find((item) => item.id === params[0] && item.status === 'approved')
        return { rows: user ? [{ email: user.email }] : [] }
      }
      unknown.push(text.slice(0, 80))
      return { rows: [] }
    },
  }
  return { client: client as unknown as Parameters<typeof publishIntegrationEvent>[0], deliveries, notifications, unknown }
}

const admin: FakeUser = { id: 'u-admin', email: 'Admin@Orgao.sp.gov.br', status: 'approved', profile: 'administrator' }
const operator: FakeUser = { id: 'u-operador', email: 'operador@orgao.sp.gov.br', status: 'approved', profile: 'slm_operator', slm: true }
const requester: FakeUser = { id: 'u-solicitante', email: 'solicitante@orgao.sp.gov.br', status: 'approved', profile: 'requester' }
const inactiveAdmin: FakeUser = { id: 'u-inativo', email: 'inativo@orgao.sp.gov.br', status: 'inactive', profile: 'administrator' }

async function publish(users: FakeUser[], input: Partial<PublishInput> & { type: EventType }) {
  const database = fakeDatabase(users)
  await publishIntegrationEvent(database.client, {
    key: `chave-${input.type}`,
    module: 'system',
    resourceId: null,
    protocol: '',
    actorId: null,
    ...input,
  })
  assert.deepEqual(database.unknown, [], 'o publicador só faz as consultas previstas')
  return database
}

async function withEnvironment<T>(values: Record<string, string | undefined>, work: () => Promise<T>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await work()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------
const newEvents: EventType[] = [
  'account_registration_received',
  'account_registration_pending',
  'account_approved',
  'account_rejected',
  'account_activated',
  'account_deactivated',
  'account_access_changed',
  'account_password_changed',
  'security_new_login',
  'security_login_blocked',
  'security_login_blocked_admin',
  'security_sessions_revoked',
  'request_unassigned',
  'demand_atribuicao',
  'demand_responsavel',
  'demand_mencao',
  'demand_comentario',
  'demand_prazo_alterado',
  'demand_prazo_proximo',
  'demand_atraso',
  'demand_status',
  'demand_recorrencia',
  'demand_providencia',
]

test('catálogo: todos os novos eventos existem e geram texto e HTML, com o aviso de mensagem automática', () => {
  for (const type of newEvents) {
    assert.ok(type in eventCatalog, type)
    const module = eventCatalog[type].modules[0]
    const message = renderEmail(type, { module, protocol: module === 'system' ? '' : 'X-1' }, null)
    assert.ok(message.subject.endsWith(' - JUCESP'), type)
    assert.match(message.text, /mensagem automática/, type)
    assert.match(message.html, /<h2/, type)
  }
  const keys = listTemplates().map((item) => item.key)
  for (const type of newEvents) assert.ok(keys.includes(type), `modelo editável para ${type}`)
})

test('conta: assunto pela seção, sem "Sistema", e o HTML escapa o nome do perfil', () => {
  assert.equal(renderSubject('account_approved', { module: 'system', protocol: '' }), 'Cadastro aprovado - Conta de acesso - JUCESP')
  const message = renderEmail('account_approved', { module: 'system', protocol: '', profileLabel: '<b>Solicitante</b>' }, null)
  assert.match(message.text, /Perfil de acesso: <b>Solicitante<\/b>/)
  assert.doesNotMatch(message.html, /<b>Solicitante/)
  assert.match(message.html, /&lt;b&gt;Solicitante/)
  assert.equal(profileLabels.slm_operator, 'Operador SLM')
})

test('conta: rejeição, desativação e senha alterada não levam link; aprovação leva ao início', () => {
  assert.equal(linkPathOf('account_rejected', 'system', 'u-1'), null)
  assert.equal(linkPathOf('account_deactivated', 'system', 'u-1'), null)
  assert.equal(linkPathOf('account_password_changed', 'system', 'u-1'), null)
  assert.equal(linkPathOf('account_approved', 'system', 'u-1'), '/')
  assert.equal(linkPathOf('account_registration_pending', 'system', 'u-1'), '/cadastros-pendentes')
  assert.equal(linkPathOf('request_assigned', 'maintenance', 'r-1'), '/manutencao/r-1')
  assert.equal(linkPathOf('demand_status', 'demands', 'd-1'), '/demandas/d-1')
})

test('segurança: os avisos não citam IP, senha, código nem link de recuperação', () => {
  for (const type of ['security_new_login', 'security_login_blocked', 'security_login_blocked_admin', 'security_sessions_revoked', 'account_password_changed'] as const) {
    const { text } = renderEmail(type, { module: 'system', protocol: '', occurredAt: '2030-01-15T13:00:00.000Z' }, null)
    assert.doesNotMatch(text, /\bIP\b|código de verificação|recuperar-senha=|senha: /i, type)
  }
  // O aviso aos administradores não identifica a conta.
  assert.doesNotMatch(
    renderEmail('security_login_blocked_admin', { module: 'system', protocol: '', accountName: 'Pessoa Real' }, null).text,
    /Pessoa Real/,
  )
})

test('demandas: restrita sai sem título; comum leva o título; o número aparece como "Demanda"', () => {
  const restricted = renderEmail('demand_atribuicao', { module: 'demands', protocol: 'DEM-2030-0001', restricted: true }, null)
  assert.doesNotMatch(restricted.text, /Contrato sigiloso/)
  assert.match(restricted.text, /Demanda restrita/)
  assert.match(restricted.text, /Demanda: DEM-2030-0001/)
  assert.equal(restricted.subject, 'Demanda atribuída - Controle de Demandas DEM-2030-0001 - JUCESP')
  const common = renderEmail('demand_atribuicao', { module: 'demands', protocol: 'DEM-2030-0002', title: 'Levantamento' }, null)
  assert.match(common.text, /Levantamento/)
})

test('demandas: nenhuma variável alcança título, descrição, setor ou solicitante', () => {
  const allowed = allowedVariables('demand_comentario')
  for (const name of ['descricao', 'responsavel', 'nome_solicitante', 'setor']) {
    assert.ok(!allowed.includes(name as never), name)
  }
  assert.match(templateTextProblem('Veja {{descricao}}', allowed) ?? '', /não existe neste evento/)
  assert.ok(allowedVariables('account_approved').includes('nome_usuario'))
  assert.ok(allowedVariables('account_approved').includes('perfil_acesso'))
  assert.ok(!allowedVariables('request_received').includes('nome_usuario'), 'variáveis da conta só nos avisos da conta')
})

test('público: responsável por e-mail na atribuição, na retirada e no prazo vencido', () => {
  for (const type of ['request_assigned', 'request_unassigned', 'request_overdue'] as const) {
    assert.equal(audienceOf(type).emailResponsible, true, type)
  }
  assert.equal(audienceOf('request_scheduled').emailResponsible, false, 'o agendamento segue só na plataforma')
  assert.equal(audienceOf('account_registration_pending').toHolders, 'users:approve')
  assert.equal(audienceOf('security_login_blocked_admin').toHolders, 'users:manage')
})

// ---------------------------------------------------------------------------
// Publicador: destinatários e permissões
// ---------------------------------------------------------------------------
test('rejeição: vai ao endereço informado no pedido, mesmo sem conta aprovada, e sem notificação', async () => {
  const database = await publish([admin], {
    type: 'account_rejected',
    resourceId: 'u-pendente',
    accountEmail: ' Pedido@Orgao.sp.gov.br ',
    actorId: admin.id,
  })
  assert.deepEqual(
    database.deliveries.map(({ recipient, audience, templateKey }) => ({ recipient, audience, templateKey })),
    [{ recipient: 'pedido@orgao.sp.gov.br', audience: 'requester', templateKey: 'account_rejected' }],
  )
  assert.equal(database.notifications.length, 0)
})

test('sem serviço ativo, o e-mail fica "não configurado"; no modo simulado, pendente', async () => {
  const off = await publish([admin], { type: 'account_approved', accountEmail: 'pessoa@orgao.sp.gov.br' })
  assert.equal(off.deliveries[0].status, 'not_configured')
  assert.equal(off.deliveries[0].error, 'EMAIL_NOT_CONFIGURED')
  const simulated = await withEnvironment({ EMAIL_TRANSPORT: 'simulated' }, () =>
    publish([admin], { type: 'account_approved', accountEmail: 'pessoa@orgao.sp.gov.br' }),
  )
  assert.equal(simulated.deliveries[0].status, 'pending')
})

test('novo cadastro: só quem aprova cadastros, com conta aprovada, recebe; quem agiu não', async () => {
  const database = await publish([admin, operator, requester, inactiveAdmin], {
    type: 'account_registration_pending',
    resourceId: 'u-novo',
  })
  assert.deepEqual(database.deliveries.map((item) => item.recipient), ['admin@orgao.sp.gov.br'])
  assert.deepEqual(database.notifications, [{ userId: admin.id, required: ['users:approve'], link: '/cadastros-pendentes' }])

  const byAdmin = await publish([admin], { type: 'account_registration_pending', actorId: admin.id })
  assert.equal(byAdmin.deliveries.length, 0)
})

test('responsável: e-mail só para conta aprovada que atende o módulo; sem e-mail para quem agiu', async () => {
  const assigned = await publish([admin, operator], {
    type: 'request_assigned',
    module: 'maintenance',
    resourceId: 'r-1',
    protocol: 'MAN-2030-00001',
    actorId: admin.id,
    responsibleId: operator.id,
  })
  assert.deepEqual(assigned.deliveries.map((item) => item.recipient), ['operador@orgao.sp.gov.br'])
  assert.equal(assigned.notifications[0].userId, operator.id)

  // Solicitante não atende o módulo: segue o aviso no sino, sem e-mail.
  const notAllowed = await publish([admin, requester], {
    type: 'request_assigned',
    module: 'maintenance',
    resourceId: 'r-1',
    protocol: 'MAN-2030-00001',
    actorId: admin.id,
    responsibleId: requester.id,
  })
  assert.equal(notAllowed.deliveries.length, 0)
  assert.equal(notAllowed.notifications.length, 1)

  const inactive = await publish([admin, { ...operator, status: 'inactive' }], {
    type: 'request_unassigned',
    module: 'maintenance',
    resourceId: 'r-1',
    protocol: 'MAN-2030-00001',
    actorId: admin.id,
    responsibleId: operator.id,
  })
  assert.equal(inactive.deliveries.length, 0)

  const self = await publish([operator], {
    type: 'request_assigned',
    module: 'maintenance',
    resourceId: 'r-1',
    protocol: 'MAN-2030-00001',
    actorId: operator.id,
    responsibleId: operator.id,
  })
  assert.equal(self.deliveries.length + self.notifications.length, 0)
})

test('duplicidade: a mesma chave publicada duas vezes gera um único e-mail', async () => {
  const database = fakeDatabase([admin])
  const input: PublishInput = {
    type: 'account_activated',
    key: 'account:u-1:activated:1',
    module: 'system',
    resourceId: 'u-1',
    protocol: '',
    actorId: admin.id,
    accountEmail: 'pessoa@orgao.sp.gov.br',
  }
  await publishIntegrationEvent(database.client, input)
  await publishIntegrationEvent(database.client, input)
  assert.equal(database.deliveries.length, 1)
})

test('falha de e-mail não gera e-mail de falha: o aviso fica só na plataforma', async () => {
  const database = await withEnvironment({ EMAIL_INTERNAL_TO_SYSTEM: 'equipe@orgao.sp.gov.br' }, () =>
    publish([admin], { type: 'integration_failure', context: { channel: 'email' } }),
  )
  assert.equal(database.deliveries.length, 0)
  assert.equal(database.notifications.length, 1)
})

// ---------------------------------------------------------------------------
// Recuperação de senha: Resend falso, nova tentativa e registro sem segredo
// ---------------------------------------------------------------------------
type Call = { payload: { to: string[]; html?: string; text: string }; options?: { idempotencyKey?: string } }

function scriptedResend(replies: (() => unknown)[]) {
  const calls: Call[] = []
  const client = {
    emails: {
      async send(payload: Call['payload'], options?: Call['options']) {
        calls.push({ payload, options })
        const reply = replies[Math.min(calls.length - 1, replies.length - 1)]
        return reply()
      },
    },
  }
  return { calls, client: client as unknown as Parameters<typeof createPasswordRecoveryMailer>[0] }
}

const ok = () => ({ data: { id: 'msg-1' }, error: null })
const status = (statusCode: number) => () => ({ data: null, error: { message: 'Detalhe com pessoa@orgao.sp.gov.br', statusCode } })
const noWait = { sleep: async () => {} }

test('recuperação: falha temporária tem uma nova tentativa, com a mesma chave de idempotência', async () => {
  const fake = scriptedResend([status(500), ok])
  const result = await createPasswordRecoveryMailer(fake.client, 'slm@orgao.sp.gov.br', noWait).sendCode('pessoa@orgao.sp.gov.br', '123456')
  assert.deepEqual(result, { attempts: 2 })
  assert.equal(fake.calls.length, 2)
  assert.ok(fake.calls[0].options?.idempotencyKey?.startsWith('slm-recuperacao-'))
  assert.equal(fake.calls[0].options?.idempotencyKey, fake.calls[1].options?.idempotencyKey)

  const network = scriptedResend([() => { throw new Error('ECONNRESET') }, ok])
  assert.deepEqual(
    await createPasswordRecoveryMailer(network.client, 'slm@orgao.sp.gov.br', noWait).sendCode('pessoa@orgao.sp.gov.br', '123456'),
    { attempts: 2 },
  )
})

test('recuperação: recusa definitiva não é repetida, e o limite de tentativas vale', async () => {
  const refused = scriptedResend([status(403)])
  await assert.rejects(
    createPasswordRecoveryMailer(refused.client, 'slm@orgao.sp.gov.br', noWait).sendCode('pessoa@orgao.sp.gov.br', '123456'),
    (error: unknown) =>
      error instanceof PasswordRecoveryDeliveryError && error.code === 'RESEND_403' && error.attempts === 1 &&
      !error.message.includes('pessoa@'),
  )
  assert.equal(refused.calls.length, 1)

  const busy = scriptedResend([status(429)])
  await assert.rejects(
    createPasswordRecoveryMailer(busy.client, 'slm@orgao.sp.gov.br', noWait).sendCode('pessoa@orgao.sp.gov.br', '123456'),
    (error: unknown) => error instanceof PasswordRecoveryDeliveryError && error.code === 'RESEND_429' && error.attempts === 2,
  )
  assert.equal(busy.calls.length, 2)
})

test('recuperação por link: agora com HTML, link escapado e a versão em texto preservada', async () => {
  const fake = scriptedResend([ok])
  await createPasswordRecoveryMailer(fake.client, 'slm@orgao.sp.gov.br', noWait).sendLink(
    'pessoa@orgao.sp.gov.br',
    'https://slm.example.gov.br/#recuperar-senha=abc"<x>',
  )
  const { html, text } = fake.calls[0].payload
  assert.match(text, /Abra este link/)
  assert.match(text, /10 minutos/)
  assert.ok(html)
  assert.match(html ?? '', /href="https:\/\/slm\.example\.gov\.br\/#recuperar-senha=abc&quot;&lt;x&gt;"/)
  assert.doesNotMatch(html ?? '', /<x>/)
})

const configured = () => true
// Só para o HMAC do teste: nenhum código sai daqui.
const pepper = { PASSWORD_RESET_PEPPER: 'p'.repeat(40) }

test('recuperação: o envio fica na auditoria com canal e tentativas, nunca com código, link ou endereço', () => withEnvironment(pepper, async () => {
  const recorded: AuthAuditEvent[] = []
  await processPasswordRecoveryRequest('pessoa@orgao.sp.gov.br', {
    isConfigured: configured,
    createCode: async (email) => ({ id: 'u-1', email }),
    invalidateCodes: async () => {},
    send: async () => ({ attempts: 2 }),
    record: async (event) => void recorded.push(event),
  })
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].eventType, 'password_recovery_email_sent')
  assert.deepEqual(recorded[0].details, { channel: 'codigo', attempts: '2' })
  assert.equal(recorded[0].subjectUserId, 'u-1')
}))

test('recuperação: falha registrada com o código do erro, e o código enviado é invalidado', () => withEnvironment(pepper, async () => {
  const recorded: AuthAuditEvent[] = []
  let invalidated = false
  let sentCode = ''
  await processPasswordRecoveryRequest('pessoa@orgao.sp.gov.br', {
    isConfigured: configured,
    createCode: async (email) => ({ id: 'u-1', email }),
    invalidateCodes: async () => {
      invalidated = true
    },
    send: async (_recipient, code) => {
      sentCode = code
      throw new PasswordRecoveryDeliveryError('RESEND_500', 2)
    },
    record: async (event) => void recorded.push(event),
  })
  assert.equal(invalidated, true)
  assert.equal(recorded[0].eventType, 'password_recovery_email_failed')
  assert.equal(recorded[0].result, 'failure')
  assert.deepEqual(recorded[0].details, { channel: 'codigo', code: 'RESEND_500', attempts: '2' })
  const serialized = JSON.stringify(recorded)
  assert.ok(!serialized.includes(sentCode), 'o código nunca vai para a auditoria')
  assert.ok(!serialized.includes('pessoa@'), 'nem o endereço')
}))

test('recuperação: conta inexistente não gera registro de envio (sem enumeração)', async () => {
  const recorded: AuthAuditEvent[] = []
  await processPasswordRecoveryRequest('ninguem@orgao.sp.gov.br', {
    isConfigured: configured,
    createCode: async () => null,
    invalidateCodes: async () => {},
    send: async () => ({ attempts: 1 }),
    record: async (event) => void recorded.push(event),
  })
  assert.equal(recorded.length, 0)
})

// ---------------------------------------------------------------------------
// Parâmetros
// ---------------------------------------------------------------------------
test('parâmetros: e-mails de segurança aceitam só verdadeiro ou falso, e o omitido fica no padrão', () => {
  const saved = validateSettings('notifications', { securityEmails: { newLogin: true } }) as {
    securityEmails: Record<string, boolean>
  }
  assert.deepEqual(saved.securityEmails, { newLogin: true, lockout: true, sessionsRevoked: true, adminAlerts: true })
  assert.throws(() => validateSettings('notifications', { securityEmails: { lockout: 'sim' } }), RequestValidationError)
  assert.throws(() => validateSettings('notifications', { securityEmails: [] }), RequestValidationError)
})
