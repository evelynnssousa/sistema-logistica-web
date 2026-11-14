import { Resend } from 'resend'

/**
 * Provedor de e-mail (14/11/2026): Resend (padrão) ou Brevo, escolhido por EMAIL_PROVIDER.
 *
 * O Brevo entra para a homologação sem domínio próprio: ele aceita um remetente confirmado por um
 * link enviado ao próprio endereço. O cliente do Brevo imita a parte do cliente do Resend que o
 * sistema usa (emails.send e emails.get), então filas, lista de destinatários permitidos, cota e
 * recuperação de senha seguem iguais. Nenhuma mensagem do provedor é repassada: só o status HTTP.
 */

type Environment = NodeJS.ProcessEnv

export type EmailProviderName = 'resend' | 'brevo'

/** Provedor que envia de verdade: a cota diária e a lista de permitidos valem para todos eles. */
export const isRealProvider = (provider: string) => provider === 'resend' || provider === 'brevo'

export const emailProviderLabels: Record<EmailProviderName, string> = { resend: 'Resend', brevo: 'Brevo' }

export function emailProviderName(environment: Environment = process.env): EmailProviderName {
  return environment.EMAIL_PROVIDER?.trim().toLowerCase() === 'brevo' ? 'brevo' : 'resend'
}

/** Chave e remetente do provedor escolhido. EMAIL_FROM vale para os dois; RESEND_FROM continua aceito. */
export function emailCredentials(environment: Environment = process.env) {
  const provider = emailProviderName(environment)
  const apiKey = (provider === 'brevo' ? environment.BREVO_API_KEY : environment.RESEND_API_KEY)?.trim() ?? ''
  const from = (environment.EMAIL_FROM?.trim() || environment.RESEND_FROM?.trim()) ?? ''
  return { provider, apiKey, from }
}

/** O que o sistema usa do cliente do Resend. */
export type EmailClient = Pick<Resend, 'emails'>

type SendPayload = {
  from: string
  to: string[]
  cc?: string[]
  subject: string
  text?: string
  html?: string
  attachments?: { filename: string; content: Buffer | string }[]
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** "Nome <endereco@dominio>" ou só o endereço. */
export function parseSender(raw: string) {
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(raw)
  if (match) return { name: match[1].replace(/^"|"$/g, '') || undefined, email: match[2].trim() }
  return { email: raw.trim() }
}

export const brevoEndpoint = 'https://api.brevo.com/v3/smtp/email'

/**
 * Cliente do Brevo com a forma do cliente do Resend: devolve { data, error } com o status HTTP.
 * Falha de rede vira exceção, como no Resend, e quem chama trata como NETWORK.
 */
export function createBrevoClient(apiKey: string, fetcher: FetchLike = (input, init) => fetch(input, init)): EmailClient {
  const emails = {
    async send(payload: SendPayload) {
      const body = {
        sender: parseSender(payload.from),
        to: payload.to.map((email) => ({ email })),
        ...(payload.cc?.length ? { cc: payload.cc.map((email) => ({ email })) } : {}),
        subject: payload.subject,
        // O Brevo exige o HTML; sem ele, o texto vira um HTML simples e escapado.
        htmlContent: payload.html ?? `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${escapeHtml(payload.text ?? '')}</pre>`,
        ...(payload.text ? { textContent: payload.text } : {}),
        ...(payload.attachments?.length
          ? {
              attachment: payload.attachments.map((item) => ({
                name: item.filename,
                content: Buffer.isBuffer(item.content) ? item.content.toString('base64') : Buffer.from(item.content).toString('base64'),
              })),
            }
          : {}),
      }
      const response = await fetcher(brevoEndpoint, {
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return { data: null, error: { statusCode: response.status, name: 'brevo_error', message: `Brevo ${response.status}` } }
      }
      const result = (await response.json().catch(() => ({}))) as { messageId?: unknown }
      return { data: { id: typeof result.messageId === 'string' ? result.messageId : '' }, error: null }
    },
    // O Brevo não informa a entrega por esta chamada: a situação fica a do envio aceito.
    async get() {
      return { data: null, error: null }
    },
  }
  return { emails } as unknown as EmailClient
}

/** Cliente do provedor configurado. Quem chama já conferiu que a chave e o remetente existem. */
export function createEmailClient(environment: Environment = process.env): EmailClient {
  const { provider, apiKey } = emailCredentials(environment)
  return provider === 'brevo' ? createBrevoClient(apiKey) : new Resend(apiKey)
}

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
