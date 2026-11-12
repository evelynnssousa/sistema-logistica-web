import type { Pool } from 'pg'
import { holdsPermission } from '../auth/permissions.js'
import type { RequestModule } from '../auth/requestPolicy.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { getDatabasePool } from '../database/pool.js'
import { protocolSql } from '../database/protocolSql.js'
import { moduleTypes, normalizeStatus } from '../requests/workflow.js'
import { formatHours } from './driverWorkload.js'
import { dateTime, number, periodSheet, tableExists } from './operationalSpreadsheets.js'
import type { SpreadsheetPeriod } from './operationalSpreadsheets.js'
import type { Cell, Sheet } from './xlsxDocument.js'

/**
 * Planilhas de Manutenção, Passagens aéreas e a geral dos Relatórios (12/11/2026). Só leitura, no
 * alcance de quem baixa: sem `requests:read_all`, só as próprias solicitações. Passagens nunca levam
 * nome nem CPF de passageiro: só a quantidade.
 */

const statusLabels: Record<string, string> = {
  aguardando_agendamento: 'Aguardando agendamento',
  agendado: 'Agendado',
  reagendado: 'Reagendado',
  em_andamento: 'Em andamento',
  concluido: 'Concluído',
  cancelado: 'Cancelado',
  em_cotacao: 'Em cotação',
  aguardando_aprovacao: 'Aguardando aprovação',
  em_emissao: 'Em emissão',
  emitida: 'Emitida',
  cancelada: 'Cancelada',
}
const priorityLabels: Record<string, string> = { baixa: 'Baixa', normal: 'Normal', alta: 'Alta', urgente: 'Urgente' }
const complexityLabels: Record<string, string> = { simples: 'Simples', media: 'Média', complexa: 'Complexa' }
const tripLabels: Record<string, string> = { ida_volta: 'Ida e volta', somente_ida: 'Somente ida', somente_volta: 'Somente volta' }
const moduleLabels: Record<RequestModule, string> = { maintenance: 'Manutenção', fleet: 'Frota', flights: 'Passagens aéreas' }
const closedStatuses = new Set(['concluido', 'cancelado', 'emitida', 'cancelada'])
const cancelledStatuses = new Set(['cancelado', 'cancelada'])

type RequestRow = {
  id: string
  tipo: string
  protocolo: string
  titulo: string
  status: string
  created_at: Date
  setor_nome: string | null
  andar_nome: string | null
  tipo_servico_nome: string | null
  prioridade: string | null
  complexidade: string | null
  solicitante: string | null
  responsavel: string | null
  data_agendada: Date | null
  agendamento_fim: Date | null
  execucao_inicio: Date | null
  execucao_fim: Date | null
  concluida_em: Date | null
  prazo_em: Date | null
  motivo_cancelamento: string | null
  dados: Record<string, unknown>
}

export type RequestFilters = {
  from: Date | null
  to: Date | null
  modules: RequestModule[]
  sectorId?: string | null
  responsibleId?: string | null
  status?: string | null
}

const day = 86_400_000
const daysBetween = (start: Date | null, end: Date | null): Cell =>
  start && end ? Math.round(((end.getTime() - start.getTime()) / day) * 10) / 10 : null
const minutesBetween = (start: Date | null, end: Date | null) =>
  start && end ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000)) : null
const text = (value: unknown): Cell => (typeof value === 'string' && value.trim() ? value : null)

/** Módulos que a pessoa pode consultar, entre os pedidos. */
export function readableRequestModules(identity: AuthenticatedIdentity, wanted: readonly RequestModule[]) {
  return wanted.filter((module) => holdsPermission(identity, `${module}:read` as never))
}

async function loadRequests(pool: Pool, identity: AuthenticatedIdentity, filters: RequestFilters) {
  const modules = readableRequestModules(identity, filters.modules)
  if (modules.length === 0) return []
  const parameters: unknown[] = [modules.map((module) => moduleTypes[module])]
  const bind = (value: unknown) => `$${parameters.push(value)}`
  const conditions = ['r.tipo = ANY($1)']
  if (filters.from) conditions.push(`r.created_at >= ${bind(filters.from)}`)
  if (filters.to) conditions.push(`r.created_at < ${bind(filters.to)}`)
  if (!holdsPermission(identity, 'requests:read_all')) conditions.push(`r.solicitante_id = ${bind(identity.userId)}`)
  if (filters.sectorId) conditions.push(`r.setor_id = ${bind(filters.sectorId)}`)
  if (filters.responsibleId) conditions.push(`r.responsavel_id = ${bind(filters.responsibleId)}`)
  const result = await pool.query<RequestRow>(
    `SELECT r.id::text AS id, r.tipo, ${protocolSql('r')} AS protocolo, r.titulo, r.status, r.created_at,
            r.setor_nome, r.andar_nome, r.tipo_servico_nome, r.prioridade, to_jsonb(r)->>'complexidade' AS complexidade,
            us.full_name AS solicitante, ur.full_name AS responsavel,
            r.data_agendada, r.agendamento_fim, r.execucao_inicio, r.execucao_fim, r.concluida_em,
            (to_jsonb(r)->>'prazo_em')::timestamptz AS prazo_em, r.motivo_cancelamento, r.dados
       FROM public.service_requests r
       LEFT JOIN public.auth_users us ON us.id = r.solicitante_id
       LEFT JOIN public.auth_users ur ON ur.id = r.responsavel_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.created_at, r.id
      LIMIT 20000`,
    parameters,
  )
  const moduleOf = Object.fromEntries(Object.entries(moduleTypes).map(([module, type]) => [type, module])) as Record<string, RequestModule>
  return result.rows
    .map((row) => ({ ...row, module: moduleOf[row.tipo], status: normalizeStatus(moduleOf[row.tipo], row.status) }))
    .filter((row) => !filters.status || row.status === filters.status)
}

/** Agrupa e conta, com o total de concluídas e o tempo médio até concluir. */
function grouped<T extends { status: string; created_at: Date; concluida_em: Date | null }>(
  rows: readonly T[],
  keyOf: (row: T) => string | null,
  label: string,
): Sheet['rows'] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row) ?? 'Não informado'
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [
    [label, 'Total', 'Em aberto', 'Concluídas', 'Canceladas', 'Dias médios até concluir'],
    ...[...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'pt-BR'))
      .map(([key, items]) => {
        const done = items.filter((item) => item.concluida_em && !cancelledStatuses.has(item.status))
        const average = done.length
          ? Math.round((done.reduce((sum, item) => sum + (item.concluida_em!.getTime() - item.created_at.getTime()), 0) / done.length / day) * 10) / 10
          : null
        return [
          key,
          items.length,
          items.filter((item) => !closedStatuses.has(item.status)).length,
          items.filter((item) => item.status === 'concluido' || item.status === 'emitida').length,
          items.filter((item) => cancelledStatuses.has(item.status)).length,
          average,
        ]
      }),
  ]
}

function monthly(rows: readonly { created_at: Date; concluida_em: Date | null; status: string }[]): Sheet['rows'] {
  const month = (date: Date) => date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', month: '2-digit', year: 'numeric' })
  const opened = new Map<string, number>()
  const done = new Map<string, number>()
  for (const row of rows) {
    opened.set(month(row.created_at), (opened.get(month(row.created_at)) ?? 0) + 1)
    if (row.concluida_em && !cancelledStatuses.has(row.status)) done.set(month(row.concluida_em), (done.get(month(row.concluida_em)) ?? 0) + 1)
  }
  const keys = [...new Set([...opened.keys(), ...done.keys()])].sort((a, b) => a.split('/').reverse().join('').localeCompare(b.split('/').reverse().join('')))
  return [['Mês', 'Abertas', 'Concluídas'], ...keys.map((key) => [key, opened.get(key) ?? 0, done.get(key) ?? 0])]
}

// ---------------------------------------------------------------------------
// Manutenção
// ---------------------------------------------------------------------------

export async function maintenanceWorkbook(
  identity: AuthenticatedIdentity,
  period: SpreadsheetPeriod,
  generatedBy: string,
  poolProvider: () => Pool = getDatabasePool,
): Promise<Sheet[]> {
  const pool = poolProvider()
  const rows = await loadRequests(pool, identity, { from: period.from, to: period.to, modules: ['maintenance'] })
  const seesAll = holdsPermission(identity, 'requests:read_all')
  const executions =
    seesAll && (await tableExists(pool, 'maintenance_executions')) && rows.length > 0
      ? (await pool.query<{
          protocolo: string
          executado_em: Date
          executado_por: string
          equipamento: string | null
          servico_realizado: string
          pendencias: string | null
        }>(
          `SELECT ${protocolSql('r')} AS protocolo, e.executado_em, e.executado_por,
                  ${(await tableExists(pool, 'equipments')) ? 'eq.nome' : 'NULL::text'} AS equipamento,
                  e.servico_realizado, e.pendencias
             FROM public.maintenance_executions e
             JOIN public.service_requests r ON r.id = e.request_id
             ${(await tableExists(pool, 'equipments')) ? 'LEFT JOIN public.equipments eq ON eq.id = e.equipment_id' : ''}
            WHERE e.request_id = ANY($1::uuid[])
            ORDER BY e.executado_em`,
          [rows.map((row) => row.id)],
        )).rows
      : null

  const sheets: Sheet[] = [
    periodSheet('Manutenção: solicitações, prazos e execução', period, generatedBy, [
      'Solicitações abertas no período.',
      'Dias até concluir: da abertura à conclusão. Tempo de execução: do início ao fim real registrados.',
      ...(seesAll ? [] : ['Você vê só as solicitações abertas por você.']),
    ]),
    {
      name: 'Solicitações',
      rows: [
        ['Protocolo', 'Aberta em', 'Situação', 'Setor', 'Andar', 'Sala', 'Local do serviço', 'Tipo de serviço', 'Prioridade',
          'Complexidade', 'Solicitante', 'Responsável', 'Prazo', 'Agendada para', 'Início real', 'Fim real',
          'Tempo de execução (h:min)', 'Concluída em', 'Dias até concluir', 'Dentro do prazo', 'Motivo do cancelamento'],
        ...rows.map((row) => {
          const minutes = minutesBetween(row.execucao_inicio, row.execucao_fim)
          return [
            row.protocolo, dateTime(row.created_at), statusLabels[row.status] ?? row.status, row.setor_nome, row.andar_nome,
            text(row.dados.sala), text(row.dados.localServico), row.tipo_servico_nome,
            priorityLabels[row.prioridade ?? ''] ?? row.prioridade, complexityLabels[row.complexidade ?? ''] ?? row.complexidade,
            row.solicitante, row.responsavel, dateTime(row.prazo_em), dateTime(row.data_agendada), dateTime(row.execucao_inicio),
            dateTime(row.execucao_fim), minutes === null ? null : formatHours(minutes), dateTime(row.concluida_em),
            daysBetween(row.created_at, row.concluida_em),
            row.prazo_em && row.concluida_em ? (row.concluida_em <= row.prazo_em ? 'Sim' : 'Não') : null,
            row.motivo_cancelamento,
          ]
        }),
      ],
    },
    { name: 'Por tipo de serviço', rows: grouped(rows, (row) => row.tipo_servico_nome, 'Tipo de serviço') },
    { name: 'Por setor', rows: grouped(rows, (row) => row.setor_nome, 'Setor') },
    { name: 'Por andar', rows: grouped(rows, (row) => row.andar_nome, 'Andar') },
    { name: 'Evolução mensal', rows: monthly(rows) },
  ]
  if (executions) {
    sheets.push({
      name: 'Execuções',
      rows: [
        ['Protocolo', 'Executado em', 'Executado por', 'Equipamento', 'Serviço realizado', 'Pendências'],
        ...executions.map((row) => [row.protocolo, dateTime(row.executado_em), row.executado_por, row.equipamento, row.servico_realizado, row.pendencias]),
      ],
    })
  }
  return sheets
}

// ---------------------------------------------------------------------------
// Passagens aéreas
// ---------------------------------------------------------------------------

type Leg = { origem?: string; destino?: string; data?: string; horario?: string }
const legDate = (leg: Leg | undefined): Cell =>
  leg?.data ? `${leg.data.split('-').reverse().join('/')}${leg.horario ? ` ${leg.horario}` : ''}` : null
const legRoute = (leg: Leg | undefined): Cell => (leg?.origem || leg?.destino ? `${leg?.origem ?? '?'} → ${leg?.destino ?? '?'}` : null)

export async function flightsWorkbook(
  identity: AuthenticatedIdentity,
  period: SpreadsheetPeriod,
  generatedBy: string,
  poolProvider: () => Pool = getDatabasePool,
): Promise<Sheet[]> {
  const pool = poolProvider()
  const rows = await loadRequests(pool, identity, { from: period.from, to: period.to, modules: ['flights'] })
  const ids = rows.map((row) => row.id)
  const passengers = new Map<string, number>()
  if (ids.length && (await tableExists(pool, 'flight_request_passengers'))) {
    const counted = await pool.query<{ request_id: string; total: number }>(
      `SELECT request_id::text AS request_id, count(*)::int AS total FROM public.flight_request_passengers
        WHERE request_id = ANY($1::uuid[]) GROUP BY request_id`,
      [ids],
    )
    for (const row of counted.rows) passengers.set(row.request_id, row.total)
  }
  // Cotação escolhida: valor e companhia, para quem atende (o solicitante não vê cotações).
  const quotes = new Map<string, { companhia: string; valor: string }>()
  const seesQuotes = holdsPermission(identity, 'flights:update')
  if (ids.length && seesQuotes && (await tableExists(pool, 'flight_quotes'))) {
    const selected = await pool.query<{ request_id: string; companhia: string; valor: string }>(
      `SELECT request_id::text AS request_id, companhia, valor FROM public.flight_quotes
        WHERE selecionada AND request_id = ANY($1::uuid[])`,
      [ids],
    )
    for (const row of selected.rows) quotes.set(row.request_id, row)
  }

  const quoted = rows.filter((row) => quotes.has(row.id) && row.status !== 'cancelada')
  const sheets: Sheet[] = [
    periodSheet('Passagens aéreas: solicitações, trechos e valores', period, generatedBy, [
      'Solicitações abertas no período.',
      'Passageiros: só a quantidade. Nomes e CPFs nunca entram na planilha.',
      ...(seesQuotes ? ['Valor: a cotação escolhida, quando registrada.'] : []),
      ...(holdsPermission(identity, 'requests:read_all') ? [] : ['Você vê só as solicitações abertas por você.']),
    ]),
    {
      name: 'Solicitações',
      rows: [
        ['Protocolo', 'Aberta em', 'Situação', 'Setor', 'Solicitante', 'Responsável', 'Tipo de viagem', 'Trecho de ida', 'Data da ida',
          'Trecho de volta', 'Data da volta', 'Passageiros', 'Bagagem', ...(seesQuotes ? ['Companhia', 'Valor (R$)'] : []),
          'Emitida em', 'Dias até emitir', 'Motivo do cancelamento'],
        ...rows.map((row) => {
          const ida = row.dados.ida as Leg | undefined
          const volta = row.dados.volta as Leg | undefined
          const quote = quotes.get(row.id)
          const issued = row.status === 'emitida' ? row.concluida_em : null
          return [
            row.protocolo, dateTime(row.created_at), statusLabels[row.status] ?? row.status, row.setor_nome, row.solicitante, row.responsavel,
            tripLabels[String(row.dados.tipoViagem)] ?? text(row.dados.tipoViagem), legRoute(ida), legDate(ida), legRoute(volta), legDate(volta),
            passengers.get(row.id) ?? null, text(row.dados.bagagem),
            ...(seesQuotes ? [quote?.companhia ?? null, number(quote?.valor ?? null)] : []),
            dateTime(issued), daysBetween(row.created_at, issued), row.motivo_cancelamento,
          ]
        }),
        ...(seesQuotes
          ? [[], ['Total das cotações escolhidas (não canceladas)', ...Array(12).fill(null), null, quoted.reduce((sum, row) => sum + Number(quotes.get(row.id)!.valor), 0)]]
          : []),
      ],
    },
    { name: 'Por setor', rows: grouped(rows, (row) => row.setor_nome, 'Setor') },
    {
      name: 'Por destino',
      rows: grouped(rows, (row) => ((row.dados.ida as Leg | undefined)?.destino ?? (row.dados.volta as Leg | undefined)?.destino) || null, 'Destino'),
    },
    { name: 'Evolução mensal', rows: monthly(rows) },
  ]
  return sheets
}

// ---------------------------------------------------------------------------
// Geral (tela Relatórios)
// ---------------------------------------------------------------------------

export async function generalWorkbook(
  identity: AuthenticatedIdentity,
  filters: RequestFilters,
  generatedBy: string,
  poolProvider: () => Pool = getDatabasePool,
): Promise<Sheet[]> {
  const pool = poolProvider()
  const rows = await loadRequests(pool, identity, filters)
  const modules = readableRequestModules(identity, filters.modules)
  const brasiliaDay = (date: Date) => date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  const periodText =
    filters.from && filters.to
      ? `${brasiliaDay(filters.from)} a ${brasiliaDay(new Date(filters.to.getTime() - 1))}`
      : filters.from
        ? `a partir de ${brasiliaDay(filters.from)}`
        : filters.to
          ? `até ${brasiliaDay(new Date(filters.to.getTime() - 1))}`
          : 'Todo o período'

  const overdue = rows.filter((row) => row.prazo_em && !closedStatuses.has(row.status) && row.prazo_em.getTime() < Date.now())
  const finished = rows.filter((row) => row.concluida_em && !cancelledStatuses.has(row.status))
  const executed = rows.map((row) => minutesBetween(row.execucao_inicio, row.execucao_fim)).filter((value): value is number => value !== null)

  return [
    {
      name: 'Sobre',
      rows: [
        ['Relatório geral de solicitações'],
        ['Período', periodText],
        ['Módulos', modules.map((module) => moduleLabels[module]).join(', ') || 'Nenhum'],
        ['Situação', filters.status ? statusLabels[filters.status] ?? filters.status : 'Todas'],
        ['Gerado em', dateTime(new Date())],
        ['Gerado por', generatedBy],
        [],
        ['Os filtros são os da tela Relatórios no momento do download.'],
        ['O Almoxarifado e a Frota têm planilhas próprias, mais detalhadas, nas telas de cada módulo.'],
        ...(holdsPermission(identity, 'requests:read_all') ? [] : [['Você vê só as solicitações abertas por você.']]),
      ],
    },
    {
      name: 'Indicadores',
      rows: [
        ['Indicador', 'Valor'],
        ['Solicitações', rows.length],
        ['Em aberto', rows.filter((row) => !closedStatuses.has(row.status)).length],
        ['Concluídas ou emitidas', rows.filter((row) => row.status === 'concluido' || row.status === 'emitida').length],
        ['Canceladas', rows.filter((row) => cancelledStatuses.has(row.status)).length],
        ['Atrasadas (prazo vencido, ainda em aberto)', overdue.length],
        ['Dias médios até concluir', finished.length
          ? Math.round((finished.reduce((sum, row) => sum + (row.concluida_em!.getTime() - row.created_at.getTime()), 0) / finished.length / day) * 10) / 10
          : null],
        ['Tempo médio de execução (h:min)', executed.length ? formatHours(executed.reduce((sum, value) => sum + value, 0) / executed.length) : null],
      ],
    },
    { name: 'Por módulo', rows: grouped(rows, (row) => moduleLabels[row.module], 'Módulo') },
    {
      name: 'Por situação',
      rows: [
        ['Módulo', 'Situação', 'Total'],
        ...Object.entries(
          rows.reduce<Record<string, number>>((acc, row) => {
            const key = `${moduleLabels[row.module]}|${statusLabels[row.status] ?? row.status}`
            acc[key] = (acc[key] ?? 0) + 1
            return acc
          }, {}),
        )
          .sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'))
          .map(([key, total]) => [...key.split('|'), total]),
      ],
    },
    { name: 'Por setor', rows: grouped(rows, (row) => row.setor_nome, 'Setor') },
    { name: 'Por responsável', rows: grouped(rows, (row) => row.responsavel, 'Responsável') },
    { name: 'Evolução mensal', rows: monthly(rows) },
    {
      name: 'Atrasadas',
      rows: [
        ['Módulo', 'Protocolo', 'Título', 'Setor', 'Responsável', 'Prazo', 'Dias de atraso', 'Situação'],
        ...overdue
          .sort((a, b) => a.prazo_em!.getTime() - b.prazo_em!.getTime())
          .map((row) => [
            moduleLabels[row.module], row.protocolo, row.module === 'flights' ? null : row.titulo, row.setor_nome, row.responsavel,
            dateTime(row.prazo_em), Math.floor((Date.now() - row.prazo_em!.getTime()) / day), statusLabels[row.status] ?? row.status,
          ]),
      ],
    },
    {
      name: 'Solicitações',
      rows: [
        ['Módulo', 'Protocolo', 'Título', 'Aberta em', 'Situação', 'Setor', 'Solicitante', 'Responsável', 'Prioridade', 'Prazo',
          'Agendada para', 'Concluída em', 'Dias até concluir'],
        ...rows.map((row) => [
          // Em Passagens, o título repete o trecho pedido; fica de fora como no restante do sistema.
          moduleLabels[row.module], row.protocolo, row.module === 'flights' ? null : row.titulo, dateTime(row.created_at),
          statusLabels[row.status] ?? row.status, row.setor_nome, row.solicitante, row.responsavel,
          priorityLabels[row.prioridade ?? ''] ?? row.prioridade, dateTime(row.prazo_em), dateTime(row.data_agendada),
          dateTime(row.concluida_em), cancelledStatuses.has(row.status) ? null : daysBetween(row.created_at, row.concluida_em),
        ]),
      ],
    },
  ]
}
