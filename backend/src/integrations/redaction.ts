import { isValidCpf } from '../requests/cpfProtection.js'

/**
 * Proteção de textos livres, como motivos e comentários, que podem trazer um CPF digitado
 * por engano.
 */

const cpfLike = /(?<!\d)\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}(?!\d)/g
const maskedCpf = '***.***.***-**'

/**
 * Para o que sai do sistema (e-mail e calendário): mascara qualquer sequência no formato de
 * CPF, mesmo com dígitos verificadores errados, porque ali o custo do engano é maior.
 */
export function redactForOutbound(text: string): string {
  return text.replace(cpfLike, maskedCpf)
}

/**
 * Para o que fica no sistema (histórico e motivos): mascara só CPFs válidos, para não apagar
 * telefones e outros números úteis que os operadores registram.
 */
export function redactValidCpf(text: string): string {
  return text.replace(cpfLike, (match) =>
    isValidCpf(match.replace(/\D/g, '')) ? maskedCpf : match,
  )
}

export function redactOptional(text: string | null): string | null {
  return text === null ? null : redactValidCpf(text)
}

/** "pessoa@orgao.sp.gov.br" vira "pe***@orgao.sp.gov.br". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1) return '***'
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`
}
