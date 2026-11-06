import assert from 'node:assert/strict'
import test from 'node:test'
import { createPasswordRecoveryMailer, isEmailConfigured } from './email.js'

type Sent = { from: string; to: string[]; subject: string; text: string; html?: string }

/** Cliente falso do Resend: guarda o que seria enviado. Nenhuma chamada sai da máquina. */
function fakeResend(error: { message: string; statusCode?: number } | null = null) {
  const sent: Sent[] = []
  const client = {
    emails: {
      async send(payload: Sent) {
        sent.push(payload)
        return error ? { data: null, error } : { data: { id: 'msg-1' }, error: null }
      },
    },
  }
  return { sent, client: client as unknown as Parameters<typeof createPasswordRecoveryMailer>[0] }
}

test('recuperação por código: remetente configurado, só o destinatário, código no texto e no HTML', async () => {
  const { sent, client } = fakeResend()
  await createPasswordRecoveryMailer(client, 'SLM <slm@jucesp.example.gov.br>').sendCode('pessoa@jucesp.sp.gov.br', '123456')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].from, 'SLM <slm@jucesp.example.gov.br>')
  assert.deepEqual(sent[0].to, ['pessoa@jucesp.sp.gov.br'])
  assert.match(sent[0].subject, /recuperação de senha/)
  assert.match(sent[0].text, /123456/)
  assert.match(sent[0].html ?? '', /123456/)
  assert.match(sent[0].text, /10 minutos/)
})

test('recuperação por link: https, ou http só na própria máquina', async () => {
  const { sent, client } = fakeResend()
  const mailer = createPasswordRecoveryMailer(client, 'slm@jucesp.example.gov.br')
  await mailer.sendLink('pessoa@jucesp.sp.gov.br', 'https://slm.example.gov.br/#recuperar-senha=abc')
  await mailer.sendLink('pessoa@jucesp.sp.gov.br', 'http://localhost:5173/#recuperar-senha=abc')
  assert.equal(sent.length, 2)
  assert.match(sent[0].text, /https:\/\/slm\.example\.gov\.br\/#recuperar-senha=abc/)
  await assert.rejects(mailer.sendLink('pessoa@jucesp.sp.gov.br', 'http://slm.example.gov.br/#x'), /https/)
  await assert.rejects(mailer.sendLink('pessoa@jucesp.sp.gov.br', 'javascript:alert(1)'), /https/)
  assert.equal(sent.length, 2, 'link recusado não chega ao provedor')
})

test('código fora do formato e endereço reservado a testes nunca chegam ao provedor', async () => {
  const { sent, client } = fakeResend()
  const mailer = createPasswordRecoveryMailer(client, 'slm@jucesp.example.gov.br')
  await assert.rejects(mailer.sendCode('pessoa@jucesp.sp.gov.br', '12345'), /inválido/)
  await assert.rejects(mailer.sendCode('pessoa@jucesp.sp.gov.br', '<b>1</b>'), /inválido/)
  await assert.rejects(mailer.sendCode('alguem@example.gov.br', '123456'), /reservado/)
  await assert.rejects(mailer.sendCode('e2e@slm-e2e.invalid', '123456'), /reservado/)
  assert.equal(sent.length, 0)
})

test('falha do provedor vira mensagem genérica, sem repetir o texto do Resend', async () => {
  const { client } = fakeResend({ message: 'Domain pessoa@jucesp.sp.gov.br not verified', statusCode: 403 })
  const mailer = createPasswordRecoveryMailer(client, 'slm@jucesp.example.gov.br')
  await assert.rejects(
    mailer.sendCode('pessoa@jucesp.sp.gov.br', '123456'),
    (error: Error) => error.message === 'O serviço de e-mail não conseguiu enviar a mensagem.',
  )
})

test('sem chave e remetente, o e-mail não é considerado configurado', () => {
  assert.equal(isEmailConfigured({}), false)
  assert.equal(isEmailConfigured({ RESEND_API_KEY: 're_x' }), false)
  assert.equal(isEmailConfigured({ RESEND_API_KEY: ' ', RESEND_FROM: 'a@b.c' }), false)
  assert.equal(isEmailConfigured({ RESEND_API_KEY: 're_x', RESEND_FROM: 'a@b.c' }), true)
})
