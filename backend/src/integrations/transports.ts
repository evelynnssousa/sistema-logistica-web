import { createSign } from 'node:crypto'
import { Resend } from 'resend'
import { isReservedTestEmail } from '../auth/reservedTestEmails.js'
import { calendarCredentials, calendarIdFor, calendarMode, emailMode } from './config.js'
import type { CalendarCredentials } from './config.js'

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
): EmailTransport {
  return {
    provider: 'resend',
    simulated: false,
    async send(message) {
      // Domínios reservados só existem em testes: nunca chegam ao provedor.
      if ([message.to, ...(message.moreTo ?? []), ...message.cc].some(isReservedTestEmail)) {
        throw new IntegrationError('RESERVED_ADDRESS', false)
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
        throw new IntegrationError(`RESEND_${status ?? 'ERROR'}`, isRetryableStatus(status))
      }
      return { messageId: result.data?.id ?? null }
    },
    async deliveryStatus(messageId) {
      const result = await client.emails.get(messageId)
      return result.data?.last_event ?? null
    },
  }
}

export function resolveEmailTransport(
  environment: NodeJS.ProcessEnv = process.env,
): EmailTransport | null {
  const mode = emailMode(environment)
  if (mode === 'simulated') return simulatedEmailTransport
  if (mode === 'provider') {
    return createResendTransport(
      new Resend(environment.RESEND_API_KEY!.trim()),
      environment.RESEND_FROM!.trim(),
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Calendário
// ---------------------------------------------------------------------------
export type CalendarEventInput = {
  /** Mesmo identificador em todas as tentativas: repetir não cria evento duplicado. */
  eventId: string
  module: 'maintenance' | 'fleet'
  summary: string
  description: string
  start: Date
  end: Date | null
}

export type CalendarTransport = {
  readonly provider: string
  readonly simulated: boolean
  upsert(event: CalendarEventInput): Promise<void>
  remove(module: 'maintenance' | 'fleet', eventId: string): Promise<void>
}

export const simulatedCalendarTransport: CalendarTransport = {
  provider: 'simulado',
  simulated: true,
  upsert: async () => {},
  remove: async () => {},
}

/** O Google aceita identificadores em base32hex: um UUID sem hifens se encaixa. */
export function externalEventId(requestId: string) {
  return `slm${requestId.replace(/-/g, '').toLowerCase()}`
}

const calendarApi = 'https://www.googleapis.com/calendar/v3/calendars'
const tokenEndpoint = 'https://oauth2.googleapis.com/token'
const calendarScope = 'https://www.googleapis.com/auth/calendar.events'
const timeZone = 'America/Sao_Paulo'

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** Asserção assinada da conta de serviço (OAuth 2.0 para servidores). */
export function buildServiceAccountAssertion(credentials: CalendarCredentials, nowSeconds: number) {
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: credentials.serviceAccountEmail,
    scope: calendarScope,
    aud: tokenEndpoint,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(credentials.privateKey)
  return `${unsigned}.${signature.toString('base64url')}`
}

type FetchLike = typeof fetch

export function createGoogleCalendarTransport(
  credentials: CalendarCredentials,
  calendarOf: (module: 'maintenance' | 'fleet') => string | null,
  fetcher: FetchLike = fetch,
  now: () => number = Date.now,
): CalendarTransport {
  let token: { value: string; expiresAt: number } | null = null

  async function call(url: string, init: RequestInit) {
    try {
      return await fetcher(url, init)
    } catch {
      throw new IntegrationError('NETWORK', true)
    }
  }

  async function accessToken() {
    if (token && token.expiresAt > now() + 60_000) return token.value

    let assertion: string
    try {
      assertion = buildServiceAccountAssertion(credentials, Math.floor(now() / 1000))
    } catch {
      throw new IntegrationError('GOOGLE_INVALID_KEY', false)
    }

    const response = await call(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    })
    if (!response.ok) {
      throw new IntegrationError(`GOOGLE_AUTH_${response.status}`, isRetryableStatus(response.status))
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number }
    if (!body.access_token) throw new IntegrationError('GOOGLE_AUTH_EMPTY', true)
    token = {
      value: body.access_token,
      expiresAt: now() + (body.expires_in ?? 3600) * 1000,
    }
    return token.value
  }

  function eventsUrl(module: 'maintenance' | 'fleet', eventId?: string) {
    const calendarId = calendarOf(module)
    if (!calendarId) throw new IntegrationError('CALENDAR_ID_MISSING', false)
    const base = `${calendarApi}/${encodeURIComponent(calendarId)}/events`
    return eventId ? `${base}/${encodeURIComponent(eventId)}` : base
  }

  function failure(response: Response) {
    // O Google responde 403 também para limite de uso, que passa com o tempo.
    const retryable = isRetryableStatus(response.status) || response.status === 403
    return new IntegrationError(`GOOGLE_${response.status}`, retryable)
  }

  return {
    provider: 'google_calendar',
    simulated: false,

    async upsert(event) {
      const authorization = `Bearer ${await accessToken()}`
      const headers = { authorization, 'content-type': 'application/json' }
      const body = JSON.stringify({
        id: event.eventId,
        summary: event.summary,
        description: event.description,
        status: 'confirmed',
        start: { dateTime: event.start.toISOString(), timeZone },
        // O Google exige um fim. Sem término previsto, informa que ele não foi definido.
        end: {
          dateTime: (event.end ?? new Date(event.start.getTime() + 3_600_000)).toISOString(),
          timeZone,
        },
        ...(event.end ? {} : { endTimeUnspecified: true }),
      })

      const updated = await call(eventsUrl(event.module, event.eventId), {
        method: 'PUT',
        headers,
        body,
      })
      if (updated.ok) return
      if (updated.status !== 404) throw failure(updated)

      const inserted = await call(eventsUrl(event.module), { method: 'POST', headers, body })
      if (inserted.ok) return
      // Outra tentativa criou o evento neste intervalo: a próxima o atualiza.
      if (inserted.status === 409) throw new IntegrationError('GOOGLE_409', true)
      throw failure(inserted)
    },

    async remove(module, eventId) {
      const response = await call(eventsUrl(module, eventId), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${await accessToken()}` },
      })
      // Já removido: o resultado desejado foi alcançado.
      if (response.ok || response.status === 404 || response.status === 410) return
      throw failure(response)
    },
  }
}

export function resolveCalendarTransport(
  environment: NodeJS.ProcessEnv = process.env,
): CalendarTransport | null {
  const mode = calendarMode(undefined, environment)
  if (mode === 'simulated') return simulatedCalendarTransport
  if (mode === 'provider') {
    return createGoogleCalendarTransport(calendarCredentials(environment)!, (module) =>
      calendarIdFor(module, environment),
    )
  }
  return null
}
