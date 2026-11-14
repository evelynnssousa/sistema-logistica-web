import type { Resend } from 'resend'
import { createEmailClient, emailCredentials } from './emailProvider.js'
import { isReservedTestEmail } from '../auth/reservedTestEmails.js'
import { RECIPIENT_OUTSIDE_TEST_LIST, realSendGuard } from './recipientAllowlist.js'
import { emailMode } from './config.js'

/**
 * Comunicação com os provedores. Toda falha vira IntegrationError, só com um código: mensagens
 * de terceiros podem repetir endereços ou conteúdo e não entram no banco nem no log.
 */

export class IntegrationError extends Error {
  constructor(
    readonly code: string,
    /** Falhas temporárias são repetidas. As demais vão direto para a fila de falhas. */
    readonly retryable: boolean,
  ) {
    super(code)
    this.name = 'IntegrationError'
  }
}

function isRetryableStatus(status: number | null | undefined) {
  return !status || status === 408 || status === 429 || status >= 500
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------
export type OutgoingEmail = {
  idempotencyKey: string
  to: string
  cc: readonly string[]
  subject: string
  text: string
  html: string
  /** Demais destinatários principais, além de "to". */
  moreTo?: readonly string[]
  attachments?: readonly { filename: string; content: Buffer }[]
}

export type EmailTransport = {
  readonly provider: string
  readonly simulated: boolean
  send(message: OutgoingEmail): Promise<{ messageId: string | null }>
  deliveryStatus?(messageId: string): Promise<string | null>
}

export const simulatedEmailTransport: EmailTransport = {
  provider: 'simulado',
  simulated: true,
  send: async () => ({ messageId: null }),
}

type ResendLike = Pick<Resend, 'emails'>

export function createResendTransport(
  client: ResendLike,
  from: string,
  /**
   * Última barreira da lista de destinatários permitidos (recipientAllowlist.ts): devolve os endereços
   * bloqueados. A conferência principal acontece antes, sem consumir cota.
   */
  guard: (addresses: readonly string[]) => readonly string[] = () => [],
  /** Resend (padrão) ou Brevo, que usa o mesmo formato de cliente (emailProvider.ts). */
  providerName: 'resend' | 'brevo' = 'resend',
): EmailTransport {
  return {
    provider: providerName,
    simulated: false,
    async send(message) {
      const addresses = [message.to, ...(message.moreTo ?? []), ...message.cc]
      // Domínios reservados só existem em testes: nunca chegam ao provedor.
      if (addresses.some(isReservedTestEmail)) {
        throw new IntegrationError('RESERVED_ADDRESS', false)
      }
      if (guard(addresses).length > 0) {
        throw new IntegrationError(RECIPIENT_OUTSIDE_TEST_LIST, false)
      }

      let result
      try {
        result = await client.emails.send(
          {
            from,
            to: [message.to, ...(message.moreTo ?? [])],
            ...(message.cc.length > 0 ? { cc: [...message.cc] } : {}),
            subject: message.subject,
            text: message.text,
            html: message.html,
            ...(message.attachments?.length
              ? { attachments: message.attachments.map(({ filename, content }) => ({ filename, content })) }
              : {}),
          },
          // A mesma chave em todas as tentativas: repetir não duplica a mensagem no provedor.
          { idempotencyKey: message.idempotencyKey },
        )
      } catch {
        throw new IntegrationError('NETWORK', true)
      }

      if (result.error) {
        const status = (result.error as { statusCode?: number | null }).statusCode
        throw new IntegrationError(`${providerName.toUpperCase()}_${status ?? 'ERROR'}`, isRetryableStatus(status))
      }
      return { messageId: result.data?.id ?? null }
    },
    async deliveryStatus(messageId) {
      const result = await client.emails.get(messageId)
      return result.data?.last_event ?? null
    },
  }
}

let testEmailTransport: EmailTransport | null | undefined

/** Só para testes: substitui o transporte escolhido pelo ambiente. undefined restaura. */
export function setEmailTransportForTests(transport: EmailTransport | null | undefined) {
  testEmailTransport = transport
}

export function resolveEmailTransport(
  environment: NodeJS.ProcessEnv = process.env,
): EmailTransport | null {
  // Nunca em produção: a substituição existe só para os testes automatizados.
  if (testEmailTransport !== undefined && environment.NODE_ENV !== 'production') return testEmailTransport
  const mode = emailMode(environment)
  if (mode === 'simulated') return simulatedEmailTransport
  if (mode === 'provider') {
    const { provider, from } = emailCredentials(environment)
    return createResendTransport(createEmailClient(environment), from, realSendGuard(environment), provider)
  }
  return null
}
