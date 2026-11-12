/**
 * Consumo médio mensal de um material, a partir das quantidades entregues nos pedidos do
 * Almoxarifado (situação "Entregue"). A janela é de 12 meses; para um material entregue pela
 * primeira vez há menos tempo, conta só desde a primeira entrega, com no mínimo 1 mês, para a média
 * não sair artificialmente baixa. Não usa as movimentações manuais do estoque interno, que podem
 * repetir as mesmas entregas.
 */
export const consumptionWindowMonths = 12

const averageMonthDays = 365.25 / 12
const dayMs = 86_400_000

export type MonthlyConsumption = {
  /** Média por mês, com duas casas; null quando nunca houve entrega. */
  average: number | null
  /** Total entregue dentro da janela. */
  total: number
  /** Meses em que a média se baseia (1 a 12, com uma casa). */
  months: number | null
}

export function monthlyConsumption(
  totalInWindow: number,
  firstDelivery: Date | null,
  now: Date = new Date(),
): MonthlyConsumption {
  if (!firstDelivery || Number.isNaN(firstDelivery.getTime())) {
    return { average: null, total: 0, months: null }
  }
  const windowStart = new Date(now.getTime() - consumptionWindowMonths * averageMonthDays * dayMs)
  const start = firstDelivery > windowStart ? firstDelivery : windowStart
  const elapsed = (now.getTime() - start.getTime()) / (averageMonthDays * dayMs)
  const months = Math.min(consumptionWindowMonths, Math.max(1, Math.round(elapsed * 10) / 10))
  return {
    average: Math.round((totalInWindow / months) * 100) / 100,
    total: totalInWindow,
    months,
  }
}
