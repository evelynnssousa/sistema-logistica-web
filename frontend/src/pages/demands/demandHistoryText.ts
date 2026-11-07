import { commentKindLabels, demandPriorityLabels, demandStatusLabels, historyLabels, moduleLinkLabels } from '../../api/demandsApi'
import { formatCalendarDate } from '../../api/modulesApi'

/**
 * Texto do histórico de uma demanda: título do registro e linhas com campo, valor anterior e
 * novo. Registros antigos (anteriores ao detalhamento) continuam legíveis: mostram os campos
 * alterados, sem os valores, que não foram guardados na época.
 */

type Details = Record<string, unknown>

export type HistoryLine = { label: string; text: string; long?: boolean }

/** Nomes dos campos: os atuais e as chaves dos registros antigos. */
const fieldLabels: Record<string, string> = {
  titulo: 'Título',
  descricao: 'Descrição',
  categoria: 'Categoria',
  setorOrigem: 'Setor solicitante',
  setorResponsavel: 'Setor responsável',
  inicioPrevisto: 'Início previsto',
  prazo: 'Prazo',
  prioridade: 'Prioridade',
  restrita: 'Acesso restrito',
  observacoes: 'Observações',
  referencias: 'Referências',
  lembreteDias: 'Lembrete de prazo',
  gestor: 'Diretor do acompanhamento',
  status: 'Status',
  responsavel: 'Responsável',
  atividade: 'Atividade',
  prazoColaborador: 'Prazo do colaborador',
  title: 'Título',
  description: 'Descrição',
  categoryId: 'Categoria',
  originSectorId: 'Setor solicitante',
  responsibleSectorId: 'Setor responsável',
  startDate: 'Início previsto',
  dueDate: 'Prazo',
  priority: 'Prioridade',
  restricted: 'Acesso restrito',
  notes: 'Observações',
  references: 'Referências',
  reminderDays: 'Lembrete de prazo',
  followUpManagerId: 'Diretor do acompanhamento',
  responsibleId: 'Responsável',
}

const changedTitles: Record<string, string> = {
  titulo: 'Título alterado',
  categoria: 'Categoria alterada',
  setorOrigem: 'Setor solicitante alterado',
  setorResponsavel: 'Setor responsável alterado',
  inicioPrevisto: 'Início previsto alterado',
  observacoes: 'Observações alteradas',
  referencias: 'Referências alteradas',
  lembreteDias: 'Lembrete de prazo alterado',
}

const longFields = new Set(['descricao', 'observacoes', 'referencias', 'atividade'])

export function fieldLabel(campo: string) {
  return fieldLabels[campo] ?? campo
}

export function historyTitle(action: string, details: Details) {
  if (action === 'campo_alterado' && typeof details.campo === 'string') {
    return changedTitles[details.campo] ?? `${fieldLabel(details.campo)} alterado`
  }
  return historyLabels[action] ?? action
}

/** Valor legível de um campo: datas, status, prioridade, sim/não e vazio. */
export function formatHistoryValue(value: unknown, campo?: string): string {
  if (value === null || value === undefined || value === '') return 'não informado'
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não'
  if (campo === 'lembreteDias' && typeof value === 'number') return `${value} dia(s) antes do prazo`
  const text = String(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return formatCalendarDate(text)
  if (campo === 'prioridade') return demandPriorityLabels[text] ?? text
  return demandStatusLabels[text as keyof typeof demandStatusLabels] ?? demandPriorityLabels[text] ?? text
}

function changeLines(campo: string | undefined, de: unknown, para: unknown, prefix = ''): HistoryLine[] {
  const long = campo ? longFields.has(campo) : false
  return [
    { label: `${prefix}Anterior`, text: formatHistoryValue(de, campo), long },
    { label: `${prefix}Novo`, text: formatHistoryValue(para, campo), long },
  ]
}

export function historyLines(action: string, details: Details): HistoryLine[] {
  const lines: HistoryLine[] = []
  const campo = typeof details.campo === 'string' ? details.campo : undefined

  if (typeof details.pessoa === 'string') lines.push({ label: 'Pessoa', text: details.pessoa })
  if (typeof details.setor === 'string') lines.push({ label: 'Setor', text: details.setor })
  if (typeof details.titulo === 'string' && action.startsWith('etapa_')) lines.push({ label: 'Etapa', text: details.titulo })
  if (typeof details.arquivo === 'string') lines.push({ label: 'Arquivo', text: details.arquivo })
  if (action === 'colaborador_adicionado') {
    if (details.atividade) lines.push({ label: 'Atividade', text: String(details.atividade), long: true })
    if (details.prazo) lines.push({ label: 'Prazo do colaborador', text: formatHistoryValue(details.prazo) })
  }

  if (Array.isArray(details.alteracoes)) {
    for (const item of details.alteracoes as { campo?: string; de?: unknown; para?: unknown }[]) {
      lines.push(...changeLines(item.campo, item.de, item.para, `${fieldLabel(item.campo ?? '')} — `))
    }
  } else if ('de' in details || 'para' in details) {
    lines.push(...changeLines(campo, details.de, details.para))
  } else if (Array.isArray(details.campos) && details.campos.length > 0) {
    // Registro antigo: só os nomes dos campos foram guardados.
    lines.push({ label: 'Campos alterados', text: details.campos.map((item) => fieldLabel(String(item))).join(', ') })
  }

  if (action === 'colaboracao_alterada') {
    // Registro antigo: guardava só as quantidades.
    const count = (value: unknown) => (typeof value === 'number' ? value : 0)
    lines.push({
      label: 'Situação registrada',
      text: `${count(details.colaboradores)} colaborador(es), ${count(details.setoresColaboradores)} setor(es), ${count(details.autorizados)} pessoa(s) autorizada(s)`,
    })
  }
  if (action === 'registro_incluido' && typeof details.tipo === 'string') {
    lines.push({ label: 'Tipo', text: commentKindLabels[details.tipo] ?? details.tipo })
  }
  if ((action === 'vinculo_incluido' || action === 'vinculo_removido') && typeof details.protocolo === 'string') {
    lines.push({ label: 'Protocolo', text: `${moduleLinkLabels[String(details.modulo)] ?? details.modulo} ${details.protocolo}` })
  }
  if (details.data) lines.push({ label: 'Data', text: formatHistoryValue(details.data) })
  if (details.aguardando) lines.push({ label: 'Aguardando', text: String(details.aguardando) })
  if (details.retomadaPrevista) lines.push({ label: 'Retomada prevista', text: formatHistoryValue(details.retomadaPrevista) })
  if (details.regra) lines.push({ label: 'Regra', text: String(details.regra) })
  if (details.proximaData) lines.push({ label: 'Próxima data', text: formatHistoryValue(details.proximaData) })
  if (details.origem) lines.push({ label: 'Alterada a partir de', text: String(details.origem) })
  if (details.alcance === 'esta_e_futuras') lines.push({ label: 'Alcance', text: 'esta e as futuras ocorrências' })
  if (details.alcance === 'somente_esta') lines.push({ label: 'Alcance', text: 'somente esta ocorrência' })
  return lines
}
