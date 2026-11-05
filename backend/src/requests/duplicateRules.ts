/**
 * Semelhança entre uma solicitação em preenchimento e as já abertas. É só um alerta: nada aqui
 * impede o registro, porque demandas legítimas podem se parecer. Passageiros e CPF não entram.
 */

export type DuplicateProbe = {
  requesterId: string
  sector: string | null
  floorId: string | null
  serviceTypeId: string | null
  location: string | null
  vehicle: string | null
  origin: string | null
  destination: string | null
  /** Data pedida, em ISO. */
  date: string | null
  description: string | null
}

const dayInMs = 86_400_000
const stopWords = new Set([
  'a', 'o', 'as', 'os', 'de', 'do', 'da', 'dos', 'das', 'e', 'em', 'no', 'na', 'nos', 'nas', 'um',
  'uma', 'para', 'por', 'com', 'que', 'se', 'ao', 'aos', 'solicito', 'solicitacao', 'favor',
])

export function normalizeText(value: string | null | undefined) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const same = (first: string | null, second: string | null) =>
  Boolean(first && second && normalizeText(first) === normalizeText(second))

/** Proporção de palavras em comum, de 0 a 1, sem contar palavras sem conteúdo. */
export function textSimilarity(first: string | null, second: string | null) {
  const words = (text: string | null) =>
    new Set(normalizeText(text).split(' ').filter((word) => word.length > 1 && !stopWords.has(word)))
  const left = words(first)
  const right = words(second)
  if (left.size === 0 || right.size === 0) return 0
  const shared = [...left].filter((word) => right.has(word)).length
  return shared / (left.size + right.size - shared)
}

const threshold = 5

/**
 * Pontua e explica. Ser da mesma pessoa ou do mesmo setor não basta sozinho: é preciso um sinal
 * sobre o conteúdo, senão todo pedido de um setor movimentado pareceria repetido.
 */
export function compareDuplicate(probe: DuplicateProbe, candidate: DuplicateProbe) {
  const reasons: string[] = []
  let score = 0
  let aboutContent = false

  const signal = (matched: boolean, points: number, label: string, content = true) => {
    if (!matched) return
    score += points
    reasons.push(label)
    if (content) aboutContent = true
  }

  signal(probe.requesterId === candidate.requesterId, 2, 'Mesmo solicitante', false)
  signal(same(probe.sector, candidate.sector), 1, 'Mesmo setor', false)
  signal(Boolean(probe.floorId) && probe.floorId === candidate.floorId, 1, 'Mesmo andar', false)
  signal(Boolean(probe.serviceTypeId) && probe.serviceTypeId === candidate.serviceTypeId, 2, 'Mesma categoria')
  signal(same(probe.location, candidate.location), 2, 'Mesmo local')
  signal(same(probe.vehicle, candidate.vehicle), 2, 'Mesmo veículo')
  signal(same(probe.origin, candidate.origin) && same(probe.destination, candidate.destination), 3, 'Mesmo trajeto')

  if (probe.date && candidate.date) {
    const distance = Math.abs(new Date(probe.date).getTime() - new Date(candidate.date).getTime())
    signal(distance <= dayInMs, 2, 'Mesma data ou período')
  }

  const similarity = textSimilarity(probe.description, candidate.description)
  if (similarity >= 0.6) signal(true, 3, 'Descrição muito parecida')
  else if (similarity >= 0.35) signal(true, 1, 'Descrição parecida')

  return { score, reasons, possibleDuplicate: aboutContent && score >= threshold }
}
