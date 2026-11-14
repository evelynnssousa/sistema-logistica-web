import type { Pool } from 'pg'
import { notifyDemand } from '../demands/demandNotifications.js'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'
import { nextDemandNumber, recordDemandHistory, todayInSaoPaulo } from './demandSeriesRepository.js'
import { getDatabasePool } from './pool.js'
import { readSystemSettings } from './settingsRepository.js'
import { withTransaction } from './withTransaction.js'

/**
 * Guarda dos dados (LGPD, 14/11/2026). A instituição guarda solicitações, CPFs de passageiros, anexos
 * e auditoria por 1 ano (Configurações → Sistema → Guarda dos dados). Para cada mês de registros, a
 * antecedência configurada antes de completar o prazo, abre uma demanda no setor escolhido para
 * imprimir ou salvar os relatórios e planilhas daquele mês. Nada é apagado aqui: só o aviso.
 * Uma demanda por mês, controlada pelo histórico da própria demanda (acao "guarda_dados_gerada").
 */

const sources: { table: string; label: string; where?: string }[] = [
  { table: 'service_requests', label: 'Manutenção', where: `tipo = 'manutencao'` },
  { table: 'service_requests', label: 'Frota', where: `tipo = 'frota'` },
  { table: 'service_requests', label: 'Passagens aéreas', where: `tipo = 'passagem'` },
  { table: 'material_requests', label: 'Pedidos de materiais' },
  { table: 'flight_request_passengers', label: 'Passageiros com CPF' },
  { table: 'request_attachments', label: 'Anexos' },
  { table: 'demands', label: 'Demandas' },
  { table: 'auth_audit_events', label: 'Registros de auditoria' },
]

const monthNames = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

/** "2025-11" → "novembro de 2025". */
export const monthLabel = (month: string) => `${monthNames[Number(month.slice(5, 7)) - 1]} de ${month.slice(0, 4)}`

/** Primeiro dia do mês, "months" meses depois: o dia em que o mês inteiro completa o prazo. */
export function retentionDeadline(month: string, months: number) {
  const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + months, 1))
  return date.toISOString().slice(0, 10)
}

/** Último mês de registros cujo aviso já deve existir: (hoje + antecedência) menos o prazo. */
export function lastDueMonth(today: string, months: number, noticeDays: number) {
  const ahead = new Date(`${today}T12:00:00Z`)
  ahead.setUTCDate(ahead.getUTCDate() + noticeDays)
  const shifted = new Date(Date.UTC(ahead.getUTCFullYear(), ahead.getUTCMonth() - months, 1))
  return shifted.toISOString().slice(0, 7)
}

async function existingSources(pool: Pick<Pool, 'query'>) {
  const tables = [...new Set(sources.map((item) => item.table))]
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'created_at' AND table_name = ANY($1::text[])`,
    [tables],
  )
  const present = new Set(rows.map((row) => row.table_name))
  return sources.filter((item) => present.has(item.table))
}

const monthSql = `to_char(date_trunc('month', created_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM')`

export async function openRetentionDemands(today = todayInSaoPaulo(), poolProvider: () => Pool = getDatabasePool) {
  const pool = poolProvider()
  const { rows: ready } = await pool.query<{ ok: boolean }>(`SELECT to_regclass('public.demands') IS NOT NULL AS ok`)
  if (!ready[0].ok) return 0
  const settings = (await readSystemSettings(pool)).retention
  if (!settings?.sectorId) return 0
  const present = await existingSources(pool)
  if (present.length === 0) return 0

  const limit = lastDueMonth(today, settings.months, settings.noticeDays)
  const union = present
    .map((item) => `SELECT ${monthSql} AS mes FROM public.${item.table} WHERE created_at IS NOT NULL${item.where ? ` AND ${item.where}` : ''}`)
    .join(' UNION ')
  // Os meses mais antigos primeiro; no máximo 12 por ciclo, para a primeira vez não lotar a lista.
  const { rows: months } = await pool.query<{ mes: string }>(
    `SELECT mes FROM (${union}) meses
      WHERE mes <= $1
        AND NOT EXISTS (SELECT 1 FROM public.demand_history h WHERE h.acao = 'guarda_dados_gerada' AND h.detalhes->>'mes' = meses.mes)
      ORDER BY mes LIMIT 12`,
    [limit],
  )

  let opened = 0
  for (const { mes } of months) {
    try {
      await withTransaction(pool, async (client) => {
        // Um ciclo por vez; outro pode ter aberto a mesma demanda no meio tempo.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('slm:retention'))`)
        const done = await client.query(
          `SELECT 1 FROM public.demand_history WHERE acao = 'guarda_dados_gerada' AND detalhes->>'mes' = $1`,
          [mes],
        )
        if (done.rowCount) return
        const sector = await client.query(`SELECT 1 FROM public.demand_sectors WHERE id = $1 AND ativo`, [settings.sectorId])
        if (!sector.rowCount) return

        // Quem consta como solicitante: um chefe do setor ou, sem chefe, um administrador.
        const owner = await client.query<{ id: string }>(
          `SELECT id FROM (
             SELECT m.user_id::text AS id, 1 AS ordem FROM public.demand_sector_members m
               JOIN public.auth_users u ON u.id = m.user_id AND u.status = 'approved'
              WHERE m.sector_id = $1 AND m.ativo AND m.papel = 'responsavel'
             UNION ALL
             SELECT id::text, 2 FROM public.auth_users WHERE role = 'admin' AND status = 'approved'
           ) pessoas ORDER BY ordem, id LIMIT 1`,
          [settings.sectorId],
        )
        if (!owner.rows[0]) return
        const ownerId = owner.rows[0].id

        const counts: string[] = []
        for (const item of present) {
          const { rows } = await client.query<{ total: number }>(
            `SELECT count(*)::int AS total FROM public.${item.table} WHERE ${monthSql} = $1${item.where ? ` AND ${item.where}` : ''}`,
            [mes],
          )
          if (rows[0].total > 0) counts.push(`- ${item.label}: ${rows[0].total}`)
        }
        const deadline = retentionDeadline(mes, settings.months)
        const first = `${mes}-01`
        const last = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).toISOString().slice(0, 10)
        const show = (date: string) => date.split('-').reverse().join('/')
        const number = await nextDemandNumber(client)
        const title = `Guarda de dados (LGPD): imprimir os relatórios de ${monthLabel(mes)}`
        const description = [
          `Os registros de ${monthLabel(mes)} completam o prazo de guarda de ${settings.months} ${settings.months === 1 ? 'mês' : 'meses'} em ${show(deadline)}.`,
          '',
          'Antes dessa data, imprima ou salve os relatórios e as planilhas do período:',
          `- Relatórios e Dashboard, com o período de ${show(first)} a ${show(last)};`,
          '- as planilhas de cada módulo (Manutenção, Frota, Passagens, Almoxarifado e Controle de Demandas), no mesmo período.',
          '',
          'Registros do mês:',
          ...(counts.length ? counts : ['- (nenhum registro encontrado)']),
          '',
          'Demanda aberta automaticamente pelo sistema (Configurações → Sistema → Guarda dos dados).',
        ].join('\n')

        const created = await client.query<{ id: string }>(
          `INSERT INTO public.demands
             (numero, titulo, descricao, categoria_id, setor_origem_id, setor_responsavel_id, solicitante_id,
              criado_por, prazo, prioridade)
           VALUES ($1, $2, $3,
                   COALESCE(
                     (SELECT id FROM public.demand_categories WHERE ativo AND lower(trim(nome)) = 'acompanhamento de processos' LIMIT 1),
                     (SELECT id FROM public.demand_categories WHERE ativo ORDER BY ordem, nome LIMIT 1)
                   ),
                   $4, $4, $5, $5, $6, 'alta') RETURNING id::text AS id`,
          [number, title, description, settings.sectorId, ownerId, deadline < today ? today : deadline],
        )
        const demandId = created.rows[0].id
        await recordDemandHistory(client, {
          demandId,
          userId: null,
          action: 'guarda_dados_gerada',
          details: { numero: number, mes },
        })
        const leads = await client.query<{ user_id: string }>(
          `SELECT user_id::text AS user_id FROM public.demand_sector_members WHERE sector_id = $1 AND ativo AND papel = 'responsavel'`,
          [settings.sectorId],
        )
        await notifyDemand(client, {
          kind: 'atribuicao',
          key: `${demandId}:guarda`,
          demand: { id: demandId, number, title, restricted: false },
          recipients: leads.rows.map((lead) => lead.user_id),
          actorId: null,
        })
      })
      opened += 1
    } catch (error) {
      recordTechnicalEvent('worker', 'retention_demand_failed', error)
    }
  }
  return opened
}
