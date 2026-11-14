import { Resend } from 'resend'
import { createTokenSource } from '../attachments/graphAuth.js'
import type { GraphCredentials, TokenSource } from '../attachments/graphAuth.js'

/**
 * Provedor de e-mail (14/11/2026): Resend (padrão), Brevo ou Microsoft 365, escolhido por EMAIL_PROVIDER.
 *
 * O Brevo entra para a homologação sem domínio próprio: ele aceita um remetente confirmado por um
 * link enviado ao próprio endereço. O cliente do Brevo imita a parte do cliente do Resend que o
 * sistema usa (emails.send e emails.get), então filas, lista de destinatários permitidos, cota e
 * recuperação de senha seguem iguais. Nenhuma mensagem do provedor é repassada: só o status HTTP.
 */

type Environment = NodeJS.ProcessEnv

export type EmailProviderName = 'resend' | 'brevo' | 'microsoft'

/** Provedor que envia de verdade: a cota diária e a lista de permitidos valem para todos eles. */
export const isRealProvider = (provider: string) => provider === 'resend' || provider === 'brevo' || provider === 'microsoft'

export const emailProviderLabels: Record<EmailProviderName, string> = { resend: 'Resend', brevo: 'Brevo', microsoft: 'Microsoft 365' }

export function emailProviderName(environment: Environment = process.env): EmailProviderName {
  const raw = environment.EMAIL_PROVIDER?.trim().toLowerCase()
  return raw === 'brevo' ? 'brevo' : raw === 'microsoft' ? 'microsoft' : 'resend'
}

/**
 * Microsoft 365 (14/11/2026): envio pela caixa institucional, pelo Microsoft Graph (sendMail), com
 * um aplicativo registrado pela TI no Entra ID (permissão Mail.Send restrita à caixa do SLM).
 * As mesmas variáveis GRAPH_* do SharePoint: o mesmo aplicativo pode servir aos dois.
 */
export function microsoftCredentials(environment: Environment = process.env): GraphCredentials | null {
  const tenantId = environment.GRAPH_TENANT_ID?.trim() ?? ''
  const clientId = environment.GRAPH_CLIENT_ID?.trim() ?? ''
  const clientSecret = environment.GRAPH_CLIENT_SECRET?.trim() ?? ''
  const privateKey = (environment.GRAPH_CERTIFICATE_PRIVATE_KEY?.trim() ?? '').replace(/\\n/g, '\n')
  const thumbprint = (environment.GRAPH_CERTIFICATE_THUMBPRINT?.trim() ?? '').replace(/[\s:]/g, '').toLowerCase()
  if (!tenantId || !clientId) return null
  if (clientSecret && !privateKey) return { kind: 'secret', tenantId, clientId, clientSecret }
  if (!clientSecret && privateKey.includes('PRIVATE KEY') && /^[0-9a-f]{40}$/.test(thumbprint)) {
    return { kind: 'certificate', tenantId, clientId, privateKey, thumbprint }
  }
  return null
}

/** Chave e remetente do provedor escolhido. EMAIL_FROM vale para todos; RESEND_FROM continua aceito. */
export function emailCredentials(environment: Environment = process.env) {
  const provider = emailProviderName(environment)
  const apiKey =
    provider === 'microsoft'
      ? microsoftCredentials(environment) ? (environment.GRAPH_CLIENT_ID?.trim() ?? '') : ''
      : ((provider === 'brevo' ? environment.BREVO_API_KEY : environment.RESEND_API_KEY)?.trim() ?? '')
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

export const graphSendMailUrl = (sender: string) =>
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`

/**
 * Cliente do Microsoft 365 com a forma do cliente do Resend. O remetente (EMAIL_FROM) é a caixa que
 * envia; a cópia fica em Itens Enviados. O Graph responde 202 sem identificador da mensagem.
 * Anexos vão no próprio pedido, que o Graph limita a cerca de 3 MB: acima disso, a recusa vem como
 * MICROSOFT_413. O token vive só na memória e nunca aparece em erro ou registro.
 */
export function createMicrosoftClient(
  credentials: GraphCredentials,
  fetcher: FetchLike = (input, init) => fetch(input, init),
  tokens: TokenSource = createTokenSource(credentials, { fetcher, now: Date.now, timeoutMs: 20_000 }),
): EmailClient {
  const recipients = (list: string[] | undefined) => (list ?? []).map((address) => ({ emailAddress: { address } }))
  const emails = {
    async send(payload: SendPayload) {
      const sender = parseSender(payload.from).email
      let token: string
      try {
        token = await tokens.token()
      } catch (error) {
        // Credencial recusada pelo Entra ID: falha definitiva, com o status, sem detalhes.
        // Falha temporária (rede, serviço fora) segue como exceção: quem chama trata como NETWORK e repete.
        if ((error as { retryable?: boolean }).retryable === false) {
          return { data: null, error: { statusCode: 401, name: 'microsoft_error', message: 'Microsoft 401' } }
        }
        throw error
      }
      const body = {
        message: {
          subject: payload.subject,
          body: payload.html
            ? { contentType: 'HTML', content: payload.html }
            : { contentType: 'Text', content: payload.text ?? '' },
          toRecipients: recipients(payload.to),
          ...(payload.cc?.length ? { ccRecipients: recipients(payload.cc) } : {}),
          ...(payload.attachments?.length
            ? {
                attachments: payload.attachments.map((item) => ({
                  '@odata.type': '#microsoft.graph.fileAttachment',
                  name: item.filename,
                  contentBytes: Buffer.isBuffer(item.content) ? item.content.toString('base64') : Buffer.from(item.content).toString('base64'),
                })),
              }
            : {}),
        },
        saveToSentItems: true,
      }
      const response = await fetcher(graphSendMailUrl(sender), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 401) tokens.invalidate()
      if (!response.ok) {
        return { data: null, error: { statusCode: response.status, name: 'microsoft_error', message: `Microsoft ${response.status}` } }
      }
      return { data: { id: '' }, error: null }
    },
    async get() {
      return { data: null, error: null }
    },
  }
  return { emails } as unknown as EmailClient
}

let cachedMicrosoft: { key: string; client: EmailClient } | null = null

/** Cliente do provedor configurado. Quem chama já conferiu que a chave e o remetente existem. */
export function createEmailClient(environment: Environment = process.env): EmailClient {
  const { provider, apiKey } = emailCredentials(environment)
  if (provider === 'microsoft') {
    const credentials = microsoftCredentials(environment)!
    // Um cliente por configuração: o token é reaproveitado entre os envios.
    const key = JSON.stringify(credentials)
    if (cachedMicrosoft?.key !== key) cachedMicrosoft = { key, client: createMicrosoftClient(credentials) }
    return cachedMicrosoft.client
  }
  return provider === 'brevo' ? createBrevoClient(apiKey) : new Resend(apiKey)
}

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
