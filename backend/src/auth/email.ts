import { randomUUID } from 'node:crypto'
import type { Resend } from 'resend'
import { createEmailClient, emailCredentials } from '../integrations/emailProvider.js'
import { isReservedTestEmail } from './reservedTestEmails.js'
import { RECIPIENT_OUTSIDE_TEST_LIST, realSendGuard } from '../integrations/recipientAllowlist.js'

function getEmailConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const { apiKey, from, provider } = emailCredentials(environment)

  if (!apiKey || !from) {
    throw new Error(
      'Configuração do e-mail ausente. Verifique a chave do provedor (RESEND_API_KEY ou BREVO_API_KEY) e o remetente.',
    )
  }

  return { apiKey, from, provider }
}

export function isEmailConfigured(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const { apiKey, from } = emailCredentials(environment)
  return Boolean(apiKey && from)
}

type ResendEmails = Pick<Resend, 'emails'>

/** Resultado de um envio da recuperação. Só números e códigos: nada do conteúdo ou do endereço. */
export type RecoveryDelivery = { attempts: number }

/**
 * Falha no envio da recuperação, só com um código (NETWORK, RESEND_429, RESERVED_ADDRESS...). A
 * mensagem do provedor pode repetir o endereço e nunca é repassada.
 */
export class PasswordRecoveryDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly attempts: number,
  ) {
    super(
      code === 'RESERVED_ADDRESS'
        ? 'Endereço reservado a testes: nada foi enviado.'
        : 'O serviço de e-mail não conseguiu enviar a mensagem.',
    )
    this.name = 'PasswordRecoveryDeliveryError'
  }
}

const isTransient = (status: number | null | undefined) =>
  !status || status === 408 || status === 429 || status >= 500

export type RecoveryMailerOptions = {
  /** Tentativas ao todo, contando a primeira. Só falhas temporárias são repetidas. */
  maxAttempts?: number
  /** Espera antes de repetir. Curta: o código vale só 10 minutos. */
  retryDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Última barreira da lista de destinatários permitidos: devolve os endereços bloqueados. */
  guard?: (addresses: readonly string[]) => readonly string[]
  /** Prefixo do código de falha (RESEND_429, BREVO_401...). */
  codePrefix?: string
}

/**
 * E-mails da recuperação de senha, com o cliente do Resend recebido de fora: os testes usam um
 * cliente falso, e nenhum envio real acontece fora do ambiente configurado. Endereços de domínios
 * reservados a testes nunca chegam ao provedor, e a mensagem de erro do provedor não é repassada.
 *
 * Falha temporária (rede, 408, 429, 5xx) tem uma tentativa a mais, com a mesma chave de idempotência:
 * se a primeira resposta se perdeu, o provedor não entrega a mensagem duas vezes. O envio é direto,
 * sem a fila, para que o código ou o link nunca fiquem gravados no banco.
 */
export function createPasswordRecoveryMailer(
  client: ResendEmails,
  from: string,
  options: RecoveryMailerOptions = {},
) {
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 2, 3))
  const retryDelayMs = options.retryDelayMs ?? 1500
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  async function deliver(
    recipient: string,
    message: { subject: string; text: string; html?: string },
  ): Promise<RecoveryDelivery> {
    if (isReservedTestEmail(recipient)) {
      throw new PasswordRecoveryDeliveryError('RESERVED_ADDRESS', 0)
    }
    if ((options.guard?.([recipient]) ?? []).length > 0) {
      throw new PasswordRecoveryDeliveryError(RECIPIENT_OUTSIDE_TEST_LIST, 0)
    }
    const idempotencyKey = `slm-recuperacao-${randomUUID()}`
    let code = 'UNEXPECTED'
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let transient: boolean
      try {
        const { error } = await client.emails.send({ from, to: [recipient], ...message }, { idempotencyKey })
        if (!error) return { attempts: attempt }
        const status = (error as { statusCode?: number | null }).statusCode
        code = `${options.codePrefix ?? 'RESEND'}_${status ?? 'ERROR'}`
        transient = isTransient(status)
      } catch {
        code = 'NETWORK'
        transient = true
      }
      if (!transient || attempt === maxAttempts) throw new PasswordRecoveryDeliveryError(code, attempt)
      await sleep(retryDelayMs * attempt)
    }
    throw new PasswordRecoveryDeliveryError(code, maxAttempts)
  }

  return {
    async sendCode(recipient: string, code: string): Promise<RecoveryDelivery> {
      if (!/^\d{6}$/.test(code)) {
        throw new Error('Código de recuperação inválido.')
      }
      return deliver(recipient, {
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
    async sendLink(recipient: string, link: string): Promise<RecoveryDelivery> {
      // Mesma regra de passwordRecoveryLink: https, ou http apenas na própria máquina.
      if (!/^https:\/\//.test(link) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(link)) {
        throw new Error('O link de recuperação precisa usar https.')
      }
      // O link já foi conferido acima; mesmo assim, entra no HTML escapado.
      const safeLink = escapeHtml(link)
      return deliver(recipient, {
        subject: 'Link para recuperação de senha — JUCESP',
        text: [
          'Você solicitou a recuperação de senha do sistema de logística da JUCESP.',
          '',
          `Abra este link para escolher uma nova senha: ${link}`,
          '',
          'O link expira em 10 minutos e pode ser utilizado uma única vez.',
          'Se você não solicitou esta recuperação, ignore este e-mail.',
        ].join('\n'),
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#263238">
            <h2 style="color:#034EA2">Recuperação de senha</h2>
            <p>Você solicitou a recuperação de senha do sistema de logística da JUCESP.</p>
            <p><a href="${safeLink}" style="display:inline-block;background:#034EA2;color:#ffffff;padding:10px 18px;text-decoration:none;border-radius:4px">Escolher uma nova senha</a></p>
            <p style="font-size:13px;color:#4d5560">Se o botão não abrir, copie este endereço no navegador:<br>${safeLink}</p>
            <p>O link expira em <strong>10 minutos</strong> e pode ser utilizado uma única vez.</p>
            <p>Se você não solicitou esta recuperação, ignore este e-mail.</p>
          </div>
        `,
      })
    },
  }
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function configuredMailer() {
  const { from, provider } = getEmailConfiguration()
  return createPasswordRecoveryMailer(createEmailClient(), from, { guard: realSendGuard(), codePrefix: provider.toUpperCase() })
}

export async function sendPasswordRecoveryCode(
  recipient: string,
  code: string,
): Promise<RecoveryDelivery> {
  if (!/^\d{6}$/.test(code)) {
    throw new Error('Código de recuperação inválido.')
  }
  return configuredMailer().sendCode(recipient, code)
}

export async function sendPasswordRecoveryLink(
  recipient: string,
  link: string,
): Promise<RecoveryDelivery> {
  return configuredMailer().sendLink(recipient, link)
}
