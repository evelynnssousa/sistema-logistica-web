import { useMemo, useState } from 'react'

/** Períodos oferecidos nos filtros suspensos. "Personalizado" abre os campos de data. */
export const periodOptions = [
  { value: '', label: 'Todo o período' },
  { value: '7', label: 'Últimos 7 dias' },
  { value: '30', label: 'Últimos 30 dias' },
  { value: '90', label: 'Últimos 90 dias' },
  { value: '365', label: 'Últimos 12 meses' },
  { value: 'custom', label: 'Personalizado' },
] as const

function resolve(period: string, from: string, to: string) {
  if (period === 'custom') {
    return {
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
    }
  }
  if (!period) return { from: undefined, to: undefined }

  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - Number(period))
  return { from: start.toISOString(), to: undefined }
}

export function usePeriodFilter() {
  const [period, setPeriod] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const range = useMemo(() => resolve(period, from, to), [period, from, to])

  return {
    period,
    from,
    to,
    range,
    setPeriod,
    setFrom,
    setTo,
    isActive: period !== '',
    clear() {
      setPeriod('')
      setFrom('')
      setTo('')
    },
  }
}

export type PeriodFilter = ReturnType<typeof usePeriodFilter>
