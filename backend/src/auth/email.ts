import { Resend } from 'resend'
import { isReservedTestEmail } from './reservedTestEmails.js'

function getEmailConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const apiKey = environment.RESEND_API_KEY?.trim()
  const from = environment.RESEND_FROM?.trim()

  if (!apiKey || !from) {
    throw new Error(
      'Configuração do Resend ausente. Verifique RESEND_API_KEY e RESEND_FROM.',
    )
  }

  return { apiKey, from }
}

export function isEmailConfigured(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return Boolean(
    environment.RESEND_API_KEY?.trim() && environment.RESEND_FROM?.trim(),
  )
}

type ResendEmails = Pick<Resend, 'emails'>

/**
 * E-mails da recuperação de senha, com o cliente do Resend recebido de fora: os testes usam um
 * cliente falso, e nenhum envio real acontece fora do ambiente configurado. Endereços de domínios
 * reservados a testes nunca chegam ao provedor, e a mensagem de erro do provedor não é repassada.
 */
export function createPasswordRecoveryMailer(client: ResendEmails, from: string) {
  async function deliver(recipient: string, message: { subject: string; text: string; html?: string }) {
    if (isReservedTestEmail(recipient)) {
      throw new Error('Endereço reservado a testes: nada foi enviado.')
    }
    const { error } = await client.emails.send({ from, to: [recipient], ...message })
    if (error) {
      throw new Error('O serviço de e-mail não conseguiu enviar a mensagem.')
    }
  }

  return {
    async sendCode(recipient: string, code: string) {
      if (!/^\d{6}$/.test(code)) {
        throw new Error('Código de recuperação inválido.')
      }
      await deliver(recipient, {
        subject: 'Código para recuperação de senha — JUCESP',
        text: [
          'Você solicitou a recuperação de senha do sistema de logística da JUCESP.',
          '',
          `Seu código de verificação é: ${code}`,
          '',
          'O código expira em 10 minutos e pode ser utilizado uma única vez.',
          'Se você não solicitou esta recuperação, ignore este e-mail.',
        ].join('\n'),
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#263238">
            <h2 style="color:#034EA2">Recuperação de senha</h2>
            <p>Você solicitou a recuperação de senha do sistema de logística da JUCESP.</p>
            <p>Utilize o código abaixo para continuar:</p>
            <p style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#034EA2">${code}</p>
            <p>O código expira em <strong>10 minutos</strong> e pode ser utilizado uma única vez.</p>
            <p>Se você não solicitou esta recuperação, ignore este e-mail.</p>
          </div>
        `,
      })
    },
    async sendLink(recipient: string, link: string) {
      // Mesma regra de passwordRecoveryLink: https, ou http apenas na própria máquina.
      if (!/^https:\/\//.test(link) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(link)) {
        throw new Error('O link de recuperação precisa usar https.')
      }
      await deliver(recipient, {
        subject: 'Link para recuperação de senha — JUCESP',
        text: [
          'Você solicitou a recuperação de senha do sistema de logística da JUCESP.',
          '',
          `Abra este link para escolher uma nova senha: ${link}`,
          '',
          'O link expira em 10 minutos e pode ser utilizado uma única vez.',
          'Se você não solicitou esta recuperação, ignore este e-mail.',
        ].join('\n'),
      })
    },
  }
}

function configuredMailer() {
  const { apiKey, from } = getEmailConfiguration()
  return createPasswordRecoveryMailer(new Resend(apiKey), from)
}

export async function sendPasswordRecoveryCode(
  recipient: string,
  code: string,
): Promise<void> {
  if (!/^\d{6}$/.test(code)) {
    throw new Error('Código de recuperação inválido.')
  }
  await configuredMailer().sendCode(recipient, code)
}

export async function sendPasswordRecoveryLink(
  recipient: string,
  link: string,
): Promise<void> {
  await configuredMailer().sendLink(recipient, link)
}
