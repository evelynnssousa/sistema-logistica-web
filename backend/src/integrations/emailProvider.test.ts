import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPasswordRecoveryMailer, isEmailConfigured } from '../auth/email.js'
import { quotaEnforcedFor } from './emailQuota.js'
import { brevoEndpoint, createBrevoClient, emailCredentials, emailProviderName, parseSender } from './emailProvider.js'
import { restrictionEnforcedFor } from './recipientAllowlist.js'
import { createResendTransport } from './transports.js'

// Brevo simulado: nenhuma chamada sai da máquina.
function fakeBrevo(status = 201) {
  const calls: { url: string; headers: Headers; body: Record<string, any> }[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
    return status < 300
      ? new Response(JSON.stringify({ messageId: '<id-1@brevo>' }), { status })
      : new Response(JSON.stringify({ message: 'detalhe do provedor com endereco@exemplo.gov.br' }), { status })
  }
  return { calls, client: createBrevoClient('xkeysib-teste', fetcher) }
}

test('escolha do provedor e credenciais: Resend por padrão, Brevo por EMAIL_PROVIDER', () => {
  assert.equal(emailProviderName({}), 'resend')
  assert.equal(emailProviderName({ EMAIL_PROVIDER: ' Brevo ' }), 'brevo')
  assert.deepEqual(emailCredentials({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'xkeysib-1', EMAIL_FROM: 'SLM <a@b.gov.br>' }), {
    provider: 'brevo', apiKey: 'xkeysib-1', from: 'SLM <a@b.gov.br>',
  })
  // RESEND_FROM continua aceito como remetente; a chave do outro provedor não vale.
  assert.equal(isEmailConfigured({ EMAIL_PROVIDER: 'brevo', RESEND_API_KEY: 're_1', RESEND_FROM: 'a@b.gov.br' }), false)
  assert.equal(isEmailConfigured({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'xkeysib-1', RESEND_FROM: 'a@b.gov.br' }), true)
  assert.deepEqual(parseSender('SLM JUCESP <nao-responda@b.gov.br>'), { name: 'SLM JUCESP', email: 'nao-responda@b.gov.br' })
  assert.deepEqual(parseSender('a@b.gov.br'), { email: 'a@b.gov.br' })
})

test('Brevo: envio no formato da API, com cópia e anexo, e erro só com o status', async () => {
  const { calls, client } = fakeBrevo()
  const transport = createResendTransport(client, 'SLM <slm@b.gov.br>', () => [], 'brevo')
  assert.equal(transport.provider, 'brevo')
  const sent = await transport.send({
    idempotencyKey: 'k1', to: 'pessoa@b.gov.br', cc: ['copia@b.gov.br'], subject: 'Assunto', text: 'Texto', html: '<p>Texto</p>',
    attachments: [{ filename: 'bilhete.pdf', content: Buffer.from('PDF') }],
  })
  assert.equal(sent.messageId, '<id-1@brevo>')
  assert.equal(calls[0].url, brevoEndpoint)
  assert.equal(calls[0].headers.get('api-key'), 'xkeysib-teste')
  assert.deepEqual(calls[0].body.sender, { name: 'SLM', email: 'slm@b.gov.br' })
  assert.deepEqual(calls[0].body.to, [{ email: 'pessoa@b.gov.br' }])
  assert.deepEqual(calls[0].body.cc, [{ email: 'copia@b.gov.br' }])
  assert.deepEqual(calls[0].body.attachment, [{ name: 'bilhete.pdf', content: Buffer.from('PDF').toString('base64') }])

  const failing = createResendTransport(fakeBrevo(401).client, 'slm@b.gov.br', () => [], 'brevo')
  await assert.rejects(failing.send({ idempotencyKey: 'k2', to: 'p@b.gov.br', cc: [], subject: 's', text: 't', html: '<p>t</p>' }), (error: Error & { code?: string; retryable?: boolean }) => {
    assert.equal(error.code, 'BREVO_401')
    assert.equal(error.retryable, false)
    assert.ok(!error.message.includes('endereco@'), 'mensagem do provedor não é repassada')
    return true
  })
})

test('Brevo: recuperação de senha pelo mesmo caminho, e falha temporária repetida', async () => {
  const { calls, client } = fakeBrevo()
  const mailer = createPasswordRecoveryMailer(client, 'slm@b.gov.br', { codePrefix: 'BREVO' })
  assert.equal((await mailer.sendCode('pessoa@b.gov.br', '123456')).attempts, 1)
  assert.match(calls[0].body.textContent, /123456/)

  const busy = createPasswordRecoveryMailer(fakeBrevo(503).client, 'slm@b.gov.br', { codePrefix: 'BREVO', sleep: async () => undefined })
  await assert.rejects(busy.sendCode('pessoa@b.gov.br', '123456'), (error: Error & { code?: string; attempts?: number }) => {
    assert.equal(error.code, 'BREVO_503')
    assert.equal(error.attempts, 2)
    return true
  })
})

test('Brevo: a cota diária e a lista de destinatários permitidos valem como no Resend', () => {
  assert.equal(quotaEnforcedFor('brevo', {}), true)
  assert.equal(restrictionEnforcedFor('brevo', {}), true)
  assert.equal(restrictionEnforcedFor('brevo', { EMAIL_RECIPIENT_RESTRICTION: 'off' }), false)
  assert.equal(quotaEnforcedFor('simulado', {}), false)
})
