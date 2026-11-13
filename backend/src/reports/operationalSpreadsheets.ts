import type { Pool } from 'pg'
import { holdsPermission } from '../auth/permissions.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { journeyOf } from '../requests/driverPortalRules.js'
import { normalizeStatus } from '../requests/workflow.js'
import { ModuleExtensionsRepository } from '../database/moduleExtensionsRepository.js'
import { getDatabasePool } from '../database/pool.js'
import { WarehouseFinanceRepository } from '../database/warehouseFinanceRepository.js'
import { protocolSql } from '../database/protocolSql.js'
import { readSystemSettings } from '../database/settingsRepository.js'
import { formatHours, workloadByDay, workloadSummary } from './driverWorkload.js'
import type { Cell, Sheet } from './xlsxDocument.js'

/**
 * Planilhas do Almoxarifado e da Frota (11/11/2026). Só leitura: nada é gravado além do registro
 * da exportação na auditoria, feito pela rota. Datas no horário de Brasília; números continuam
 * numéricos, para somar no Excel.
 */

export type SpreadsheetPeriod = { from: Date; to: Date }

const brasilia = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
const brasiliaDay = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

export const dateTime = (value: Date | string | null | undefined): Cell =>
  value ? brasilia.format(new Date(value)) : null
const dayOnly = (value: string): Cell => {
  const [year, month, day] = value.split('-')
  return `${day}/${month}/${year}`
}
export const number = (value: string | number | null | undefined): Cell =>
  value === null || value === undefined || value === '' ? null : Number(value)

const warehouseStatusLabels: Record<string, string> = {
  pendente: 'Pendente',
  em_analise: 'Em análise',
  atendido_parcial: 'Atendido parcialmente',
  atendido: 'Atendido',
  entregue: 'Entregue',
  rejeitado: 'Rejeitado',
  cancelado: 'Cancelado',
}
const operationalStatusLabels: Record<string, string> = {
  aguardando_agendamento: 'Aguardando agendamento',
  agendado: 'Agendado',
  reagendado: 'Reagendado',
  em_andamento: 'Em andamento',
  concluido: 'Concluído',
  cancelado: 'Cancelado',
}
const movementLabels: Record<string, string> = { entrada: 'Entrada', saida: 'Saída' }

export function periodSheet(title: string, period: SpreadsheetPeriod, generatedBy: string, notes: string[]): Sheet {
  return {
    name: 'Sobre',
    rows: [
      [title],
      ['Período', `${brasiliaDay.format(period.from)} a ${brasiliaDay.format(new Date(period.to.getTime() - 1))}`],
      ['Gerado em', dateTime(new Date())],
      ['Gerado por', generatedBy],
      [],
      ...notes.map((note) => [note]),
    ],
  }
}

export async function tableExists(pool: Pool, table: string) {
  const result = await pool.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${table}`])
  return result.rows[0].present
}

// ---------------------------------------------------------------------------
// Almoxarifado
// ---------------------------------------------------------------------------

export async function warehouseWorkbook(
  period: SpreadsheetPeriod,
  generatedBy: string,
  poolProvider: () => Pool = getDatabasePool,
  /** Só para quem tem warehouse:finance: custo médio, valor do estoque e as abas financeiras. */
  withValues = false,
): Promise<Sheet[]> {
  const pool = poolProvider()
  const stock = await new ModuleExtensionsRepository(poolProvider).stock({ search: '', belowMinimum: false, withValues })
  const financial = withValues ? await new WarehouseFinanceRepository(poolProvider).spreadsheetRows(period) : null

  const requests = await pool.query<{
    protocolo: string
    created_at: Date
    status: string
    origem: string | null
    setor: string | null
    solicitante: string | null
    itens: number
    solicitada: string | null
    atendida: string | null
    entregue_em: Date | null
  }>(
    `SELECT ${protocolSql('r')} AS protocolo, r.created_at, r.status, to_jsonb(r)->>'origem' AS origem,
            COALESCE(to_jsonb(r)->>'setor_nome', s.nome) AS setor,
            COALESCE(u.full_name, to_jsonb(r)->>'solicitante_externo') AS solicitante,
            count(i.id)::int AS itens, sum(i.quantidade_solicitada) AS solicitada, sum(i.quantidade_atendida) AS atendida,
            (to_jsonb(r)->>'entregue_em')::timestamptz AS entregue_em
       FROM public.material_requests r
       LEFT JOIN public.setores s ON s.id = r.setor_id
       LEFT JOIN public.auth_users u ON u.id = r.solicitante_id
       LEFT JOIN public.material_request_items i ON i.material_request_id = r.id
      WHERE r.created_at >= $1 AND r.created_at < $2
      GROUP BY r.id, s.nome, u.full_name
      ORDER BY r.created_at, r.id`,
    [period.from, period.to],
  )

  const delivered = await pool.query<{
    protocolo: string
    entregue_em: Date | null
    setor: string | null
    material: string
    unidade: string | null
    solicitada: string
    atendida: string
  }>(
    `SELECT ${protocolSql('r')} AS protocolo, COALESCE((to_jsonb(r)->>'entregue_em')::timestamptz, r.updated_at) AS entregue_em,
            COALESCE(to_jsonb(r)->>'setor_nome', s.nome) AS setor,
            COALESCE(to_jsonb(i)->>'material_nome', m.nome) AS material,
            COALESCE(to_jsonb(i)->>'unidade', m.unidade) AS unidade,
            i.quantidade_solicitada AS solicitada, i.quantidade_atendida AS atendida
       FROM public.material_request_items i
       JOIN public.material_requests r ON r.id = i.material_request_id
       JOIN public.materials m ON m.id = i.material_id
       LEFT JOIN public.setores s ON s.id = r.setor_id
      WHERE r.status = 'entregue'
        AND COALESCE((to_jsonb(r)->>'entregue_em')::timestamptz, r.updated_at) >= $1
        AND COALESCE((to_jsonb(r)->>'entregue_em')::timestamptz, r.updated_at) < $2
      ORDER BY 2, 1, 4`,
    [period.from, period.to],
  )

  const movements = await pool.query<{
    created_at: Date
    material: string
    unidade: string
    tipo: string
    quantidade: string
    motivo: string | null
    usuario: string | null
  }>(
    `SELECT s.created_at, m.nome AS material, m.unidade, s.tipo, s.quantidade, s.motivo, u.full_name AS usuario
       FROM public.stock_movements s
       JOIN public.materials m ON m.id = s.material_id
       LEFT JOIN public.auth_users u ON u.id = s.usuario_id
      WHERE s.created_at >= $1 AND s.created_at < $2
      ORDER BY s.created_at, s.id`,
    [period.from, period.to],
  )

  const sheets: Sheet[] = [
    periodSheet('Almoxarifado: estoque, pedidos e entregas', period, generatedBy, [
      'Estoque: situação de agora, sem filtro de período.',
      ...(financial
        ? ['Valores: custo médio ponderado. Entradas pelo valor pago; saídas e entregas pelo custo médio do momento. Compras e consumo: só o período informado.']
        : []),
      'Consumo médio por mês: quantidades entregues nos pedidos dos últimos 12 meses (ou desde a primeira entrega, se for mais recente), divididas pelos meses da base.',
      'Pedidos, Itens entregues e Movimentações: só o período informado.',
      'O saldo é o controle interno do sistema e não substitui o sistema governamental.',
    ]),
    {
      name: 'Estoque',
      rows: [
        ['Código', 'Material', 'Localização', 'Unidade', 'Estoque físico', 'Reservado', 'Disponível', 'Mínimo', 'Abaixo do mínimo',
          'Consumo médio por mês', 'Base do consumo (meses)', 'Entregue nos últimos 12 meses', 'Fornecido (total)', 'Última movimentação',
          ...(financial ? ['Custo médio (R$)', 'Valor em estoque (R$)'] : [])],
        ...stock.map((item) => [
          item.code, item.name, item.location, item.unit, item.current, item.reserved, item.available,
          item.minimum > 0 ? item.minimum : null, item.belowMinimum ? 'Sim' : 'Não',
          item.monthlyConsumption.average, item.monthlyConsumption.months, item.monthlyConsumption.total,
          item.provided, dateTime(item.lastMovement),
          ...(financial ? [item.averageCost ?? null, item.stockValue ?? null] : []),
        ]),
      ],
    },
    {
      name: 'Pedidos',
      rows: [
        ['Protocolo', 'Aberto em', 'Situação', 'Origem', 'Setor', 'Solicitante', 'Itens', 'Quantidade solicitada', 'Quantidade atendida', 'Entregue em'],
        ...requests.rows.map((row) => [
          row.protocolo, dateTime(row.created_at), warehouseStatusLabels[row.status] ?? row.status,
          row.origem === 'governamental' ? 'Governamental' : 'Interna', row.setor, row.solicitante,
          row.itens, number(row.solicitada), number(row.atendida), dateTime(row.entregue_em),
        ]),
      ],
    },
    {
      name: 'Itens entregues',
      rows: [
        ['Protocolo', 'Entregue em', 'Setor', 'Material', 'Unidade', 'Solicitado', 'Atendido'],
        ...delivered.rows.map((row) => [
          row.protocolo, dateTime(row.entregue_em), row.setor, row.material, row.unidade, number(row.solicitada), number(row.atendida),
        ]),
      ],
    },
    {
      name: 'Movimentações',
      rows: [
        ['Data', 'Material', 'Unidade', 'Tipo', 'Quantidade', 'Justificativa', 'Registrado por'],
        ...movements.rows.map((row) => [
          dateTime(row.created_at), row.material, row.unidade, movementLabels[row.tipo] ?? row.tipo, number(row.quantidade), row.motivo, row.usuario,
        ]),
      ],
    },
  ]
  if (!financial) return sheets
  const summary = financial.summary
  return [
    ...sheets,
    {
      name: 'Financeiro',
      rows: [
        ['Indicador', 'Valor (R$)'],
        ['Valor total em estoque (agora)', summary.stockValue],
        ['Compras no período', summary.purchases],
        ['Consumo no período (saídas)', summary.consumption],
        ['Atas vigentes: valor', summary.agreementsTotal],
        ['Atas vigentes: gasto', summary.agreementsSpent],
        ['Atas vigentes: saldo', summary.agreementsBalance],
        ['Materiais com saldo e sem valor informado', summary.materialsWithoutValue],
        [],
        ['Mês', 'Compras (R$)', 'Consumo (R$)'],
        ...summary.monthly.map((row) => [row.month.split('-').reverse().join('/'), row.purchases, row.consumption]),
        [],
        ['Consumo por setor', 'Valor (R$)', 'Pedidos'],
        ...summary.bySector.map((row) => [row.sector, row.value, row.requests]),
      ],
    },
    {
      name: 'Atas',
      rows: [
        ['Número', 'Fornecedor', 'Objeto', 'Início', 'Fim', 'Situação', 'Valor (R$)', 'Gasto (R$)', 'Saldo (R$)', 'Usado (%)', 'Entradas'],
        ...summary.agreements.map((row) => [
          row.number, row.supplier, row.subject, row.validFrom ? dayOnly(row.validFrom) : null, row.validUntil ? dayOnly(row.validUntil) : null,
          agreementLabels[row.situation], row.total, row.spent, row.balance, row.usedPercent, row.entries,
        ]),
      ],
    },
    {
      name: 'Entradas com valor',
      rows: [
        ['Data', 'Material', 'Unidade', 'Quantidade', 'Valor total (R$)', 'Valor por unidade (R$)', 'Valor digitado', 'Nota fiscal', 'Empenho', 'Fornecedor', 'Ata', 'Registrado por'],
        ...financial.entries.map((row) => [
          dateTime(row.at), row.material, row.unit, row.quantity, row.value,
          row.value !== null && row.quantity > 0 ? Math.round((row.value / row.quantity) * 100) / 100 : null,
          row.informed ? 'Sim' : 'Não (custo médio)', row.invoice, row.commitment, row.supplier, row.agreement, row.user,
        ]),
      ],
    },
    {
      name: 'Saídas com valor',
      rows: [
        ['Data', 'Material', 'Unidade', 'Quantidade', 'Custo (R$)', 'Pedido', 'Setor'],
        ...financial.exits.map((row) => [dateTime(row.at), row.material, row.unit, row.quantity, row.value, row.protocol, row.sector]),
      ],
    },
  ]
}

const agreementLabels: Record<string, string> = { vigente: 'Vigente', futura: 'Ainda não vigente', vencida: 'Vencida', encerrada: 'Encerrada' }

// ---------------------------------------------------------------------------
// Frota
// ---------------------------------------------------------------------------

type ExecutionRecord = {
  inicio?: { hodometro?: number; veiculo?: string }
  fim?: { hodometro?: number }
}

export async function fleetWorkbook(
  identity: AuthenticatedIdentity,
  period: SpreadsheetPeriod,
  generatedBy: string,
  poolProvider: () => Pool = getDatabasePool,
): Promise<Sheet[]> {
  const pool = poolProvider()
  const hasDrivers = await tableExists(pool, 'fleet_drivers')
  const seesAll = holdsPermission(identity, 'requests:read_all')
  const parameters: unknown[] = [period.from, period.to]
  const ownOnly = seesAll ? '' : `AND r.solicitante_id = $${parameters.push(identity.userId)}`

  // A viagem entra pelo início real e, se ainda não começou, pela data agendada ou pedida.
  const when = `COALESCE(r.execucao_inicio, r.data_agendada, r.created_at)`
  const trips = await pool.query<{
    id: string
    protocolo: string
    status: string
    quando: Date
    data_agendada: Date | null
    origem: string | null
    destino: string | null
    finalidade: string | null
    setor: string | null
    veiculo: string | null
    motorista_id: string | null
    motorista: string | null
    execucao_inicio: Date | null
    execucao_fim: Date | null
    registro: ExecutionRecord | null
  }>(
    `SELECT r.id::text AS id, ${protocolSql('r')} AS protocolo, r.status, ${when} AS quando, r.data_agendada,
            r.dados->>'origem' AS origem, r.dados->>'destino' AS destino, r.dados->>'finalidade' AS finalidade,
            r.setor_nome AS setor, r.dados->>'veiculo' AS veiculo,
            ${hasDrivers ? `d.id::text AS motorista_id, d.nome AS motorista,` : `NULL::text AS motorista_id, NULL::text AS motorista,`}
            r.execucao_inicio, r.execucao_fim, to_jsonb(r)->'execucao_registro' AS registro
       FROM public.service_requests r
       ${hasDrivers ? `LEFT JOIN public.fleet_drivers d ON d.id::text = to_jsonb(r)->>'motorista_id'` : ''}
      WHERE r.tipo = 'frota'
        AND ${when} >= $1 AND ${when} < $2
        ${ownOnly}
      ORDER BY ${when}, r.id`,
    parameters,
  )

  const tripRows = trips.rows.map((row) => {
    const start = row.registro?.inicio?.hodometro
    const end = row.registro?.fim?.hodometro
    const kilometers = typeof start === 'number' && typeof end === 'number' && end >= start ? end - start : null
    const minutes =
      row.execucao_inicio && row.execucao_fim
        ? Math.max(0, Math.round((row.execucao_fim.getTime() - row.execucao_inicio.getTime()) / 60_000))
        : null
    return { row, start, end, kilometers, minutes }
  })

  // Diário de bordo dos veículos (migração 009): uso, abastecimento e manutenção, com a quilometragem.
  const vehicles = (await tableExists(pool, 'vehicle_logs')) && holdsPermission(identity, 'fleet:update')
    ? (await pool.query<{
        placa: string
        modelo: string | null
        usos: number
        km: string | null
        abastecimentos: number
        litros: string | null
        valor: string | null
        manutencoes: number
        ocorrencias: number
        km_atual: number
      }>(
        `SELECT v.placa, to_jsonb(v)->>'modelo' AS modelo,
                count(l.id) FILTER (WHERE l.tipo = 'utilizacao')::int AS usos,
                sum(l.km_final - l.km_inicial) FILTER (WHERE l.tipo = 'utilizacao') AS km,
                count(l.id) FILTER (WHERE l.tipo = 'abastecimento')::int AS abastecimentos,
                sum(l.litros) AS litros, sum(l.valor) AS valor,
                count(l.id) FILTER (WHERE l.tipo = 'manutencao')::int AS manutencoes,
                count(l.id) FILTER (WHERE l.tipo = 'ocorrencia')::int AS ocorrencias,
                v.km_atual
           FROM public.vehicles v
           LEFT JOIN public.vehicle_logs l ON l.vehicle_id = v.id AND l.data_registro >= $1 AND l.data_registro < $2
          GROUP BY v.id
          ORDER BY lower(v.placa)`,
        [period.from, period.to],
      )).rows
    : null

  const sheets: Sheet[] = [
    periodSheet('Frota: viagens, quilometragem e carga horária', period, generatedBy, [
      'Viagens: pelo início real ou, se ainda não começou, pela data agendada ou, sem agendamento, pela data do pedido.',
      'Km rodados: hodômetro final menos o inicial, quando o motorista informou os dois no portal.',
      'Veículos: diário de bordo do período (utilização, abastecimento, manutenção e ocorrências).',
      ...(hasDrivers && holdsPermission(identity, 'fleet:manage')
        ? [
            'Carga horária: ESTIMATIVA a partir das viagens (os motoristas não batem ponto no sistema).',
            'Jornada do dia = da primeira saída à última chegada, menos o intervalo; nunca menos que o tempo em viagem.',
            'Horas extras = acima da jornada prevista em Configurações; em dia fora da jornada, tudo é extra.',
            'Horas a menos = abaixo da jornada prevista, só nos dias com viagem. Dias sem viagem não entram.',
          ]
        : []),
    ]),
    {
      name: 'Viagens',
      rows: [
        ['Protocolo', 'Data', 'Situação', 'Origem', 'Destino', 'Finalidade', 'Setor', 'Motorista', 'Veículo',
          'Início real', 'Fim real', 'Duração (h:min)', 'Hodômetro inicial', 'Hodômetro final', 'Km rodados'],
        ...tripRows.map(({ row, start, end, kilometers, minutes }) => [
          row.protocolo, dateTime(row.quando), operationalStatusLabels[normalizeStatus('fleet', row.status)] ?? row.status,
          row.origem, row.destino, row.finalidade, row.setor, row.motorista,
          row.registro?.inicio?.veiculo ?? row.veiculo, dateTime(row.execucao_inicio), dateTime(row.execucao_fim),
          minutes === null ? null : formatHours(minutes), start ?? null, end ?? null, kilometers,
        ]),
        [],
        ['Total', null, null, null, null, null, null, null, null, null, null,
          formatHours(tripRows.reduce((sum, item) => sum + (item.minutes ?? 0), 0)), null, null,
          tripRows.reduce((sum, item) => sum + (item.kilometers ?? 0), 0)],
      ],
    },
  ]

  if (vehicles) {
    sheets.push({
      name: 'Veículos',
      rows: [
        ['Placa', 'Modelo', 'Utilizações', 'Km rodados', 'Abastecimentos', 'Litros', 'Valor (R$)', 'Manutenções', 'Ocorrências', 'Km atual'],
        ...vehicles.map((row) => [
          row.placa, row.modelo, row.usos, number(row.km), row.abastecimentos, number(row.litros), number(row.valor),
          row.manutencoes, row.ocorrencias, row.km_atual,
        ]),
      ],
    })
  }

  // Horas dos motoristas: dado de pessoal, só para quem administra a Frota (cadastro de motoristas).
  if (hasDrivers && holdsPermission(identity, 'fleet:manage')) {
    const settings = await readSystemSettings(pool)
    const journey = journeyOf(settings)
    const holidays = settings.holidays.list.map((item) => item.date)
    const days = workloadByDay(
      tripRows
        .filter(({ row }) => row.motorista_id && row.motorista)
        .map(({ row }) => ({
          driverId: row.motorista_id!,
          driverName: row.motorista!,
          startedAt: row.execucao_inicio,
          finishedAt: row.execucao_fim,
        })),
      journey,
      holidays,
    )
    const weekdayNames = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
    const journeyText = `${journey.weekdays.map((day) => weekdayNames[day]).join(', ')}, das ${journey.start} às ${journey.end}, intervalo de ${journey.breakMinutes} min`
    sheets.push(
      {
        name: 'Carga horária',
        rows: [
          ['Jornada de referência', journeyText],
          [],
          ['Motorista', 'Dias com viagem', 'Viagens', 'Tempo em viagem', 'Em viagem fora do horário', 'Jornada estimada',
            'Jornada prevista', 'Horas extras', 'Horas a menos', 'Saldo'],
          ...workloadSummary(days).map((driver) => [
            driver.driverName, driver.days, driver.trips, formatHours(driver.tripMinutes), formatHours(driver.outsideJourneyMinutes),
            formatHours(driver.workedMinutes), formatHours(driver.expectedMinutes), formatHours(driver.extraMinutes),
            formatHours(driver.missingMinutes), formatHours(driver.balanceMinutes),
          ]),
        ],
      },
      {
        name: 'Carga horária por dia',
        rows: [
          ['Motorista', 'Dia', 'Viagens', 'Primeira saída', 'Última chegada', 'Tempo em viagem', 'Em viagem fora do horário',
            'Jornada estimada', 'Jornada prevista', 'Horas extras', 'Horas a menos'],
          ...days.map((day) => [
            day.driverName, dayOnly(day.day), day.trips, dateTime(day.firstStart), dateTime(day.lastFinish),
            formatHours(day.tripMinutes), formatHours(day.outsideJourneyMinutes), formatHours(day.workedMinutes),
            formatHours(day.expectedMinutes), formatHours(day.extraMinutes), formatHours(day.missingMinutes),
          ]),
        ],
      },
    )
  }
  return sheets
}
