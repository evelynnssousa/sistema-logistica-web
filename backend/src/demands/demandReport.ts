import type { ReportDocument } from '../reports/reportDocument.js'
import type { Sheet } from '../reports/xlsxDocument.js'

/** Relatório do módulo em PDF e Excel, a partir dos mesmos dados da tela. */

const statusLabels: Record<string, string> = {
  nao_iniciada: 'Não iniciada',
  em_andamento: 'Em andamento',
  aguardando_terceiros: 'Aguardando terceiros',
  aguardando_autorizacao: 'Aguardando autorização',
  suspensa: 'Suspensa',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
}

const priorityLabels: Record<string, string> = {
  baixa: 'Baixa',
  media: 'Média',
  alta: 'Alta',
  urgente: 'Urgente',
}

export const reportPurposeNotice =
  'Finalidade: transparência sobre o volume e a distribuição das atividades administrativas. Estes indicadores não são instrumento de avaliação individual de desempenho.'

type Group = { label: string; total: number; open: number; overdue: number }

export type DemandReport = {
  totals: Record<string, number | null>
  bySector: Group[]
  byResponsible: Group[]
  byCategory: Group[]
  byPriority: Group[]
  byStatus: Group[]
  monthly: { mes: string; abertas: number; concluidas: number }[]
}

export type DemandReportRow = {
  number: string
  title: string
  category: string | null
  responsibleSector: string | null
  responsible: string | null
  priority: string
  status: string
  openedAt: Date
  dueDate: string | null
  overdue: boolean
  recurring: boolean
  shared: boolean
  // Só para a planilha (12/11/2026); ausentes, as colunas ficam vazias.
  originSector?: string | null
  requester?: string | null
  startDate?: string | null
  completedAt?: Date | null
  subtasks?: number
  subtasksDone?: number
  reopenings?: number
  waitingOn?: string | null
}

/** Data AAAA-MM-DD do prazo em DD/MM/AAAA. */
const dueText = (value: string | null | undefined) => (value ? value.split('-').reverse().join('/') : null)
const brasiliaDate = (value: Date) => new Date(value).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
const brasiliaToday = (now: Date) => now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
const dayMs = 86_400_000

/** Dias de atraso: vencida e aberta, conta até hoje; concluída depois do prazo, até a conclusão. */
export function delayDays(row: Pick<DemandReportRow, 'dueDate' | 'completedAt' | 'overdue' | 'status'>, now = new Date()) {
  if (!row.dueDate || row.status === 'cancelada') return null
  const due = Date.parse(`${row.dueDate}T00:00:00Z`)
  const end = row.completedAt
    ? Date.parse(`${new Date(row.completedAt).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })}T00:00:00Z`)
    : Date.parse(`${brasiliaToday(now)}T00:00:00Z`)
  const days = Math.round((end - due) / dayMs)
  return days > 0 ? days : 0
}

const friendly = (group: Group, labels: Record<string, string>) => ({ ...group, label: labels[group.label] ?? group.label })

function indicators(totals: DemandReport['totals']): [string, number][] {
  return [
    ['Demandas no recorte', totals.total ?? 0],
    ['Abertas', totals.abertas ?? 0],
    ['Não iniciadas', totals.nao_iniciadas ?? 0],
    ['Em andamento', totals.em_andamento ?? 0],
    ['Aguardando terceiros', totals.aguardando_terceiros ?? 0],
    ['Aguardando autorização', totals.aguardando_autorizacao ?? 0],
    ['Suspensas', totals.suspensas ?? 0],
    ['Atrasadas', totals.atrasadas ?? 0],
    ['Concluídas', totals.concluidas ?? 0],
    ['Canceladas', totals.canceladas ?? 0],
    ['Sem responsável', totals.sem_responsavel ?? 0],
    ['Recorrentes', totals.recorrentes ?? 0],
    ['Compartilhadas', totals.compartilhadas ?? 0],
  ]
}

function groupSections(report: DemandReport) {
  return [
    { name: 'Por setor', rows: report.bySector },
    { name: 'Por responsável', rows: report.byResponsible },
    { name: 'Por categoria', rows: report.byCategory },
    { name: 'Por prioridade', rows: report.byPriority.map((group) => friendly(group, priorityLabels)) },
    { name: 'Por status', rows: report.byStatus.map((group) => friendly(group, statusLabels)) },
  ]
}

function averageLabel(days: number | null | undefined) {
  return days === null || days === undefined ? 'Sem conclusões no recorte' : `${String(days).replace('.', ',')} dias`
}

export function demandReportDocument(
  report: DemandReport,
  rows: readonly DemandReportRow[],
  generatedBy: string,
  now = new Date(),
): ReportDocument {
  return {
    title: 'Controle de Demandas',
    subtitle: 'Relatório gerencial da Diretoria Administrativa',
    generatedAt: now,
    generatedBy,
    sections: [
      {
        heading: 'Indicadores',
        rows: [
          ...indicators(report.totals).map(([label, value]): [string, string] => [label, String(value)]),
          ['Tempo médio de conclusão', averageLabel(report.totals.tempo_medio_dias)],
        ],
      },
      ...groupSections(report).map((section) => ({
        heading: section.name,
        entries: section.rows.map((group) => `${group.label}: ${group.total} (${group.open} abertas, ${group.overdue} atrasadas)`),
      })),
      {
        heading: 'Evolução mensal',
        entries: report.monthly.map((item) => `${item.mes}: ${item.abertas} abertas, ${item.concluidas} concluídas`),
      },
      {
        heading: `Demandas (${rows.length})`,
        entries: rows.slice(0, 500).map(
          (row) =>
            `${row.number} - ${row.title} - ${row.responsibleSector ?? 'Sem setor'} - ${row.responsible ?? 'Sem responsável'} - ${statusLabels[row.status] ?? row.status} - prazo ${row.dueDate ? row.dueDate.split('-').reverse().join('/') : 'não definido'}${row.overdue ? ' (atrasada)' : ''}`,
        ),
      },
      { heading: 'Observação', entries: [reportPurposeNotice] },
    ],
  }
}

const scopeLabels: Record<string, string> = {
  all: 'Todas que você pode ver',
  mine: 'Minhas',
  sector: 'Do meu setor',
  shared: 'Compartilhadas comigo',
  drafts: 'Rascunhos',
}

/** Filtros da tela em texto, para a aba "Sobre". Identificadores aparecem como "selecionado". */
export function describeDemandFilters(filters: {
  search?: string
  number?: string
  statuses?: string[]
  priority?: string | null
  sectorId?: string | null
  responsibleId?: string | null
  categoryId?: string | null
  from?: Date | null
  to?: Date | null
  dueFrom?: string | null
  dueTo?: string | null
  recurring?: boolean | null
  shared?: boolean | null
  overdue?: boolean
  unassigned?: boolean
  scope?: string
}): [string, string][] {
  const out: [string, string][] = []
  if (filters.scope && filters.scope !== 'all') out.push(['Visão', scopeLabels[filters.scope] ?? filters.scope])
  if (filters.search) out.push(['Pesquisa', filters.search])
  if (filters.number) out.push(['Número', filters.number])
  if (filters.statuses?.length) out.push(['Status', filters.statuses.map((status) => statusLabels[status] ?? status).join(', ')])
  if (filters.priority) out.push(['Prioridade', priorityLabels[filters.priority] ?? filters.priority])
  if (filters.sectorId) out.push(['Setor', 'selecionado na tela'])
  if (filters.responsibleId) out.push(['Responsável', 'selecionado na tela'])
  if (filters.categoryId) out.push(['Categoria', 'selecionada na tela'])
  if (filters.from || filters.to) {
    out.push(['Abertura', `${filters.from ? brasiliaDate(filters.from) : 'início'} a ${filters.to ? brasiliaDate(filters.to) : 'hoje'}`])
  }
  if (filters.dueFrom || filters.dueTo) out.push(['Prazo', `${dueText(filters.dueFrom) ?? 'início'} a ${dueText(filters.dueTo) ?? 'sem limite'}`])
  if (filters.recurring !== null && filters.recurring !== undefined) out.push(['Recorrentes', filters.recurring ? 'Só recorrentes' : 'Sem recorrentes'])
  if (filters.shared !== null && filters.shared !== undefined) out.push(['Compartilhadas', filters.shared ? 'Só compartilhadas' : 'Sem compartilhadas'])
  if (filters.overdue) out.push(['Atrasadas', 'Só atrasadas'])
  if (filters.unassigned) out.push(['Responsável', 'Só sem responsável'])
  return out
}

export function demandReportWorkbook(
  report: DemandReport,
  rows: readonly DemandReportRow[],
  meta: { generatedBy?: string; filters?: [string, string][]; now?: Date } = {},
): Sheet[] {
  const now = meta.now ?? new Date()
  const late = rows
    .map((row) => ({ row, days: delayDays(row, now) }))
    .filter((item) => item.row.overdue && item.days !== null)
    .sort((a, b) => (b.days ?? 0) - (a.days ?? 0))
  const finished = rows.filter((row) => row.status === 'concluida' && row.dueDate && row.completedAt)
  const onTime = finished.filter((row) => delayDays(row, now) === 0).length
  return [
    {
      name: 'Sobre',
      rows: [
        ['Controle de Demandas: relatório gerencial da Diretoria Administrativa'],
        ['Gerado em', now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })],
        ...(meta.generatedBy ? [['Gerado por', meta.generatedBy]] : []),
        ...(meta.filters?.length ? [[], ['Filtros aplicados'], ...meta.filters] : [[], ['Filtros aplicados', 'Nenhum: todas as demandas que você pode ver']]),
        [],
        ['Dias de atraso: de o prazo vencer até hoje (abertas) ou até a conclusão (concluídas depois do prazo).'],
        [reportPurposeNotice],
      ],
    },
    {
      name: 'Indicadores',
      rows: [
        ['Indicador', 'Valor'],
        ...indicators(report.totals),
        ['Tempo médio de conclusão (dias)', report.totals.tempo_medio_dias ?? null],
        ['Concluídas com prazo', finished.length],
        ['Concluídas dentro do prazo', onTime],
        ['Concluídas dentro do prazo (%)', finished.length ? Math.round((onTime / finished.length) * 100) : null],
        [],
        [reportPurposeNotice],
      ],
    },
    ...groupSections(report).map((section) => ({
      name: section.name,
      rows: [
        [section.name.replace('Por ', ''), 'Total', 'Abertas', 'Atrasadas'],
        ...section.rows.map((group) => [group.label, group.total, group.open, group.overdue]),
      ],
    })),
    {
      name: 'Evolução mensal',
      rows: [
        ['Mês', 'Abertas', 'Concluídas'],
        ...report.monthly.map((item) => [item.mes, item.abertas, item.concluidas]),
      ],
    },
    {
      name: 'Atrasadas',
      rows: [
        ['Número', 'Título', 'Setor responsável', 'Responsável', 'Prioridade', 'Status', 'Prazo', 'Dias de atraso', 'Aguardando'],
        ...late.map(({ row, days }) => [
          row.number, row.title, row.responsibleSector, row.responsible, priorityLabels[row.priority] ?? row.priority,
          statusLabels[row.status] ?? row.status, dueText(row.dueDate), days, row.waitingOn ?? null,
        ]),
      ],
    },
    {
      name: 'Demandas',
      rows: [
        ['Número', 'Título', 'Categoria', 'Setor de origem', 'Setor responsável', 'Solicitante', 'Responsável', 'Prioridade', 'Status',
          'Abertura', 'Início previsto', 'Prazo', 'Concluída em', 'Atrasada', 'Dias de atraso', 'Etapas concluídas', 'Etapas',
          'Progresso (%)', 'Reaberturas', 'Aguardando', 'Recorrente', 'Compartilhada'],
        ...rows.map((row) => [
          row.number,
          row.title,
          row.category,
          row.originSector ?? null,
          row.responsibleSector,
          row.requester ?? null,
          row.responsible,
          priorityLabels[row.priority] ?? row.priority,
          statusLabels[row.status] ?? row.status,
          brasiliaDate(row.openedAt),
          dueText(row.startDate),
          dueText(row.dueDate),
          row.completedAt ? brasiliaDate(row.completedAt) : null,
          row.overdue ? 'Sim' : 'Não',
          delayDays(row, now),
          row.subtasks ? row.subtasksDone ?? 0 : null,
          row.subtasks || null,
          row.subtasks ? Math.round(((row.subtasksDone ?? 0) / row.subtasks) * 100) : null,
          row.reopenings ?? null,
          row.waitingOn ?? null,
          row.recurring ? 'Sim' : 'Não',
          row.shared ? 'Sim' : 'Não',
        ]),
      ],
    },
  ]
}
