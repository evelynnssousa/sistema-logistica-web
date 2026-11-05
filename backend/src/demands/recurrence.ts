import { asBody, RequestValidationError } from '../requests/validation.js'

/**
 * Regras de repetição, sem banco e sem relógio: tudo é calculado sobre datas de calendário
 * (AAAA-MM-DD), para o dia nunca mudar por causa de fuso ou horário de verão.
 *
 * Dia inexistente no mês vira o último dia daquele mês: dia 31 cai em 30/04 e em 28/02, ou 29/02
 * em ano bissexto. Com isso, uma série mensal do dia 31 nunca perde um mês.
 */

export const frequencies = [
  'diaria',
  'semanal',
  'quinzenal',
  'mensal',
  'bimestral',
  'trimestral',
  'semestral',
  'anual',
  'personalizada',
] as const
export type Frequency = (typeof frequencies)[number]

export const units = ['dia', 'semana', 'mes', 'ano'] as const
export type Unit = (typeof units)[number]

export type RecurrenceEnd =
  | { type: 'sem_fim' }
  | { type: 'quantidade'; count: number }
  | { type: 'data'; date: string }

export type RecurrenceRule = {
  frequency: Frequency
  interval: number
  unit: Unit
  /** 0 = domingo. Só na repetição por semana. */
  weekdays: number[]
  /** 1 a 31. Só na repetição por mês ou ano. */
  monthDays: number[]
  startDate: string
  end: RecurrenceEnd
}

const presets: Record<Exclude<Frequency, 'personalizada'>, { interval: number; unit: Unit }> = {
  diaria: { interval: 1, unit: 'dia' },
  semanal: { interval: 1, unit: 'semana' },
  quinzenal: { interval: 15, unit: 'dia' },
  mensal: { interval: 1, unit: 'mes' },
  bimestral: { interval: 2, unit: 'mes' },
  trimestral: { interval: 3, unit: 'mes' },
  semestral: { interval: 6, unit: 'mes' },
  anual: { interval: 1, unit: 'ano' },
}

const dayMs = 86_400_000
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/

function toDayNumber(date: string) {
  const match = datePattern.exec(date)
  if (!match) throw new RequestValidationError('Data inválida.')
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / dayMs
}

function fromDayNumber(day: number) {
  return new Date(day * dayMs).toISOString().slice(0, 10)
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !datePattern.test(value)) return false
  const day = toDayNumber(value)
  const year = Number(value.slice(0, 4))
  // Confere se a data existe: 2026-02-30 voltaria como 2026-03-02.
  return fromDayNumber(day) === value && year >= 2000 && year <= 2200
}

export function addDays(date: string, days: number) {
  return fromDayNumber(toDayNumber(date) + days)
}

export function daysBetween(from: string, to: string) {
  return toDayNumber(to) - toDayNumber(from)
}

function weekdayOf(day: number) {
  // 01/01/1970 foi uma quinta-feira.
  return (((day + 4) % 7) + 7) % 7
}

function lastDayOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

function datesInMonth(monthIndex: number, monthDays: readonly number[]) {
  const year = Math.floor(monthIndex / 12)
  const month = monthIndex % 12
  const last = lastDayOfMonth(year, month)
  const days = [...new Set(monthDays.map((day) => Math.min(day, last)))].sort((a, b) => a - b)
  return days.map((day) => fromDayNumber(Date.UTC(year, month, day) / dayMs))
}

function monthIndexOf(date: string) {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1
}

function nextByMonth(rule: RecurrenceRule, floor: string) {
  const step = rule.unit === 'ano' ? rule.interval * 12 : rule.interval
  const base = monthIndexOf(rule.startDate)
  const offset = Math.max(0, monthIndexOf(floor) - base)
  let index = base + Math.floor(offset / step) * step
  // Sempre há data dentro de dois passos; o limite só protege contra regra corrompida.
  for (let attempt = 0; attempt < 400; attempt += 1, index += step) {
    const found = datesInMonth(index, rule.monthDays).find((date) => date >= floor)
    if (found) return found
  }
  return null
}

function nextByWeek(rule: RecurrenceRule, floor: string) {
  const start = toDayNumber(rule.startDate)
  const firstWeek = start - weekdayOf(start)
  const floorDay = toDayNumber(floor)
  const weeksSince = Math.max(0, Math.floor((floorDay - firstWeek) / 7))
  let week = firstWeek + Math.floor(weeksSince / rule.interval) * rule.interval * 7
  const days = [...rule.weekdays].sort((a, b) => a - b)
  for (let attempt = 0; attempt < 400; attempt += 1, week += rule.interval * 7) {
    for (const weekday of days) {
      if (week + weekday >= floorDay) return fromDayNumber(week + weekday)
    }
  }
  return null
}

function nextByDay(rule: RecurrenceRule, floor: string) {
  const start = toDayNumber(rule.startDate)
  const elapsed = toDayNumber(floor) - start
  return fromDayNumber(start + Math.ceil(elapsed / rule.interval) * rule.interval)
}

/**
 * Primeira data da regra a partir de "from", inclusive. Respeita a data final; a quantidade de
 * ocorrências é controlada por quem gera, porque depende do que já foi registrado.
 */
export function occurrenceOnOrAfter(rule: RecurrenceRule, from: string): string | null {
  const floor = from < rule.startDate ? rule.startDate : from
  const found =
    rule.unit === 'dia'
      ? nextByDay(rule, floor)
      : rule.unit === 'semana'
        ? nextByWeek(rule, floor)
        : nextByMonth(rule, floor)
  if (!found) return null
  if (rule.end.type === 'data' && found > rule.end.date) return null
  return found
}

export function occurrenceAfter(rule: RecurrenceRule, date: string) {
  return occurrenceOnOrAfter(rule, addDays(date, 1))
}

/** Datas da regra em um intervalo, para a agenda e para a prévia. Limitado por "limit". */
export function occurrencesBetween(rule: RecurrenceRule, from: string, to: string, limit = 400) {
  const dates: string[] = []
  let current = occurrenceOnOrAfter(rule, from)
  while (current && current <= to && dates.length < limit) {
    dates.push(current)
    current = occurrenceAfter(rule, current)
  }
  return dates
}

function readInteger(value: unknown, label: string, min: number, max: number) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
    throw new RequestValidationError(`${label} inválido.`)
  }
  return number
}

function readIntegerList(value: unknown, label: string, min: number, max: number) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 31) throw new RequestValidationError(`${label} inválidos.`)
  const list = value.map((item) => readInteger(item, label, min, max))
  return [...new Set(list)].sort((a, b) => a - b)
}

/** Valida o que veio da tela e completa os padrões a partir da data inicial. */
export function readRecurrenceRule(input: unknown): RecurrenceRule {
  const body = asBody(input)
  const frequency = body.frequency as Frequency
  if (!frequencies.includes(frequency)) throw new RequestValidationError('Selecione a frequência da repetição.')

  const startDate = body.startDate
  if (!isCalendarDate(startDate)) throw new RequestValidationError('Informe a data inicial da repetição.')

  let interval: number
  let unit: Unit
  if (frequency === 'personalizada') {
    unit = body.unit as Unit
    if (!units.includes(unit)) throw new RequestValidationError('Selecione a unidade da repetição.')
    interval = readInteger(body.interval, 'Intervalo', 1, 365)
  } else {
    ;({ interval, unit } = presets[frequency])
  }

  let weekdays = readIntegerList(body.weekdays, 'Dias da semana', 0, 6)
  let monthDays = readIntegerList(body.monthDays, 'Dias do mês', 1, 31)

  if (unit === 'semana') {
    monthDays = []
    if (weekdays.length === 0) weekdays = [weekdayOf(toDayNumber(startDate))]
  } else if (unit === 'mes' || unit === 'ano') {
    weekdays = []
    if (monthDays.length === 0) monthDays = [Number(startDate.slice(8, 10))]
  } else {
    weekdays = []
    monthDays = []
  }

  const endBody = asBody(body.end)
  let end: RecurrenceEnd
  if (endBody.type === 'quantidade') {
    end = { type: 'quantidade', count: readInteger(endBody.count, 'Quantidade de ocorrências', 1, 1000) }
  } else if (endBody.type === 'data') {
    if (!isCalendarDate(endBody.date)) throw new RequestValidationError('Informe a data de encerramento.')
    if (endBody.date < startDate) {
      throw new RequestValidationError('O encerramento não pode ser anterior à data inicial.')
    }
    end = { type: 'data', date: endBody.date }
  } else if (endBody.type === undefined || endBody.type === 'sem_fim') {
    end = { type: 'sem_fim' }
  } else {
    throw new RequestValidationError('Selecione como a repetição termina.')
  }

  return { frequency, interval, unit, weekdays, monthDays, startDate, end }
}

const weekdayNames = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
const unitNames: Record<Unit, [string, string]> = {
  dia: ['dia', 'dias'],
  semana: ['semana', 'semanas'],
  mes: ['mês', 'meses'],
  ano: ['ano', 'anos'],
}

function listNames(items: readonly string[]) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`
}

/** Frase para a tela, o histórico e os relatórios. */
export function describeRule(rule: RecurrenceRule) {
  const [singular, plural] = unitNames[rule.unit]
  const every = rule.interval === 1 ? `A cada ${singular}` : `A cada ${rule.interval} ${plural}`
  const when =
    rule.unit === 'semana'
      ? `, ${listNames(rule.weekdays.map((day) => weekdayNames[day]))}`
      : rule.unit === 'mes' || rule.unit === 'ano'
        ? `, ${rule.monthDays.length > 1 ? 'dias' : 'dia'} ${listNames(rule.monthDays.map(String))}`
        : ''
  const inMonth = rule.unit === 'ano' ? ` de cada ano, a partir de ${rule.startDate.slice(5, 7)}/${rule.startDate.slice(0, 4)}` : ''
  const end =
    rule.end.type === 'quantidade'
      ? ` · termina após ${rule.end.count} ${rule.end.count === 1 ? 'ocorrência' : 'ocorrências'}`
      : rule.end.type === 'data'
        ? ` · termina em ${rule.end.date.split('-').reverse().join('/')}`
        : ''
  return `${every}${when}${inMonth}${end}`
}
