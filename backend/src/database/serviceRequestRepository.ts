import type { Pool, PoolClient } from 'pg'
import { resolveRequestOwnership } from '../auth/requestPolicy.js'
import type { RequestModule } from '../auth/requestPolicy.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { flightEventFor } from '../integrations/catalog.js'
import { publishIntegrationEvent, publishTripDriverEvent, requestCalendarSync } from '../integrations/publisher.js'
import { redactOptional, redactValidCpf } from '../integrations/redaction.js'
import { encryptCpf } from '../requests/cpfProtection.js'
import { describeChanges, importantFields, requiresJustification } from '../requests/changeRules.js'
import { compareDuplicate } from '../requests/duplicateRules.js'
import type { DuplicateProbe } from '../requests/duplicateRules.js'
import {
  canReturnFromStatus,
  classifyScheduleChange,
  correctableFields,
  differsFromRequest,
  preserveOriginalRequest,
  requestedSchedule,
  requestTiming,
  resolveJustification,
} from '../requests/justificationRules.js'
import type { ReasonOption, ResolvedJustification } from '../requests/justificationRules.js'
import { journeyOf } from '../requests/driverPortalRules.js'
import type { DriverNotificationEvent } from '../requests/driverPortalRules.js'
import { defaultDeadline } from '../requests/settingsRules.js'
import { likePattern, maxPassengers, RequestValidationError } from '../requests/validation.js'
import type { ValidatedPassenger } from '../requests/validation.js'
import {
  initialStatusOf,
  isTerminalStatus,
  moduleTypes,
  nextStatus,
  normalizeStatus,
  storedValuesFor,
} from '../requests/workflow.js'
import type { RequestAction, RequestStatus } from '../requests/workflow.js'
import { maskCpf } from '../auth/requestPolicy.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import type { AuthAuditEventType } from './authAuditRepository.js'
import {
  findSectorIdByName,
  requireActiveOption,
  requireActiveSector,
} from './catalogRepository.js'
import {
  conflict,
  forbidden,
  ModuleError,
  notFound,
  ScheduleConflictError,
} from './moduleErrors.js'
import type { ScheduleConflict } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { optionalColumnSql, protocolSql } from './protocolSql.js'
import { readSystemSettings } from './settingsRepository.js'
import { withTransaction } from './withTransaction.js'

const pageSize = 25

export type RequestFilters = {
  status?: RequestStatus
  tripType?: string
  search?: string
  from?: Date | null
  to?: Date | null
  page?: number
}

type RequestRow = {
  id: string
  protocolo: string
  tipo: string
  status: string
  solicitante_id: string
  solicitante_nome: string
  solicitante_email: string
  aberto_por_nome: string | null
  em_nome_de_outro_setor: boolean
  setor_id: string | null
  setor_nome: string | null
  andar_id: string | null
  andar_nome: string | null
  tipo_servico_id: string | null
  tipo_servico_nome: string | null
  titulo: string
  descricao: string | null
  prioridade: string
  dados: Record<string, unknown>
  data_agendada: Date | null
  agendamento_fim: Date | null
  agendado_por_nome: string | null
  responsavel_id: string | null
  responsavel_nome: string | null
  observacao_operador: string | null
  execucao_inicio: Date | null
  execucao_fim: Date | null
  concluida_em: Date | null
  motivo_cancelamento: string | null
  created_at: Date
  updated_at: Date
  prazo_em: string | null
  complexidade: string | null
  aguardando_externo_desde: string | null
  espera_externa_segundos: string | null
}

/** Dentro de uma transação, erro de validação precisa atravessá-la com a mensagem intacta. */
function resolveInTransaction(
  options: readonly ReasonOption[],
  input: { code: unknown; text: unknown },
  rules: { required: boolean; missingMessage: string },
) {
  try {
    return resolveJustification(options, input, rules)
  } catch (error) {
    if (error instanceof RequestValidationError) throw new ModuleError(error.message, 400)
    throw error
  }
}

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null

const requestSelect = `
  SELECT r.id::text AS id, ${protocolSql('r')} AS protocolo, r.tipo, r.status,
         r.solicitante_id::text AS solicitante_id,
         solicitante.full_name AS solicitante_nome,
         solicitante.email AS solicitante_email,
         aberto.full_name AS aberto_por_nome,
         r.em_nome_de_outro_setor,
         r.setor_id::text AS setor_id, r.setor_nome,
         r.andar_id::text AS andar_id, r.andar_nome,
         r.tipo_servico_id::text AS tipo_servico_id, r.tipo_servico_nome,
         r.titulo, r.descricao, r.prioridade, r.dados,
         r.data_agendada, r.agendamento_fim,
         agendou.full_name AS agendado_por_nome,
         r.responsavel_id::text AS responsavel_id,
         responsavel.full_name AS responsavel_nome,
         r.observacao_operador, r.execucao_inicio, r.execucao_fim, r.concluida_em,
         r.motivo_cancelamento, r.created_at, r.updated_at,
         ${optionalColumnSql('r', 'prazo_em')} AS prazo_em,
         ${optionalColumnSql('r', 'complexidade')} AS complexidade,
         ${optionalColumnSql('r', 'aguardando_externo_desde')} AS aguardando_externo_desde,
         ${optionalColumnSql('r', 'espera_externa_segundos')} AS espera_externa_segundos
    FROM public.service_requests r
    JOIN public.auth_users solicitante ON solicitante.id = r.solicitante_id
    LEFT JOIN public.auth_users aberto ON aberto.id = r.aberto_por
    LEFT JOIN public.auth_users agendou ON agendou.id = r.agendado_por
    LEFT JOIN public.auth_users responsavel ON responsavel.id = r.responsavel_id`

function toRequest(module: RequestModule, row: RequestRow) {
  return {
    id: row.id,
    protocol: row.protocolo,
    module,
    status: normalizeStatus(module, row.status),
    requester: {
      id: row.solicitante_id,
      name: row.solicitante_nome,
      email: row.solicitante_email,
    },
    openedBy: row.aberto_por_nome,
    onBehalf: row.em_nome_de_outro_setor,
    sector: row.setor_nome,
    sectorId: row.setor_id,
    floor: row.andar_nome,
    floorId: row.andar_id,
    serviceType: row.tipo_servico_nome,
    serviceTypeId: row.tipo_servico_id,
    title: row.titulo,
    description: row.descricao,
    priority: row.prioridade,
    deadline: row.prazo_em,
    complexity: row.complexidade,
    details: row.dados,
    scheduledAt: row.data_agendada,
    scheduledEnd: row.agendamento_fim,
    scheduledBy: row.agendado_por_nome,
    responsibleId: row.responsavel_id,
    responsible: row.responsavel_nome,
    operatorNote: row.observacao_operador,
    startedAt: row.execucao_inicio,
    finishedAt: row.execucao_fim,
    concludedAt: row.concluida_em,
    cancelReason: row.motivo_cancelamento,
    waitingSince: row.aguardando_externo_desde,
    timing: requestTiming({
      createdAt: row.created_at,
      closedAt: row.concluida_em,
      pausedSeconds: Number(row.espera_externa_segundos ?? 0),
      waitingSince: row.aguardando_externo_desde ? new Date(row.aguardando_externo_desde) : null,
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export type ServiceRequest = ReturnType<typeof toRequest>

export type RequestScopeRow = {
  id: string
  requesterId: string
  status: RequestStatus
}

export async function recordHistory(
  client: Pick<PoolClient, 'query'>,
  input: {
    requestId: string
    userId: string
    action: string
    from: string | null
    to: string | null
    comment?: string | null
    details?: Record<string, unknown>
  },
) {
  await client.query(
    `INSERT INTO public.request_history
      (request_id, usuario_id, acao, status_anterior, status_novo, comentario, detalhes)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.requestId,
      input.userId,
      input.action,
      input.from,
      input.to,
      redactOptional(input.comment ?? null),
      JSON.stringify(input.details ?? {}),
    ],
  )
}

/**
 * Guarda na viagem a jornada vigente ao iniciar: mudar a jornada depois não reescreve o passado.
 * Sem a migração 017, a coluna não existe, e a Frota segue igual.
 */
export async function stampTripJourney(client: Pick<PoolClient, 'query'>, requestId: string) {
  const schema = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.driver_occurrence_types') IS NOT NULL AS present`,
  )
  if (!schema.rows[0]?.present) return
  await client.query(
    `UPDATE public.service_requests
        SET execucao_registro = COALESCE(execucao_registro, '{}'::jsonb) || jsonb_build_object('jornada', $2::jsonb)
      WHERE id = $1`,
    [requestId, JSON.stringify(journeyOf(await readSystemSettings(client)))],
  )
}

/** Qual regra de notificação do portal vale para a edição de uma viagem. */
function tripEditRules(changed: readonly string[]): DriverNotificationEvent[] {
  const rules: DriverNotificationEvent[] = []
  if (changed.includes('destino')) rules.push('destination_changed')
  if (changed.includes('dataHora') || changed.includes('dataHoraRetorno')) rules.push('time_changed')
  return rules.length > 0 ? rules : ['other_changed']
}

async function audit(
  client: Pick<PoolClient, 'query'>,
  actor: AuthenticatedIdentity,
  eventType: AuthAuditEventType,
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

async function resolveSector(
  client: Pick<PoolClient, 'query'>,
  actor: AuthenticatedIdentity,
  module: RequestModule,
  sectorId: string | null,
) {
  const chosen = sectorId ? await requireActiveSector(client, sectorId) : null
  const ownership = resolveRequestOwnership(actor, {
    module,
    targetSector: chosen?.name,
  })
  if (!ownership) throw forbidden()

  return {
    ...ownership,
    sectorId: chosen?.id ?? (await findSectorIdByName(client, ownership.sector)),
  }
}

function encryptedPassengers(passengers: readonly ValidatedPassenger[]) {
  return passengers.map((passenger) => ({
    id: passenger.id,
    name: passenger.name,
    cpf: passenger.cpf
      ? { encrypted: encryptCpf(passenger.cpf), masked: maskCpf(passenger.cpf) }
      : null,
  }))
}

export type NewRequest = {
  title: string
  description: string | null
  priority: string
  sectorId: string | null
  floorId: string | null
  serviceTypeId?: string | null
  details: Record<string, unknown>
  lgpdAccepted: boolean
  passengers?: readonly ValidatedPassenger[]
  /** Versão do aviso de privacidade exibido no formulário. Fica no histórico. */
  privacyNotice?: string | null
  /** Versão publicada do formulário preenchido. Nula enquanto só houver os campos padrão. */
  formVersion?: number | null
  /** A pessoa viu o alerta de possível duplicidade e decidiu enviar mesmo assim. */
  duplicateAcknowledged?: boolean
}

// Situações em que o horário está de fato reservado, incluindo o valor antigo equivalente.
const occupyingStatuses = ['agendado', 'reagendado', 'em_andamento', 'agendada']

const moduleByStoredType: Record<string, 'maintenance' | 'fleet'> = {
  manutencao: 'maintenance',
  frota: 'fleet',
}

/**
 * Compromissos que se sobrepõem. Encostar no fim de outro não conta. Sem término previsto, o
 * compromisso conta só no horário de início: nenhuma duração é presumida.
 */
async function findScheduleConflicts(
  client: Pick<PoolClient, 'query'>,
  input: {
    requestId: string
    start: Date
    end: Date | null
    responsibleId: string
    vehicle: string | null
  },
): Promise<ScheduleConflict[]> {
  const result = await client.query<{
    id: string
    protocolo: string
    tipo: string
    data_agendada: Date
    agendamento_fim: Date | null
    mesmo_responsavel: boolean
  }>(
    `SELECT r.id::text AS id, ${protocolSql('r')} AS protocolo, r.tipo, r.data_agendada,
            r.agendamento_fim, r.responsavel_id = $4 AS mesmo_responsavel
       FROM public.service_requests r
      WHERE r.id <> $1
        AND r.tipo IN ('manutencao', 'frota')
        AND r.status = ANY($6::text[])
        AND r.data_agendada IS NOT NULL
        AND (r.responsavel_id = $4
             OR ($5::text IS NOT NULL AND r.tipo = 'frota'
                 AND lower(trim(r.dados->>'veiculo')) = lower(trim($5::text))))
        AND ((r.data_agendada < COALESCE($3::timestamptz, $2::timestamptz)
              AND $2::timestamptz < COALESCE(r.agendamento_fim, r.data_agendada))
             OR r.data_agendada = $2::timestamptz)
      ORDER BY r.data_agendada, r.id
      LIMIT 20`,
    [input.requestId, input.start, input.end, input.responsibleId, input.vehicle, occupyingStatuses],
  )
  return result.rows.map((row) => ({
    id: row.id,
    protocol: row.protocolo,
    module: moduleByStoredType[row.tipo],
    reason: row.mesmo_responsavel ? 'responsible' : 'vehicle',
    start: row.data_agendada,
    end: row.agendamento_fim,
  }))
}

export class ServiceRequestRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async list(
    actor: AuthenticatedIdentity,
    module: RequestModule,
    filters: RequestFilters,
  ) {
    const parameters: unknown[] = [moduleTypes[module]]
    const conditions = ['r.tipo = $1']
    const bind = (value: unknown) => {
      parameters.push(value)
      return `$${parameters.length}`
    }

    // O filtro de dono fica no SQL, nunca depois da consulta.
    if (!actor.permissions.includes('requests:read_all')) {
      conditions.push(`r.solicitante_id = ${bind(actor.userId)}`)
    }
    if (filters.status) {
      conditions.push(`r.status = ANY(${bind(storedValuesFor(module, filters.status))})`)
    }
    if (filters.tripType) conditions.push(`r.dados->>'tipoViagem' = ${bind(filters.tripType)}`)
    if (filters.from) conditions.push(`r.created_at >= ${bind(filters.from)}`)
    if (filters.to) conditions.push(`r.created_at <= ${bind(filters.to)}`)
    if (filters.search) {
      const pattern = bind(likePattern(filters.search))
      conditions.push(
        `(r.protocolo::text ILIKE ${pattern} OR ${protocolSql('r')} ILIKE ${pattern} OR r.titulo ILIKE ${pattern}
          OR r.descricao ILIKE ${pattern} OR solicitante.full_name ILIKE ${pattern})`,
      )
    }

    const where = `WHERE ${conditions.join(' AND ')}`
    const page = Math.max(1, filters.page ?? 1)
    const pool = this.poolProvider()
    const [rows, total] = await Promise.all([
      pool.query<RequestRow>(
        `${requestSelect} ${where}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        parameters,
      ),
      pool.query<{ total: number }>(
        `SELECT count(*)::int AS total
           FROM public.service_requests r
           JOIN public.auth_users solicitante ON solicitante.id = r.solicitante_id
           ${where}`,
        parameters,
      ),
    ])

    return {
      requests: rows.rows.map((row) => toRequest(module, row)),
      total: total.rows[0].total,
      page,
      pageSize,
    }
  }

  async find(module: RequestModule, id: string): Promise<ServiceRequest | null> {
    const result = await this.poolProvider().query<RequestRow>(
      `${requestSelect} WHERE r.id = $1 AND r.tipo = $2`,
      [id, moduleTypes[module]],
    )
    return result.rows[0] ? toRequest(module, result.rows[0]) : null
  }

  async history(requestId: string) {
    const result = await this.poolProvider().query<{
      id: string
      acao: string
      status_anterior: string | null
      status_novo: string | null
      comentario: string | null
      detalhes: Record<string, unknown>
      usuario: string | null
      created_at: Date
    }>(
      `SELECT h.id::text AS id, h.acao, h.status_anterior, h.status_novo, h.comentario,
              h.detalhes, u.full_name AS usuario, h.created_at
         FROM public.request_history h
         LEFT JOIN public.auth_users u ON u.id = h.usuario_id
        WHERE h.request_id = $1
        ORDER BY h.created_at, h.id`,
      [requestId],
    )
    return result.rows.map((row) => ({
      id: row.id,
      action: row.acao,
      from: row.status_anterior,
      to: row.status_novo,
      comment: row.comentario,
      details: row.detalhes,
      user: row.usuario,
      at: row.created_at,
    }))
  }

  async occurrences(requestId: string) {
    const result = await this.poolProvider().query<{
      id: string
      tipo: string
      descricao: string
      atraso_minutos: number | null
      usuario: string
      created_at: Date
    }>(
      `SELECT o.id::text AS id, o.tipo, o.descricao, o.atraso_minutos,
              u.full_name AS usuario, o.created_at
         FROM public.request_occurrences o
         JOIN public.auth_users u ON u.id = o.registrado_por
        WHERE o.request_id = $1
        ORDER BY o.created_at, o.id`,
      [requestId],
    )
    return result.rows.map((row) => ({
      id: row.id,
      type: row.tipo,
      description: row.descricao,
      delayMinutes: row.atraso_minutos,
      user: row.usuario,
      at: row.created_at,
    }))
  }

  async create(
    actor: AuthenticatedIdentity,
    module: RequestModule,
    input: NewRequest,
  ): Promise<{ id: string; protocol: string }> {
    // Cifra antes da transação: sem chave, nada chega a ser gravado.
    const passengers = encryptedPassengers(input.passengers ?? [])

    return withTransaction(this.poolProvider(), async (client) => {
      const sector = await resolveSector(client, actor, module, input.sectorId)
      const floor = input.floorId
        ? await requireActiveOption(client, 'floors', input.floorId, 'Andar')
        : null
      const serviceType = input.serviceTypeId
        ? await requireActiveOption(client, 'serviceTypes', input.serviceTypeId, 'Tipo de serviço')
        : null
      const status = initialStatusOf(module)

      const created = await client.query<{ id: string; protocolo: string }>(
        `INSERT INTO public.service_requests
          (tipo, status, solicitante_id, aberto_por, em_nome_de_outro_setor,
           setor_id, setor_nome, andar_id, andar_nome, tipo_servico_id, tipo_servico_nome,
           titulo, descricao, prioridade, dados, lgpd_aceite, lgpd_aceite_em)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb,
                 $16, CASE WHEN $16 THEN now() END)
         RETURNING id::text AS id, ${protocolSql('service_requests')} AS protocolo`,
        [
          moduleTypes[module],
          status,
          sector.requesterId,
          actor.userId,
          sector.onBehalf,
          sector.sectorId,
          sector.sector,
          floor?.id ?? null,
          floor?.name ?? null,
          serviceType?.id ?? null,
          serviceType?.name ?? null,
          serviceType ? `${serviceType.name}: ${input.title}` : input.title,
          input.description,
          input.priority,
          JSON.stringify(input.details),
          input.lgpdAccepted,
        ],
      )
      const { id, protocolo } = created.rows[0]

      // Prazo padrão: só existe se a administração definir um para esta prioridade.
      const deadline = defaultDeadline(await readSystemSettings(client), input.priority, new Date(), {
        module,
        serviceTypeId: serviceType?.id ?? null,
      })
      if (deadline) {
        await client.query(`UPDATE public.service_requests SET prazo_em = $2 WHERE id = $1`, [id, deadline])
      }

      for (const passenger of passengers) {
        await insertPassenger(client, id, passenger.name, passenger.cpf!)
      }
      // A coluna só é citada havendo versão publicada, o que já pressupõe a migração 012.
      if (input.formVersion) {
        await client.query(`UPDATE public.service_requests SET formulario_versao = $2 WHERE id = $1`, [id, input.formVersion])
      }

      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'criada',
        from: null,
        to: status,
        details: {
          ...(sector.onBehalf ? { emNomeDoSetor: sector.sector } : {}),
          ...(input.privacyNotice ? { avisoPrivacidade: input.privacyNotice } : {}),
          ...(input.formVersion ? { versaoFormulario: input.formVersion } : {}),
          ...(input.duplicateAcknowledged ? { duplicidadeAvisada: true } : {}),
        },
      })
      await audit(client, actor, 'request_created', id, sector.requesterId, {
        module,
        protocol: protocolo,
        ...(sector.onBehalf ? { onBehalfOf: sector.sector } : {}),
      })
      await publishIntegrationEvent(client, {
        type: 'request_received',
        key: `${id}:received`,
        module,
        resourceId: id,
        protocol: protocolo,
        actorId: actor.userId,
        requesterId: sector.requesterId,
        context: { title: serviceType ? `${serviceType.name}: ${input.title}` : input.title },
      })

      return { id, protocol: protocolo }
    })
  }

  /** Bloqueia a linha: duas ações simultâneas não partem do mesmo status. */
  private async lock(client: PoolClient, module: RequestModule, id: string) {
    const result = await client.query<{
      status: string
      solicitante_id: string
      protocolo: string
      titulo: string
      responsavel_id: string | null
      veiculo: string | null
      execucao_inicio: Date | null
      data_agendada: Date | null
      agendamento_fim: Date | null
      updated_at: Date
      dados: Record<string, unknown>
      aguardando_externo_desde: string | null
    }>(
      `SELECT status, solicitante_id::text AS solicitante_id, ${protocolSql('service_requests')} AS protocolo, titulo,
              responsavel_id::text AS responsavel_id, dados->>'veiculo' AS veiculo,
              execucao_inicio, data_agendada, agendamento_fim, updated_at, dados,
              ${optionalColumnSql('service_requests', 'aguardando_externo_desde')} AS aguardando_externo_desde
         FROM public.service_requests
        WHERE id = $1 AND tipo = $2
        FOR UPDATE`,
      [id, moduleTypes[module]],
    )
    const row = result.rows[0]
    if (!row) throw notFound()
    return { ...row, status: normalizeStatus(module, row.status) }
  }

  private assertNotWaiting(current: { aguardando_externo_desde: string | null }) {
    if (current.aguardando_externo_desde) {
      throw conflict('Esta solicitação aguarda o retorno do solicitante. Encerre a devolução para prosseguir.')
    }
  }

  private transition(module: RequestModule, status: RequestStatus, action: RequestAction) {
    const next = nextStatus(module, status, action)
    if (!next) {
      throw conflict('Esta ação não é permitida no status atual da solicitação.')
    }
    return next
  }

  async update(
    actor: AuthenticatedIdentity,
    module: RequestModule,
    id: string,
    input: Omit<NewRequest, 'lgpdAccepted' | 'passengers' | 'sectorId'> & {
      justification?: string | null
    },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lock(client, module, id)
      if (isTerminalStatus(current.status)) {
        throw conflict('Solicitações encerradas não podem ser editadas.')
      }
      const result = await this.applyEdit(client, actor, module, id, current, input, { byRequester: false })
      return result.changed.length > 0
    })
  }

  /** Grava a edição e seu histórico. Serve à equipe e à correção feita pelo solicitante. */
  private async applyEdit(
    client: PoolClient,
    actor: AuthenticatedIdentity,
    module: RequestModule,
    id: string,
    current: Awaited<ReturnType<ServiceRequestRepository['lock']>>,
    input: Omit<NewRequest, 'lgpdAccepted' | 'passengers' | 'sectorId'> & { justification?: string | null },
    { byRequester }: { byRequester: boolean },
  ) {
    {
      const before = await client.query<{
        titulo: string
        descricao: string | null
        prioridade: string
        dados: Record<string, unknown>
        andar_id: string | null
        andar_nome: string | null
        tipo_servico_id: string | null
        tipo_servico_nome: string | null
      }>(
        `SELECT titulo, descricao, prioridade, dados, andar_id::text AS andar_id, andar_nome,
                tipo_servico_id::text AS tipo_servico_id, tipo_servico_nome
           FROM public.service_requests WHERE id = $1`,
        [id],
      )
      const previous = before.rows[0]

      // Mantém o nome já gravado se a opção não mudou, mesmo que tenha sido desativada.
      const floor =
        input.floorId && input.floorId !== previous.andar_id
          ? await requireActiveOption(client, 'floors', input.floorId, 'Andar')
          : input.floorId
            ? { id: previous.andar_id, name: previous.andar_nome }
            : null
      const serviceType =
        input.serviceTypeId && input.serviceTypeId !== previous.tipo_servico_id
          ? await requireActiveOption(client, 'serviceTypes', input.serviceTypeId, 'Tipo de serviço')
          : input.serviceTypeId
            ? { id: previous.tipo_servico_id, name: previous.tipo_servico_nome }
            : null
      const title = serviceType ? `${serviceType.name}: ${input.title}` : input.title
      // Editar a data pedida não apaga o que foi solicitado. A correção do solicitante é o novo pedido.
      const nextDetails = {
        ...(byRequester ? input.details : preserveOriginalRequest(module, previous.dados, input.details)),
        // Os nomes dos campos personalizados, como estavam no cadastro.
        ...(previous.dados.customFieldLabels ? { customFieldLabels: previous.dados.customFieldLabels } : {}),
      }

      const changed = [
        previous.titulo !== title && 'titulo',
        previous.descricao !== input.description && 'descricao',
        previous.prioridade !== input.priority && 'prioridade',
        previous.andar_id !== (floor?.id ?? null) && 'andar',
        previous.tipo_servico_id !== (serviceType?.id ?? null) && 'tipoServico',
        ...Object.keys({ ...previous.dados, ...input.details })
          .filter((key) => key !== 'solicitacaoOriginal' && key !== 'customFieldLabels')
          .filter(
            (key) =>
              JSON.stringify(previous.dados[key] ?? null) !==
              JSON.stringify(input.details[key] ?? null),
          ),
      ].filter((item): item is string => Boolean(item))

      if (changed.length === 0) return { changed, previous }

      // Nenhuma alteração relevante é silenciosa.
      if (!byRequester && requiresJustification(current.status, changed) && !input.justification) {
        throw new ModuleError('Informe a justificativa desta alteração.', 400)
      }

      await client.query(
        `UPDATE public.service_requests
            SET titulo = $2, descricao = $3, prioridade = $4, dados = $5::jsonb,
                andar_id = $6, andar_nome = $7, tipo_servico_id = $8, tipo_servico_nome = $9
          WHERE id = $1`,
        [
          id,
          title,
          input.description,
          input.priority,
          JSON.stringify(nextDetails),
          floor?.id ?? null,
          floor?.name ?? null,
          serviceType?.id ?? null,
          serviceType?.name ?? null,
        ],
      )
      const changes = describeChanges(
        {
          ...previous.dados,
          titulo: previous.titulo,
          descricao: previous.descricao,
          prioridade: previous.prioridade,
          andar: previous.andar_nome,
          tipoServico: previous.tipo_servico_nome,
        },
        {
          ...input.details,
          titulo: title,
          descricao: input.description,
          prioridade: input.priority,
          andar: floor?.name ?? null,
          tipoServico: serviceType?.name ?? null,
        },
        changed,
      )
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: byRequester ? 'corrigida_pelo_solicitante' : 'editada',
        from: current.status,
        to: current.status,
        comment: input.justification,
        details: {
          campos: changed,
          alteracoes: changes,
        },
      })
      await audit(client, actor, 'request_updated', id, current.solicitante_id, {
        module,
        fields: changed,
      })
      // O título pode ter mudado: o evento externo acompanha.
      if (module !== 'flights' && current.data_agendada) {
        await requestCalendarSync(client, id, module, 'upsert', { onlyIfTracked: true })
        if (module === 'fleet' && changed.length > 0) {
          await publishTripDriverEvent(client, {
            type: 'trip_updated',
            rules: tripEditRules(changed),
            key: `${id}:driver-update:${Date.now()}`,
            resourceId: id,
            protocol: current.protocolo,
            actorId: actor.userId,
            context: { title, scheduledAt: current.data_agendada.toISOString() },
          })
        }
        // Simples edição não gera e-mail; mudar as condições de um atendimento combinado, sim.
        const important = changed.filter((field) => importantFields.has(field))
        if (!byRequester && important.length > 0 && input.justification) {
          await publishIntegrationEvent(client, {
            type: 'request_schedule_changed',
            key: `${id}:conditions:${Date.now()}`,
            module,
            resourceId: id,
            protocol: current.protocolo,
            actorId: actor.userId,
            requesterId: current.solicitante_id,
            responsibleId: current.responsavel_id,
            context: {
              title,
              reason: input.justification,
              scheduledAt: current.data_agendada.toISOString(),
              changes: changes.filter((_change, index) => important.includes(changed[index])),
            },
          })
        }
      }
      return { changed, previous }
    }
  }

  async schedule(
    actor: AuthenticatedIdentity,
    module: RequestModule,
    id: string,
    input: {
      scheduledAt: Date
      scheduledEnd: Date | null
      responsibleId: string | null
      comment: string | null
      reasonCode?: unknown
      conditions?: string | null
      confirmConflicts?: boolean
      expectedVersion?: Date | null
    },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lock(client, module, id)
      if (
        input.expectedVersion &&
        input.expectedVersion.getTime() !== current.updated_at.getTime()
      ) {
        throw conflict('Esta solicitação foi alterada por outra pessoa. Atualize a página e confira.')
      }
      this.assertNotWaiting(current)
      const next = this.transition(module, current.status, 'schedule')
      const responsibleId = input.responsibleId ?? actor.userId
      const kind = classifyScheduleChange(
        { start: current.data_agendada, end: current.agendamento_fim, responsibleId: current.responsavel_id },
        { start: input.scheduledAt, end: input.scheduledEnd, responsibleId, conditions: input.conditions ?? null },
      )
      // Clique duplo ou reprocessamento: nada mudou, nada a registrar nem a comunicar.
      if (kind === 'none') return current.status

      const requested = requestedSchedule(module, current.dados)
      const divergent = differsFromRequest(requested, { start: input.scheduledAt, end: input.scheduledEnd })
      const needsReason = kind !== 'schedule' || divergent || Boolean(input.conditions)
      const settings = await readSystemSettings(client)
      const justification: ResolvedJustification | null = needsReason
        ? resolveInTransaction(
            settings.reasons.scheduling,
            { code: input.reasonCode, text: input.comment },
            {
              required: true,
              missingMessage:
                kind === 'reschedule'
                  ? 'Informe o motivo do reagendamento.'
                  : kind === 'adjust'
                    ? 'Informe o motivo da alteração do agendamento.'
                    : 'Informe o motivo: o atendimento difere do que foi solicitado.',
            },
          )
        : null
      const rescheduling = kind === 'reschedule'
      const statusAfter = kind === 'adjust' ? current.status : next
      await assertAssignable(client, responsibleId)

      // Serializa os agendamentos do mesmo responsável: dois ao mesmo tempo não escapam da
      // conferência um do outro. O bloqueio termina com a transação.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `agenda:${responsibleId}`,
      ])
      const vehicle = module === 'fleet' ? current.veiculo : null
      if (vehicle) {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `agenda-veiculo:${vehicle.trim().toLowerCase()}`,
        ])
      }
      const conflicts = await findScheduleConflicts(client, {
        requestId: id,
        start: input.scheduledAt,
        end: input.scheduledEnd,
        responsibleId,
        vehicle,
      })
      if (conflicts.length > 0 && !input.confirmConflicts) {
        throw new ScheduleConflictError(conflicts)
      }

      await client.query(
        `UPDATE public.service_requests
            SET status = $2, data_agendada = $3, agendamento_fim = $4, agendado_por = $5,
                responsavel_id = $6
          WHERE id = $1`,
        [id, statusAfter, input.scheduledAt, input.scheduledEnd, actor.userId, responsibleId],
      )
      const previousPeriod = { inicio: iso(current.data_agendada), fim: iso(current.agendamento_fim) }
      const newPeriod = { inicio: input.scheduledAt.toISOString(), fim: iso(input.scheduledEnd) }
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: kind === 'adjust' ? 'agendamento_alterado' : rescheduling ? 'reagendada' : 'agendada',
        from: current.status,
        to: statusAfter,
        comment: justification?.summary ?? input.comment,
        details: {
          solicitado: { inicio: requested.start, fim: requested.end },
          ...(current.data_agendada ? { anterior: previousPeriod } : {}),
          novo: newPeriod,
          divergente: divergent,
          ...(justification ? { motivoCodigo: justification.code, motivoNome: justification.label } : {}),
          ...(input.conditions ? { condicoes: input.conditions } : {}),
          alteracoes: [
            ...(requested.start && divergent
              ? [{ campo: 'Solicitado', de: requested.start, para: input.scheduledAt.toISOString() }]
              : []),
            ...(current.data_agendada
              ? [{ campo: 'Agendamento', de: previousPeriod.inicio, para: newPeriod.inicio }]
              : []),
            ...(current.agendamento_fim?.getTime() !== input.scheduledEnd?.getTime() && current.data_agendada
              ? [{ campo: 'Término previsto', de: previousPeriod.fim, para: newPeriod.fim }]
              : []),
          ],
          dataAgendada: input.scheduledAt.toISOString(),
          ...(current.data_agendada
            ? { dataAnterior: current.data_agendada.toISOString() }
            : {}),
          responsavelId: responsibleId,
          ...(current.responsavel_id && current.responsavel_id !== responsibleId
            ? { responsavelAnteriorId: current.responsavel_id }
            : {}),
          ...(conflicts.length > 0
            ? { conflitosConfirmados: conflicts.map((item) => item.protocol) }
            : {}),
        },
      })
      await audit(
        client,
        actor,
        kind === 'adjust' ? 'request_schedule_changed' : rescheduling ? 'request_rescheduled' : 'request_scheduled',
        id,
        current.solicitante_id,
        {
          module,
          to: statusAfter,
          scheduledAt: input.scheduledAt.toISOString(),
          ...(justification ? { reason: justification.code } : {}),
        },
      )
      await publishIntegrationEvent(client, {
        type: kind === 'adjust' ? 'request_schedule_changed' : rescheduling ? 'request_rescheduled' : 'request_scheduled',
        // A mesma data repetida não gera nova mensagem. Uma data nova, ou outra condição, sim.
        key:
          kind === 'adjust'
            ? `${id}:schedule-change:${Date.now()}`
            : `${id}:schedule:${input.scheduledAt.toISOString()}`,
        module,
        resourceId: id,
        protocol: current.protocolo,
        actorId: actor.userId,
        requesterId: current.solicitante_id,
        responsibleId,
        context: {
          title: current.titulo,
          scheduledAt: input.scheduledAt.toISOString(),
          scheduledEnd: input.scheduledEnd?.toISOString() ?? null,
          previousScheduledAt: current.data_agendada?.toISOString(),
          previousScheduledEnd: iso(current.agendamento_fim),
          requestedAt: requested.start,
          requestedEnd: requested.end,
          divergent,
          conditions: input.conditions ?? null,
          // Só o motivo registrado como justificativa vai ao solicitante; comentário interno, não.
          reason: justification?.summary ?? null,
        },
      })
      // Agendar com outro responsável é também uma mudança de responsável: os dois são avisados.
      if (current.responsavel_id !== responsibleId) {
        const stamp = Date.now()
        await publishIntegrationEvent(client, {
          type: 'request_assigned',
          key: `${id}:assign:${responsibleId}:${stamp}`,
          module,
          resourceId: id,
          protocol: current.protocolo,
          actorId: actor.userId,
          responsibleId,
        })
        if (current.responsavel_id) {
          await publishIntegrationEvent(client, {
            type: 'request_unassigned',
            key: `${id}:unassign:${current.responsavel_id}:${stamp}`,
            module,
            resourceId: id,
            protocol: current.protocolo,
            actorId: actor.userId,
            responsibleId: current.responsavel_id,
          })
        }
      }
      if (module !== 'flights') await requestCalendarSync(client, id, module, 'upsert')
      if (module === 'fleet' && kind !== 'schedule') {
        await publishTripDriverEvent(client, {
          type: rescheduling ? 'trip_rescheduled' : 'trip_updated',
          rules: [rescheduling ? 'trip_rescheduled' : 'time_changed'],
          key: `${id}:driver-schedule:${Date.now()}`,
          resourceId: id,
          protocol: current.protocolo,
          actorId: actor.userId,
          context: { title: current.titulo, scheduledAt: input.scheduledAt.toISOString() },
        })
      }
      return statusAfter
    })
  }

  async start(
    actor: AuthenticatedIdentity,
    module: RequestModule,
    id: string,
    input: { startedAt: Date; comment: string | null },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lock(client, module, id)
      this.assertNotWaiting(current)
      const next = this.transition(module, current.status, 'start')

      await client.query(
        `UPDATE public.service_requests SET status = $2, execucao_inicio = $3 WHERE id = $1`,
        [id, next, input.startedAt],
      )
      if (module === 'fleet') await stampTripJourney(client, id)
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'iniciada',
        from: current.status,
        to: next,
        comment: input.comment,
        details: { inicioReal: input.startedAt.toISOString() },
      })
      await audit(client, actor, 'request_started', id, current.solicitante_id, { module, to: next })
      await publishIntegrationEvent(client, {
        type: 'request_started',
        key: `${id}:started`,
        module,
        resourceId: id,
        protocol: current.protocolo,
        actorId: actor.userId,
        requesterId: current.solicitante_id,
        context: { title: current.titulo },
      })
      if (module !== 'flights') {
        await requestCalendarSync(client, id, module, 'upsert', { onlyIfTracked: true })
      }
      return next
    })
  }

  async complete(
    actor: AuthenticatedIdentity,
    module: RequestModule,
    id: string,
    input: { finishedAt: Date; comment: string | null },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lock(client, module, id)
      const next = this.transition(module, current.status, 'complete')

      if (current.execucao_inicio && input.finishedAt < current.execucao_inicio) {
        throw new ModuleError('O término real não pode ser anterior ao início real.', 400)
      }

      await client.query(
        `UPDATE public.service_requests
            SET status = $2, execucao_fim = $3, concluida_em = now(),
                observacao_operador = COALESCE($4, observacao_operador)
          WHERE id = $1`,
        [id, next, input.finishedAt, input.comment],
      )
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'concluida',
        from: current.status,
        to: next,
        comment: input.comment,
        details: { fimReal: input.finishedAt.toISOString() },
      })
      await audit(client, actor, 'request_completed', id, current.solicitante_id, { module, to: next })
      await publishIntegrationEvent(client, {
        type: 'request_completed',
        key: `${id}:completed`,
        module,
        resourceId: id,
        protocol: current.protocolo,
        actorId: actor.userId,
        requesterId: current.solicitante_id,
        context: { title: current.titulo },
      })
      if (module !== 'flights') {
        await requestCalendarSync(client, id, module, 'upsert', { onlyIfTracked: true })
      }
      return next
    })
  }

  async cancel(
    actor: AuthenticatedIdentity,
    module: RequestModule,
    id: string,
    input: { code: unknown; text: unknown },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lock(client, module, id)
      const next = this.transition(module, current.status, 'cancel')
      const settings = await readSystemSettings(client)
      const justification = resolveInTransaction(settings.reasons.cancellation, input, {
        required: true,
        missingMessage: 'Informe o motivo do cancelamento.',
      })!
      const reason = justification.summary

      await client.query(
        `UPDATE public.service_requests SET status = $2, motivo_cancelamento = $3 WHERE id = $1`,
        [id, next, redactValidCpf(reason)],
      )
      await this.finishWait(client, id, current.aguardando_externo_desde)
      if (current.aguardando_externo_desde) {
        await client.query(
          `UPDATE public.request_returns
              SET situacao = 'encerrada', resposta = 'Solicitação cancelada.', finalizada_por = $2, finalizada_em = now()
            WHERE request_id = $1 AND situacao = 'aberta'`,
          [id, actor.userId],
        )
      }
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'cancelada',
        from: current.status,
        to: next,
        comment: reason,
        details: {
          situacaoAnterior: current.status,
          motivoCodigo: justification.code,
          motivoNome: justification.label,
          // Continua aqui mesmo depois de o evento sair da agenda.
          ...(current.data_agendada
            ? { agendamentoCancelado: { inicio: iso(current.data_agendada), fim: iso(current.agendamento_fim) } }
            : {}),
        },
      })
      await audit(client, actor, 'request_cancelled', id, current.solicitante_id, { module, to: next, from: current.status })
      await publishIntegrationEvent(client, {
        type: 'request_cancelled',
        key: `${id}:cancelled`,
        module,
        resourceId: id,
        protocol: current.protocolo,
        actorId: actor.userId,
        requesterId: current.solicitante_id,
        responsibleId: current.responsavel_id,
        context: {
          title: current.titulo,
          reason,
          previousScheduledAt: current.data_agendada?.toISOString(),
          previousScheduledEnd: iso(current.agendamento_fim),
        },
      })
      if (module !== 'flights') {
        await requestCalendarSync(client, id, module, 'delete', { onlyIfTracked: true })
      }
      if (module === 'fleet') {
        await publishTripDriverEvent(client, {
          type: 'trip_cancelled',
          rules: ['trip_cancelled'],
          key: `${id}:driver-cancelled`,
          resourceId: id,
          protocol: current.protocolo,
          actorId: actor.userId,
          context: { title: current.titulo },
        })
      }
      return next
    })
  }

  /** Soma a espera encerrada: o prazo interno não correu nesse período. */
  private async finishWait(client: PoolClient, id: string, waitingSince: string | null) {
    if (!waitingSince) return
    await client.query(
      `UPDATE public.service_requests
          SET espera_externa_segundos = espera_externa_segundos
                + GREATEST(0, round(extract(epoch FROM now() - aguardando_externo_desde)))::int,
              aguardando_externo_desde = NULL
        WHERE id = $1`,
      [id],
    )
  }

  // -------------------------------------------------------------------------
  // Devolução ao solicitante: mesma solicitação, mesmo protocolo, sem apagar nada.
  // -------------------------------------------------------------------------
  async openReturn(
    actor: AuthenticatedIdentity,
    module: RequestModule,
    id: string,
    input: { type: 'correcao' | 'complementacao'; reason: string; fields: readonly string[] },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lock(client, module, id)
      if (!canReturnFromStatus(current.status)) {
        throw conflict('Só é possível devolver solicitações que ainda não estão em execução.')
      }
      this.assertNotWaiting(current)
      const reason = redactValidCpf(input.reason)
      await client.query(
        `INSERT INTO public.request_returns (request_id, tipo, motivo, campos, devolvida_por)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, input.type, reason, input.fields, actor.userId],
      )
      await client.query(`UPDATE public.service_requests SET aguardando_externo_desde = now() WHERE id = $1`, [id])
      const labels = input.fields.map((field) => correctableFields[module][field])
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: input.type === 'correcao' ? 'devolvida_para_correcao' : 'informacoes_solicitadas',
        from: current.status,
        to: current.status,
        comment: reason,
        details: { campos: labels },
      })
      await audit(client, actor, 'request_returned', id, current.solicitante_id, {
        module,
        type: input.type,
        fields: input.fields,
      })
      await publishIntegrationEvent(client, {
        type: input.type === 'correcao' ? 'request_returned' : 'request_info_requested',
        key: `${id}:return:${Date.now()}`,
        module,
        resourceId: id,
        protocol: current.protocolo,
        actorId: actor.userId,
        requesterId: current.solicitante_id,
        context: { title: current.titulo, reason, returnFields: labels },
      })
    })
  }

  /** Dados da devolução aberta, para a rota validar a correção antes de abrir a transação. */
  async currentReturn(id: string) {
    const result = await this.poolProvider().query<{ id: string; tipo: string; campos: string[] }>(
      `SELECT id::text AS id, tipo, campos FROM public.request_returns WHERE request_id = $1 AND situacao = 'aberta'`,
      [id],
    )
    return result.rows[0] ?? null
  }

  async respondReturn(
    actor: AuthenticatedIdentity,
    module: RequestModule,
    id: string,
    input: {
      response: string | null
      edit: (Omit<NewRequest, 'lgpdAccepted' | 'passengers' | 'sectorId'>) | null
      passengers: readonly ValidatedPassenger[] | null
    },
  ) {
    const passengers = input.passengers ? encryptedPassengers(input.passengers) : null

    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lock(client, module, id)
      if (current.solicitante_id !== actor.userId) throw notFound()
      const open = await client.query<{ id: string; tipo: string; campos: string[] }>(
        `SELECT id::text AS id, tipo, campos FROM public.request_returns
          WHERE request_id = $1 AND situacao = 'aberta' FOR UPDATE`,
        [id],
      )
      const pending = open.rows[0]
      if (!pending) throw conflict('Esta solicitação não está aguardando correção.')

      const result = input.edit
        ? await this.applyEdit(client, actor, module, id, current, input.edit, { byRequester: true })
        : null
      if (passengers) await this.applyPassengers(client, actor, id, current, passengers)
      const changedSomething = (result?.changed.length ?? 0) > 0 || Boolean(passengers)
      if (!changedSomething && !input.response) {
        throw new ModuleError('Altere os campos indicados ou escreva uma resposta.', 400)
      }

      await client.query(
        `UPDATE public.request_returns
            SET situacao = 'atendida', resposta = $2, dados_anteriores = $3::jsonb,
                finalizada_por = $4, finalizada_em = now()
          WHERE id = $1`,
        [
          pending.id,
          input.response ? redactValidCpf(input.response) : null,
          result ? JSON.stringify(result.previous) : null,
          actor.userId,
        ],
      )
      await this.finishWait(client, id, current.aguardando_externo_desde)
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'devolucao_respondida',
        from: current.status,
        to: current.status,
        comment: input.response,
        details: { camposAlterados: result?.changed ?? [] },
      })
      await audit(client, actor, 'request_corrected', id, current.solicitante_id, {
        module,
        fields: result?.changed ?? [],
      })
      await publishIntegrationEvent(client, {
        type: 'request_corrected',
        key: `${id}:corrected:${pending.id}`,
        module,
        resourceId: id,
        protocol: current.protocolo,
        actorId: actor.userId,
        responsibleId: current.responsavel_id,
        context: { title: current.titulo },
      })
    })
  }

  async closeReturn(actor: AuthenticatedIdentity, module: RequestModule, id: string, reason: string) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lock(client, module, id)
      const text = redactValidCpf(reason)
      const closed = await client.query(
        `UPDATE public.request_returns
            SET situacao = 'encerrada', resposta = $2, finalizada_por = $3, finalizada_em = now()
          WHERE request_id = $1 AND situacao = 'aberta'`,
        [id, text, actor.userId],
      )
      if (closed.rowCount === 0) throw conflict('Esta solicitação não está aguardando correção.')
      await this.finishWait(client, id, current.aguardando_externo_desde)
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'devolucao_encerrada',
        from: current.status,
        to: current.status,
        comment: text,
      })
      await audit(client, actor, 'request_return_closed', id, current.solicitante_id, { module })
      await publishIntegrationEvent(client, {
        type: 'request_return_closed',
        key: `${id}:return-closed:${Date.now()}`,
        module,
        resourceId: id,
        protocol: current.protocolo,
        actorId: actor.userId,
        requesterId: current.solicitante_id,
        context: { title: current.titulo, reason: text },
      })
    })
  }

  /** Vazia em um banco sem a 012. Os dados anteriores ficam só com quem atende. */
  async returns(id: string, internal: boolean) {
    const pool = this.poolProvider()
    const present = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.request_returns') IS NOT NULL AS present`,
    )
    if (!present.rows[0]?.present) return []
    const result = await pool.query<{
      id: string
      tipo: string
      motivo: string
      campos: string[]
      situacao: string
      resposta: string | null
      dados_anteriores: unknown
      devolvida_em: Date
      finalizada_em: Date | null
      devolvida_por_nome: string | null
    }>(
      `SELECT r.id::text AS id, r.tipo, r.motivo, r.campos, r.situacao, r.resposta, r.dados_anteriores,
              r.devolvida_em, r.finalizada_em, u.full_name AS devolvida_por_nome
         FROM public.request_returns r
         LEFT JOIN public.auth_users u ON u.id = r.devolvida_por
        WHERE r.request_id = $1
        ORDER BY r.devolvida_em DESC`,
      [id],
    )
    return result.rows.map((row) => ({
      id: row.id,
      type: row.tipo,
      reason: row.motivo,
      fields: row.campos,
      status: row.situacao,
      response: row.resposta,
      returnedAt: row.devolvida_em,
      finishedAt: row.finalizada_em,
      ...(internal ? { returnedBy: row.devolvida_por_nome, previousData: row.dados_anteriores } : {}),
    }))
  }

  // -------------------------------------------------------------------------
  // Possíveis duplicidades. Só alerta: nunca impede o registro.
  // -------------------------------------------------------------------------
  async possibleDuplicates(
    actor: AuthenticatedIdentity,
    module: RequestModule,
    probe: Omit<DuplicateProbe, 'requesterId' | 'sector'> & { sectorId: string | null },
  ) {
    const pool = this.poolProvider()
    const chosen = probe.sectorId
      ? await pool.query<{ nome: string }>(`SELECT nome FROM public.setores WHERE id = $1`, [probe.sectorId])
      : null
    const sector = chosen?.rows[0]?.nome ?? actor.sector ?? null
    const closed = ['concluido', 'concluida', 'cancelado', 'cancelada', 'rejeitada', 'emitida']
    const result = await pool.query<{
      id: string
      protocolo: string
      status: string
      titulo: string
      descricao: string | null
      solicitante_id: string
      setor_nome: string | null
      andar_id: string | null
      tipo_servico_id: string | null
      dados: Record<string, unknown>
      created_at: Date
    }>(
      `SELECT r.id::text AS id, ${protocolSql('r')} AS protocolo, r.status, r.titulo, r.descricao,
              r.solicitante_id::text AS solicitante_id, r.setor_nome,
              r.andar_id::text AS andar_id, r.tipo_servico_id::text AS tipo_servico_id, r.dados, r.created_at
         FROM public.service_requests r
        WHERE r.tipo = $1 AND NOT (r.status = ANY($2::text[]))
          AND r.created_at > now() - interval '90 days'
        ORDER BY r.created_at DESC
        LIMIT 300`,
      [moduleTypes[module], closed],
    )
    const seesAll = actor.permissions.includes('requests:read_all')
    const full: DuplicateProbe = { ...probe, requesterId: actor.userId, sector }
    return result.rows
      .map((row) => {
        const details = row.dados
        const segment = (details.ida ?? details.volta ?? {}) as Record<string, string | undefined>
        const candidate: DuplicateProbe = {
          requesterId: row.solicitante_id,
          sector: row.setor_nome,
          floorId: row.andar_id,
          serviceTypeId: row.tipo_servico_id,
          location: (details.localServico as string | null) ?? null,
          vehicle: (details.veiculo as string | null) ?? null,
          origin: (details.origem as string | null) ?? segment.origem ?? null,
          destination: (details.destino as string | null) ?? segment.destino ?? null,
          date:
            (details.dataHora as string | null) ??
            (details.dataPreferencial as string | null) ??
            (segment.data ? `${segment.data}T12:00:00.000Z` : null),
          description: row.descricao,
        }
        return { row, ...compareDuplicate(full, candidate) }
      })
      .filter((item) => item.possibleDuplicate)
      .sort((first, second) => second.score - first.score)
      .slice(0, 5)
      .map(({ row, reasons }) => {
        const status = normalizeStatus(module, row.status)
        // Sem acesso à solicitação, a pessoa sabe que existe algo parecido, e nada além disso.
        const canOpen = seesAll || row.solicitante_id === actor.userId
        return canOpen
          ? { canOpen, id: row.id, protocol: row.protocolo, title: row.titulo, status, createdAt: row.created_at, reasons }
          : { canOpen, status, createdAt: row.created_at, reasons }
      })
  }

  /** Próxima etapa das passagens aéreas: cotação, aprovação, emissão, emitida. */
  async advanceFlight(
    actor: AuthenticatedIdentity,
    id: string,
    input: { expected: RequestStatus; comment: string | null },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lock(client, 'flights', id)
      this.assertNotWaiting(current)
      const next = this.transition('flights', current.status, 'advance')
      if (next !== input.expected) {
        throw conflict('Esta solicitação já mudou de status. Atualize a página.')
      }

      await client.query(
        `UPDATE public.service_requests
            SET status = $2, concluida_em = CASE WHEN $2 = 'emitida' THEN now() END
          WHERE id = $1`,
        [id, next],
      )
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'status_alterado',
        from: current.status,
        to: next,
        comment: input.comment,
      })
      await audit(client, actor, 'request_status_changed', id, current.solicitante_id, {
        module: 'flights',
        from: current.status,
        to: next,
      })
      const eventType = flightEventFor(next)
      if (eventType) {
        await publishIntegrationEvent(client, {
          type: eventType,
          key: `${id}:flight:${next}`,
          module: 'flights',
          resourceId: id,
          protocol: current.protocolo,
          actorId: actor.userId,
          requesterId: current.solicitante_id,
        })
      }
      return next
    })
  }

  async addOccurrence(
    actor: AuthenticatedIdentity,
    module: RequestModule,
    id: string,
    input: { type: string; description: string; delayMinutes: number | null },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lock(client, module, id)
      if (!['agendado', 'reagendado', 'em_andamento', 'concluido'].includes(current.status)) {
        throw conflict('Só é possível registrar ocorrências de atendimentos agendados ou em execução.')
      }

      const occurrence = await client.query<{ id: string }>(
        `INSERT INTO public.request_occurrences
          (request_id, tipo, descricao, atraso_minutos, registrado_por)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id::text AS id`,
        [id, input.type, redactValidCpf(input.description), input.delayMinutes, actor.userId],
      )
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: input.type === 'atraso' ? 'atraso_registrado' : 'ocorrencia_registrada',
        from: current.status,
        to: current.status,
        comment: input.description,
        details: input.delayMinutes ? { atrasoMinutos: input.delayMinutes } : {},
      })
      await audit(client, actor, 'request_occurrence', id, current.solicitante_id, {
        module,
        type: input.type,
      })
      await publishIntegrationEvent(client, {
        type: 'request_occurrence',
        key: `${id}:occurrence:${occurrence.rows[0].id}`,
        module,
        resourceId: id,
        protocol: current.protocolo,
        actorId: actor.userId,
        requesterId: current.solicitante_id,
        context: { title: current.titulo, delayMinutes: input.delayMinutes },
      })
    })
  }

  /**
   * Substitui a lista de passageiros de uma solicitação em aberto. Passageiro já cadastrado
   * pode vir sem CPF: nesse caso o número guardado continua o mesmo.
   */
  async replacePassengers(
    actor: AuthenticatedIdentity,
    id: string,
    input: readonly ValidatedPassenger[],
  ) {
    const passengers = encryptedPassengers(input)

    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lock(client, 'flights', id)
      if (isTerminalStatus(current.status)) {
        throw conflict('Solicitações encerradas não podem ser editadas.')
      }
      await this.applyPassengers(client, actor, id, current, passengers)
    })
  }

  private async applyPassengers(
    client: PoolClient,
    actor: AuthenticatedIdentity,
    id: string,
    current: { status: RequestStatus; solicitante_id: string },
    passengers: ReturnType<typeof encryptedPassengers>,
  ) {
    {
      const existing = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM public.flight_request_passengers
          WHERE request_id = $1 FOR UPDATE`,
        [id],
      )
      const existingIds = new Set(existing.rows.map((row) => row.id))
      const kept = new Set<string>()

      if (passengers.length > maxPassengers) {
        throw new ModuleError(`O limite é de ${maxPassengers} passageiros.`, 400)
      }

      for (const passenger of passengers) {
        if (passenger.id && !existingIds.has(passenger.id)) throw notFound()

        if (passenger.id) {
          kept.add(passenger.id)
          await client.query(
            `UPDATE public.flight_request_passengers
                SET full_name = $2,
                    cpf = CASE WHEN $3::text IS NULL THEN cpf END,
                    cpf_encrypted = COALESCE($3, cpf_encrypted),
                    cpf_masked = COALESCE($4, cpf_masked)
              WHERE id = $1`,
            [
              passenger.id,
              passenger.name,
              passenger.cpf?.encrypted ?? null,
              passenger.cpf?.masked ?? null,
            ],
          )
        } else {
          if (!passenger.cpf) throw new ModuleError('Informe o CPF do novo passageiro.', 400)
          await insertPassenger(client, id, passenger.name, passenger.cpf)
        }
      }

      const removed = [...existingIds].filter((passengerId) => !kept.has(passengerId))
      if (removed.length > 0) {
        await client.query(
          `DELETE FROM public.flight_request_passengers WHERE id = ANY($1::uuid[])`,
          [removed],
        )
      }

      // Nem histórico nem auditoria recebem nomes ou CPF: só as quantidades.
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'passageiros_alterados',
        from: current.status,
        to: current.status,
        details: { total: passengers.length, removidos: removed.length },
      })
      await audit(client, actor, 'flight_passengers_changed', id, current.solicitante_id, {
        module: 'flights',
        total: String(passengers.length),
      })
    }
  }

  /** Quem pode ser responsável por um atendimento: administradores e equipe SLM ativos. */
  async listAssignable() {
    const result = await this.poolProvider().query<{ id: string; full_name: string }>(
      `SELECT u.id::text AS id, u.full_name
         FROM public.auth_users u
         LEFT JOIN public.auth_user_access a ON a.user_id = u.id
        WHERE ${assignableCondition}
        ORDER BY lower(u.full_name)`,
    )
    return result.rows.map((row) => ({ id: row.id, name: row.full_name }))
  }
}

// Conta sem linha de acesso segue as colunas antigas, como no restante do sistema.
export const assignableCondition = `u.status = 'approved'
  AND (a.slm_member IS TRUE OR COALESCE(a.profile = 'administrator', u.role = 'admin'))`

async function insertPassenger(
  client: Pick<PoolClient, 'query'>,
  requestId: string,
  name: string,
  cpf: { encrypted: string; masked: string },
) {
  await client.query(
    `INSERT INTO public.flight_request_passengers
      (request_id, full_name, cpf_encrypted, cpf_masked, created_at)
     VALUES ($1, $2, $3, $4, clock_timestamp())`,
    [requestId, name, cpf.encrypted, cpf.masked],
  )
}

export async function assertAssignable(client: Pick<PoolClient, 'query'>, userId: string) {
  const result = await client.query(
    `SELECT 1
       FROM public.auth_users u
       LEFT JOIN public.auth_user_access a ON a.user_id = u.id
      WHERE u.id = $1
        AND ${assignableCondition}`,
    [userId],
  )
  if (result.rows.length === 0) {
    throw new ModuleError('O responsável precisa ser da equipe SLM ou administrador, com conta ativa.', 400)
  }
}
