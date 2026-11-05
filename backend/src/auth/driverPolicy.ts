/**
 * Regras do perfil Motorista. O perfil é fechado por padrão: além das permissões, que ele não tem, a
 * API recusa qualquer rota fora desta lista. Assim, uma rota nova, ou uma rota que só exige sessão,
 * nunca fica ao alcance do motorista por esquecimento.
 */

const driverApiPrefixes = ['/driver', '/auth', '/notifications'] as const

/** Recebe o caminho da requisição, com ou sem o prefixo /api e com ou sem parâmetros. */
export function isDriverApiPath(url: string) {
  const path = url.split('?')[0].replace(/^\/api(?=\/)/, '')
  return driverApiPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

// ---------------------------------------------------------------------------
// Jornada de referência
// ---------------------------------------------------------------------------

/** A jornada editável em Configurações. Dias: 0 é domingo, como em Date.getDay(). */
export type Journey = {
  start: string
  end: string
  weekdays: number[]
  breakMinutes: number
  expectedMinutes: number | null
}

/**
 * Padrão sem nada cadastrado, e a referência das viagens anteriores à migração 017. Todos os dias:
 * nenhum dia foi definido pela instituição, e a regra anterior não distinguia dias.
 */
export const defaultJourney: Journey = {
  start: '07:00',
  end: '19:00',
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  breakMinutes: 0,
  expectedMinutes: null,
}

const journeyTimeZone = 'America/Sao_Paulo'

const toMinutes = (hour: string) => Number(hour.slice(0, 2)) * 60 + Number(hour.slice(3, 5))

const saoPauloClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: journeyTimeZone,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const saoPauloDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: journeyTimeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const saoPauloWeekday = new Intl.DateTimeFormat('en-US', { timeZone: journeyTimeZone, weekday: 'short' })
const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Fora da faixa ou dos dias da jornada, no horário de São Paulo. O fim da faixa em ponto ainda está dentro. */
export function isOutsideJourney(moment: Date, journey: Journey = defaultJourney) {
  const minutes = toMinutes(saoPauloClock.format(moment))
  return (
    minutes < toMinutes(journey.start) ||
    minutes > toMinutes(journey.end) ||
    !journey.weekdays.includes(weekdayNames.indexOf(saoPauloWeekday.format(moment)))
  )
}

/**
 * A viagem ultrapassa a jornada se começou ou terminou fora dela, se atravessou a noite, se ainda está
 * em andamento depois do fim da faixa ou, havendo duração prevista, se durou mais que ela e o intervalo.
 */
export function exceedsJourney(
  trip: { startedAt: Date | null; finishedAt: Date | null },
  now = new Date(),
  journey: Journey = defaultJourney,
) {
  if (!trip.startedAt) return false
  const end = trip.finishedAt ?? now
  const duration = (end.getTime() - trip.startedAt.getTime()) / 60_000
  return (
    isOutsideJourney(trip.startedAt, journey) ||
    isOutsideJourney(end, journey) ||
    saoPauloDay.format(trip.startedAt) !== saoPauloDay.format(end) ||
    (journey.expectedMinutes !== null && duration > journey.expectedMinutes + journey.breakMinutes)
  )
}

/** A jornada guardada na viagem ao iniciar. Registro antigo, sem ela, fica com a referência da época. */
export function journeyOfRecord(record: unknown): Journey {
  const stored = (record as { jornada?: Partial<Journey> } | null | undefined)?.jornada
  return stored && typeof stored.start === 'string' && typeof stored.end === 'string' && Array.isArray(stored.weekdays)
    ? { ...defaultJourney, ...stored }
    : defaultJourney
}

/** Tempo efetivo, em minutos. Sem início e fim, não há o que calcular. */
export function effectiveMinutes(trip: { startedAt: Date | null; finishedAt: Date | null }) {
  if (!trip.startedAt || !trip.finishedAt) return null
  return Math.max(0, Math.round((trip.finishedAt.getTime() - trip.startedAt.getTime()) / 60_000))
}

// ---------------------------------------------------------------------------
// Grupos de viagens do portal
// ---------------------------------------------------------------------------

export const tripGroups = ['proximas', 'agendadas', 'em_andamento', 'concluidas', 'canceladas'] as const
export type TripGroup = (typeof tripGroups)[number]
