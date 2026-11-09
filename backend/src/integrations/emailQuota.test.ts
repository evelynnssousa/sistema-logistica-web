import assert from 'node:assert/strict'
import { test } from 'node:test'
import { maxAgeHoursOf, noticeMaxAgeHours, renderEmail } from './catalog.js'
import type { EventContext } from './catalog.js'
import { nextQuotaDay, quotaEnforcedFor, quotaSettings, quotaSettingsProblems, reserveEmailQuota } from './emailQuota.js'

test('cota: sem EMAIL_DAILY_LIMIT não há limite presumido; com ele, a reserva padrão é 20%', () => {
  assert.deepEqual(quotaSettings({}), { dailyLimit: null, recoveryReserve: 0, adminGroupMinutes: 30 })
  assert.deepEqual(quotaSettings({ EMAIL_DAILY_LIMIT: '100' }), { dailyLimit: 100, recoveryReserve: 20, adminGroupMinutes: 30 })
  assert.equal(quotaSettings({ EMAIL_DAILY_LIMIT: '3' }).recoveryReserve, 1, 'ao menos uma')
  assert.equal(quotaSettings({ EMAIL_DAILY_LIMIT: '100', EMAIL_RECOVERY_DAILY_RESERVE: '40' }).recoveryReserve, 40)
  assert.equal(quotaSettings({ EMAIL_ADMIN_GROUP_MINUTES: '0' }).adminGroupMinutes, 0)
  assert.equal(quotaSettings({ EMAIL_ADMIN_GROUP_MINUTES: '99999' }).adminGroupMinutes, 1440)
})

test('cota: valor inválido nunca vira "sem limite"; a configuração aponta o problema sem valores', () => {
  assert.equal(quotaSettings({ EMAIL_DAILY_LIMIT: 'muito' }).dailyLimit, 0)
  assert.equal(quotaSettings({ EMAIL_DAILY_LIMIT: '-5' }).dailyLimit, 0)
  assert.equal(quotaSettings({ EMAIL_DAILY_LIMIT: '10', EMAIL_RECOVERY_DAILY_RESERVE: 'x' }).recoveryReserve, 10)
  assert.equal(quotaSettingsProblems({ EMAIL_DAILY_LIMIT: '10' }).length, 0)
  assert.match(quotaSettingsProblems({ EMAIL_DAILY_LIMIT: 'muito' }).join(' '), /inteiro/)
  assert.match(quotaSettingsProblems({ EMAIL_DAILY_LIMIT: '10', EMAIL_RECOVERY_DAILY_RESERVE: '10' }).join(' '), /nenhuma notificação/)
})

test('cota: obrigatória para o Resend ou com limite configurado; provedor falso sem limite não conta', () => {
  assert.equal(quotaEnforcedFor('resend', {}), true)
  assert.equal(quotaEnforcedFor('simulado', {}), false)
  assert.equal(quotaEnforcedFor('falso', { EMAIL_DAILY_LIMIT: '10' }), true)
})

test('cota: sem limite, a fila do provedor real para e a recuperação segue; sem banco, a fila para', async () => {
  const unreachable = { query: async () => { throw new Error('sem a migração 019') } }
  assert.deepEqual(await reserveEmailQuota(unreachable, 'notification', 1, { enforced: true, environment: {} }), {
    allowed: false, code: 'QUOTA_NOT_CONFIGURED',
  })
  assert.equal((await reserveEmailQuota(unreachable, 'recovery', 1, { enforced: true, environment: {} })).allowed, true)
  const limited = { EMAIL_DAILY_LIMIT: '10' }
  assert.deepEqual(await reserveEmailQuota(unreachable, 'notification', 1, { enforced: true, environment: limited }), {
    allowed: false, code: 'QUOTA_UNAVAILABLE',
  })
  assert.equal((await reserveEmailQuota(unreachable, 'recovery', 1, { enforced: true, environment: limited })).allowed, true)
  assert.equal(nextQuotaDay(new Date('2031-03-10T22:15:00Z')).toISOString(), '2031-03-11T00:00:00.000Z')
})

test('validade: segurança 24 h, conta 7 dias, responsável e Demandas 3 dias, o resto 30 dias', () => {
  assert.equal(maxAgeHoursOf('security_new_login'), noticeMaxAgeHours.security)
  assert.equal(maxAgeHoursOf('account_password_changed'), 24)
  assert.equal(maxAgeHoursOf('account_approved'), 168)
  assert.equal(maxAgeHoursOf('request_unassigned'), 72)
  assert.equal(maxAgeHoursOf('demand_atraso'), 72)
  assert.equal(maxAgeHoursOf('request_scheduled'), 720)
})

test('bloqueio: o texto distingue a conta do endereço de rede; agrupado, leva só a contagem', () => {
  const base: EventContext = { module: 'system', protocol: '' }
  const byAddress = renderEmail('security_login_blocked', { ...base, blockScope: 'address' }, null)
  const byAccount = renderEmail('security_login_blocked', { ...base, blockScope: 'account' }, null)
  assert.match(byAddress.text, /a partir de um mesmo endereço de rede/)
  assert.doesNotMatch(byAccount.text, /endereço de rede/)
  const grouped = renderEmail('security_login_blocked_admin', { ...base, groupedCount: 4 }, null)
  assert.match(grouped.text, /4 bloqueios temporários/)
})

test('lista de testes: só endereços exatos; domínio inteiro e curinga são recusados; o padrão é restrito', async () => {
  const { recipientRestriction, recipientsOutsideList, restrictionEnforcedFor, restrictionProblems, recipientDomains } =
    await import('./recipientAllowlist.js')
  const environment = { EMAIL_RECIPIENT_ALLOWLIST: ' Teste@Exemplo.gov.br , @jucesp.sp.gov.br, *@jucesp.sp.gov.br, jucesp.sp.gov.br, ok2@exemplo.gov.br' }
  const restriction = recipientRestriction(environment)
  assert.equal(restriction.mode, 'test')
  assert.deepEqual([...restriction.allowed].sort(), ['ok2@exemplo.gov.br', 'teste@exemplo.gov.br'])
  assert.equal(restriction.rejectedEntries, 3)
  assert.deepEqual(recipientsOutsideList(['TESTE@exemplo.gov.br', 'servidor@exemplo.gov.br'], environment), ['servidor@exemplo.gov.br'])
  assert.match(restrictionProblems(environment).join(' '), /3 entrada/)
  // Restrição: sempre para o Resend; para provedores falsos, só com a lista definida; "off" desliga.
  assert.equal(restrictionEnforcedFor('resend', {}), true)
  assert.equal(restrictionEnforcedFor('falso', {}), false)
  assert.equal(restrictionEnforcedFor('falso', environment), true)
  assert.equal(restrictionEnforcedFor('resend', { EMAIL_RECIPIENT_RESTRICTION: 'off' }), false)
  assert.equal(restrictionEnforcedFor('resend', { EMAIL_RECIPIENT_RESTRICTION: 'desligar' }), true, 'valor desconhecido mantém')
  assert.match(restrictionProblems({ EMAIL_RECIPIENT_RESTRICTION: 'desligar' }).join(' '), /só "test" ou "off"/)
  assert.deepEqual(recipientsOutsideList(['qualquer@exemplo.gov.br'], {}), ['qualquer@exemplo.gov.br'], 'sem lista, ninguém')
  assert.deepEqual(recipientDomains(['a@x.gov.br', 'b@x.gov.br', 'c@y.gov.br']), ['x.gov.br', 'y.gov.br'])
})

test('lista de testes: a segunda barreira no Resend e na recuperação recusa sozinha, antes do provedor', async () => {
  const previous = process.env.EMAIL_RECIPIENT_ALLOWLIST
  process.env.EMAIL_RECIPIENT_ALLOWLIST = 'autorizada@orgao.sp.gov.br'
  try {
    const { realSendGuard } = await import('./recipientAllowlist.js')
    const { createResendTransport } = await import('./transports.js')
    const { createPasswordRecoveryMailer, PasswordRecoveryDeliveryError } = await import('../auth/email.js')
    const calls: unknown[] = []
    const client = {
      emails: {
        send: async (payload: unknown) => { calls.push(payload); return { data: { id: 'x' }, error: null } },
        get: async () => ({ data: null }),
      },
    } as never
    const resend = createResendTransport(client, 'remetente@orgao.sp.gov.br', realSendGuard())
    await assert.rejects(
      resend.send({ idempotencyKey: 'k', to: 'autorizada@orgao.sp.gov.br', cc: ['servidor@exemplo.gov.br'], subject: 's', text: 't', html: 'h' }),
      /RECIPIENT_OUTSIDE_TEST_LIST/,
    )
    await assert.rejects(
      resend.send({ idempotencyKey: 'k1', to: 'autorizada@orgao.sp.gov.br', moreTo: ['outro@orgao.sp.gov.br'], cc: [], subject: 's', text: 't', html: 'h' }),
      /RECIPIENT_OUTSIDE_TEST_LIST/,
    )
    await resend.send({ idempotencyKey: 'k2', to: 'autorizada@orgao.sp.gov.br', cc: [], subject: 's', text: 't', html: 'h' })
    assert.equal(calls.length, 1, 'só a autorizada chega ao provedor')

    const mailer = createPasswordRecoveryMailer(client, 'remetente@orgao.sp.gov.br', { guard: realSendGuard() })
    await assert.rejects(mailer.sendCode('servidor@exemplo.gov.br', '123456'), (error: unknown) =>
      error instanceof PasswordRecoveryDeliveryError && error.code === 'RECIPIENT_OUTSIDE_TEST_LIST')
    await mailer.sendCode('autorizada@orgao.sp.gov.br', '123456')
    assert.equal(calls.length, 2)
  } finally {
    if (previous === undefined) delete process.env.EMAIL_RECIPIENT_ALLOWLIST
    else process.env.EMAIL_RECIPIENT_ALLOWLIST = previous
  }
})
