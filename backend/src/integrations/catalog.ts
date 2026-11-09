import type { Permission } from '../auth/permissions.js'
import type { RequestModule } from '../auth/requestPolicy.js'
import type { RequestStatus, WarehouseStatus } from '../requests/workflow.js'
import { redactForOutbound } from './redaction.js'
import {
  fillLines,
  fillTemplate,
  sampleValues,
  variablesForEvent,
} from './templateVariables.js'
import type { TemplateValues, VariableScope } from './templateVariables.js'

/**
 * Catálogo dos acontecimentos que geram comunicação: modelo de e-mail, texto da notificação
 * interna e público. É a única fonte dessas regras. Nenhum modelo recebe CPF, nome de
 * passageiro, descrição do pedido ou dado de contato: nem há campo para isso no contexto.
 */

export type IntegrationModule = RequestModule | 'warehouse' | 'system' | 'demands'

export const moduleNames: Record<IntegrationModule, string> = {
  maintenance: 'Manutenção',
  fleet: 'Frota',
  flights: 'Passagens aéreas',
  warehouse: 'Almoxarifado',
  system: 'Sistema',
  demands: 'Controle de Demandas',
}

const modulePaths: Record<Exclude<IntegrationModule, 'system'>, { list: string; item: string }> = {
  maintenance: { list: '/manutencao', item: '/manutencao' },
  fleet: { list: '/frota', item: '/frota' },
  flights: { list: '/passagens-aereas', item: '/passagens-aereas' },
  warehouse: { list: '/almoxarifado/solicitacoes', item: '/almoxarifado/pedidos' },
  demands: { list: '/demandas', item: '/demandas' },
}

export function resourcePath(module: IntegrationModule, resourceId: string | null) {
  if (module === 'system') return '/integracoes'
  const paths = modulePaths[module]
  return resourceId ? `${paths.item}/${resourceId}` : paths.list
}

/** Únicos dados aceitos nos textos. Datas em ISO; comentários e motivos passam por redação. */
export type EventContext = {
  module: IntegrationModule
  protocol: string
  title?: string
  scheduledAt?: string
  scheduledEnd?: string | null
  previousScheduledAt?: string
  reason?: string | null
  delayMinutes?: number | null
  total?: number
  days?: number
  channel?: 'email' | 'calendar'
  /** Só o dia (AAAA-MM-DD): a previsão de entrega não tem horário. */
  forecastDate?: string
  previousForecastDate?: string | null
  /** Agendamento em condições diferentes das pedidas: o e-mail mostra o pedido e o motivo. */
  divergent?: boolean
  requestedAt?: string | null
  requestedEnd?: string | null
  previousScheduledEnd?: string | null
  conditions?: string | null
  changes?: readonly { campo: string; de: string | null; para: string | null }[]
  /** Campos a corrigir, já com o nome exibido à pessoa. */
  returnFields?: readonly string[]
  // Lidos do banco no momento do envio, e nunca gravados na fila.
  requesterName?: string | null
  // Só no encaminhamento de passagens, escrito e conferido pelo operador antes do envio.
  passengerName?: string | null
  airline?: string | null
  flights?: string | null
  outbound?: string | null
  inbound?: string | null
  locator?: string | null
  sector?: string | null
  description?: string | null
  responsible?: string | null
  requestedQuantities?: string | null
  providedQuantities?: string | null
  deliveredAt?: string | null
  /** Nome do acontecimento, nos avisos do Portal do Motorista à equipe. */
  portalEventLabel?: string | null
  // Avisos da conta e de segurança. Nunca levam senha, código, link de recuperação ou endereço IP.
  /** Nome da pessoa dona da conta, lido na mesma transação do acontecimento. */
  accountName?: string | null
  /** Nome do perfil de acesso, como a tela o exibe. */
  profileLabel?: string | null
  /** Momento do acontecimento, em ISO. */
  occurredAt?: string | null
  /** Demanda restrita: o e-mail não leva título, conteúdo nem anexos. */
  restricted?: boolean
  /** Quantos acontecimentos equivalentes um aviso administrativo agrupado representa. */
  groupedCount?: number
  /**
   * Bloqueio de acesso: "account" quando o limite da própria conta foi atingido (qualquer origem);
   * "address" quando foi o limite da conta a partir de um mesmo endereço de rede.
   */
  blockScope?: 'account' | 'address' | null
}

type Definition = {
  label: string
  category: string
  modules: readonly IntegrationModule[]
  /** Envia e-mail e notificação à pessoa solicitante. */
  toRequester: boolean
  /** Avisa também quem atende: e-mail configurado para o módulo e notificação interna. */
  toTeam: boolean
  /** Avisa também a pessoa responsável pelo atendimento na plataforma. */
  toResponsible?: boolean
  /**
   * O responsável recebe também o e-mail. Só sai para conta aprovada que ainda atende o módulo
   * (leitura e atualização), conferida na mesma transação.
   */
  emailResponsible?: boolean
  /** E-mail à pessoa dona da conta, no endereço lido pela própria transação (accountEmail). */
  toAccount?: boolean
  /** E-mail e notificação a quem tem esta permissão, com conta aprovada. */
  toHolders?: Permission
  /** Nome da seção no assunto e no corpo, no lugar do módulo (ex.: "Conta de acesso"). */
  sectionLabel?: string
  /** Destino fixo do link, no lugar do registro (ex.: /minha-conta). null: a mensagem não leva link. */
  path?: string | null
  /** Assunto institucional fixo: "Texto — Protocolo", sem o módulo e a sigla ao final. */
  plainSubject?: boolean
  headline: (context: EventContext) => string
  lines: (context: EventContext) => string[]
  /** Texto curto da notificação. Sem motivo ou comentário: o detalhe fica na solicitação. */
  notice: (context: EventContext) => string
  /** Vai para o motorista da viagem, que vê a notificação pelo portal. */
  toDriver?: boolean
  /** Parte do operador, pela central de comunicação. Nenhum acontecimento o dispara sozinho. */
  manual?: boolean
  /** Sem estes dados, a mensagem não sai: seria genérica ou enganosa. */
  requires?: readonly (keyof EventContext)[]
}

const dateFormat = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
})

export function formatMoment(iso: string | null | undefined) {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date)
}

/** AAAA-MM-DD para DD/MM/AAAA, sem passar por Date: o dia não muda com o fuso. */
export function formatCalendarDate(value: string | null | undefined) {
  return value ? value.split('-').reverse().join('/') : ''
}

const slmSignature = [
  'Atenciosamente,',
  'Equipe de Serviços de Logística e Manutenção — SLM',
  'JUCESP',
]

export const factKeys = ['title', 'requested', 'scheduled', 'previous', 'changes', 'conditions', 'reason', 'fields'] as const
export type FactKey = (typeof factKeys)[number]

export const factLabels: Record<FactKey, string> = {
  title: 'Assunto da solicitação',
  requested: 'O que foi solicitado',
  scheduled: 'Data e horário agendados',
  previous: 'Agendamento anterior',
  changes: 'O que foi alterado',
  conditions: 'Condições do atendimento',
  reason: 'Motivo registrado',
  fields: 'Campos a corrigir',
}

/** Dados do atendimento, separados do texto: um modelo pode reordená-los, sem perder o motivo. */
function factLines(context: EventContext): Record<FactKey, string[]> {
  const period = (start: string | null | undefined, end: string | null | undefined) =>
    `${formatMoment(start)}${end ? ` a ${formatMoment(end)}` : ''}`
  return {
    title: context.title ? [`Assunto da solicitação: ${context.title}`] : [],
    requested: context.divergent && context.requestedAt ? [`Solicitado: ${period(context.requestedAt, context.requestedEnd)}`] : [],
    scheduled: context.scheduledAt
      ? [
          `Data e horário: ${formatMoment(context.scheduledAt)}`,
          ...(context.scheduledEnd ? [`Término previsto: ${formatMoment(context.scheduledEnd)}`] : []),
        ]
      : [],
    previous: context.previousScheduledAt ? [`Data anterior: ${period(context.previousScheduledAt, context.previousScheduledEnd)}`] : [],
    changes: (context.changes ?? []).map(
      (change) => `${change.campo}: de ${printableChange(change.de)} para ${printableChange(change.para)}`,
    ),
    conditions: context.conditions ? [`Condições do atendimento: ${context.conditions}`] : [],
    reason: context.reason ? [`${context.divergent ? 'Motivo da adequação' : 'Motivo informado'}: ${context.reason}`] : [],
    fields: context.returnFields?.length ? [`Campos a corrigir: ${context.returnFields.join(', ')}`] : [],
  }
}

function printableChange(value: string | null) {
  if (value === null) return '(vazio)'
  return /^\d{4}-\d{2}-\d{2}T/.test(value) ? formatMoment(value) : value
}

const requestModules = ['maintenance', 'fleet', 'flights'] as const
const scheduledModules = ['maintenance', 'fleet'] as const

/** Aviso do Controle de Demandas: o texto é fixo, e o título só entra fora das restritas. */
function demandEvent(label: string, category: string, message: string): Definition {
  return {
    label,
    category,
    modules: ['demands'],
    toRequester: false,
    toTeam: false,
    headline: () => label,
    lines: (context) => [
      message,
      ...(context.restricted ? ['Demanda restrita: os detalhes ficam disponíveis apenas no sistema.'] : []),
    ],
    notice: () => message,
  }
}

export const eventCatalog = {
  request_received: {
    label: 'Confirmação de recebimento',
    category: 'nova_solicitacao',
    modules: requestModules,
    toRequester: true,
    toTeam: true,
    headline: () => 'Solicitação recebida',
    lines: () => [
      'Sua solicitação foi registrada e será analisada pela equipe responsável.',
      'Você pode acompanhar a situação pelo sistema, usando o protocolo acima.',
    ],
    notice: () => 'Nova solicitação registrada.',
  },
  request_scheduled: {
    label: 'Comunicação de agendamento',
    category: 'agendamento',
    modules: scheduledModules,
    toRequester: true,
    toTeam: false,
    toResponsible: true,
    headline: () => 'Atendimento agendado',
    requires: ['scheduledAt'],
    lines: (context) => [
      context.divergent
        ? 'O atendimento da sua solicitação foi agendado em condições diferentes das solicitadas.'
        : 'O atendimento da sua solicitação foi agendado.',
    ],
    notice: (context) => `Agendamento para ${formatMoment(context.scheduledAt)}.`,
  },
  request_rescheduled: {
    label: 'Comunicação de reagendamento',
    category: 'reagendamento',
    modules: scheduledModules,
    toRequester: true,
    toTeam: false,
    toResponsible: true,
    headline: () => 'Atendimento reagendado',
    requires: ['scheduledAt', 'reason'],
    lines: () => ['A data do atendimento da sua solicitação foi alterada.'],
    notice: (context) => `Reagendamento para ${formatMoment(context.scheduledAt)}.`,
  },
  request_schedule_changed: {
    label: 'Comunicação de alteração de agendamento',
    category: 'reagendamento',
    modules: scheduledModules,
    toRequester: true,
    toTeam: false,
    toResponsible: true,
    headline: () => 'Agendamento alterado',
    requires: ['reason'],
    lines: () => ['As condições do atendimento da sua solicitação foram alteradas.'],
    notice: () => 'Condições do agendamento alteradas.',
  },
  request_info_requested: {
    label: 'Solicitação de informações complementares',
    category: 'devolucao',
    modules: requestModules,
    toRequester: true,
    toTeam: false,
    headline: () => 'Informações complementares necessárias',
    requires: ['reason'],
    lines: () => ['Precisamos de informações complementares para continuar o atendimento. Responda pelo sistema, usando o protocolo acima.'],
    notice: () => 'Informações complementares solicitadas.',
  },
  request_returned: {
    label: 'Devolução para correção',
    category: 'devolucao',
    modules: requestModules,
    toRequester: true,
    toTeam: false,
    headline: () => 'Solicitação devolvida para correção',
    requires: ['reason'],
    lines: () => ['Sua solicitação precisa de correção para continuar. O protocolo é o mesmo, e os dados já informados foram mantidos.'],
    notice: () => 'Solicitação devolvida para correção.',
  },
  request_corrected: {
    label: 'Resposta à devolução',
    category: 'devolucao',
    modules: requestModules,
    toRequester: false,
    toTeam: true,
    toResponsible: true,
    headline: () => 'Solicitação corrigida pelo solicitante',
    lines: () => ['O solicitante respondeu à devolução, e a solicitação voltou para a equipe.'],
    notice: () => 'Devolução respondida pelo solicitante.',
  },
  request_return_closed: {
    label: 'Encerramento da devolução',
    category: 'devolucao',
    modules: requestModules,
    toRequester: true,
    toTeam: false,
    headline: () => 'Devolução encerrada',
    requires: ['reason'],
    lines: () => ['A equipe encerrou a devolução. Não é mais necessário corrigir a solicitação.'],
    notice: () => 'Devolução encerrada pela equipe.',
  },
  request_started: {
    label: 'Início do atendimento',
    category: 'status',
    modules: scheduledModules,
    toRequester: true,
    toTeam: false,
    headline: () => 'Atendimento iniciado',
    lines: () => ['O atendimento da sua solicitação foi iniciado.'],
    notice: () => 'Atendimento iniciado.',
  },
  request_completed: {
    label: 'Comunicação de conclusão',
    category: 'status',
    modules: scheduledModules,
    toRequester: true,
    toTeam: false,
    headline: () => 'Atendimento concluído',
    lines: () => ['O atendimento da sua solicitação foi concluído.'],
    notice: () => 'Atendimento concluído.',
  },
  request_cancelled: {
    label: 'Comunicação de cancelamento',
    category: 'cancelamento',
    modules: requestModules,
    toRequester: true,
    toTeam: true,
    toResponsible: true,
    headline: () => 'Solicitação cancelada',
    requires: ['reason'],
    lines: () => ['Sua solicitação foi cancelada.'],
    notice: () => 'Solicitação cancelada.',
  },
  request_assigned: {
    label: 'Atribuição de responsável',
    category: 'atribuicao',
    modules: requestModules,
    toRequester: false,
    toTeam: false,
    toResponsible: true,
    emailResponsible: true,
    headline: () => 'Solicitação atribuída',
    lines: () => ['Uma solicitação foi atribuída a você.'],
    notice: () => 'Solicitação atribuída a você.',
  },
  request_unassigned: {
    label: 'Retirada de responsável',
    category: 'atribuicao',
    modules: requestModules,
    toRequester: false,
    toTeam: false,
    toResponsible: true,
    emailResponsible: true,
    headline: () => 'Solicitação retirada da sua responsabilidade',
    lines: () => ['Uma solicitação deixou de estar sob a sua responsabilidade.'],
    notice: () => 'Solicitação retirada da sua responsabilidade.',
  },
  request_overdue: {
    label: 'Prazo vencido',
    category: 'pendencia',
    modules: requestModules,
    toRequester: false,
    toTeam: false,
    toResponsible: true,
    emailResponsible: true,
    headline: () => 'Prazo vencido',
    lines: () => ['O prazo de uma solicitação sob sua responsabilidade venceu.'],
    notice: () => 'Prazo vencido. Confira a solicitação.',
  },
  request_occurrence: {
    label: 'Ocorrência ou atraso na execução',
    category: 'execucao',
    modules: ['fleet'],
    toRequester: true,
    toTeam: true,
    headline: (context) => (context.delayMinutes ? 'Atraso registrado' : 'Ocorrência registrada'),
    lines: (context) => [
      context.delayMinutes
        ? `Foi registrado um atraso de ${context.delayMinutes} minutos na execução da sua solicitação.`
        : 'Foi registrada uma ocorrência na execução da sua solicitação.',
      'Os detalhes podem ser consultados no sistema.',
    ],
    notice: (context) =>
      context.delayMinutes
        ? `Atraso de ${context.delayMinutes} minutos registrado.`
        : 'Ocorrência registrada.',
  },
  trip_assigned: {
    label: 'Viagem atribuída ao motorista',
    category: 'atribuicao',
    modules: ['fleet'],
    toRequester: false,
    toTeam: false,
    toDriver: true,
    headline: () => 'Nova viagem atribuída',
    requires: ['scheduledAt'],
    lines: () => ['Uma viagem foi atribuída a você. Confira os detalhes no Portal do Motorista.'],
    notice: (context) => `Nova viagem atribuída para ${formatMoment(context.scheduledAt)}.`,
  },
  trip_rescheduled: {
    label: 'Viagem do motorista reagendada',
    category: 'reagendamento',
    modules: ['fleet'],
    toRequester: false,
    toTeam: false,
    toDriver: true,
    headline: () => 'Viagem reagendada',
    requires: ['scheduledAt'],
    lines: () => ['Uma viagem atribuída a você foi reagendada. Confira o novo horário no Portal do Motorista.'],
    notice: (context) => `Viagem reagendada para ${formatMoment(context.scheduledAt)}.`,
  },
  trip_updated: {
    label: 'Viagem do motorista alterada',
    category: 'status',
    modules: ['fleet'],
    toRequester: false,
    toTeam: false,
    toDriver: true,
    headline: () => 'Viagem alterada',
    lines: () => ['As informações de uma viagem atribuída a você foram atualizadas. Confira no Portal do Motorista.'],
    notice: () => 'As informações de uma viagem foram atualizadas.',
  },
  trip_cancelled: {
    label: 'Viagem do motorista cancelada',
    category: 'cancelamento',
    modules: ['fleet'],
    toRequester: false,
    toTeam: false,
    toDriver: true,
    headline: () => 'Viagem cancelada',
    lines: () => ['Uma viagem atribuída a você foi cancelada.'],
    notice: () => 'Uma viagem atribuída a você foi cancelada.',
  },
  trip_unassigned: {
    label: 'Viagem retirada do motorista',
    category: 'cancelamento',
    modules: ['fleet'],
    toRequester: false,
    toTeam: false,
    toDriver: true,
    headline: () => 'Viagem retirada',
    lines: () => ['Uma viagem deixou de estar atribuída a você.'],
    notice: () => 'Uma viagem deixou de estar atribuída a você.',
  },
  // Vai à equipe conforme as regras de notificação do Portal do Motorista, em Configurações.
  trip_portal_notice: {
    label: 'Aviso à equipe sobre viagem do motorista',
    category: 'status',
    modules: ['fleet'],
    toRequester: false,
    toTeam: true,
    headline: (context) => context.portalEventLabel ?? 'Movimentação de viagem',
    lines: (context) => [`${context.portalEventLabel ?? 'Movimentação'} em uma viagem com motorista. Confira na solicitação.`],
    notice: (context) => `${context.portalEventLabel ?? 'Movimentação'} em uma viagem com motorista.`,
  },
  flight_approval_needed: {
    label: 'Necessidade de aprovação',
    category: 'aprovacao',
    modules: ['flights'],
    toRequester: true,
    toTeam: true,
    headline: () => 'Aguardando aprovação',
    lines: () => ['A cotação foi concluída, e a solicitação aguarda aprovação.'],
    notice: () => 'Solicitação aguardando aprovação.',
  },
  flight_approved: {
    label: 'Aprovação e início da emissão',
    category: 'aprovacao',
    modules: ['flights'],
    toRequester: true,
    toTeam: false,
    headline: () => 'Solicitação em emissão',
    lines: () => ['A solicitação avançou da aprovação para a emissão.'],
    notice: () => 'Solicitação em emissão.',
  },
  flight_issued: {
    label: 'Emissão e conclusão',
    category: 'status',
    modules: ['flights'],
    toRequester: true,
    toTeam: false,
    headline: () => 'Passagens emitidas',
    lines: () => [
      'A emissão foi concluída, e a solicitação foi encerrada.',
      'As informações dos bilhetes não são enviadas por e-mail. Consulte a equipe responsável.',
    ],
    notice: () => 'Passagens emitidas.',
  },
  // Modelos da central de comunicação. Partem do operador: nenhum evento automático os dispara.
  manual_message: {
    label: 'Mensagem do operador',
    category: 'status',
    modules: ['maintenance', 'fleet', 'flights', 'warehouse'],
    toRequester: false,
    toTeam: false,
    manual: true,
    headline: () => 'Informação sobre a sua solicitação',
    lines: () => ['Informamos o andamento da solicitação de protocolo {{protocolo}}.'],
    notice: () => 'Mensagem enviada pela equipe.',
  },
  flight_ticket_delivery: {
    label: 'Encaminhamento de passagem',
    category: 'status',
    modules: ['flights'],
    toRequester: false,
    toTeam: false,
    manual: true,
    headline: () => 'Sua passagem aérea',
    lines: () => [
      'Prezado(a) {{nome_passageiro}},',
      'Encaminhamos em anexo o bilhete referente à solicitação {{protocolo}}.',
      'Companhia aérea: {{companhia}}',
      'Voos: {{voos}}',
      'Ida: {{trecho_ida}}',
      'Volta: {{trecho_volta}}',
      'Localizador da reserva: {{localizador}}',
    ],
    notice: () => 'Passagem encaminhada.',
  },
  warehouse_received: {
    label: 'Pedido recebido',
    category: 'nova_solicitacao',
    modules: ['warehouse'],
    toRequester: true,
    toTeam: true,
    headline: () => 'Pedido de materiais recebido',
    lines: () => [
      'Seu pedido de materiais foi registrado e será analisado pelo Almoxarifado.',
    ],
    notice: () => 'Novo pedido de materiais.',
  },
  warehouse_external_registered: {
    label: 'Pedido de origem externa registrado',
    category: 'nova_solicitacao',
    modules: ['warehouse'],
    toRequester: false,
    toTeam: true,
    headline: () => 'Pedido de origem externa registrado',
    lines: () => ['Um pedido do sistema governamental foi digitado na central do Almoxarifado.'],
    notice: () => 'Pedido de origem externa registrado.',
  },
  warehouse_in_review: {
    label: 'Atualização de status',
    category: 'status',
    modules: ['warehouse'],
    toRequester: true,
    toTeam: false,
    headline: () => 'Pedido em análise',
    lines: () => ['Seu pedido de materiais está em análise pelo Almoxarifado.'],
    notice: () => 'Pedido em análise.',
  },
  warehouse_partial: {
    label: 'Atendimento parcial',
    category: 'status',
    modules: ['warehouse'],
    toRequester: true,
    toTeam: false,
    headline: () => 'Pedido atendido parcialmente',
    lines: () => [
      'Parte dos itens do seu pedido foi atendida. As quantidades podem ser consultadas no sistema.',
    ],
    notice: () => 'Pedido atendido parcialmente.',
  },
  warehouse_ready: {
    label: 'Disponibilidade para retirada ou entrega',
    category: 'status',
    modules: ['warehouse'],
    toRequester: true,
    toTeam: false,
    headline: () => 'Pedido atendido',
    lines: () => [
      'Os itens do seu pedido foram atendidos e aguardam o registro da entrega pelo Almoxarifado.',
    ],
    notice: () => 'Pedido atendido, aguardando entrega.',
  },
  warehouse_delivered: {
    label: 'Conclusão',
    category: 'status',
    modules: ['warehouse'],
    toRequester: true,
    toTeam: false,
    headline: () => 'Entrega registrada',
    lines: () => ['A entrega do seu pedido de materiais foi registrada, e o pedido foi concluído.'],
    notice: () => 'Entrega registrada.',
  },
  // Só o dia previsto: a justificativa de uma alteração é interna e nem chega ao contexto.
  warehouse_forecast_set: {
    label: 'Previsão de entrega',
    category: 'previsao_entrega',
    modules: ['warehouse'],
    toRequester: true,
    toTeam: false,
    plainSubject: true,
    headline: () => 'Previsão de entrega de materiais',
    requires: ['forecastDate'],
    lines: (context) => [
      'Prezado(a),',
      `Informamos que os materiais relacionados à sua solicitação possuem previsão de entrega para ${formatCalendarDate(context.forecastDate)}.`,
      'Em caso de alteração da previsão, você será informado(a).',
      ...slmSignature,
    ],
    notice: (context) => `Previsão de entrega para ${formatCalendarDate(context.forecastDate)}.`,
  },
  warehouse_forecast_changed: {
    label: 'Alteração da previsão de entrega',
    category: 'previsao_entrega',
    modules: ['warehouse'],
    toRequester: true,
    toTeam: false,
    plainSubject: true,
    headline: () => 'Alteração da previsão de entrega de materiais',
    requires: ['forecastDate'],
    lines: (context) => [
      'Prezado(a),',
      `Informamos que a previsão de entrega dos materiais relacionados à sua solicitação foi alterada para ${formatCalendarDate(context.forecastDate)}.`,
      ...(context.previousForecastDate
        ? [`Previsão anterior: ${formatCalendarDate(context.previousForecastDate)}.`]
        : []),
      'Em caso de nova alteração da previsão, você será informado(a).',
      ...slmSignature,
    ],
    notice: (context) =>
      `Previsão de entrega alterada para ${formatCalendarDate(context.forecastDate)}.`,
  },
  warehouse_rejected: {
    label: 'Pedido recusado',
    category: 'cancelamento',
    modules: ['warehouse'],
    toRequester: true,
    toTeam: false,
    headline: () => 'Pedido recusado',
    requires: ['reason'],
    lines: () => ['Seu pedido de materiais foi recusado.'],
    notice: () => 'Pedido recusado.',
  },
  warehouse_cancelled: {
    label: 'Pedido cancelado',
    category: 'cancelamento',
    modules: ['warehouse'],
    toRequester: true,
    toTeam: false,
    headline: () => 'Pedido cancelado',
    requires: ['reason'],
    lines: () => ['Seu pedido de materiais foi cancelado.'],
    notice: () => 'Pedido cancelado.',
  },
  pending_reminder: {
    label: 'Pendências',
    category: 'pendencia',
    modules: ['maintenance', 'fleet', 'flights', 'warehouse'],
    toRequester: false,
    toTeam: true,
    headline: () => 'Solicitações pendentes',
    lines: (context) => [
      `Há ${context.total} solicitações em aberto, sem andamento há mais de ${context.days} dias.`,
    ],
    notice: (context) =>
      `${context.total} solicitações sem andamento há mais de ${context.days} dias.`,
  },
  integration_failure: {
    label: 'Falha operacional',
    category: 'falha_operacional',
    modules: ['system'],
    toRequester: false,
    toTeam: true,
    headline: () => 'Falha em uma integração',
    lines: (context) => [
      context.channel === 'calendar'
        ? `A sincronização do agendamento ${context.protocol} com o calendário esgotou as tentativas.`
        : `O envio de um e-mail da solicitação ${context.protocol} esgotou as tentativas.`,
    ],
    notice: (context) =>
      context.channel === 'calendar'
        ? `Sincronização da solicitação ${context.protocol} falhou.`
        : `Envio de e-mail da solicitação ${context.protocol} falhou.`,
  },
  // -------------------------------------------------------------------------
  // Conta de acesso. Vão à pessoa dona da conta (toAccount), sem motivo interno da decisão.
  // -------------------------------------------------------------------------
  account_registration_received: {
    label: 'Cadastro recebido',
    category: 'conta',
    modules: ['system'],
    toRequester: false,
    toTeam: false,
    toAccount: true,
    sectionLabel: 'Conta de acesso',
    path: null,
    headline: () => 'Cadastro recebido',
    lines: () => [
      'Recebemos o seu pedido de cadastro no sistema.',
      'Ele será analisado por um administrador, e você receberá a decisão por e-mail.',
      'Se você não fez este pedido, ignore esta mensagem.',
    ],
    notice: () => 'Cadastro recebido.',
  },
  account_registration_pending: {
    label: 'Novo cadastro aguardando análise',
    category: 'aprovacao',
    modules: ['system'],
    toRequester: false,
    toTeam: false,
    toHolders: 'users:approve',
    sectionLabel: 'Administração',
    path: '/cadastros-pendentes',
    headline: () => 'Novo cadastro aguardando análise',
    // Nem nome nem e-mail de quem pediu: os dados ficam na tela de cadastros pendentes.
    lines: (context) => [
      (context.groupedCount ?? 1) > 1
        ? `Foram recebidos ${context.groupedCount} novos pedidos de cadastro, que aguardam análise na página de cadastros pendentes.`
        : 'Há um novo pedido de cadastro aguardando análise na página de cadastros pendentes.',
    ],
    notice: () => 'Novo cadastro aguardando análise.',
  },
  account_approved: {
    label: 'Cadastro aprovado',
    category: 'conta',
    modules: ['system'],
    toRequester: false,
    toTeam: false,
    toAccount: true,
    sectionLabel: 'Conta de acesso',
    path: '/',
    headline: () => 'Cadastro aprovado',
    lines: (context) => [
      'O seu cadastro foi aprovado. Você já pode acessar o sistema com o e-mail e a senha cadastrados.',
      ...(context.profileLabel ? [`Perfil de acesso: ${context.profileLabel}`] : []),
    ],
    notice: () => 'Cadastro aprovado.',
  },
  account_rejected: {
    label: 'Cadastro não aprovado',
    category: 'conta',
    modules: ['system'],
    toRequester: false,
    toTeam: false,
    toAccount: true,
    sectionLabel: 'Conta de acesso',
    path: null,
    headline: () => 'Cadastro não aprovado',
    lines: () => [
      'O seu pedido de cadastro no sistema não foi aprovado.',
      'Em caso de dúvida, procure a equipe de Serviços de Logística e Manutenção.',
    ],
    notice: () => 'Cadastro não aprovado.',
  },
  account_activated: {
    label: 'Conta ativada',
    category: 'conta',
    modules: ['system'],
    toRequester: false,
    toTeam: false,
    toAccount: true,
    sectionLabel: 'Conta de acesso',
    path: '/',
    headline: () => 'Conta ativada',
    lines: () => ['A sua conta foi ativada por um administrador. Você já pode acessar o sistema.'],
    notice: () => 'Conta ativada.',
  },
  account_deactivated: {
    label: 'Conta desativada',
    category: 'conta',
    modules: ['system'],
    toRequester: false,
    toTeam: false,
    toAccount: true,
    sectionLabel: 'Conta de acesso',
    path: null,
    headline: () => 'Conta desativada',
    lines: () => [
      'A sua conta foi desativada por um administrador, e as sessões abertas foram encerradas.',
      'Em caso de dúvida, procure a equipe de Serviços de Logística e Manutenção.',
    ],
    notice: () => 'Conta desativada.',
  },
  account_access_changed: {
    label: 'Perfil ou permissões alterados',
    category: 'conta',
    modules: ['system'],
    toRequester: false,
    toTeam: false,
    toAccount: true,
    sectionLabel: 'Conta de acesso',
    path: '/minha-conta',
    headline: () => 'Perfil ou permissões alterados',
    // A lista de permissões não sai por e-mail: a pessoa a consulta em Minha conta.
    lines: (context) => [
      'O perfil ou as permissões da sua conta foram alterados por um administrador.',
      ...(context.profileLabel ? [`Perfil de acesso: ${context.profileLabel}`] : []),
      'Consulte os detalhes em Minha conta.',
    ],
    notice: () => 'Perfil ou permissões alterados.',
  },
  account_password_changed: {
    label: 'Senha alterada',
    category: 'conta',
    modules: ['system'],
    toRequester: false,
    toTeam: false,
    toAccount: true,
    sectionLabel: 'Conta de acesso',
    path: null,
    headline: () => 'Senha alterada',
    lines: (context) => [
      `A senha da sua conta foi alterada${context.occurredAt ? ` em ${formatMoment(context.occurredAt)}` : ''}, e as sessões abertas foram encerradas.`,
      'Se não foi você, solicite imediatamente a recuperação de senha e procure a equipe responsável.',
    ],
    notice: () => 'Senha alterada.',
  },

  // -------------------------------------------------------------------------
  // Segurança. Ligados ou desligados em Parâmetros > Notificações. Sem IP, senha ou código.
  // -------------------------------------------------------------------------
  security_new_login: {
    label: 'Novo acesso à conta',
    category: 'seguranca',
    modules: ['system'],
    toRequester: false,
    toTeam: false,
    toAccount: true,
    sectionLabel: 'Segurança da conta',
    path: '/minha-conta',
    headline: () => 'Novo acesso à sua conta',
    lines: (context) => [
      `A sua conta foi acessada${context.occurredAt ? ` em ${formatMoment(context.occurredAt)}` : ''}.`,
      'Se não foi você, solicite a recuperação de senha e encerre as sessões em Minha conta.',
    ],
    notice: () => 'Novo acesso à conta.',
  },
  security_login_blocked: {
    label: 'Acesso bloqueado temporariamente',
    category: 'seguranca',
    modules: ['system'],
    toRequester: false,
    toTeam: false,
    toAccount: true,
    sectionLabel: 'Segurança da conta',
    path: null,
    headline: () => 'Acesso bloqueado temporariamente',
    lines: (context) => [
      context.blockScope === 'address'
        ? 'Houve várias tentativas de acesso sem sucesso à sua conta a partir de um mesmo endereço de rede, e novas tentativas desse endereço foram bloqueadas por alguns minutos.'
        : 'Houve várias tentativas de acesso sem sucesso à sua conta, e novas tentativas foram bloqueadas por alguns minutos.',
      'Se não foi você, solicite a recuperação de senha e procure a equipe responsável.',
    ],
    notice: () => 'Acesso bloqueado temporariamente.',
  },
  security_login_blocked_admin: {
    label: 'Alerta de bloqueio de acesso',
    category: 'seguranca',
    modules: ['system'],
    toRequester: false,
    toTeam: false,
    toHolders: 'users:manage',
    sectionLabel: 'Administração',
    path: '/usuarios',
    headline: () => 'Conta com acesso bloqueado',
    // A conta não é identificada no e-mail: o registro fica na auditoria, para quem pode consultá-la.
    lines: (context) => [
      (context.groupedCount ?? 1) > 1
        ? `${context.groupedCount} bloqueios temporários de acesso foram registrados após várias tentativas sem sucesso.`
        : 'Uma conta teve o acesso bloqueado temporariamente após várias tentativas sem sucesso.',
      'Consulte a auditoria de acessos no sistema.',
    ],
    notice: () => 'Conta com acesso bloqueado temporariamente.',
  },
  security_sessions_revoked: {
    label: 'Sessões encerradas pela administração',
    category: 'seguranca',
    modules: ['system'],
    toRequester: false,
    toTeam: false,
    toAccount: true,
    sectionLabel: 'Segurança da conta',
    path: '/',
    headline: () => 'Sessões encerradas',
    lines: (context) => [
      `As sessões abertas da sua conta foram encerradas por um administrador${context.occurredAt ? ` em ${formatMoment(context.occurredAt)}` : ''}.`,
      'Para continuar, entre novamente no sistema.',
    ],
    notice: () => 'Sessões encerradas pela administração.',
  },

  // -------------------------------------------------------------------------
  // Controle de Demandas. Publicados por demands/demandNotifications.ts, que escolhe os
  // destinatários: só quem tem acesso à demanda e pediu o aviso por e-mail. Em demanda restrita,
  // o contexto nem traz o título.
  // -------------------------------------------------------------------------
  demand_atribuicao: demandEvent('Demanda atribuída', 'atribuicao', 'Uma demanda foi atribuída a você.'),
  demand_responsavel: demandEvent('Responsável alterado', 'atribuicao', 'O responsável pela demanda foi alterado.'),
  demand_mencao: demandEvent('Menção em comentário', 'demandas', 'Você foi mencionado em um comentário da demanda.'),
  demand_comentario: demandEvent('Novo registro na demanda', 'demandas', 'Há um novo registro em uma demanda que você acompanha.'),
  demand_prazo_alterado: demandEvent('Prazo alterado', 'demandas', 'O prazo da demanda foi alterado.'),
  demand_prazo_proximo: demandEvent('Prazo próximo', 'demandas', 'O prazo da demanda está próximo.'),
  demand_atraso: demandEvent('Demanda atrasada', 'pendencia', 'A demanda está com o prazo vencido.'),
  demand_status: demandEvent('Mudança de situação', 'demandas', 'A situação da demanda mudou.'),
  demand_recorrencia: demandEvent('Nova ocorrência recorrente', 'demandas', 'Uma nova ocorrência recorrente da demanda foi gerada.'),
  demand_providencia: demandEvent('Providência pendente', 'pendencia', 'A demanda aguarda uma providência.'),
} satisfies Record<string, Definition>

export type EventType = keyof typeof eventCatalog

const definitionOf = (type: EventType): Definition => eventCatalog[type]

export function isEventType(value: string): value is EventType {
  return Object.prototype.hasOwnProperty.call(eventCatalog, value)
}

export function audienceOf(type: EventType) {
  const {
    toRequester,
    toTeam,
    toResponsible = false,
    toDriver = false,
    emailResponsible = false,
    toAccount = false,
    toHolders = null,
  } = definitionOf(type)
  return { toRequester, toTeam, toResponsible, toDriver, emailResponsible, toAccount, toHolders }
}

/**
 * Validade de uma mensagem na fila, em horas, contada da criação. Passado o prazo, ela não sai mais:
 * fica como falha EXPIRED, sem alerta à equipe, e não pode ser reprocessada. Vale para "pendente" e
 * para "não configurado", para que ligar o serviço nunca envie avisos que perderam o sentido.
 */
export const noticeMaxAgeHours = {
  /** Novo acesso, bloqueio, sessões encerradas, senha alterada: só fazem sentido logo depois. */
  security: 24,
  /** Cadastro, decisão, ativação e perfil. */
  account: 7 * 24,
  /** Atribuição, retirada e prazo vencido. */
  responsible: 3 * 24,
  /** Controle de Demandas. */
  demands: 3 * 24,
  /** Demais avisos das solicitações (recebimento, agendamento, devolução etc.). */
  default: 30 * 24,
} as const

const securityEvents: readonly string[] = [
  'security_new_login', 'security_login_blocked', 'security_login_blocked_admin', 'security_sessions_revoked',
  'account_password_changed',
]
const responsibleEvents: readonly string[] = ['request_assigned', 'request_unassigned', 'request_overdue']

export function maxAgeHoursOf(type: string) {
  if (securityEvents.includes(type)) return noticeMaxAgeHours.security
  if (type.startsWith('account_')) return noticeMaxAgeHours.account
  if (responsibleEvents.includes(type)) return noticeMaxAgeHours.responsible
  if (type.startsWith('demand_')) return noticeMaxAgeHours.demands
  return noticeMaxAgeHours.default
}

/** Prazo de cada evento conhecido, para a varredura da fila em uma só consulta. */
export function maxAgeTable() {
  const types = Object.keys(eventCatalog)
  return { types, hours: types.map(maxAgeHoursOf) }
}

/** Avisos administrativos que podem ser agrupados: o texto não identifica nenhuma conta. */
export const groupableEvents: readonly EventType[] = ['account_registration_pending', 'security_login_blocked_admin']

/** Nome exibido no assunto e no corpo: a seção do evento ou, sem ela, o módulo. */
function sectionOf(type: EventType, module: IntegrationModule) {
  return definitionOf(type).sectionLabel ?? moduleNames[module]
}

/**
 * Destino do link da mensagem e da notificação. Avisos da conta têm destino fixo, ou nenhum, para
 * não levar quem perdeu o acesso a uma tela de administração.
 */
export function linkPathOf(type: EventType, module: IntegrationModule, resourceId: string | null) {
  const definition = definitionOf(type)
  if (definition.path !== undefined) return definition.path
  return resourcePath(module, resourceId)
}

export function categoryOf(type: EventType) {
  return definitionOf(type).category
}

/** Quem vê a notificação de equipe, e abre o registro de destino pela mesma regra da API. */
export function teamPermissions(module: IntegrationModule): Permission[] {
  if (module === 'warehouse') return ['warehouse:manage']
  if (module === 'system') return ['integrations:manage']
  // O acesso às demandas vem do setor e da diretoria, conferidos por demandNotifications.
  if (module === 'demands') return []
  return [`${module}:update` as Permission, `${module}:read` as Permission, 'requests:read_all']
}

/** A pessoa solicitante só abre o próprio registro com acesso ao módulo. */
export function requesterPermissions(module: IntegrationModule): Permission[] {
  if (module === 'warehouse') return ['warehouse:read']
  if (module === 'system') return ['integrations:read']
  if (module === 'demands') return []
  return [`${module}:read` as Permission]
}

/** Número antigo com "#"; o código da migração 007 já se identifica sozinho. */
function reference(context: EventContext) {
  if (!context.protocol) return ''
  return /^\d+$/.test(context.protocol) ? ` #${context.protocol}` : ` ${context.protocol}`
}

export function renderNotification(type: EventType, context: EventContext) {
  const definition = definitionOf(type)
  return {
    title: `${sectionOf(type, context.module)}${reference(context)}`,
    message: redactForOutbound(definition.notice(context)),
    category: definition.category,
  }
}

/**
 * Texto próprio de um modelo. subject e intro vêm dos parâmetros antigos; os demais, do gerenciador
 * de modelos. Marcação não existe aqui: **negrito** e listas são convertidos ao montar o HTML.
 */
export type TemplateOverride = {
  subject?: string
  intro?: string
  greeting?: string
  body?: string
  closing?: string
  signature?: string
  /** Dados do atendimento, na ordem de apresentação. O motivo nunca sai, mesmo fora da lista. */
  facts?: readonly FactKey[]
}

export function renderSubject(type: EventType, context: EventContext, override?: TemplateOverride) {
  const definition = definitionOf(type)
  if (definition.plainSubject) {
    return redactForOutbound(
      `${override?.subject ?? definition.headline(context)} — ${reference(context).trim()}`,
    )
  }
  // O protocolo e o módulo continuam sempre no assunto, mesmo com texto próprio.
  return redactForOutbound(
    `${fill(override?.subject, context) || definition.headline(context)} - ${sectionOf(type, context.module)}${reference(context)} - JUCESP`,
  )
}

function fill(text: string | undefined, context: EventContext) {
  return text ? fillTemplate(text, valuesOf(context)) : ''
}

const onlyDate = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' })
const onlyTime = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short', timeZone: 'America/Sao_Paulo' })

function datePart(iso: string | null | undefined, format: Intl.DateTimeFormat) {
  if (!iso) return undefined
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? undefined : format.format(date)
}

/** Valores das variáveis. Só o que existe: o restante fica ausente, e a linha some da mensagem. */
export function valuesOf(context: EventContext): TemplateValues {
  const type = context as EventContext & { situation?: string }
  return {
    nome_solicitante: context.requesterName ?? undefined,
    protocolo: context.protocol || undefined,
    modulo: moduleNames[context.module],
    setor: context.sector ?? undefined,
    situacao: type.situation,
    // Passagens não leva descrição nem responsável, mesmo que cheguem por engano.
    descricao: context.module === 'flights' ? undefined : (context.description ?? undefined),
    responsavel: context.module === 'flights' ? undefined : (context.responsible ?? undefined),
    data_solicitada: context.requestedAt ? formatMoment(context.requestedAt) : undefined,
    data_agendada: datePart(context.scheduledAt, onlyDate),
    horario_agendado: datePart(context.scheduledAt, onlyTime),
    data_anterior: datePart(context.previousScheduledAt, onlyDate),
    horario_anterior: datePart(context.previousScheduledAt, onlyTime),
    nova_data: datePart(context.scheduledAt, onlyDate),
    novo_horario: datePart(context.scheduledAt, onlyTime),
    justificativa: context.reason ?? undefined,
    campos_correcao: context.returnFields?.join(', ') || undefined,
    quantidade_solicitada: context.requestedQuantities ?? undefined,
    quantidade_disponibilizada: context.providedQuantities ?? undefined,
    data_prevista_entrega: context.forecastDate ? formatCalendarDate(context.forecastDate) : undefined,
    previsao_anterior: context.previousForecastDate ? formatCalendarDate(context.previousForecastDate) : undefined,
    data_efetiva_entrega: datePart(context.deliveredAt, onlyDate),
    nome_passageiro: context.passengerName ?? undefined,
    companhia: context.airline ?? undefined,
    voos: context.flights ?? undefined,
    trecho_ida: context.outbound ?? undefined,
    trecho_volta: context.inbound ?? undefined,
    localizador: context.locator ?? undefined,
    nome_usuario: context.accountName ?? undefined,
    perfil_acesso: context.profileLabel ?? undefined,
    data_hora: context.occurredAt ? formatMoment(context.occurredAt) : undefined,
  }
}

/** Dados obrigatórios da mensagem. Faltando algum, ela não é enviada. */
export function missingEmailData(type: EventType, context: EventContext): string[] {
  const required = definitionOf(type).requires ?? []
  return [
    ...(context.module !== 'system' && !context.protocol ? ['protocol'] : []),
    ...required.filter((key) => !context[key]).map(String),
  ]
}

const schedulingEvents: readonly string[] = [
  'request_scheduled',
  'request_rescheduled',
  'request_schedule_changed',
  'request_cancelled',
]
const reasonEvents: readonly string[] = [
  'request_scheduled',
  'request_rescheduled',
  'request_schedule_changed',
  'request_cancelled',
  'request_info_requested',
  'request_returned',
  'request_return_closed',
  'warehouse_rejected',
  'warehouse_cancelled',
]
const returnEvents: readonly string[] = ['request_info_requested', 'request_returned', 'request_corrected']

/** Variáveis compatíveis com o evento, para a tela oferecer e o servidor conferir. */
export function allowedVariables(type: EventType) {
  const definition = definitionOf(type)
  const scope: VariableScope = {
    modules: definition.modules,
    account: Boolean(definition.toAccount),
    schedule: schedulingEvents.includes(type),
    reason: reasonEvents.includes(type),
    returned: returnEvents.includes(type),
    ticket: type === 'flight_ticket_delivery',
  }
  return variablesForEvent(scope)
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const automaticNotice =
  'Esta é uma mensagem automática do Sistema de Serviços de Logística e Manutenção da JUCESP. Não responda a este e-mail.'

/** Motivo, pedido e dados necessários não saem por descuido de quem editou o modelo. */
const mandatoryFacts: readonly FactKey[] = ['requested', 'scheduled', 'previous', 'changes', 'reason', 'fields']

function customFactOrder(chosen: readonly FactKey[] | undefined): FactKey[] {
  const list = chosen ? chosen.filter((key) => factKeys.includes(key)) : [...factKeys]
  return [...list, ...mandatoryFacts.filter((key) => !list.includes(key))]
}

const plainLine = (line: string) => line.replace(/\*\*(.+?)\*\*/g, '$1')

/** **negrito** e linhas iniciadas por "- ". Tudo é escapado antes: o texto não vira marcação. */
function inlineHtml(line: string) {
  return escapeHtml(line).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}

function linesToHtml(lines: readonly string[]) {
  const parts: string[] = []
  let items: string[] = []
  const flush = () => {
    if (items.length) parts.push(`<ul style="margin:0 0 8px;padding-left:20px">${items.join('')}</ul>`)
    items = []
  }
  for (const line of lines) {
    if (line.startsWith('- ')) {
      items.push(`<li style="margin:0 0 4px">${inlineHtml(line.slice(2))}</li>`)
    } else {
      flush()
      parts.push(`<p style="margin:0 0 8px">${inlineHtml(line)}</p>`)
    }
  }
  flush()
  return parts.join('\n    ')
}

/** Monta a mensagem. Todo o texto passa por redação e, na versão em HTML, por escape. */
export function renderEmail(
  type: EventType,
  context: EventContext,
  link: string | null,
  override?: TemplateOverride,
) {
  const definition = definitionOf(type)
  const filled: EventContext = { ...context, situation: definition.headline(context) } as EventContext
  const values = valuesOf(filled)
  const headline = redactForOutbound(fill(override?.subject, filled) || definition.headline(context))
  const facts = factLines(context)
  const custom = Boolean(override?.body || override?.greeting || override?.closing || override?.signature || override?.facts)
  const order = customFactOrder(override?.facts)
  const factText = (keys: readonly FactKey[]) => keys.flatMap((key) => facts[key])
  const rawLines = (
    custom
      ? [
          ...fillLines(override?.greeting ?? '', values),
          ...(override?.intro ? fillLines(override.intro, values) : []),
          ...(override?.body ? fillLines(override.body, values) : definition.lines(context)),
          ...factText(order),
          ...fillLines(override?.closing ?? '', values),
          ...fillLines(override?.signature ?? '', values),
        ]
      : [
          ...(override?.intro ? fillLines(override.intro, values) : []),
          ...facts.title,
          ...definition.lines(context),
          ...factText(factKeys.filter((key) => key !== 'title')),
        ]
  )
  const lines = rawLines.flatMap((line) => (line.includes('{{') ? fillLines(line, values) : [line])).map(redactForOutbound)
  const moduleLabel = sectionOf(type, context.module)

  const text = [
    headline,
    '',
    `${definition.sectionLabel ? 'Assunto' : 'Módulo'}: ${moduleLabel}`,
    ...(context.protocol ? [`${context.module === 'demands' ? 'Demanda' : 'Protocolo'}: ${context.protocol}`] : []),
    '',
    ...lines.map(plainLine),
    ...(link ? ['', `Acompanhe pelo sistema: ${link}`] : []),
    '',
    automaticNotice,
  ].join('\n')

  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#15191f">
  <div style="background:#000000;color:#fbb900;padding:12px 16px;font-weight:bold">JUCESP · Logística e Manutenção</div>
  <div style="padding:16px;border:1px solid #dedfda;border-top:0">
    <h2 style="margin:0 0 12px;font-size:20px">${escapeHtml(headline)}</h2>
    <p style="margin:0 0 12px;color:#4d5560">${escapeHtml(moduleLabel)}${
      context.protocol ? ` · ${context.module === 'demands' ? 'Demanda' : 'Protocolo'} ${escapeHtml(context.protocol)}` : ''
    }</p>
    ${linesToHtml(lines)}
    ${link ? `<p style="margin:16px 0 0"><a href="${escapeHtml(link)}" style="color:#034ea2">Acompanhar pelo sistema</a></p>` : ''}
    <p style="margin:16px 0 0;font-size:12px;color:#4d5560">${escapeHtml(automaticNotice)}</p>
  </div>
</div>`

  return { subject: renderSubject(type, context, override), text, html }
}

// ---------------------------------------------------------------------------
// Tradução das mudanças de status em acontecimentos.
// ---------------------------------------------------------------------------

export function flightEventFor(status: RequestStatus): EventType | null {
  if (status === 'aguardando_aprovacao') return 'flight_approval_needed'
  if (status === 'em_emissao') return 'flight_approved'
  if (status === 'emitida') return 'flight_issued'
  return null
}

export function warehouseEventFor(status: WarehouseStatus): EventType | null {
  const events: Partial<Record<WarehouseStatus, EventType>> = {
    em_analise: 'warehouse_in_review',
    atendido_parcial: 'warehouse_partial',
    atendido: 'warehouse_ready',
    entregue: 'warehouse_delivered',
    rejeitado: 'warehouse_rejected',
    cancelado: 'warehouse_cancelled',
  }
  return events[status] ?? null
}

/** Mensagem escrita pelo operador: o mesmo cabeçalho institucional, e todo o texto escapado. */
export function renderManualEmail(input: {
  module: IntegrationModule
  protocol: string
  subject: string
  body: string
  link: string | null
}) {
  const moduleLabel = moduleNames[input.module]
  const subject = redactForOutbound(input.subject.replace(/[\r\n]+/g, ' ').trim())
  const lines = input.body.split('\n').map((line) => redactForOutbound(line.trim())).filter(Boolean)
  const text = [
    `Módulo: ${moduleLabel}`,
    `Protocolo: ${input.protocol}`,
    '',
    ...lines.map(plainLine),
    ...(input.link ? ['', `Acompanhe pelo sistema: ${input.link}`] : []),
  ].join('\n')
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#15191f">
  <div style="background:#000000;color:#fbb900;padding:12px 16px;font-weight:bold">JUCESP · Logística e Manutenção</div>
  <div style="padding:16px;border:1px solid #dedfda;border-top:0">
    <p style="margin:0 0 12px;color:#4d5560">${escapeHtml(moduleLabel)} · Protocolo ${escapeHtml(input.protocol)}</p>
    ${linesToHtml(lines)}
    ${input.link ? `<p style="margin:16px 0 0"><a href="${escapeHtml(input.link)}" style="color:#034ea2">Acompanhar pelo sistema</a></p>` : ''}
  </div>
</div>`
  return { subject, text, html }
}

// ---------------------------------------------------------------------------
// Texto padrão e simulação, para o gerenciador de modelos.
// ---------------------------------------------------------------------------

const signatureText = slmSignature.join('\n')

/** O texto padrão de um evento, escrito com variáveis, para servir de ponto de partida ao editar. */
export function defaultTemplateContent(type: EventType) {
  const definition = definitionOf(type)
  const placeholders = {
    module: definition.modules[0],
    // Modelos manuais já são escritos com variáveis.
    protocol: '{{protocolo}}',
    forecastDate: '{{data_prevista_entrega}}',
    previousForecastDate: '{{previsao_anterior}}',
    delayMinutes: 0,
    total: 'as' as unknown as number,
    days: 'alguns' as unknown as number,
    channel: 'email',
  } satisfies EventContext
  return {
    name: definition.label,
    event: type,
    subject: definition.headline(placeholders),
    greeting: '',
    body: definition.lines(placeholders).filter((line) => !slmSignature.includes(line)).join('\n'),
    closing: '',
    signature: signatureText,
    facts: [...factKeys] as FactKey[],
  }
}

/** Dados de exemplo, identificados como tal, sem nenhuma pessoa ou solicitação real. */
export function sampleContext(type: EventType): EventContext {
  const module = definitionOf(type).modules[0]
  return {
    module,
    protocol: String(sampleValues.protocolo),
    title: 'Solicitação de exemplo',
    requesterName: sampleValues.nome_solicitante,
    sector: sampleValues.setor,
    description: sampleValues.descricao,
    responsible: sampleValues.responsavel,
    scheduledAt: '2030-01-15T13:00:00.000Z',
    previousScheduledAt: '2030-01-14T12:00:00.000Z',
    requestedAt: '2030-01-13T12:00:00.000Z',
    divergent: true,
    reason: sampleValues.justificativa,
    returnFields: ['Local do serviço', 'Sala'],
    requestedQuantities: sampleValues.quantidade_solicitada,
    providedQuantities: sampleValues.quantidade_disponibilizada,
    deliveredAt: '2030-01-21T13:00:00.000Z',
    delayMinutes: 15,
    total: 3,
    days: 5,
    channel: 'email',
    forecastDate: '2030-01-20',
    previousForecastDate: '2030-01-18',
    passengerName: sampleValues.nome_passageiro,
    airline: sampleValues.companhia,
    flights: sampleValues.voos,
    outbound: sampleValues.trecho_ida,
    inbound: sampleValues.trecho_volta,
    locator: sampleValues.localizador,
  }
}

export function isManualEvent(type: EventType) {
  return definitionOf(type).manual === true
}

// ---------------------------------------------------------------------------
// Consulta administrativa dos modelos. Os exemplos são fictícios.
// ---------------------------------------------------------------------------

export function listTemplates() {
  return (Object.keys(eventCatalog) as EventType[]).map((key) => {
    const definition = definitionOf(key)
    const module = definition.modules[0]
    const sample = renderEmail(
      key,
      {
        module,
        protocol: '0000',
        title: 'Exemplo',
        scheduledAt: '2030-01-15T13:00:00.000Z',
        previousScheduledAt: '2030-01-14T13:00:00.000Z',
        reason: 'Motivo de exemplo',
        delayMinutes: 15,
        total: 3,
        days: 5,
        channel: 'email',
        forecastDate: '2030-01-15',
        previousForecastDate: '2030-01-14',
        returnFields: ['Campo de exemplo'],
      },
      null,
    )
    return {
      key,
      label: definition.label,
      modules: definition.modules.map((item) => moduleNames[item]),
      audience: {
        requester: definition.toRequester,
        team: definition.toTeam,
        responsible: definition.toResponsible ?? false,
        responsibleEmail: definition.emailResponsible ?? false,
        account: definition.toAccount ?? false,
        holders: definition.toHolders ?? null,
      },
      subject: sample.subject,
      body: sample.text,
    }
  })
}
