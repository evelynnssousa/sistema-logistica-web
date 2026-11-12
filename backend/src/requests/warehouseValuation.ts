/**
 * Valores do Almoxarifado (12/11/2026): custo médio ponderado. Cada material guarda a quantidade
 * em estoque e o valor total desse estoque; o custo médio é a divisão dos dois. Valores em reais,
 * com duas casas, sempre arredondados aqui, para o banco e a tela mostrarem a mesma coisa.
 */

export const cents = (value: number) => Math.round(value * 100) / 100

/** Custo médio por unidade. Sem estoque, não há custo médio. */
export function unitCost(quantity: number, value: number): number | null {
  return quantity > 0 ? cents(value / quantity) : null
}

/**
 * Valor de uma entrada. Com o valor pago, é ele. Sem ele (devolução, ou quem registrou não pode
 * ver valores), a entrada vale o custo médio atual e não muda a média; sem custo médio, vale zero.
 */
export function entryValue(stock: { quantity: number; value: number }, quantity: number, paid: number | null) {
  if (paid !== null) return { value: cents(paid), informed: true }
  if (stock.quantity <= 0) return { value: 0, informed: false }
  return { value: cents((stock.value * quantity) / stock.quantity), informed: false }
}

/**
 * Custo de uma saída: a parte proporcional do valor do estoque. Quando a saída leva tudo o que
 * resta, leva o valor inteiro, para não sobrar centavo sem quantidade.
 */
export function exitCost(stock: { quantity: number; value: number }, quantity: number) {
  if (stock.quantity <= 0 || quantity <= 0) return 0
  if (quantity >= stock.quantity) return cents(stock.value)
  return Math.min(cents(stock.value), cents((stock.value * quantity) / stock.quantity))
}

/** Quanto da entrega sai do saldo interno: nunca mais que o saldo, para a entrega nunca falhar. */
export function deliveryDebit(stockQuantity: number, delivered: number) {
  const debited = Math.max(0, Math.min(stockQuantity, delivered))
  return { debited, missing: Math.max(0, delivered - debited) }
}

/** Situação de uma ata na data de referência (AAAA-MM-DD). */
export function agreementSituation(
  agreement: { active: boolean; validFrom: string | null; validUntil: string | null },
  today: string,
) {
  if (!agreement.active) return 'encerrada' as const
  if (agreement.validFrom && today < agreement.validFrom) return 'futura' as const
  if (agreement.validUntil && today > agreement.validUntil) return 'vencida' as const
  return 'vigente' as const
}
