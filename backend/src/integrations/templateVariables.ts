/**
 * Biblioteca de informações dinâmicas dos modelos de e-mail, escritas como {{protocolo}}. A lista é
 * fechada: um modelo não alcança nenhum outro dado, e CPF e passageiros não têm variável.
 */
type VariableGroup = 'base' | 'request' | 'schedule' | 'reason' | 'return' | 'warehouse' | 'ticket'

const definitions = [
  { key: 'nome_solicitante', label: 'Nome do solicitante', group: 'base', example: 'Pessoa de Exemplo' },
  { key: 'protocolo', label: 'Protocolo', group: 'base', example: 'MAN-0000-00000' },
  { key: 'modulo', label: 'Módulo', group: 'base', example: 'Manutenção' },
  { key: 'setor', label: 'Setor', group: 'base', example: 'Setor de Exemplo' },
  { key: 'situacao', label: 'Situação', group: 'base', example: 'Situação de exemplo' },
  { key: 'descricao', label: 'Descrição da solicitação', group: 'request', example: 'Descrição de exemplo' },
  { key: 'responsavel', label: 'Responsável pelo atendimento', group: 'request', example: 'Responsável de Exemplo' },
  { key: 'data_solicitada', label: 'Data e horário solicitados', group: 'schedule', example: '15/01/2030 10:00' },
  { key: 'data_agendada', label: 'Data agendada', group: 'schedule', example: '15/01/2030' },
  { key: 'horario_agendado', label: 'Horário agendado', group: 'schedule', example: '10:00' },
  { key: 'data_anterior', label: 'Data anterior', group: 'schedule', example: '14/01/2030' },
  { key: 'horario_anterior', label: 'Horário anterior', group: 'schedule', example: '09:00' },
  { key: 'nova_data', label: 'Nova data', group: 'schedule', example: '15/01/2030' },
  { key: 'novo_horario', label: 'Novo horário', group: 'schedule', example: '10:00' },
  { key: 'justificativa', label: 'Justificativa registrada', group: 'reason', example: 'Justificativa de exemplo' },
  { key: 'campos_correcao', label: 'Campos a corrigir', group: 'return', example: 'Local do serviço, Sala' },
  { key: 'quantidade_solicitada', label: 'Quantidades solicitadas', group: 'warehouse', example: 'Papel A4: 10 un' },
  { key: 'quantidade_disponibilizada', label: 'Quantidades disponibilizadas', group: 'warehouse', example: 'Papel A4: 6 un' },
  { key: 'data_prevista_entrega', label: 'Data prevista de entrega', group: 'warehouse', example: '20/01/2030' },
  { key: 'previsao_anterior', label: 'Previsão anterior', group: 'warehouse', example: '18/01/2030' },
  { key: 'data_efetiva_entrega', label: 'Data efetiva de entrega', group: 'warehouse', example: '21/01/2030' },
  { key: 'nome_passageiro', label: 'Nome do passageiro', group: 'ticket', example: 'Passageiro de Exemplo' },
  { key: 'companhia', label: 'Companhia aérea', group: 'ticket', example: 'Companhia de Exemplo' },
  { key: 'voos', label: 'Voos da cotação escolhida', group: 'ticket', example: 'Voo de exemplo' },
  { key: 'trecho_ida', label: 'Ida: origem, destino, data e horário', group: 'ticket', example: 'Origem → Destino, 15/01/2030 às 10:00' },
  { key: 'trecho_volta', label: 'Volta: origem, destino, data e horário', group: 'ticket', example: 'Destino → Origem, 20/01/2030 às 18:00' },
  { key: 'localizador', label: 'Localizador da reserva', group: 'ticket', example: 'ABC123' },
] as const

export const templateVariables = definitions.map(({ key, label, example }) => ({ key, label, example }))

export type TemplateVariable = (typeof definitions)[number]['key']

const known = new Set<string>(definitions.map((item) => item.key))
const variablePattern = /\{\{\s*([a-z_]+)\s*\}\}/g

export type VariableScope = {
  /** Módulos do evento. Passagens não leva descrição nem responsável, e o sistema não leva nada do pedido. */
  modules: readonly string[]
  schedule?: boolean
  reason?: boolean
  returned?: boolean
  ticket?: boolean
}

/** Só as variáveis compatíveis com o evento: o que ele não tem, o modelo não oferece. */
export function variablesForEvent(scope: VariableScope): TemplateVariable[] {
  const isSystem = scope.modules.every((module) => module === 'system')
  const isWarehouse = scope.modules.includes('warehouse')
  const isFlight = scope.modules.includes('flights')
  const groups = new Set<VariableGroup>(['base'])
  if (!isSystem && !isWarehouse && !isFlight) groups.add('request')
  if (scope.schedule) groups.add('schedule')
  if (scope.reason) groups.add('reason')
  if (scope.returned) groups.add('return')
  if (isWarehouse) groups.add('warehouse')
  if (scope.ticket) groups.add('ticket')
  return definitions
    .filter((item) => groups.has(item.group) && !(isSystem && ['nome_solicitante', 'setor'].includes(item.key)))
    .map((item) => item.key)
}

/** Variáveis que o texto precisa citar, porque a mensagem não faria sentido sem elas. */
export const requiredBodyVariables: Partial<Record<string, readonly TemplateVariable[]>> = {
  warehouse_forecast_set: ['data_prevista_entrega'],
  warehouse_forecast_changed: ['data_prevista_entrega'],
}

/** Explica o que está errado no texto, ou devolve null. Marcação nunca é aceita. */
export function templateTextProblem(text: string, allowed?: readonly string[]): string | null {
  if (/[<>]/.test(text)) return 'não pode conter os caracteres < >'
  for (const [, name] of text.matchAll(variablePattern)) {
    if (!known.has(name)) return `usa a variável desconhecida {{${name}}}`
    if (allowed && !allowed.includes(name)) return `usa {{${name}}}, que não existe neste evento`
  }
  if (/[{}]/.test(text.replace(variablePattern, ''))) {
    return 'só aceita chaves em variáveis, como {{protocolo}}'
  }
  return null
}

export function citedVariables(text: string): string[] {
  return [...text.matchAll(variablePattern)].map(([, name]) => name)
}

export type TemplateValues = Partial<Record<TemplateVariable, string>>

/** Dado ausente vira vazio, nunca o nome da variável. */
export function fillTemplate(text: string, values: TemplateValues) {
  return text
    .replace(variablePattern, (_match, name: TemplateVariable) => values[name] ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** Linha que depende de um dado ausente sai inteira: nada de "Setor: " sem o setor. */
export function fillLines(text: string, values: TemplateValues) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false
      return citedVariables(line).every((name) => Boolean(values[name as TemplateVariable]))
    })
    .map((line) => fillTemplate(line, values))
    .filter(Boolean)
}

/** Dados de exemplo, claramente identificados, para a prévia e o envio de teste. */
export const sampleValues = Object.fromEntries(definitions.map(({ key, example }) => [key, example])) as TemplateValues
