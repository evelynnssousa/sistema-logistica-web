import { correctableFields } from '../requests/justificationRules.js'
import type { RequestModule } from '../auth/requestPolicy.js'
import { moduleNames } from '../integrations/catalog.js'
import type { ReportDocument, ReportSection } from './reportDocument.js'

/**
 * Monta o relatório a partir do que a pessoa já pode ver: o histórico chega filtrado pela rota, e os
 * passageiros não entram. Nome e CPF de passageiros têm rota própria, autorizada e auditada.
 */

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })

export function formatReportDate(value: Date | string | null | undefined) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : dateTime.format(date)
}

const durationOf = (seconds: number) => {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours} h ${minutes} min`
}

const communicationStatus: Record<string, string> = {
  pending: 'aguardando envio',
  sending: 'em envio',
  sent: 'enviado',
  failed: 'falhou',
  not_configured: 'não enviado: serviço não configurado',
  synced: 'sincronizado',
  syncing: 'em sincronização',
}

type Entry = { action: string; from: string | null; to: string | null; comment: string | null; user: string | null; at: Date | string; details?: Record<string, unknown> }

export function historyLine(entry: Entry, labels: Record<string, string>, statuses: Record<string, string>) {
  const status = entry.from !== entry.to && entry.to
    ? ` (${entry.from ? `${statuses[entry.from] ?? entry.from} -> ` : ''}${statuses[entry.to] ?? entry.to})`
    : ''
  const comment = entry.comment ? ` - ${entry.comment}` : ''
  return `${formatReportDate(entry.at)} - ${labels[entry.action] ?? entry.action}${status}${comment} - ${entry.user ?? 'Sistema'}`
}

export const reportHistoryLabels: Record<string, string> = {
  criada: 'Solicitação criada',
  editada: 'Dados alterados',
  agendada: 'Agendamento realizado',
  reagendada: 'Reagendamento',
  agendamento_alterado: 'Agendamento alterado',
  iniciada: 'Atendimento iniciado',
  concluida: 'Atendimento concluído',
  cancelada: 'Solicitação cancelada',
  status_alterado: 'Status alterado',
  ocorrencia_registrada: 'Ocorrência registrada',
  atraso_registrado: 'Atraso registrado',
  responsavel_alterado: 'Responsável alterado',
  prioridade_alterada: 'Prioridade alterada',
  prazo_alterado: 'Prazo alterado',
  complexidade_alterada: 'Complexidade alterada',
  nota_interna: 'Observação interna registrada',
  anexo_incluido: 'Anexo incluído',
  anexo_removido: 'Anexo removido',
  passageiros_alterados: 'Passageiros alterados',
  devolvida_para_correcao: 'Devolvida para correção',
  informacoes_solicitadas: 'Informações complementares solicitadas',
  corrigida_pelo_solicitante: 'Dados corrigidos pelo solicitante',
  devolucao_respondida: 'Devolução respondida',
  devolucao_encerrada: 'Devolução encerrada pela equipe',
  execucao_registrada: 'Execução registrada',
  cotacao_registrada: 'Cotação registrada',
  cotacao_selecionada: 'Cotação escolhida',
}

export function buildRequestReport(input: {
  module: RequestModule
  generatedBy: string
  statusLabel: string
  statuses: Record<string, string>
  request: {
    protocol: string
    title: string
    description: string | null
    requester: { name: string }
    sector: string | null
    floor: string | null
    serviceType: string | null
    responsible: string | null
    priority: string
    deadline: string | Date | null
    scheduledAt: string | Date | null
    scheduledEnd: string | Date | null
    startedAt: string | Date | null
    finishedAt: string | Date | null
    concludedAt: string | Date | null
    cancelReason: string | null
    createdAt: string | Date
    timing: { requesterWaitSeconds: number; internalSeconds: number; totalSeconds: number }
  }
  history: readonly Entry[]
  passengerCount: number
  returns: readonly { type: string; reason: string; fields: readonly string[]; status: string; response: string | null; returnedAt: Date | string; finishedAt: Date | string | null }[]
  communications: readonly { channel: string; status: string; simulated: boolean; template: string | null; at: Date | string }[]
  attachments: readonly { name: string; category: string; uploadedAt: Date | string }[]
  notes: readonly { text: string; author: string; at: Date | string }[]
}): ReportDocument {
  const { request, module } = input
  const scheduleActions = ['agendada', 'reagendada', 'agendamento_alterado']
  const fieldNames = correctableFields[module]

  const sections: ReportSection[] = [
    {
      heading: 'Dados principais',
      rows: [
        ['Protocolo', request.protocol],
        ['Módulo', moduleNames[module]],
        ['Assunto', module === 'flights' ? 'Passagens aéreas' : request.title],
        ['Solicitante', request.requester.name],
        ['Setor', request.sector ?? '-'],
        ['Andar', request.floor ?? '-'],
        ...(request.serviceType ? ([['Tipo de serviço', request.serviceType]] as const) : []),
        ['Responsável', request.responsible ?? '-'],
        ['Prioridade', request.priority],
        ['Prazo', formatReportDate(request.deadline)],
        ['Registrada em', formatReportDate(request.createdAt)],
        ['Situação final', input.statusLabel],
        ...(request.description ? ([['Descrição', request.description]] as const) : []),
        ...(module === 'flights' ? ([['Passageiros', `${input.passengerCount}. Nomes e CPF não são exportados.`]] as const) : []),
      ],
    },
    {
      heading: 'Tempos',
      rows: [
        ['Espera por resposta do solicitante', durationOf(request.timing.requesterWaitSeconds)],
        ['Tempo interno', durationOf(request.timing.internalSeconds)],
        ['Tempo total', durationOf(request.timing.totalSeconds)],
      ],
    },
    {
      heading: 'Agendamento e execução',
      rows: [
        ['Agendado para', formatReportDate(request.scheduledAt)],
        ['Término previsto', formatReportDate(request.scheduledEnd)],
        ['Início real', formatReportDate(request.startedAt)],
        ['Término real', formatReportDate(request.finishedAt)],
        ['Concluída em', formatReportDate(request.concludedAt)],
      ],
      entries: input.history
        .filter((entry) => scheduleActions.includes(entry.action))
        .map((entry) => historyLine(entry, reportHistoryLabels, input.statuses)),
    },
    ...(request.cancelReason
      ? [{ heading: 'Cancelamento', rows: [['Motivo', request.cancelReason]] as [string, string][] }]
      : []),
    {
      heading: 'Devoluções',
      entries: input.returns.length
        ? input.returns.map((item) => {
            const fields = item.fields.map((field) => fieldNames[field] ?? field).join(', ')
            return `${formatReportDate(item.returnedAt)} - ${item.type === 'correcao' ? 'Correção' : 'Informações complementares'}: ${item.reason}${fields ? ` (${fields})` : ''} - ${item.status}${item.response ? ` - Resposta: ${item.response}` : ''}`
          })
        : ['Nenhuma devolução.'],
    },
    {
      heading: 'Histórico de alterações',
      entries: input.history.map((entry) => historyLine(entry, reportHistoryLabels, input.statuses)),
    },
    {
      heading: 'Comunicações realizadas',
      entries: input.communications.length
        ? input.communications.map(
            (item) =>
              `${formatReportDate(item.at)} - ${item.channel === 'email' ? 'E-mail' : 'Calendário'}: ${communicationStatus[item.status] ?? item.status}${item.simulated ? ' (simulado)' : ''}`,
          )
        : ['Nenhuma comunicação visível para o seu perfil.'],
    },
    {
      heading: 'Documentos relacionados',
      entries: input.attachments.length
        ? input.attachments.map((item) => `${item.name} (${item.category}) - ${formatReportDate(item.uploadedAt)}`)
        : ['Nenhum documento disponível para o seu perfil.'],
    },
    ...(input.notes.length
      ? [{ heading: 'Observações internas', entries: input.notes.map((item) => `${formatReportDate(item.at)} - ${item.text} - ${item.author}`) }]
      : []),
  ]

  return {
    title: 'Relatório da solicitação',
    subtitle: `Protocolo ${request.protocol}`,
    generatedAt: new Date(),
    generatedBy: input.generatedBy,
    sections,
  }
}
