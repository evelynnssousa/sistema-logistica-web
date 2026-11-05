import type { RequestStatus } from './workflow.js'

/**
 * O que exige justificativa e o que entra no "de → para" da linha do tempo. Regras puras, para
 * valerem igual em toda rota e serem testadas sem banco.
 */

// Dados dos quais depende um atendimento já combinado: mudá-los afeta quem foi avisado.
export const importantFields = new Set([
  'localServico',
  'sala',
  'andar',
  'tipoServico',
  'origem',
  'destino',
  'dataHora',
  'dataHoraRetorno',
  'veiculo',
  'ida',
  'volta',
  'tipoViagem',
])

const committedStatuses: readonly RequestStatus[] = [
  'agendado',
  'reagendado',
  'em_andamento',
  'aguardando_aprovacao',
  'em_emissao',
]

export function requiresJustification(status: RequestStatus, changedFields: readonly string[]) {
  if (changedFields.includes('prioridade')) return true
  return (
    committedStatuses.includes(status) &&
    changedFields.some((field) => importantFields.has(field))
  )
}

const fieldLabels: Record<string, string> = {
  titulo: 'Título',
  descricao: 'Descrição',
  prioridade: 'Prioridade',
  andar: 'Andar',
  tipoServico: 'Tipo de serviço',
  localServico: 'Local',
  sala: 'Sala',
  observacoes: 'Observações',
  origem: 'Origem',
  destino: 'Destino',
  dataHora: 'Data e horário',
  dataHoraRetorno: 'Retorno',
  finalidade: 'Serviço solicitado',
  veiculo: 'Veículo',
  passageiros: 'Passageiros',
  bagagem: 'Bagagem',
  tipoViagem: 'Tipo de viagem',
  ida: 'Ida',
  volta: 'Volta',
}

// Lista de pessoas: o histórico diz que mudou, sem repetir nomes em mais um lugar.
const withheldFields = new Set(['passageiros'])

const maximumValueLength = 300

function printable(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') {
    return value.length > maximumValueLength ? `${value.slice(0, maximumValueLength)}…` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return '(dados estruturados)'
}

/** Só texto curto ou número: CPF digitado por engano é mascarado pela gravação do histórico. */
export function describeChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
) {
  return fields.map((field) => {
    const withheld = withheldFields.has(field)
    return {
      campo: fieldLabels[field] ?? field,
      de: withheld ? null : maskCpfLike(printable(before[field])),
      para: withheld ? null : maskCpfLike(printable(after[field])),
    }
  })
}

const cpfLike = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g

export function maskCpfLike(text: string | null) {
  return text === null ? null : text.replace(cpfLike, '***')
}
