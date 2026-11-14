/**
 * Cores dos gráficos (14/11/2026), iguais no Dashboard e nos Relatórios.
 *
 * Módulos: cada módulo tem sempre a mesma cor, em qualquer gráfico e com qualquer filtro (a cor segue
 * o módulo, nunca a posição). Ordem fixa da paleta validada para daltonismo: azul, laranja,
 * verde-água e amarelo. As duas últimas têm pouco contraste com o fundo branco: por isso o número
 * fica sempre escrito ao lado da barra e o gráfico de colunas tem a tabela.
 *
 * Situações: a cor diz o que a situação significa, sempre junto do nome escrito, nunca sozinha.
 */

export const moduleColors: Record<string, string> = {
  maintenance: '#2a78d6',
  fleet: '#eb6834',
  flights: '#1baf7a',
  warehouse: '#eda100',
}

export const statusColors = {
  concluded: '#0ca30c',
  progress: '#2a78d6',
  waiting: '#fab219',
  closed: '#9aa3ae',
} as const

const statusGroups: Record<string, keyof typeof statusColors> = {
  // Concluída, emitida, entregue: verde.
  concluido: 'concluded',
  emitida: 'concluded',
  atendido: 'concluded',
  entregue: 'concluded',
  // Já em atendimento: azul.
  agendado: 'progress',
  reagendado: 'progress',
  em_andamento: 'progress',
  em_cotacao: 'progress',
  em_emissao: 'progress',
  atendido_parcial: 'progress',
  // Esperando alguém agir: amarelo.
  aguardando_agendamento: 'waiting',
  aguardando_aprovacao: 'waiting',
  pendente: 'waiting',
  em_analise: 'waiting',
  // Encerrada sem atendimento: cinza.
  cancelado: 'closed',
  cancelada: 'closed',
  rejeitado: 'closed',
}

export function statusColor(status: string) {
  return statusColors[statusGroups[status] ?? 'closed']
}

/** Legenda das cores de situação, mostrada junto dos gráficos que as usam. */
export const statusLegend = [
  { label: 'Concluída', color: statusColors.concluded },
  { label: 'Em atendimento', color: statusColors.progress },
  { label: 'Aguardando', color: statusColors.waiting },
  { label: 'Cancelada ou recusada', color: statusColors.closed },
]
