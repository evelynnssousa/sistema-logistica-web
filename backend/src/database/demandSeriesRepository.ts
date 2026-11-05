import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { notifyDemand } from '../demands/demandNotifications.js'
import type { DemandRecurrenceInput } from '../demands/demandValidation.js'
import {
  addDays,
  describeRule,
  occurrenceAfter,
  occurrenceOnOrAfter,
  occurrencesBetween,
} from '../demands/recurrence.js'
import type { Frequency, RecurrenceEnd, RecurrenceRule, Unit } from '../demands/recurrence.js'
import { redactOptional } from '../integrations/redaction.js'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { conflict, ModuleError, notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'

type Client = Pick<PoolClient, 'query'>

/**
 * Séries recorrentes. Cada data vira uma demanda independente, com número, prazo, responsável,
 * status e histórico próprios. O que impede a duplicidade, mesmo com dois processos ou um
 * reprocessamento, é a soma de três travas: a série é reservada com FOR UPDATE SKIP LOCKED, e
 * tanto o registro da data quanto a demanda têm chave única por série e data.
 */

export type SeriesTemplate = {
  title: string
  description: string
  categoryId: string
  originSectorId: string
  responsibleSectorId: string
  requesterId: string
  responsibleId: string | null
  followUpManagerId?: string | null
  priority: string
  restricted: boolean
  notes: string | null
  references: string | null
  reminderDays: number | null
  collaborators: { userId: string; activity: string | null }[]
  collaboratorSectorIds: string[]
  authorizedUserIds: string[]
}

export type SeriesRow = {
  id: string
  frequencia: Frequency
  intervalo: number
  unidade: Unit
  dias_semana: number[]
  dias_mes: number[]
  data_inicio: string
  fim_tipo: 'sem_fim' | 'quantidade' | 'data'
  fim_quantidade: number | null
  fim_data: string | null
  antecedencia_dias: number
  inicio_offset_dias: number
  status: 'ativa' | 'suspensa' | 'cancelada' | 'encerrada'
  proxima_execucao: string | null
  ocorrencias_contadas: number
  modelo: SeriesTemplate
  criado_por: string
}

export const seriesColumns = `
  s.id::text AS id, s.frequencia, s.intervalo, s.unidade, s.dias_semana, s.dias_mes,
  s.data_inicio::text AS data_inicio, s.fim_tipo, s.fim_quantidade, s.fim_data::text AS fim_data,
  s.antecedencia_dias, s.inicio_offset_dias, s.status, s.proxima_execucao::text AS proxima_execucao,
  s.ocorrencias_contadas, s.modelo, s.criado_por::text AS criado_por`

export function ruleOf(row: SeriesRow): RecurrenceRule {
  const end: RecurrenceEnd =
    row.fim_tipo === 'quantidade'
      ? { type: 'quantidade', count: row.fim_quantidade as number }
      : row.fim_tipo === 'data'
        ? { type: 'data', date: row.fim_data as string }
        : { type: 'sem_fim' }
  return {
    frequency: row.frequencia,
    interval: row.intervalo,
    unit: row.unidade,
    weekdays: row.dias_semana,
    monthDays: row.dias_mes,
    startDate: row.data_inicio,
    end,
  }
}

/** A data que vale para a instituição, seja qual for o fuso do servidor. */
export function todayInSaoPaulo(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** O que mudou, para a auditoria: quem e quando já são colunas do próprio registro. */
async function auditDetails(client: Client, entry: { demandId?: string | null; action: string; details?: Record<string, unknown> }) {
  const readable = (value: unknown) => (value === null || value === undefined ? 'vazio' : String(value).replace(/_/g, ' '))
  const { de, para, campos } = entry.details ?? {}
  const found = entry.demandId
    ? await client.query<{ numero: string }>(`SELECT numero FROM public.demands WHERE id = $1`, [entry.demandId])
    : null
  return {
    alteracao: readable(entry.action),
    ...(found?.rows[0] ? { demanda: found.rows[0].numero } : {}),
    ...(de !== undefined || para !== undefined ? { from: readable(de), to: readable(para) } : {}),
    ...(Array.isArray(campos) ? { campos: campos.map(String) } : {}),
  }
}

export async function recordDemandHistory(
  client: Client,
  entry: {
    demandId?: string | null
    seriesId?: string | null
    userId: string | null
    action: string
    comment?: string | null
    details?: Record<string, unknown>
  },
) {
  await client.query(
    `INSERT INTO public.demand_history (demand_id, series_id, usuario_id, acao, comentario, detalhes)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      entry.demandId ?? null,
      entry.seriesId ?? null,
      entry.userId,
      entry.action,
      redactOptional(entry.comment ?? null),
      JSON.stringify(entry.details ?? {}),
    ],
  )
  // Na mesma transação: toda alteração feita por uma pessoa fica também na auditoria geral.
  // O cadastro já tem registro próprio, e o que o worker gera não tem autor.
  if (entry.userId && !['criada', 'rascunho_criado'].includes(entry.action)) {
    await insertAuthAuditEvent(client, {
      actorUserId: entry.userId,
      actorKind: 'user',
      subjectUserId: null,
      sessionId: entry.demandId ?? entry.seriesId ?? null,
      eventType: 'demand_changed',
      details: await auditDetails(client, entry),
    })
  }
}

export async function nextDemandNumber(client: Client) {
  const { rows } = await client.query<{ numero: string }>(
    `SELECT public.next_protocol_code('DEM', public.protocol_year(now())) AS numero`,
  )
  return rows[0].numero
}

async function saveParticipants(
  client: Client,
  demandId: string,
  actorId: string | null,
  collaborators: readonly { userId: string; activity: string | null; dueDate?: string | null }[],
  authorizedUserIds: readonly string[],
) {
  for (const item of collaborators) {
    await client.query(
      `INSERT INTO public.demand_participants (demand_id, user_id, tipo, atividade, prazo, adicionado_por)
       VALUES ($1, $2, 'colaborador', $3, $4, $5)`,
      [demandId, item.userId, redactOptional(item.activity), item.dueDate ?? null, actorId],
    )
  }
  for (const userId of authorizedUserIds) {
    await client.query(
      `INSERT INTO public.demand_participants (demand_id, user_id, tipo, adicionado_por)
       VALUES ($1, $2, 'autorizado', $3)`,
      [demandId, userId, actorId],
    )
  }
}

/** Quem saiu do setor não recebe novas ocorrências: a demanda fica sem responsável, à vista no painel. */
async function stillResponsible(client: Client, template: SeriesTemplate) {
  if (!template.responsibleId) return null
  return (await canRespondFor(client, template.responsibleId, template.responsibleSectorId)) ? template.responsibleId : null
}

/** Responde por um setor quem o integra. Nos setores marcados como SLM, também a equipe SLM. */
export async function canRespondFor(client: Client, userId: string, sectorId: string) {
  const { rowCount } = await client.query(
    `SELECT 1 FROM public.auth_users u
      WHERE u.id = $1 AND u.status = 'approved'
        AND EXISTS (SELECT 1 FROM public.demand_sector_members m
                     WHERE m.user_id = u.id AND m.sector_id = $2 AND m.ativo)`,
    [userId, sectorId],
  )
  return Boolean(rowCount)
}

async function sectorLeads(client: Client, sectorId: string) {
  const { rows } = await client.query<{ user_id: string }>(
    `SELECT m.user_id::text AS user_id FROM public.demand_sector_members m
      WHERE m.sector_id = $1 AND m.ativo AND m.papel = 'responsavel'`,
    [sectorId],
  )
  return rows.map((row) => row.user_id)
}

async function createOccurrence(client: Client, series: SeriesRow, date: string) {
  const template = series.modelo
  const number = await nextDemandNumber(client)
  const responsibleId = await stillResponsible(client, template)
  const created = await client.query<{ id: string }>(
    `INSERT INTO public.demands
       (numero, titulo, descricao, categoria_id, setor_origem_id, setor_responsavel_id, solicitante_id,
        responsavel_id, criado_por, inicio_previsto, prazo, prioridade, restrita, observacoes, referencias,
        lembrete_dias, series_id, data_ocorrencia, gestor_acompanhamento_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING id::text AS id`,
    [
      number,
      template.title,
      template.description,
      template.categoryId,
      template.originSectorId,
      template.responsibleSectorId,
      template.requesterId,
      responsibleId,
      series.criado_por,
      series.inicio_offset_dias ? addDays(date, -series.inicio_offset_dias) : null,
      date,
      template.priority,
      template.restricted,
      template.notes,
      template.references,
      template.reminderDays,
      series.id,
      date,
      template.followUpManagerId ?? null,
    ],
  )
  const demandId = created.rows[0].id
  await saveParticipants(client, demandId, null, template.collaborators, template.authorizedUserIds)
  for (const sectorId of template.collaboratorSectorIds) {
    await client.query(
      `INSERT INTO public.demand_sector_links (demand_id, sector_id) VALUES ($1, $2)`,
      [demandId, sectorId],
    )
  }
  await recordDemandHistory(client, {
    demandId,
    seriesId: series.id,
    userId: null,
    action: 'ocorrencia_gerada',
    details: { numero: number, data: date },
  })
  await notifyDemand(client, {
    kind: 'recorrencia',
    key: `${demandId}:recorrencia`,
    demand: { id: demandId, number, title: template.title, restricted: template.restricted },
    recipients: [
      responsibleId,
      ...template.collaborators.map((item) => item.userId),
      ...(responsibleId ? [] : await sectorLeads(client, template.responsibleSectorId)),
    ],
    actorId: null,
  })
  return demandId
}

/** Primeira data da regra, a partir de "from", que ainda não foi gerada nem pulada. */
async function nextFreeDate(client: Client, seriesId: string, rule: RecurrenceRule, from: string) {
  const { rows } = await client.query<{ data: string }>(
    `SELECT data_prevista::text AS data FROM public.demand_series_occurrences
      WHERE series_id = $1 AND data_prevista >= $2::date`,
    [seriesId, from],
  )
  const taken = new Set(rows.map((row) => row.data))
  let date = occurrenceOnOrAfter(rule, from)
  while (date && taken.has(date)) date = occurrenceAfter(rule, date)
  return date
}

/** Decide a próxima data e encerra a série quando a regra terminou. */
async function nextState(client: Client, series: SeriesRow, after: string, counted: number) {
  const limitReached = series.fim_tipo === 'quantidade' && counted >= (series.fim_quantidade as number)
  const next = limitReached ? null : await nextFreeDate(client, series.id, ruleOf(series), addDays(after, 1))
  return { next, status: next ? ('ativa' as const) : ('encerrada' as const) }
}

/** Trata uma data de uma série. Devolve true se há mais a verificar. */
async function advanceSeries(client: PoolClient, seriesId: string, today: string) {
  const found = await client.query<SeriesRow>(
    `SELECT ${seriesColumns} FROM public.demand_series s
      WHERE s.id = $1 AND s.status = 'ativa'
      FOR UPDATE SKIP LOCKED`,
    [seriesId],
  )
  const series = found.rows[0]
  if (!series?.proxima_execucao) return false
  const date = series.proxima_execucao
  if (addDays(date, -series.antecedencia_dias) > today) return false

  let counted = series.ocorrencias_contadas
  if (series.fim_tipo === 'quantidade' && counted >= (series.fim_quantidade as number)) {
    await client.query(
      `UPDATE public.demand_series SET status = 'encerrada', proxima_execucao = NULL WHERE id = $1`,
      [series.id],
    )
    await recordDemandHistory(client, { seriesId: series.id, userId: null, action: 'recorrencia_encerrada' })
    return false
  }

  // Data já registrada (pulada, ou gerada em uma tentativa anterior): só segue adiante.
  const ledger = await client.query<{ id: string }>(
    `INSERT INTO public.demand_series_occurrences (series_id, data_prevista, situacao)
     VALUES ($1, $2, 'gerada')
     ON CONFLICT (series_id, data_prevista) DO NOTHING
     RETURNING id::text AS id`,
    [series.id, date],
  )
  if (ledger.rows[0]) {
    const demandId = await createOccurrence(client, series, date)
    await client.query(`UPDATE public.demand_series_occurrences SET demand_id = $2 WHERE id = $1`, [
      ledger.rows[0].id,
      demandId,
    ])
    counted += 1
  }

  const { next, status } = await nextState(client, series, date, counted)
  await client.query(
    `UPDATE public.demand_series
        SET proxima_execucao = $2, status = $3, ocorrencias_contadas = $4, ultima_execucao_em = now()
      WHERE id = $1`,
    [series.id, next, status, counted],
  )
  if (status === 'encerrada') {
    await recordDemandHistory(client, { seriesId: series.id, userId: null, action: 'recorrencia_encerrada' })
  }
  return status === 'ativa'
}

// Depois de um longo tempo parado, a recuperação continua no ciclo seguinte.
const maxOccurrencesPerCycle = 60

/**
 * Gera o que venceu, sem depender de ninguém abrir a plataforma. Depois de uma queda, gera as datas
 * perdidas na ordem. Rodar de novo, ou em paralelo, não duplica.
 */
export async function generateDueOccurrences(
  today = todayInSaoPaulo(),
  poolProvider: () => Pool = getDatabasePool,
) {
  const pool = poolProvider()
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM public.demand_series
      WHERE status = 'ativa' AND proxima_execucao IS NOT NULL
        AND proxima_execucao - antecedencia_dias <= $1::date
      ORDER BY proxima_execucao
      LIMIT 200`,
    [today],
  )
  let processed = 0
  for (const { id } of rows) {
    try {
      for (let attempt = 0; attempt < maxOccurrencesPerCycle; attempt += 1) {
        const hasMore = await withTransaction(pool, (client) => advanceSeries(client, id, today))
        processed += 1
        if (!hasMore) break
      }
    } catch (error) {
      // Uma série com problema não impede as demais.
      recordTechnicalEvent('worker', 'demand_series_generation_failed', error)
    }
  }
  return processed
}

/** Vincula a demanda recém-publicada a uma série nova, como a primeira ocorrência. */
export async function createSeriesFor(
  client: Client,
  input: {
    demandId: string
    template: SeriesTemplate
    recurrence: DemandRecurrenceInput
    actorId: string
    today?: string
  },
) {
  const { rule, leadDays, startOffsetDays } = input.recurrence
  const today = input.today ?? todayInSaoPaulo()
  const first = occurrenceOnOrAfter(rule, rule.startDate > today ? rule.startDate : today)
  if (!first) throw new ModuleError('A regra de repetição não tem nenhuma data a partir de hoje.', 400)

  const counted = 1
  const limitReached = rule.end.type === 'quantidade' && counted >= rule.end.count
  const next = limitReached ? null : occurrenceAfter(rule, first)

  const created = await client.query<{ id: string }>(
    `INSERT INTO public.demand_series
       (frequencia, intervalo, unidade, dias_semana, dias_mes, data_inicio, fim_tipo, fim_quantidade, fim_data,
        antecedencia_dias, inicio_offset_dias, status, proxima_execucao, ocorrencias_contadas, modelo, criado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)
     RETURNING id::text AS id`,
    [
      rule.frequency,
      rule.interval,
      rule.unit,
      rule.weekdays,
      rule.monthDays,
      rule.startDate,
      rule.end.type,
      rule.end.type === 'quantidade' ? rule.end.count : null,
      rule.end.type === 'data' ? rule.end.date : null,
      leadDays,
      startOffsetDays,
      next ? 'ativa' : 'encerrada',
      next,
      counted,
      JSON.stringify(input.template),
      input.actorId,
    ],
  )
  const seriesId = created.rows[0].id
  await client.query(
    `UPDATE public.demands
        SET series_id = $2, data_ocorrencia = $3, prazo = $3, inicio_previsto = $4
      WHERE id = $1`,
    [input.demandId, seriesId, first, startOffsetDays ? addDays(first, -startOffsetDays) : null],
  )
  await client.query(
    `INSERT INTO public.demand_series_occurrences (series_id, data_prevista, situacao, demand_id, registrado_por)
     VALUES ($1, $2, 'gerada', $3, $4)`,
    [seriesId, first, input.demandId, input.actorId],
  )
  await recordDemandHistory(client, {
    demandId: input.demandId,
    seriesId,
    userId: input.actorId,
    action: 'recorrencia_criada',
    details: { regra: describeRule(rule), primeiraData: first },
  })
  return { seriesId, firstDate: first }
}

export class DemandSeriesRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  private async lockSeries(client: Client, demandId: string) {
    const found = await client.query<SeriesRow>(
      `SELECT ${seriesColumns}
         FROM public.demand_series s
         JOIN public.demands d ON d.series_id = s.id
        WHERE d.id = $1
        FOR UPDATE OF s`,
      [demandId],
    )
    if (!found.rows[0]) throw new ModuleError('Esta demanda não faz parte de uma recorrência.', 409)
    return found.rows[0]
  }

  /** Resumo para o detalhe da demanda. Datas futuras são previsão, e não demandas existentes. */
  async detail(demandId: string, visibleSql: string, parameters: readonly unknown[]) {
    const pool = this.poolProvider()
    const found = await pool.query<SeriesRow & { ultima_execucao_em: Date | null }>(
      `SELECT ${seriesColumns}, s.ultima_execucao_em
         FROM public.demand_series s
         JOIN public.demands d ON d.series_id = s.id
        WHERE d.id = $1`,
      [demandId],
    )
    const series = found.rows[0]
    if (!series) return null

    // Os parâmetros de visibilidade são $1 e $2; a série vem depois.
    const occurrences = await pool.query<{
      data_prevista: string
      situacao: string
      motivo: string | null
      demand_id: string | null
      numero: string | null
      status: string | null
    }>(
      `SELECT o.data_prevista::text AS data_prevista, o.situacao, o.motivo,
              d.id::text AS demand_id, d.numero, d.status
         FROM public.demand_series_occurrences o
         LEFT JOIN public.demands d ON d.id = o.demand_id AND ${visibleSql}
        WHERE o.series_id = $3
        ORDER BY o.data_prevista DESC
        LIMIT 100`,
      [...parameters, series.id],
    )
    return {
      id: series.id,
      status: series.status,
      frequency: series.frequencia,
      interval: series.intervalo,
      unit: series.unidade,
      weekdays: series.dias_semana,
      monthDays: series.dias_mes,
      startDate: series.data_inicio,
      end: ruleOf(series).end,
      leadDays: series.antecedencia_dias,
      startOffsetDays: series.inicio_offset_dias,
      description: describeRule(ruleOf(series)),
      nextExecution: series.proxima_execucao,
      counted: series.ocorrencias_contadas,
      lastRunAt: series.ultima_execucao_em,
      occurrences: occurrences.rows.map((row) => ({
        date: row.data_prevista,
        situation: row.situacao,
        reason: row.motivo,
        demandId: row.demand_id,
        number: row.numero,
        status: row.status,
      })),
      upcoming: projectDates(
        series,
        occurrences.rows.map((row) => row.data_prevista),
        6,
      ),
    }
  }

  async suspend(actor: AuthenticatedIdentity, demandId: string, reason: string) {
    await withTransaction(this.poolProvider(), async (client) => {
      const series = await this.lockSeries(client, demandId)
      if (series.status !== 'ativa') throw conflict('Só uma recorrência ativa pode ser suspensa.')
      await client.query(`UPDATE public.demand_series SET status = 'suspensa' WHERE id = $1`, [series.id])
      await recordDemandHistory(client, {
        demandId,
        seriesId: series.id,
        userId: actor.userId,
        action: 'recorrencia_suspensa',
        comment: reason,
      })
    })
  }

  /** Retoma a partir de hoje: as datas do período suspenso não são geradas depois. */
  async resume(actor: AuthenticatedIdentity, demandId: string, today = todayInSaoPaulo()) {
    return withTransaction(this.poolProvider(), async (client) => {
      const series = await this.lockSeries(client, demandId)
      if (series.status !== 'suspensa') throw conflict('Só uma recorrência suspensa pode ser retomada.')
      const finished =
        series.fim_tipo === 'quantidade' && series.ocorrencias_contadas >= (series.fim_quantidade as number)
      const next = finished ? null : await nextFreeDate(client, series.id, ruleOf(series), today)
      await client.query(
        `UPDATE public.demand_series SET status = $2, proxima_execucao = $3 WHERE id = $1`,
        [series.id, next ? 'ativa' : 'encerrada', next],
      )
      await recordDemandHistory(client, {
        demandId,
        seriesId: series.id,
        userId: actor.userId,
        action: 'recorrencia_retomada',
        details: { proximaData: next },
      })
      return next
    })
  }

  /**
   * Nada é apagado. As ocorrências existentes seguem normais, a menos que a pessoa peça para cancelar
   * também as futuras ainda não iniciadas.
   */
  async cancel(
    actor: AuthenticatedIdentity,
    demandId: string,
    input: { reason: string; cancelFuture: boolean },
    today = todayInSaoPaulo(),
  ) {
    await withTransaction(this.poolProvider(), async (client) => {
      const series = await this.lockSeries(client, demandId)
      if (series.status === 'cancelada' || series.status === 'encerrada') {
        throw conflict('Esta recorrência já terminou.')
      }
      await client.query(
        `UPDATE public.demand_series SET status = 'cancelada', proxima_execucao = NULL WHERE id = $1`,
        [series.id],
      )
      await recordDemandHistory(client, {
        demandId,
        seriesId: series.id,
        userId: actor.userId,
        action: 'recorrencia_cancelada',
        comment: input.reason,
        details: { canceladasAsFuturas: input.cancelFuture },
      })
      if (!input.cancelFuture) return
      const { rows } = await client.query<{ id: string }>(
        `UPDATE public.demands
            SET status = 'cancelada', cancelamento_motivo = $2, cancelada_em = now(), cancelada_por = $3,
                versao = versao + 1, ultima_atividade_em = now()
          WHERE series_id = $1 AND data_ocorrencia > $4::date AND status = 'nao_iniciada'
          RETURNING id::text AS id`,
        [series.id, redactOptional(input.reason), actor.userId, today],
      )
      for (const row of rows) {
        await recordDemandHistory(client, {
          demandId: row.id,
          seriesId: series.id,
          userId: actor.userId,
          action: 'cancelada',
          comment: input.reason,
          details: { origem: 'cancelamento_da_recorrencia' },
        })
      }
    })
  }

  /** Pula uma data futura, ainda não gerada, ou a própria ocorrência, se ela não terminou. */
  async skip(actor: AuthenticatedIdentity, demandId: string, input: { reason: string; date: string | null }) {
    await withTransaction(this.poolProvider(), async (client) => {
      const series = await this.lockSeries(client, demandId)
      if (input.date) {
        if (series.status !== 'ativa' && series.status !== 'suspensa') {
          throw conflict('Esta recorrência já terminou.')
        }
        if (input.date < todayInSaoPaulo()) {
          throw new ModuleError('Só é possível pular datas de hoje em diante.', 400)
        }
        if (occurrenceOnOrAfter(ruleOf(series), input.date) !== input.date) {
          throw new ModuleError('Esta data não faz parte da recorrência.', 400)
        }
        const ledger = await client.query(
          `INSERT INTO public.demand_series_occurrences (series_id, data_prevista, situacao, motivo, registrado_por)
           VALUES ($1, $2, 'pulada', $3, $4)
           ON CONFLICT (series_id, data_prevista) DO NOTHING`,
          [series.id, input.date, redactOptional(input.reason), actor.userId],
        )
        if (!ledger.rowCount) throw conflict('Esta data já foi gerada ou pulada.')
        // A data pulada conta na quantidade pedida, e não pode continuar como próxima execução.
        const counted = series.ocorrencias_contadas + 1
        const finished = series.fim_tipo === 'quantidade' && counted >= (series.fim_quantidade as number)
        const next = finished
          ? null
          : series.proxima_execucao === input.date
            ? await nextFreeDate(client, series.id, ruleOf(series), input.date)
            : series.proxima_execucao
        await client.query(
          `UPDATE public.demand_series
              SET ocorrencias_contadas = $2, proxima_execucao = $3, status = $4
            WHERE id = $1`,
          [series.id, counted, next, finished ? 'encerrada' : series.status],
        )
        await recordDemandHistory(client, {
          demandId,
          seriesId: series.id,
          userId: actor.userId,
          action: 'ocorrencia_pulada',
          comment: input.reason,
          details: { data: input.date },
        })
        return
      }

      const updated = await client.query<{ data_ocorrencia: string }>(
        `UPDATE public.demands
            SET status = 'cancelada', cancelamento_motivo = $2, cancelada_em = now(), cancelada_por = $3,
                versao = versao + 1, ultima_atividade_em = now()
          WHERE id = $1 AND status NOT IN ('concluida', 'cancelada')
          RETURNING data_ocorrencia::text AS data_ocorrencia`,
        [demandId, redactOptional(`Ocorrência pulada: ${input.reason}`), actor.userId],
      )
      if (!updated.rows[0]) throw conflict('Uma ocorrência encerrada não pode ser pulada.')
      await client.query(
        `UPDATE public.demand_series_occurrences SET situacao = 'pulada', motivo = $3, registrado_por = $4
          WHERE series_id = $1 AND data_prevista = $2`,
        [series.id, updated.rows[0].data_ocorrencia, redactOptional(input.reason), actor.userId],
      )
      await recordDemandHistory(client, {
        demandId,
        seriesId: series.id,
        userId: actor.userId,
        action: 'ocorrencia_pulada',
        comment: input.reason,
        details: { data: updated.rows[0].data_ocorrencia },
      })
    })
  }

  /** Nova regra daqui em diante. As datas já registradas continuam protegidas pela chave única. */
  async changeRule(
    actor: AuthenticatedIdentity,
    demandId: string,
    recurrence: DemandRecurrenceInput,
    today = todayInSaoPaulo(),
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const series = await this.lockSeries(client, demandId)
      if (series.status === 'cancelada' || series.status === 'encerrada') {
        throw conflict('Esta recorrência já terminou.')
      }
      const { rule, leadDays, startOffsetDays } = recurrence
      const finished = rule.end.type === 'quantidade' && series.ocorrencias_contadas >= rule.end.count
      const next = finished
        ? null
        : await nextFreeDate(client, series.id, rule, rule.startDate > today ? rule.startDate : today)
      const before = describeRule(ruleOf(series))
      await client.query(
        `UPDATE public.demand_series
            SET frequencia = $2, intervalo = $3, unidade = $4, dias_semana = $5, dias_mes = $6, data_inicio = $7,
                fim_tipo = $8, fim_quantidade = $9, fim_data = $10, antecedencia_dias = $11,
                inicio_offset_dias = $12, proxima_execucao = $13, status = $14
          WHERE id = $1`,
        [
          series.id,
          rule.frequency,
          rule.interval,
          rule.unit,
          rule.weekdays,
          rule.monthDays,
          rule.startDate,
          rule.end.type,
          rule.end.type === 'quantidade' ? rule.end.count : null,
          rule.end.type === 'data' ? rule.end.date : null,
          leadDays,
          startOffsetDays,
          next,
          !next ? 'encerrada' : series.status,
        ],
      )
      await recordDemandHistory(client, {
        demandId,
        seriesId: series.id,
        userId: actor.userId,
        action: 'recorrencia_alterada',
        details: { de: before, para: describeRule(rule), proximaData: next },
      })
      return next
    })
  }
}

/** Datas futuras previstas, sem as já registradas e respeitando o limite de ocorrências. */
export function projectDates(series: SeriesRow, known: readonly string[], limit: number, until?: string) {
  if (series.status !== 'ativa' || !series.proxima_execucao) return []
  const rule = ruleOf(series)
  const remaining =
    series.fim_tipo === 'quantidade' ? (series.fim_quantidade as number) - series.ocorrencias_contadas : Infinity
  const end = until ?? addDays(series.proxima_execucao, 800)
  const taken = new Set(known)
  return occurrencesBetween(rule, series.proxima_execucao, end, limit + known.length)
    .filter((date) => !taken.has(date))
    .slice(0, Math.max(0, Math.min(limit, remaining)))
}
