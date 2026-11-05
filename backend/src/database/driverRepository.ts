import type { Pool, PoolClient } from 'pg'
import { effectiveMinutes, exceedsJourney, isOutsideJourney, journeyOfRecord } from '../auth/driverPolicy.js'
import type { TripGroup } from '../auth/driverPolicy.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { publishDriverRuleEvent, publishIntegrationEvent, requestCalendarSync } from '../integrations/publisher.js'
import { redactOptional, redactValidCpf } from '../integrations/redaction.js'
import { journeyOf, readExecutionRecord, readJustification } from '../requests/driverPortalRules.js'
import type { ExecutionRecord, OccurrenceType } from '../requests/driverPortalRules.js'
import type { SystemSettings } from '../requests/settingsRules.js'
import { RequestValidationError } from '../requests/validation.js'
import { nextStatus, normalizedStatusSql, normalizeStatus } from '../requests/workflow.js'
import type { RequestStatus } from '../requests/workflow.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { conflict, forbidden, ModuleError, notFound, ScheduleConflictError } from './moduleErrors.js'
import type { ScheduleConflict } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { protocolSql } from './protocolSql.js'
import { recordHistory } from './serviceRequestRepository.js'
import { readSystemSettings } from './settingsRepository.js'
import { withTransaction } from './withTransaction.js'

/**
 * Portal do Motorista e cadastro de motoristas. A viagem é a própria solicitação de Frota: nada aqui
 * cria um registro paralelo. O motorista vem sempre de driverOf(identity), que parte da sessão, e toda
 * consulta do portal filtra por ele. Viagem de outro motorista responde como inexistente.
 */

type Client = Pick<PoolClient, 'query'>

const tripPageSize = 20

/** A conta só serve a um motorista enquanto for ativa, de perfil Motorista e estiver vinculada. */
const validDriverSql = `d.ativo AND d.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM public.auth_users u
    JOIN public.auth_user_access a ON a.user_id = u.id
   WHERE u.id = d.user_id AND u.status = 'approved' AND a.profile = 'driver'
)`

const assignableStatuses = ['agendado', 'reagendado']
const occurrenceStatuses = ['agendado', 'reagendado', 'em_andamento', 'concluido']
const occupyingStatuses = ['agendado', 'reagendado', 'em_andamento', 'agendada']

const tripColumns = `r.id::text AS id, ${protocolSql('r')} AS protocolo, r.status, r.titulo, r.dados,
  r.data_agendada, r.agendamento_fim, r.motorista_observacoes, r.execucao_inicio, r.execucao_fim,
  r.aguardando_externo_desde, r.setor_nome, r.execucao_registro, solicitante.full_name AS solicitante_nome`

type TripRow = {
  id: string
  protocolo: string
  status: string
  titulo: string
  dados: Record<string, unknown>
  data_agendada: Date | null
  agendamento_fim: Date | null
  motorista_observacoes: string | null
  execucao_inicio: Date | null
  execucao_fim: Date | null
  aguardando_externo_desde: Date | null
  setor_nome: string | null
  execucao_registro: Record<string, unknown> | null
  solicitante_nome: string
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : null)

/**
 * Só o necessário para executar a viagem, dentro do que Configurações libera. Observações internas,
 * motivo de cancelamento, contatos e campos personalizados não saem daqui, nem que a tela peça. Campo
 * oculto sai como vazio da própria API. As viagens já iniciadas usam a jornada guardada nelas.
 */
function presentTrip(row: TripRow, settings: SystemSettings, now = new Date()) {
  const status = normalizeStatus('fleet', row.status)
  const timing = { startedAt: row.execucao_inicio, finishedAt: row.execucao_fim }
  const passengers = Array.isArray(row.dados.passageiros) ? (row.dados.passageiros as { nome?: unknown }[]) : []
  const shown = settings.driverDisplay.fields
  const visible = <T,>(field: keyof typeof shown, value: T) => (shown[field] === 'hidden' ? null : value)
  const destination = text(row.dados.destino)
  const journey = row.execucao_inicio ? journeyOfRecord(row.execucao_registro) : journeyOf(settings)
  const outsideNow = isOutsideJourney(now, journey)
  const startAllowed = settings.driverJourney.allowOutsideStart || !outsideNow
  const startable = !row.aguardando_externo_desde && Boolean(nextStatus('fleet', status, 'start'))
  return {
    id: row.id,
    protocol: row.protocolo,
    status,
    // O título da Frota traz a saída: com ela oculta, fica só o destino.
    title: shown.origin === 'hidden' ? (destination ?? 'Viagem') : row.titulo,
    scheduledAt: row.data_agendada,
    scheduledEnd: visible('scheduledEnd', row.agendamento_fim),
    origin: visible('origin', text(row.dados.origem)),
    destination,
    returnAt: visible('returnAt', text(row.dados.dataHoraRetorno)),
    purpose: visible('purpose', text(row.dados.finalidade)),
    vehicle: visible('vehicle', text(row.dados.veiculo)),
    passengers: visible('passengers', passengers.map((item) => text(item.nome)).filter((name): name is string => Boolean(name))) ?? [],
    requester: visible('requester', row.solicitante_nome),
    sector: visible('sector', row.setor_nome),
    notes: visible('notes', row.motorista_observacoes),
    startedAt: row.execucao_inicio,
    finishedAt: row.execucao_fim,
    durationMinutes: effectiveMinutes(timing),
    exceedsJourney: exceedsJourney(timing, now, journey),
    journeyReference: { start: journey.start, end: journey.end },
    outsideJourneyNow: outsideNow,
    canStart: startable && startAllowed,
    startBlockedByJourney: startable && !startAllowed,
    startNeedsVehicle: settings.driverExecution.startFields.includes('vehicle') && !text(row.dados.veiculo),
    canFinish: Boolean(nextStatus('fleet', status, 'complete')),
    canReportOccurrence: settings.driverAccess.occurrencesEnabled && occurrenceStatuses.includes(status),
  }
}

function groupConditions(upcomingDays: number): Record<TripGroup, { where: string; order: string }> {
  // Vai direto no SQL: o valor passa pela validação de inteiro dos parâmetros, e é conferido aqui de novo.
  const days = Number.isInteger(upcomingDays) && upcomingDays > 0 ? upcomingDays : 7
  return {
    proximas: {
      where: `status_atual = ANY('{agendado,reagendado}'::text[])
        AND (r.data_agendada IS NULL OR r.data_agendada < now() + interval '${days} days')`,
      order: 'r.data_agendada ASC NULLS FIRST',
    },
    agendadas: {
      where: `status_atual = ANY('{agendado,reagendado}'::text[])
        AND r.data_agendada >= now() + interval '${days} days'`,
      order: 'r.data_agendada ASC',
    },
    em_andamento: { where: `status_atual = 'em_andamento'`, order: 'r.execucao_inicio ASC' },
    concluidas: { where: `status_atual = 'concluido'`, order: 'r.execucao_fim DESC NULLS LAST' },
    canceladas: { where: `status_atual = 'cancelado'`, order: 'r.updated_at DESC' },
  }
}

// O status gravado pode ser um valor antigo: a leitura é sempre pelo normalizado.
const driverTripsFrom = `(
    SELECT r.*, ${normalizedStatusSql('r')} AS status_atual FROM public.service_requests r
     WHERE r.tipo = 'frota' AND r.motorista_id = $1
  ) r
  JOIN public.auth_users solicitante ON solicitante.id = r.solicitante_id`

type CurrentDriver = { id: string; name: string; registration: string | null }

export type DriverInput = {
  name: string
  registration: string | null
  active: boolean
  userId: string | null
}

export class DriverRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  // -------------------------------------------------------------------------
  // O motorista da sessão
  // -------------------------------------------------------------------------

  /** Null quando a conta ainda não tem cadastro ativo vinculado. */
  async driverOf(identity: AuthenticatedIdentity): Promise<CurrentDriver | null> {
    const found = await this.poolProvider().query<{ id: string; nome: string; matricula: string | null }>(
      `SELECT d.id::text AS id, d.nome, d.matricula FROM public.fleet_drivers d
        WHERE d.user_id = $1 AND ${validDriverSql}`,
      [identity.userId],
    )
    const row = found.rows[0]
    return row ? { id: row.id, name: row.nome, registration: row.matricula } : null
  }

  async trips(driverId: string, group: TripGroup, page: number) {
    const pool = this.poolProvider()
    const settings = await readSystemSettings(pool)
    const conditions = groupConditions(settings.driverExecution.upcomingDays)
    const condition = conditions[group]
    const visibleGroups = settings.driverExecution.visibleGroups
    const [rows, totals] = await Promise.all([
      pool.query<TripRow>(
        `SELECT ${tripColumns} FROM ${driverTripsFrom}
          WHERE ${condition.where}
          ORDER BY ${condition.order}, r.id
          LIMIT ${tripPageSize} OFFSET ${(page - 1) * tripPageSize}`,
        [driverId],
      ),
      pool.query<Record<TripGroup, number>>(
        `SELECT ${visibleGroups
          .map((key) => `count(*) FILTER (WHERE ${conditions[key].where})::int AS ${key}`)
          .join(', ')}
           FROM ${driverTripsFrom}`,
        [driverId],
      ),
    ])
    return {
      trips: rows.rows.map((row) => presentTrip(row, settings)),
      counts: totals.rows[0],
      page,
      pageSize: tripPageSize,
    }
  }

  private async findTrip(client: Client, driverId: string, tripId: string, lock = false) {
    const found = await client.query<TripRow>(
      `SELECT ${tripColumns}, r.solicitante_id::text AS solicitante_id
         FROM public.service_requests r
         JOIN public.auth_users solicitante ON solicitante.id = r.solicitante_id
        WHERE r.id = $1 AND r.tipo = 'frota' AND r.motorista_id = $2
        ${lock ? 'FOR UPDATE OF r' : ''}`,
      [tripId, driverId],
    )
    if (!found.rows[0]) throw notFound()
    return found.rows[0] as TripRow & { solicitante_id: string }
  }

  private async occurrencesOf(client: Client, tripId: string, driverId: string) {
    const found = await client.query<{
      id: string
      categoria: string | null
      categoria_nome: string | null
      justificativa: string | null
      descricao: string
      atraso_minutos: number | null
      created_at: Date
      anexos: { id: string; name: string }[]
    }>(
      `SELECT o.id::text AS id, o.categoria, o.categoria_nome, o.justificativa, o.descricao, o.atraso_minutos, o.created_at,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id', f.id::text, 'name', f.nome_original) ORDER BY f.created_at)
                          FROM public.request_occurrence_attachments l
                          JOIN public.request_attachments f ON f.id = l.attachment_id
                         WHERE l.occurrence_id = o.id AND f.removido_em IS NULL), '[]'::jsonb) AS anexos
         FROM public.request_occurrences o
        WHERE o.request_id = $1 AND o.motorista_id = $2
        ORDER BY o.created_at, o.id`,
      [tripId, driverId],
    )
    return found.rows.map((row) => ({
      id: row.id,
      category: row.categoria,
      categoryLabel: row.categoria_nome ?? row.categoria,
      justification: row.justificativa,
      description: row.descricao,
      delayMinutes: row.atraso_minutos,
      at: row.created_at,
      attachments: row.anexos,
    }))
  }

  async trip(driverId: string, tripId: string) {
    const pool = this.poolProvider()
    const row = await this.findTrip(pool, driverId, tripId)
    return { trip: presentTrip(row, await readSystemSettings(pool)), occurrences: await this.occurrencesOf(pool, tripId, driverId) }
  }

  /** Histórico individual: o que o motorista começou a executar, concluiu ou teve cancelado. */
  async history(driverId: string, filters: { from: Date | null; to: Date | null; page: number }) {
    const pool = this.poolProvider()
    const values = [driverId, filters.from, filters.to]
    const settings = await readSystemSettings(pool)
    // Situação fora do portal também fica fora do histórico. A concluída é o próprio histórico.
    const closed = settings.driverExecution.visibleGroups.includes('canceladas') ? '{concluido,cancelado}' : '{concluido}'
    const where = `(r.execucao_inicio IS NOT NULL OR status_atual = ANY('${closed}'::text[]))
      ${closed === '{concluido}' ? `AND status_atual <> 'cancelado'` : ''}
      AND ($2::timestamptz IS NULL OR COALESCE(r.execucao_inicio, r.data_agendada) >= $2)
      AND ($3::timestamptz IS NULL OR COALESCE(r.execucao_inicio, r.data_agendada) <= $3)`
    const [rows, total] = await Promise.all([
      pool.query<TripRow & { ocorrencias: { category: string | null; categoryLabel: string | null; description: string; at: string }[] }>(
        `SELECT ${tripColumns},
                COALESCE((SELECT jsonb_agg(jsonb_build_object('category', o.categoria, 'categoryLabel', COALESCE(o.categoria_nome, o.categoria), 'description', o.descricao, 'at', o.created_at) ORDER BY o.created_at)
                            FROM public.request_occurrences o
                           WHERE o.request_id = r.id AND o.motorista_id = $1), '[]'::jsonb) AS ocorrencias
           FROM ${driverTripsFrom}
          WHERE ${where}
          ORDER BY COALESCE(r.execucao_inicio, r.data_agendada) DESC NULLS LAST, r.id
          LIMIT ${tripPageSize} OFFSET ${(filters.page - 1) * tripPageSize}`,
        values,
      ),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM ${driverTripsFrom} WHERE ${where}`, values),
    ])
    return {
      trips: rows.rows.map((row) => ({ ...presentTrip(row, settings), occurrences: row.ocorrencias })),
      total: total.rows[0].total,
      page: filters.page,
      pageSize: tripPageSize,
    }
  }

  // -------------------------------------------------------------------------
  // Execução. Os horários vêm do servidor: nenhum dado do navegador entra aqui.
  // -------------------------------------------------------------------------

  async start(actor: AuthenticatedIdentity, driver: CurrentDriver, tripId: string, body: Record<string, unknown> = {}) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.findTrip(client, driver.id, tripId, true)
      const status = normalizeStatus('fleet', current.status)
      if (status === 'em_andamento') throw conflict('Esta viagem já foi iniciada.')
      if (current.aguardando_externo_desde) {
        throw conflict('Esta viagem está aguardando uma correção do solicitante. Fale com a equipe de Frota.')
      }
      const next = nextStatus('fleet', status, 'start')
      if (!next) throw conflict('Esta viagem não pode ser iniciada na situação atual.')

      const settings = await readSystemSettings(client)
      const journey = journeyOf(settings)
      const moment = await this.transactionMoment(client)
      const outside = isOutsideJourney(moment, journey)
      if (outside && !settings.driverJourney.allowOutsideStart) {
        throw conflict('Fora da jornada, a viagem não inicia pelo portal. Fale com a equipe de Frota, que pode registrar o início.')
      }
      const record = this.readRecord(body, settings.driverExecution.startFields, { tripHasVehicle: Boolean(text(current.dados.veiculo)) })
      if (outside && settings.driverJourney.outsideStart === 'justify') record.justificativa = this.requireJustification(body)
      const stored = this.protectRecord(record)

      const updated = await client.query<{ execucao_inicio: Date }>(
        `UPDATE public.service_requests
            SET status = $2, execucao_inicio = now(), execucao_fim = NULL,
                execucao_registro = $3::jsonb
          WHERE id = $1 RETURNING execucao_inicio`,
        [tripId, next, JSON.stringify({ jornada: journey, inicio: stored })],
      )
      const startedAt = updated.rows[0].execucao_inicio
      await recordHistory(client, {
        requestId: tripId,
        userId: actor.userId,
        action: 'iniciada',
        from: current.status,
        to: next,
        details: {
          inicioReal: startedAt.toISOString(),
          origem: 'portal_motorista',
          motoristaId: driver.id,
          motorista: driver.name,
          foraDaReferencia: outside,
        },
      })
      await this.recordExecutionData(client, actor, tripId, current.status, next, 'inicio', stored)
      await this.auditTrip(client, actor, 'request_started', tripId, current.solicitante_id, {
        module: 'fleet',
        to: next,
        via: 'portal_motorista',
      })
      await publishIntegrationEvent(client, {
        type: 'request_started',
        key: `${tripId}:started`,
        module: 'fleet',
        resourceId: tripId,
        protocol: current.protocolo,
        actorId: actor.userId,
        requesterId: current.solicitante_id,
        context: { title: current.titulo },
      })
      await publishDriverRuleEvent(client, 'trip_started', {
        type: 'request_started',
        key: `${tripId}:portal-started`,
        module: 'fleet',
        resourceId: tripId,
        protocol: current.protocolo,
        actorId: actor.userId,
        context: { title: current.titulo },
      })
      await requestCalendarSync(client, tripId, 'fleet', 'upsert', { onlyIfTracked: true })
      return { status: next, startedAt }
    })
  }

  /** A jornada nunca impede a finalização: viagem em andamento sempre pode ser encerrada. */
  async finish(actor: AuthenticatedIdentity, driver: CurrentDriver, tripId: string, body: Record<string, unknown> = {}) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.findTrip(client, driver.id, tripId, true)
      const status = normalizeStatus('fleet', current.status)
      if (status === 'concluido') throw conflict('Esta viagem já foi finalizada.')
      const next = nextStatus('fleet', status, 'complete')
      if (!next) throw conflict('Só é possível finalizar uma viagem em andamento.')

      const settings = await readSystemSettings(client)
      const journey = journeyOfRecord(current.execucao_registro)
      const record = this.readRecord(body, settings.driverExecution.finishFields)
      const startOdometer = (current.execucao_registro?.inicio as ExecutionRecord | undefined)?.hodometro
      if (record.hodometro !== undefined && startOdometer !== undefined && record.hodometro < startOdometer) {
        throw new ModuleError(`O hodômetro final não pode ser menor que o inicial (${startOdometer}).`, 400)
      }
      const moment = await this.transactionMoment(client)
      if (settings.driverJourney.outsideFinish === 'justify' && isOutsideJourney(moment, journey)) {
        record.justificativa = this.requireJustification(body)
      }
      const stored = this.protectRecord(record)

      const updated = await client.query<{ execucao_fim: Date }>(
        `UPDATE public.service_requests
            SET status = $2, execucao_fim = now(), concluida_em = now(),
                execucao_registro = COALESCE(execucao_registro, '{}'::jsonb) || jsonb_build_object('fim', $3::jsonb)
          WHERE id = $1 RETURNING execucao_fim`,
        [tripId, next, JSON.stringify(stored)],
      )
      const finishedAt = updated.rows[0].execucao_fim
      const timing = { startedAt: current.execucao_inicio, finishedAt }
      const durationMinutes = effectiveMinutes(timing)
      await recordHistory(client, {
        requestId: tripId,
        userId: actor.userId,
        action: 'concluida',
        from: current.status,
        to: next,
        details: {
          fimReal: finishedAt.toISOString(),
          origem: 'portal_motorista',
          motoristaId: driver.id,
          motorista: driver.name,
          duracaoMinutos: durationMinutes,
          foraDaReferencia: exceedsJourney(timing, finishedAt, journey),
        },
      })
      await this.recordExecutionData(client, actor, tripId, current.status, next, 'fim', stored)
      await this.auditTrip(client, actor, 'request_completed', tripId, current.solicitante_id, {
        module: 'fleet',
        to: next,
        via: 'portal_motorista',
      })
      await publishIntegrationEvent(client, {
        type: 'request_completed',
        key: `${tripId}:completed`,
        module: 'fleet',
        resourceId: tripId,
        protocol: current.protocolo,
        actorId: actor.userId,
        requesterId: current.solicitante_id,
        context: { title: current.titulo },
      })
      await publishDriverRuleEvent(client, 'trip_finished', {
        type: 'request_completed',
        key: `${tripId}:portal-completed`,
        module: 'fleet',
        resourceId: tripId,
        protocol: current.protocolo,
        actorId: actor.userId,
        context: { title: current.titulo },
      })
      await requestCalendarSync(client, tripId, 'fleet', 'upsert', { onlyIfTracked: true })
      return { status: next, finishedAt, durationMinutes }
    })
  }

  async addOccurrence(
    actor: AuthenticatedIdentity,
    driver: CurrentDriver,
    tripId: string,
    input: { type: OccurrenceType; description: string; justification: string | null; delayMinutes: number | null },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.findTrip(client, driver.id, tripId, true)
      const status = normalizeStatus('fleet', current.status)
      if (!occurrenceStatuses.includes(status)) {
        throw conflict('Esta viagem não recebe novas ocorrências.')
      }
      const description = redactValidCpf(input.description)
      const justification = input.justification ? redactValidCpf(input.justification) : null
      const created = await client.query<{ id: string }>(
        `INSERT INTO public.request_occurrences
          (request_id, tipo, categoria, categoria_nome, justificativa, descricao, atraso_minutos, registrado_por, motorista_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id::text AS id`,
        [
          tripId,
          input.type.asksDelay ? 'atraso' : 'ocorrencia',
          input.type.key,
          input.type.label,
          justification,
          description,
          input.delayMinutes,
          actor.userId,
          driver.id,
        ],
      )
      const occurrenceId = created.rows[0].id
      await recordHistory(client, {
        requestId: tripId,
        userId: actor.userId,
        action: 'ocorrencia_motorista',
        from: current.status,
        to: current.status,
        comment: description,
        details: {
          categoria: input.type.key,
          categoriaNome: input.type.label,
          motorista: driver.name,
          ...(justification ? { justificativa: justification } : {}),
          ...(input.delayMinutes ? { atrasoMinutos: input.delayMinutes } : {}),
        },
      })
      await this.auditTrip(client, actor, 'request_occurrence', tripId, current.solicitante_id, {
        module: 'fleet',
        type: input.type.key,
        via: 'portal_motorista',
      })
      // Vai só para a equipe: o texto do motorista é operacional, e não uma resposta ao solicitante.
      if ((await readSystemSettings(client)).driverNotifications.rules.occurrence?.team) {
        await publishIntegrationEvent(client, {
          type: 'request_occurrence',
          key: `${tripId}:occurrence:${occurrenceId}`,
          module: 'fleet',
          resourceId: tripId,
          protocol: current.protocolo,
          actorId: actor.userId,
          context: { title: current.titulo, delayMinutes: input.delayMinutes },
        })
      }
      return occurrenceId
    })
  }

  /** Confere se a ocorrência é deste motorista e desta viagem, antes de receber um arquivo. */
  async assertOwnOccurrence(driverId: string, tripId: string, occurrenceId: string) {
    const found = await this.poolProvider().query<{ categoria: string | null }>(
      `SELECT o.categoria FROM public.request_occurrences o
        JOIN public.service_requests r ON r.id = o.request_id
       WHERE o.id = $1 AND o.request_id = $2 AND o.motorista_id = $3 AND r.motorista_id = $3`,
      [occurrenceId, tripId, driverId],
    )
    if (found.rows.length === 0) throw notFound()
    return found.rows[0].categoria
  }

  async linkOccurrenceAttachment(occurrenceId: string, attachmentId: string) {
    await this.poolProvider().query(
      `INSERT INTO public.request_occurrence_attachments (occurrence_id, attachment_id) VALUES ($1, $2)`,
      [occurrenceId, attachmentId],
    )
  }

  // -------------------------------------------------------------------------
  // Cadastro de motoristas, na Frota
  // -------------------------------------------------------------------------

  async listDrivers() {
    const found = await this.poolProvider().query<{
      id: string
      nome: string
      matricula: string | null
      ativo: boolean
      user_id: string | null
      conta_nome: string | null
      conta_email: string | null
      valido: boolean
      viagens_abertas: number
    }>(
      `SELECT d.id::text AS id, d.nome, d.matricula, d.ativo, d.user_id::text AS user_id,
              u.full_name AS conta_nome, u.email AS conta_email, (${validDriverSql}) AS valido,
              (SELECT count(*)::int FROM public.service_requests r
                WHERE r.motorista_id = d.id AND ${normalizedStatusSql('r')} = ANY('{agendado,reagendado,em_andamento}'::text[])) AS viagens_abertas
         FROM public.fleet_drivers d
         LEFT JOIN public.auth_users u ON u.id = d.user_id
        ORDER BY d.ativo DESC, d.nome`,
    )
    return found.rows.map((row) => ({
      id: row.id,
      name: row.nome,
      registration: row.matricula,
      active: row.ativo,
      userId: row.user_id,
      accountName: row.conta_nome,
      accountEmail: row.conta_email,
      canReceiveTrips: row.valido,
      openTrips: row.viagens_abertas,
    }))
  }

  /** Só nomes, de quem pode receber viagens de fato. */
  async listAssignable() {
    const found = await this.poolProvider().query<{ id: string; nome: string; matricula: string | null }>(
      `SELECT d.id::text AS id, d.nome, d.matricula FROM public.fleet_drivers d WHERE ${validDriverSql} ORDER BY d.nome`,
    )
    return found.rows.map((row) => ({ id: row.id, name: row.nome, registration: row.matricula }))
  }

  /** Contas de perfil Motorista ainda sem cadastro. Definir o perfil é da administração de usuários. */
  async listLinkableAccounts() {
    const found = await this.poolProvider().query<{ id: string; full_name: string; email: string }>(
      `SELECT u.id::text AS id, u.full_name, u.email
         FROM public.auth_users u
         JOIN public.auth_user_access a ON a.user_id = u.id
        WHERE u.status = 'approved' AND a.profile = 'driver'
          AND NOT EXISTS (SELECT 1 FROM public.fleet_drivers d WHERE d.user_id = u.id)
        ORDER BY u.full_name`,
    )
    return found.rows.map((row) => ({ id: row.id, name: row.full_name, email: row.email }))
  }

  private async assertLinkable(client: Client, userId: string) {
    const found = await client.query(
      `SELECT 1 FROM public.auth_users u
         JOIN public.auth_user_access a ON a.user_id = u.id
        WHERE u.id = $1 AND u.status = 'approved' AND a.profile = 'driver'`,
      [userId],
    )
    if (found.rows.length === 0) {
      throw new ModuleError('A conta precisa estar ativa e ter o perfil Motorista, definido em Usuários.', 400)
    }
  }

  private duplicated(error: unknown) {
    if ((error as { code?: unknown }).code !== '23505') return error
    return conflict(
      String((error as { constraint?: unknown }).constraint).includes('user_id')
        ? 'Esta conta já está vinculada a outro motorista.'
        : 'Já existe um motorista com esta matrícula.',
    )
  }

  async createDriver(actor: AuthenticatedIdentity, input: DriverInput) {
    try {
      return await withTransaction(this.poolProvider(), async (client) => {
        if (input.userId) await this.assertLinkable(client, input.userId)
        const created = await client.query<{ id: string }>(
          `INSERT INTO public.fleet_drivers (nome, matricula, ativo, user_id, criado_por)
           VALUES ($1, $2, $3, $4, $5) RETURNING id::text AS id`,
          [redactValidCpf(input.name), input.registration, input.active, input.userId, actor.userId],
        )
        const id = created.rows[0].id
        await insertAuthAuditEvent(client, {
          actorUserId: actor.userId,
          actorKind: 'user',
          subjectUserId: input.userId,
          sessionId: id,
          eventType: 'fleet_driver_changed',
          details: { operation: 'created', active: String(input.active), linked: String(Boolean(input.userId)) },
        })
        return id
      })
    } catch (error) {
      throw this.duplicated(error)
    }
  }

  async updateDriver(actor: AuthenticatedIdentity, id: string, input: DriverInput) {
    try {
      await withTransaction(this.poolProvider(), async (client) => {
        const found = await client.query<{ user_id: string | null; ativo: boolean }>(
          `SELECT user_id::text AS user_id, ativo FROM public.fleet_drivers WHERE id = $1 FOR UPDATE`,
          [id],
        )
        const current = found.rows[0]
        if (!current) throw notFound()
        const losesAccess = (current.ativo && !input.active) || (current.user_id !== null && current.user_id !== input.userId)
        if (losesAccess) {
          // Viagem em aberto ficaria sem quem a execute, e a em andamento não poderia ser finalizada.
          const open = await client.query(
            `SELECT 1 FROM public.service_requests r
              WHERE r.motorista_id = $1 AND ${normalizedStatusSql('r')} = ANY('{agendado,reagendado,em_andamento}'::text[])
              LIMIT 1`,
            [id],
          )
          if (open.rows.length > 0) {
            throw conflict('Este motorista tem viagens em aberto. Reatribua ou encerre as viagens antes.')
          }
        }
        if (input.userId && input.userId !== current.user_id) await this.assertLinkable(client, input.userId)
        await client.query(
          `UPDATE public.fleet_drivers SET nome = $2, matricula = $3, ativo = $4, user_id = $5 WHERE id = $1`,
          [id, redactValidCpf(input.name), input.registration, input.active, input.userId],
        )
        await insertAuthAuditEvent(client, {
          actorUserId: actor.userId,
          actorKind: 'user',
          subjectUserId: input.userId ?? current.user_id,
          sessionId: id,
          eventType: 'fleet_driver_changed',
          details: { operation: 'updated', active: String(input.active), linked: String(Boolean(input.userId)) },
        })
      })
    } catch (error) {
      throw this.duplicated(error)
    }
  }

  // -------------------------------------------------------------------------
  // Atribuição e consulta pela equipe da Frota
  // -------------------------------------------------------------------------

  private async driverConflicts(client: Client, requestId: string, driverId: string, start: Date, end: Date | null): Promise<ScheduleConflict[]> {
    const found = await client.query<{ id: string; protocolo: string; data_agendada: Date; agendamento_fim: Date | null }>(
      `SELECT r.id::text AS id, ${protocolSql('r')} AS protocolo, r.data_agendada, r.agendamento_fim
         FROM public.service_requests r
        WHERE r.id <> $1 AND r.motorista_id = $2 AND r.status = ANY($5::text[]) AND r.data_agendada IS NOT NULL
          AND ((r.data_agendada < COALESCE($4::timestamptz, $3::timestamptz)
                AND $3::timestamptz < COALESCE(r.agendamento_fim, r.data_agendada))
               OR r.data_agendada = $3::timestamptz)
        ORDER BY r.data_agendada, r.id
        LIMIT 20`,
      [requestId, driverId, start, end, occupyingStatuses],
    )
    return found.rows.map((row) => ({
      id: row.id,
      protocol: row.protocolo,
      module: 'fleet',
      reason: 'driver',
      start: row.data_agendada,
      end: row.agendamento_fim,
    }))
  }

  async assign(
    actor: AuthenticatedIdentity,
    requestId: string,
    input: { driverId: string | null; notes: string | null; confirmConflicts: boolean },
  ) {
    await withTransaction(this.poolProvider(), async (client) => {
      const found = await client.query<{
        status: string
        protocolo: string
        titulo: string
        data_agendada: Date | null
        agendamento_fim: Date | null
        solicitante_id: string
        motorista_id: string | null
        motorista_observacoes: string | null
        motorista_nome: string | null
        motorista_user_id: string | null
      }>(
        `SELECT r.status, ${protocolSql('r')} AS protocolo, r.titulo, r.data_agendada, r.agendamento_fim,
                r.solicitante_id::text AS solicitante_id, r.motorista_id::text AS motorista_id, r.motorista_observacoes,
                d.nome AS motorista_nome, d.user_id::text AS motorista_user_id
           FROM public.service_requests r
           LEFT JOIN public.fleet_drivers d ON d.id = r.motorista_id
          WHERE r.id = $1 AND r.tipo = 'frota'
          FOR UPDATE OF r`,
        [requestId],
      )
      const current = found.rows[0]
      if (!current) throw notFound()
      const status = normalizeStatus('fleet', current.status)
      if (!assignableStatuses.includes(status) || !current.data_agendada) {
        throw conflict('Só é possível atribuir motorista a uma viagem agendada e ainda não iniciada.')
      }

      const notes = input.notes ? redactOptional(input.notes) : null
      const sameDriver = current.motorista_id === input.driverId
      if (sameDriver && (current.motorista_observacoes ?? null) === notes) return

      let chosen: { nome: string; user_id: string } | null = null
      if (input.driverId) {
        const driver = await client.query<{ nome: string; user_id: string }>(
          `SELECT d.nome, d.user_id::text AS user_id FROM public.fleet_drivers d WHERE d.id = $1 AND ${validDriverSql}`,
          [input.driverId],
        )
        chosen = driver.rows[0] ?? null
        if (!chosen) throw new ModuleError('O motorista precisa estar ativo e ter uma conta de acesso vinculada.', 400)
        if (chosen.user_id === actor.userId) throw forbidden()

        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`agenda-motorista:${input.driverId}`])
        const conflicts = await this.driverConflicts(client, requestId, input.driverId, current.data_agendada, current.agendamento_fim)
        if (conflicts.length > 0 && !input.confirmConflicts) throw new ScheduleConflictError(conflicts)
      }

      await client.query(
        `UPDATE public.service_requests SET motorista_id = $2, motorista_observacoes = $3 WHERE id = $1`,
        [requestId, input.driverId, input.driverId ? notes : null],
      )
      await recordHistory(client, {
        requestId,
        userId: actor.userId,
        action: input.driverId ? (sameDriver ? 'motorista_orientacao_alterada' : 'motorista_atribuido') : 'motorista_removido',
        from: current.status,
        to: current.status,
        details: {
          motoristaId: input.driverId,
          ...(sameDriver
            ? {}
            : { alteracoes: [{ campo: 'Motorista', de: current.motorista_nome, para: chosen?.nome ?? null }] }),
        },
      })
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: chosen?.user_id ?? current.motorista_user_id,
        sessionId: requestId,
        eventType: 'trip_driver_assigned',
        details: {
          ...(current.motorista_nome ? { from: current.motorista_nome } : {}),
          ...(chosen ? { to: chosen.nome } : {}),
        },
      })

      const scheduledAt = current.data_agendada.toISOString()
      const context = { title: current.titulo, scheduledAt }
      const stamp = Date.now()
      if (!sameDriver && current.motorista_user_id) {
        await publishDriverRuleEvent(client, 'trip_unassigned', {
          type: 'trip_unassigned',
          key: `${requestId}:driver-removed:${current.motorista_id}:${stamp}`,
          module: 'fleet',
          resourceId: requestId,
          protocol: current.protocolo,
          actorId: actor.userId,
          driverUserId: current.motorista_user_id,
          context,
        })
      }
      if (chosen) {
        await publishDriverRuleEvent(client, sameDriver ? 'other_changed' : 'trip_assigned', {
          type: sameDriver ? 'trip_updated' : 'trip_assigned',
          key: `${requestId}:driver:${input.driverId}:${stamp}`,
          module: 'fleet',
          resourceId: requestId,
          protocol: current.protocolo,
          actorId: actor.userId,
          driverUserId: chosen.user_id,
          context,
        })
      }
    })
  }

  /** O que a equipe consulta na solicitação. Sem a migração 016, responde que ainda não há portal. */
  async execution(requestId: string) {
    const pool = this.poolProvider()
    const found = await pool.query<{
      motorista_id: string | null
      motorista_nome: string | null
      motorista_matricula: string | null
      motorista_observacoes: string | null
      execucao_inicio: Date | null
      execucao_fim: Date | null
      execucao_registro: { inicio?: ExecutionRecord; fim?: ExecutionRecord } | null
    }>(
      `SELECT r.motorista_id::text AS motorista_id, d.nome AS motorista_nome, d.matricula AS motorista_matricula,
              r.motorista_observacoes, r.execucao_inicio, r.execucao_fim, r.execucao_registro
         FROM public.service_requests r
         LEFT JOIN public.fleet_drivers d ON d.id = r.motorista_id
        WHERE r.id = $1 AND r.tipo = 'frota'`,
      [requestId],
    )
    const row = found.rows[0]
    if (!row) throw notFound()
    const timing = { startedAt: row.execucao_inicio, finishedAt: row.execucao_fim }
    const journey = journeyOfRecord(row.execucao_registro)

    const [occurrences, corrections] = await Promise.all([
      pool.query<{
        id: string
        categoria: string | null
        categoria_nome: string | null
        justificativa: string | null
        descricao: string
        atraso_minutos: number | null
        created_at: Date
        motorista: string | null
        anexos: { id: string; name: string }[]
      }>(
        `SELECT o.id::text AS id, o.categoria, o.categoria_nome, o.justificativa, o.descricao, o.atraso_minutos, o.created_at, d.nome AS motorista,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('id', f.id::text, 'name', f.nome_original) ORDER BY f.created_at)
                            FROM public.request_occurrence_attachments l
                            JOIN public.request_attachments f ON f.id = l.attachment_id
                           WHERE l.occurrence_id = o.id AND f.removido_em IS NULL), '[]'::jsonb) AS anexos
           FROM public.request_occurrences o
           JOIN public.fleet_drivers d ON d.id = o.motorista_id
          WHERE o.request_id = $1
          ORDER BY o.created_at, o.id`,
        [requestId],
      ),
      pool.query<{
        id: string
        inicio_anterior: Date | null
        fim_anterior: Date | null
        inicio_novo: Date | null
        fim_novo: Date | null
        motivo: string
        usuario: string
        created_at: Date
      }>(
        `SELECT c.id::text AS id, c.inicio_anterior, c.fim_anterior, c.inicio_novo, c.fim_novo, c.motivo,
                u.full_name AS usuario, c.created_at
           FROM public.fleet_execution_corrections c
           JOIN public.auth_users u ON u.id = c.corrigido_por
          WHERE c.request_id = $1
          ORDER BY c.created_at, c.id`,
        [requestId],
      ),
    ])

    return {
      driver: row.motorista_id ? { id: row.motorista_id, name: row.motorista_nome, registration: row.motorista_matricula } : null,
      notes: row.motorista_observacoes,
      startedAt: row.execucao_inicio,
      finishedAt: row.execucao_fim,
      durationMinutes: effectiveMinutes(timing),
      exceedsJourney: exceedsJourney(timing, new Date(), journey),
      journeyReference: { start: journey.start, end: journey.end },
      startRecord: row.execucao_registro?.inicio ?? null,
      finishRecord: row.execucao_registro?.fim ?? null,
      occurrences: occurrences.rows.map((item) => ({
        id: item.id,
        category: item.categoria,
        categoryLabel: item.categoria_nome ?? item.categoria,
        justification: item.justificativa,
        description: item.descricao,
        delayMinutes: item.atraso_minutos,
        at: item.created_at,
        driver: item.motorista,
        attachments: item.anexos,
      })),
      corrections: corrections.rows.map((item) => ({
        id: item.id,
        previousStart: item.inicio_anterior,
        previousEnd: item.fim_anterior,
        newStart: item.inicio_novo,
        newEnd: item.fim_novo,
        reason: item.motivo,
        user: item.usuario,
        at: item.created_at,
      })),
    }
  }

  /** Correção autorizada: os valores anteriores ficam em um registro que não muda. */
  async correctExecution(
    actor: AuthenticatedIdentity,
    requestId: string,
    input: { start: Date | null; end: Date | null; reason: string },
  ) {
    await withTransaction(this.poolProvider(), async (client) => {
      const found = await client.query<{ status: string; solicitante_id: string; execucao_inicio: Date | null; execucao_fim: Date | null }>(
        `SELECT status, solicitante_id::text AS solicitante_id, execucao_inicio, execucao_fim
           FROM public.service_requests WHERE id = $1 AND tipo = 'frota' FOR UPDATE`,
        [requestId],
      )
      const current = found.rows[0]
      if (!current) throw notFound()
      const status: RequestStatus = normalizeStatus('fleet', current.status)
      if (!current.execucao_inicio) throw conflict('Esta viagem ainda não tem horários registrados para corrigir.')

      const start = input.start ?? current.execucao_inicio
      const end = input.end ?? current.execucao_fim
      if (input.end && status !== 'concluido') {
        throw conflict('O término só pode ser corrigido depois de a viagem ser finalizada.')
      }
      if (end && end < start) throw new ModuleError('O término não pode ser anterior ao início.', 400)
      const unchanged = start.getTime() === current.execucao_inicio.getTime() && end?.getTime() === current.execucao_fim?.getTime()
      if (unchanged) throw new ModuleError('Informe um horário diferente do registrado.', 400)

      const reason = redactValidCpf(input.reason)
      await client.query(
        `INSERT INTO public.fleet_execution_corrections
          (request_id, inicio_anterior, fim_anterior, inicio_novo, fim_novo, motivo, corrigido_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [requestId, current.execucao_inicio, current.execucao_fim, start, end, reason, actor.userId],
      )
      await client.query(`UPDATE public.service_requests SET execucao_inicio = $2, execucao_fim = $3 WHERE id = $1`, [requestId, start, end])

      const changes = [
        ...(start.getTime() !== current.execucao_inicio.getTime()
          ? [{ campo: 'Início efetivo', de: current.execucao_inicio.toISOString(), para: start.toISOString() }]
          : []),
        ...(end?.getTime() !== current.execucao_fim?.getTime()
          ? [{ campo: 'Término efetivo', de: current.execucao_fim?.toISOString() ?? null, para: end?.toISOString() ?? null }]
          : []),
      ]
      await recordHistory(client, {
        requestId,
        userId: actor.userId,
        action: 'execucao_corrigida',
        from: current.status,
        to: current.status,
        comment: reason,
        details: { alteracoes: changes },
      })
      await this.auditTrip(client, actor, 'trip_execution_corrected', requestId, current.solicitante_id, {
        module: 'fleet',
        ...(changes[0] ? { from: changes[0].de ?? '', to: changes[0].para ?? '' } : {}),
        fields: changes.map((change) => change.campo),
      })
    })
  }

  // -------------------------------------------------------------------------
  // Apoio às rotas da Frota. Sem a migração, nada muda nessas telas.
  // -------------------------------------------------------------------------

  async driverNames(requestIds: readonly string[]) {
    if (requestIds.length === 0) return new Map<string, string>()
    const found = await this.poolProvider().query<{ id: string; nome: string }>(
      `SELECT r.id::text AS id, d.nome FROM public.service_requests r
         JOIN public.fleet_drivers d ON d.id = r.motorista_id
        WHERE r.id = ANY($1::uuid[])`,
      [requestIds],
    )
    return new Map(found.rows.map((row) => [row.id, row.nome]))
  }

  async driverOccurrenceIds(requestId: string) {
    const found = await this.poolProvider().query<{ id: string }>(
      `SELECT id::text AS id FROM public.request_occurrences WHERE request_id = $1 AND motorista_id IS NOT NULL`,
      [requestId],
    )
    return new Set(found.rows.map((row) => row.id))
  }

  private async transactionMoment(client: Client) {
    const found = await client.query<{ now: Date }>(`SELECT now() AS now`)
    return found.rows[0].now
  }

  /** Dentro da transação, só erro de regra de negócio chega à pessoa com a mensagem intacta. */
  private readRecord(...args: Parameters<typeof readExecutionRecord>) {
    try {
      return readExecutionRecord(...args)
    } catch (error) {
      if (error instanceof RequestValidationError) throw new ModuleError(error.message, 400)
      throw error
    }
  }

  private requireJustification(body: Record<string, unknown>) {
    const justification = readJustification(body.justificativa)
    if (!justification) {
      throw new ModuleError('Fora da jornada, informe a justificativa.', 400, 'JOURNEY_JUSTIFICATION_REQUIRED')
    }
    return justification
  }

  private protectRecord(record: ExecutionRecord): ExecutionRecord {
    return {
      ...record,
      ...(record.observacao ? { observacao: redactValidCpf(record.observacao) } : {}),
      ...(record.justificativa ? { justificativa: redactValidCpf(record.justificativa) } : {}),
    }
  }

  /** Só para a equipe: o relato do motorista não entra no histórico que o solicitante acompanha. */
  private async recordExecutionData(
    client: Client,
    actor: AuthenticatedIdentity,
    tripId: string,
    from: string,
    to: string,
    step: 'inicio' | 'fim',
    record: ExecutionRecord,
  ) {
    if (Object.keys(record).length === 0) return
    await recordHistory(client, {
      requestId: tripId,
      userId: actor.userId,
      action: 'execucao_dados_motorista',
      from,
      to,
      details: { etapa: step, ...record },
    })
  }

  private async auditTrip(
    client: Client,
    actor: AuthenticatedIdentity,
    eventType: 'request_started' | 'request_completed' | 'request_occurrence' | 'trip_execution_corrected',
    requestId: string,
    requesterId: string,
    details: Record<string, string | readonly string[]>,
  ) {
    await insertAuthAuditEvent(client, {
      actorUserId: actor.userId,
      actorKind: 'user',
      subjectUserId: requesterId,
      sessionId: requestId,
      eventType,
      details,
    })
  }
}
