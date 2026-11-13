import type { Journey } from '../auth/driverPolicy.js'

/**
 * Carga horária dos motoristas, ESTIMADA a partir das viagens: os motoristas não batem ponto no sistema (decisão de 12/11/2026),
 * só o início e o fim real de cada viagem. Regras, por motorista e por dia (horário de Brasília,
 * pelo dia em que a viagem começou):
 *
 * - jornada do dia: da primeira saída à última chegada, menos o intervalo da jornada, e nunca menos
 *   que o tempo efetivamente em viagem;
 * - prevista: a duração prevista da jornada ou, sem ela, a faixa (fim − início) menos o intervalo,
 *   só nos dias da jornada; em outro dia, a prevista é zero e tudo conta como extra;
 * - horas extras: o que passa da prevista; horas a menos: o que falta para ela;
 * - dias sem viagem não entram: o sistema não sabe se a pessoa trabalhou na base ou não trabalhou.
 *
 * Viagens sem início ou sem fim real ficam de fora do cálculo de horas.
 */

export type WorkloadTrip = {
  driverId: string
  driverName: string
  startedAt: Date | null
  finishedAt: Date | null
}

export type WorkloadDay = {
  driverId: string
  driverName: string
  /** AAAA-MM-DD, no horário de Brasília. */
  day: string
  trips: number
  firstStart: Date
  lastFinish: Date
  tripMinutes: number
  outsideJourneyMinutes: number
  workedMinutes: number
  expectedMinutes: number
  extraMinutes: number
  missingMinutes: number
}

export type WorkloadSummary = {
  driverId: string
  driverName: string
  days: number
  trips: number
  tripMinutes: number
  outsideJourneyMinutes: number
  workedMinutes: number
  expectedMinutes: number
  extraMinutes: number
  missingMinutes: number
  /** Extras menos horas a menos: positivo é saldo a favor do motorista. */
  balanceMinutes: number
}

const saoPauloDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const toMinutes = (hour: string) => Number(hour.slice(0, 2)) * 60 + Number(hour.slice(3, 5))

/** Dia da semana (0 = domingo) de uma data AAAA-MM-DD, sem depender do fuso do servidor. */
function weekdayOf(day: string) {
  return new Date(`${day}T12:00:00Z`).getUTCDay()
}

export function expectedDailyMinutes(journey: Journey) {
  if (journey.expectedMinutes !== null) return journey.expectedMinutes
  return Math.max(0, toMinutes(journey.end) - toMinutes(journey.start) - journey.breakMinutes)
}

const saoPauloClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Sao_Paulo',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/**
 * O minuto que começa neste instante está fora da jornada? Para medir duração, o minuto das 17h00
 * às 17h01 já é fora de uma jornada que acaba às 17h (por isso não usa isOutsideJourney, que trata
 * o fim em ponto como dentro, para decidir se uma viagem começou fora).
 */
function minuteOutside(moment: Date, journey: Journey) {
  const minutes = toMinutes(saoPauloClock.format(moment))
  return (
    !journey.weekdays.includes(weekdayOf(saoPauloDay.format(moment))) ||
    minutes < toMinutes(journey.start) ||
    minutes >= toMinutes(journey.end)
  )
}

/** Minutos da viagem fora da faixa ou dos dias da jornada (viagens longas são amostradas). */
function minutesOutside(start: Date, end: Date, journey: Journey) {
  const total = Math.round((end.getTime() - start.getTime()) / 60_000)
  const step = Math.max(1, Math.ceil(total / 1440))
  let outside = 0
  for (let minute = 0; minute < total; minute += step) {
    if (minuteOutside(new Date(start.getTime() + minute * 60_000), journey)) outside += Math.min(step, total - minute)
  }
  return outside
}

/** holidays: datas AAAA-MM-DD definidas em Configurações; nelas não há horas previstas. */
export function workloadByDay(trips: readonly WorkloadTrip[], journey: Journey, holidays: readonly string[] = []): WorkloadDay[] {
  const groups = new Map<string, { driverId: string; driverName: string; day: string; spans: { start: Date; end: Date }[] }>()
  for (const trip of trips) {
    if (!trip.startedAt || !trip.finishedAt || trip.finishedAt < trip.startedAt) continue
    const day = saoPauloDay.format(trip.startedAt)
    const key = `${trip.driverId}|${day}`
    const group = groups.get(key) ?? { driverId: trip.driverId, driverName: trip.driverName, day, spans: [] }
    group.spans.push({ start: trip.startedAt, end: trip.finishedAt })
    groups.set(key, group)
  }

  const expected = expectedDailyMinutes(journey)
  return [...groups.values()]
    .map((group) => {
      const firstStart = new Date(Math.min(...group.spans.map((span) => span.start.getTime())))
      const lastFinish = new Date(Math.max(...group.spans.map((span) => span.end.getTime())))
      const tripMinutes = group.spans.reduce(
        (sum, span) => sum + Math.round((span.end.getTime() - span.start.getTime()) / 60_000),
        0,
      )
      const spanMinutes = Math.round((lastFinish.getTime() - firstStart.getTime()) / 60_000)
      const workedMinutes = Math.max(tripMinutes, spanMinutes - journey.breakMinutes)
      const expectedMinutes = journey.weekdays.includes(weekdayOf(group.day)) && !holidays.includes(group.day) ? expected : 0
      return {
        driverId: group.driverId,
        driverName: group.driverName,
        day: group.day,
        trips: group.spans.length,
        firstStart,
        lastFinish,
        tripMinutes,
        outsideJourneyMinutes: group.spans.reduce((sum, span) => sum + minutesOutside(span.start, span.end, journey), 0),
        workedMinutes,
        expectedMinutes,
        extraMinutes: Math.max(0, workedMinutes - expectedMinutes),
        missingMinutes: Math.max(0, expectedMinutes - workedMinutes),
      }
    })
    .sort((a, b) => a.driverName.localeCompare(b.driverName, 'pt-BR') || a.day.localeCompare(b.day))
}

export function workloadSummary(days: readonly WorkloadDay[]): WorkloadSummary[] {
  const byDriver = new Map<string, WorkloadSummary>()
  for (const day of days) {
    const current = byDriver.get(day.driverId) ?? {
      driverId: day.driverId,
      driverName: day.driverName,
      days: 0,
      trips: 0,
      tripMinutes: 0,
      outsideJourneyMinutes: 0,
      workedMinutes: 0,
      expectedMinutes: 0,
      extraMinutes: 0,
      missingMinutes: 0,
      balanceMinutes: 0,
    }
    current.days += 1
    current.trips += day.trips
    current.tripMinutes += day.tripMinutes
    current.outsideJourneyMinutes += day.outsideJourneyMinutes
    current.workedMinutes += day.workedMinutes
    current.expectedMinutes += day.expectedMinutes
    current.extraMinutes += day.extraMinutes
    current.missingMinutes += day.missingMinutes
    current.balanceMinutes = current.extraMinutes - current.missingMinutes
    byDriver.set(day.driverId, current)
  }
  return [...byDriver.values()].sort((a, b) => a.driverName.localeCompare(b.driverName, 'pt-BR'))
}

/** 125 minutos viram "2:05"; negativos levam o sinal: "-0:30". */
export function formatHours(minutes: number) {
  const sign = minutes < 0 ? '-' : ''
  const absolute = Math.abs(Math.round(minutes))
  return `${sign}${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, '0')}`
}
