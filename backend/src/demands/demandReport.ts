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

export function demandReportWorkbook(report: DemandReport, rows: readonly DemandReportRow[]): Sheet[] {
  return [
    {
      name: 'Indicadores',
      rows: [
        ['Indicador', 'Valor'],
        ...indicators(report.totals),
        ['Tempo médio de conclusão (dias)', report.totals.tempo_medio_dias ?? null],
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
      name: 'Demandas',
      rows: [
        ['Número', 'Título', 'Categoria', 'Setor responsável', 'Responsável', 'Prioridade', 'Status', 'Abertura', 'Prazo', 'Atrasada', 'Recorrente', 'Compartilhada'],
        ...rows.map((row) => [
          row.number,
          row.title,
          row.category,
          row.responsibleSector,
          row.responsible,
          priorityLabels[row.priority] ?? row.priority,
          statusLabels[row.status] ?? row.status,
          new Date(row.openedAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
          row.dueDate ? row.dueDate.split('-').reverse().join('/') : null,
          row.overdue ? 'Sim' : 'Não',
          row.recurring ? 'Sim' : 'Não',
          row.shared ? 'Sim' : 'Não',
        ]),
      ],
    },
  ]
}
