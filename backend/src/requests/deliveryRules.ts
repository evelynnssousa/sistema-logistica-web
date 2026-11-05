import { isInstitutionalEmailAllowed } from '../auth/institutionalEmail.js'
import { emailPattern } from '../auth/identifiers.js'
import { optionalText, RequestValidationError } from './validation.js'
import type { WarehouseStatus } from './workflow.js'

/**
 * Regras da previsão e da entrega de materiais. A previsão é só um dia do calendário: nada aqui
 * a converte em horário, para que ela não mude de dia conforme o fuso.
 */

const timeZone = 'America/Sao_Paulo'
const today = new Intl.DateTimeFormat('en-CA', { timeZone })

export function todayInSaoPaulo(now = new Date()) {
  return today.format(now)
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  const year = date.getUTCFullYear()
  // A volta para texto recusa dias que não existem, como 31/02.
  return (
    !Number.isNaN(date.getTime()) &&
    year >= 1900 &&
    year <= 2200 &&
    date.toISOString().slice(0, 10) === value
  )
}

export function validateDeliveryForecast(body: Record<string, unknown>, now = new Date()) {
  const date = body.date
  if (!isCalendarDate(date)) {
    throw new RequestValidationError('Informe a data prevista de entrega.')
  }
  if (date < todayInSaoPaulo(now)) {
    throw new RequestValidationError('A data prevista de entrega não pode estar no passado.')
  }
  return { date, justification: optionalText(body.justification, 'Justificativa', 1000) }
}

/**
 * Data efetiva informada pela equipe. Hoje guarda o momento do registro; outro dia, o meio-dia em
 * São Paulo, que continua sendo o mesmo dia em todo o território nacional.
 */
export function readEffectiveDeliveryDate(value: unknown, now = new Date()): Date | null {
  if (value === undefined || value === null || value === '') return null
  if (!isCalendarDate(value)) {
    throw new RequestValidationError('Informe uma data efetiva de entrega válida.')
  }
  const current = todayInSaoPaulo(now)
  if (value > current) {
    throw new RequestValidationError('A data efetiva de entrega não pode estar no futuro.')
  }
  return value === current ? now : new Date(`${value}T12:00:00-03:00`)
}

export function readRequesterEmail(
  value: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const email = optionalText(value, 'E-mail do solicitante', 254)?.toLowerCase() ?? null
  if (email === null) return null
  if (!emailPattern.test(email)) {
    throw new RequestValidationError('E-mail do solicitante inválido.')
  }
  if (!isInstitutionalEmailAllowed(email, environment)) {
    throw new RequestValidationError('Informe o e-mail institucional do solicitante.')
  }
  return email
}

export type DeliveryStatus = 'aguardando_entrega' | 'entrega_reagendada' | 'entregue'

/**
 * Calculada, e não gravada, para nunca divergir do pedido. Só a entrega registrada conclui: ter
 * uma previsão, mesmo vencida, nunca conta como entregue. Pedido encerrado sem entrega não
 * aguarda nada.
 */
export function deliveryStatusOf(input: {
  status: WarehouseStatus
  forecastRevision: number
}): DeliveryStatus | null {
  if (input.status === 'entregue') return 'entregue'
  if (input.status === 'rejeitado' || input.status === 'cancelado') return null
  return input.forecastRevision > 1 ? 'entrega_reagendada' : 'aguardando_entrega'
}
