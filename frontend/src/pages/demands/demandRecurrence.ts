import type { RecurrenceEnd, RecurrenceInput } from '../../api/demandsApi'

/** Estado do formulário de repetição, e sua conversão de e para o que a API espera. */

function todayIso() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function parseDays(text: string) {
  return [...new Set(text.split(/[,;\s]+/).filter(Boolean).map(Number))]
}

export type RecurrenceDraft = {
  frequency: string
  interval: string
  unit: string
  weekdays: number[]
  monthDays: string
  startDate: string
  endType: RecurrenceEnd['type']
  endCount: string
  endDate: string
  leadDays: string
  startOffsetDays: string
}

export function emptyRecurrence(): RecurrenceDraft {
  return {
    frequency: 'mensal',
    interval: '1',
    unit: 'mes',
    weekdays: [],
    monthDays: '',
    startDate: todayIso(),
    endType: 'sem_fim',
    endCount: '12',
    endDate: '',
    leadDays: '0',
    startOffsetDays: '0',
  }
}

export function recurrenceDraftFrom(input: Partial<RecurrenceInput> & { startDate: string }): RecurrenceDraft {
  const end = input.end ?? { type: 'sem_fim' as const }
  return {
    frequency: input.frequency ?? 'mensal',
    interval: String(input.interval ?? 1),
    unit: input.unit ?? 'mes',
    weekdays: input.weekdays ?? [],
    monthDays: (input.monthDays ?? []).join(', '),
    startDate: input.startDate,
    endType: end.type,
    endCount: end.type === 'quantidade' ? String(end.count) : '12',
    endDate: end.type === 'data' ? end.date : '',
    leadDays: String(input.leadDays ?? 0),
    startOffsetDays: String(input.startOffsetDays ?? 0),
  }
}

export function recurrencePayload(draft: RecurrenceDraft): RecurrenceInput {
  const end: RecurrenceEnd =
    draft.endType === 'quantidade'
      ? { type: 'quantidade', count: Number(draft.endCount) }
      : draft.endType === 'data'
        ? { type: 'data', date: draft.endDate }
        : { type: 'sem_fim' }
  return {
    frequency: draft.frequency,
    interval: Number(draft.interval),
    unit: draft.unit,
    weekdays: draft.weekdays,
    monthDays: parseDays(draft.monthDays),
    startDate: draft.startDate,
    end,
    leadDays: Number(draft.leadDays),
    startOffsetDays: Number(draft.startOffsetDays),
  }
}
