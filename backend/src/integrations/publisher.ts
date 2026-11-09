import type { PoolClient } from 'pg'
import { accessSql, isAccessSchemaMigrated, resolveAccess } from '../database/accessSchema.js'
import type { AccessRow } from '../database/accessSchema.js'
import { readSystemSettings } from '../database/settingsRepository.js'
import { driverNotificationEvents } from '../requests/driverPortalRules.js'
import type { DriverNotificationEvent } from '../requests/driverPortalRules.js'
import { describeError, logSecurityEvent } from '../security/logger.js'
import type { Permission } from '../auth/permissions.js'
import {
  audienceOf,
  groupableEvents,
  linkPathOf,
  renderNotification,
  renderSubject,
  requesterPermissions,
  teamPermissions,
} from './catalog.js'
import type { EventContext, EventType, IntegrationModule } from './catalog.js'
import { calendarMode, carbonCopies, emailMode, internalRecipients } from './config.js'
import { quotaSettings } from './emailQuota.js'
import { redactForOutbound } from './redaction.js'

type Client = Pick<PoolClient, 'query'>

/**
 * Publica um acontecimento na mesma transação da mudança que o causou: se a mudança for
 * desfeita, nada é comunicado; se for confirmada, a comunicação está garantida na fila.
 *
 * Nada aqui fala com provedores, e tudo roda em um SAVEPOINT. Um erro nesta etapa, inclusive
 * a migração 006 ainda não aplicada, fica no log e nunca impede o registro da solicitação.
 */
export async function publishIntegrationEvent(client: Client, input: PublishInput) {
  await runIsolated(client, 'integration_publish', 'integration_publish_failed', input.type, () =>
    fanOut(client, input),
  )
}

/**
 * Aplica as regras de notificação do portal: o motorista recebe o evento próprio, e a equipe, um aviso
 * com o nome do acontecimento. Mais de uma regra (destino e horário juntos) gera um aviso só, se alguma
 * estiver ligada. A movimentação segue registrada no histórico da solicitação de qualquer forma.
 */
async function applyDriverRules(
  client: Client,
  rules: readonly DriverNotificationEvent[],
  input: PublishInput,
) {
  const configured = (await readSystemSettings(client)).driverNotifications.rules
  if (input.driverUserId && rules.some((rule) => configured[rule]?.driver)) await fanOut(client, input)
  const teamRule = rules.find((rule) => configured[rule]?.team)
  if (teamRule) {
    await fanOut(client, {
      ...input,
      type: 'trip_portal_notice',
      key: `${input.key}:team`,
      driverUserId: null,
      context: { ...input.context, portalEventLabel: driverNotificationEvents.find((event) => event.key === teamRule)?.label },
    })
  }
}

/** Publica um acontecimento do portal cujo motorista já é conhecido, como a atribuição. */
export async function publishDriverRuleEvent(
  client: Client,
  rule: DriverNotificationEvent,
  input: PublishInput,
) {
  await runIsolated(client, 'integration_publish', 'integration_publish_failed', input.type, () =>
    applyDriverRules(client, [rule], input),
  )
}

/**
 * Avisa o motorista da viagem, se houver. Mesmo isolamento: sem a migração 016, a solicitação segue
 * igual. A consulta confere antes, para não deixar um erro no log a cada alteração de solicitação.
 */
export async function publishTripDriverEvent(
  client: Client,
  input: Omit<PublishInput, 'driverUserId' | 'requesterId' | 'responsibleId' | 'module'> & {
    resourceId: string
    rules: readonly DriverNotificationEvent[]
  },
) {
  await runIsolated(client, 'integration_publish', 'integration_publish_failed', input.type, async () => {
    const schema = await client.query<{ present: boolean }>(`SELECT to_regclass('public.fleet_drivers') IS NOT NULL AS present`)
    if (!schema.rows[0]?.present) return
    const driver = await client.query<{ user_id: string }>(
      `SELECT d.user_id::text AS user_id
         FROM public.service_requests r
         JOIN public.fleet_drivers d ON d.id = r.motorista_id
        WHERE r.id = $1 AND d.user_id IS NOT NULL`,
      [input.resourceId],
    )
    if (!driver.rows[0]) return
    const { rules, ...event } = input
    await applyDriverRules(client, rules, { ...event, module: 'fleet', driverUserId: driver.rows[0].user_id })
  })
}

/** Atualiza o estado desejado do agendamento no calendário externo, com o mesmo isolamento. */
export async function requestCalendarSync(
  client: Client,
  requestId: string,
  module: 'maintenance' | 'fleet',
  action: 'upsert' | 'delete',
  { onlyIfTracked = false }: { onlyIfTracked?: boolean } = {},
) {
  await runIsolated(client, 'calendar_sync', 'calendar_sync_request_failed', action, async () => {
    const status = calendarMode(module) === 'none' ? 'not_configured' : 'pending'
    if (onlyIfTracked) {
      await client.query(
        `UPDATE public.calendar_sync_items
            SET desired_action = $2, revision = revision + 1, status = $3,
                attempts = 0, next_attempt_at = now(), locked_until = NULL, last_error_code = NULL
          WHERE request_id = $1`,
        [requestId, action, status],
      )
      return
    }
    await client.query(
      `INSERT INTO public.calendar_sync_items (request_id, module, desired_action, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (request_id) DO UPDATE
         SET desired_action = EXCLUDED.desired_action,
             revision = public.calendar_sync_items.revision + 1,
             status = EXCLUDED.status,
             attempts = 0, next_attempt_at = now(), locked_until = NULL, last_error_code = NULL`,
      [requestId, module, action, status],
    )
  })
}

async function runIsolated(
  client: Client,
  savepoint: string,
  failureEvent: string,
  detail: string,
  work: () => Promise<void>,
) {
  await client.query(`SAVEPOINT ${savepoint}`)
  try {
    await work()
    await client.query(`RELEASE SAVEPOINT ${savepoint}`)
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
    await client.query(`RELEASE SAVEPOINT ${savepoint}`)
    logSecurityEvent(failureEvent, { detail, ...describeError(error) })
  }
}

export type PublishInput = {
  type: EventType
  /** Repetir a mesma chave não gera nova comunicação. */
  key: string
  module: IntegrationModule
  resourceId: string | null
  protocol: string
  actorId: string | null
  requesterId?: string | null
  /** Pedido digitado de outro sistema: a pessoa pode não ter conta, só o e-mail informado. */
  requesterEmail?: string | null
  responsibleId?: string | null
  /** Conta do motorista da viagem, para os eventos que vão a ele. */
  driverUserId?: string | null
  /**
   * Endereço da pessoa dona da conta, lido pela transação que causou o aviso. Vale para cadastro
   * pendente ou rejeitado e conta desativada, que não passam pela busca de contas aprovadas.
   */
  accountEmail?: string | null
  context?: Omit<EventContext, 'module' | 'protocol'>
}

/** Situação inicial de um e-mail na fila: sem serviço ativo, fica registrado e não sai sozinho. */
export function initialEmailStatus() {
  return emailMode() === 'none' ? 'not_configured' : 'pending'
}

/**
 * Uma linha na fila central. A restrição única (evento, destinatário) impede a duplicidade, e o
 * worker monta o texto na hora do envio. Usada também pelo Controle de Demandas.
 */
export async function enqueueEmail(
  client: Client,
  input: {
    eventId: string
    templateKey: string
    audience: 'requester' | 'internal'
    recipient: string
    cc?: readonly string[]
    subject: string
    /**
     * Agrupamento de avisos administrativos equivalentes (mesmo modelo e destinatário). Dentro da
     * janela, o acontecimento soma na mensagem ainda não enviada; se a anterior acabou de sair, a nova
     * espera o fim da janela e reúne o que vier até lá. Exige a migração 019.
     */
    groupMinutes?: number
  },
) {
  const status = initialEmailStatus()
  const recipient = input.recipient.trim().toLowerCase()
  if (input.groupMinutes && input.groupMinutes > 0 && (await hasGroupingColumn(client))) {
    // Dois acontecimentos simultâneos para a mesma pessoa não criam duas mensagens.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`email-group:${input.templateKey}:${recipient}`])
    const open = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM public.email_deliveries
        WHERE template_key = $1 AND recipient = $2 AND attempts = 0
          AND status IN ('pending', 'not_configured')
          AND created_at > now() - make_interval(mins => $3)
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [input.templateKey, recipient, input.groupMinutes],
    )
    if (open.rows[0]) {
      await client.query(
        `UPDATE public.email_deliveries SET grouped_count = grouped_count + 1 WHERE id = $1`,
        [open.rows[0].id],
      )
      return
    }
    const recent = await client.query<{ last: Date | null }>(
      `SELECT max(COALESCE(sent_at, created_at)) AS last FROM public.email_deliveries
        WHERE template_key = $1 AND recipient = $2 AND status IN ('sent', 'sending')
          AND COALESCE(sent_at, created_at) > now() - make_interval(mins => $3)`,
      [input.templateKey, recipient, input.groupMinutes],
    )
    const last = recent.rows[0]?.last ?? null
    await client.query(
      `INSERT INTO public.email_deliveries
        (event_id, template_key, audience, recipient, cc, subject, status, last_error_code, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               CASE WHEN $9::timestamptz IS NULL THEN now() ELSE $9::timestamptz + make_interval(mins => $10) END)
       ON CONFLICT (event_id, recipient) DO NOTHING`,
      [
        input.eventId,
        input.templateKey,
        input.audience,
        recipient,
        [...(input.cc ?? [])],
        input.subject,
        status,
        status === 'not_configured' ? 'EMAIL_NOT_CONFIGURED' : null,
        last,
        input.groupMinutes,
      ],
    )
    return
  }
  await client.query(
    `INSERT INTO public.email_deliveries
      (event_id, template_key, audience, recipient, cc, subject, status, last_error_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (event_id, recipient) DO NOTHING`,
    [
      input.eventId,
      input.templateKey,
      input.audience,
      recipient,
      [...(input.cc ?? [])],
      input.subject,
      status,
      status === 'not_configured' ? 'EMAIL_NOT_CONFIGURED' : null,
    ],
  )
}

/** A coluna grouped_count chega com a migração 019. Sem ela, cada aviso segue individual. */
async function hasGroupingColumn(client: Client) {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.email_daily_usage') IS NOT NULL AS present`,
  )
  return result.rows[0]?.present === true
}

/** Contas aprovadas que têm todas as permissões, com o endereço. */
async function loadHolders(client: Client, required: readonly Permission[], excludeUserId: string | null) {
  const migrated = await isAccessSchemaMigrated(client)
  const sql = accessSql(migrated)
  const result = await client.query<AccessRow & { id: string; email: string | null }>(
    `SELECT u.id::text AS id, u.email, ${sql.columns}
       FROM public.auth_users u
       ${sql.join}
      WHERE u.status = 'approved'`,
  )
  return result.rows
    .filter((row) => row.id !== excludeUserId)
    .filter((row) => {
      const access = resolveAccess(row)
      return access !== null && required.every((permission) => access.permissions.includes(permission))
    })
    .map((row) => ({ id: row.id, email: row.email?.trim().toLowerCase() || null }))
}

/**
 * O responsável só recebe e-mail se a conta estiver aprovada e ainda atender o módulo: quem perdeu
 * a permissão depois da atribuição não recebe nada por e-mail.
 */
async function responsibleAddress(client: Client, module: IntegrationModule, userId: string) {
  if (module !== 'maintenance' && module !== 'fleet' && module !== 'flights') return null
  const required: Permission[] = [`${module}:read` as Permission, `${module}:update` as Permission]
  const migrated = await isAccessSchemaMigrated(client)
  const sql = accessSql(migrated)
  const result = await client.query<AccessRow & { email: string | null }>(
    `SELECT u.email, ${sql.columns}
       FROM public.auth_users u
       ${sql.join}
      WHERE u.id = $1 AND u.status = 'approved'`,
    [userId],
  )
  const row = result.rows[0]
  const access = row ? resolveAccess(row) : null
  if (!row || !access || !required.every((permission) => access.permissions.includes(permission))) return null
  return row.email?.trim().toLowerCase() || null
}

async function loadTeam(client: Client, module: IntegrationModule, excludeUserId: string | null) {
  const migrated = await isAccessSchemaMigrated(client)
  const sql = accessSql(migrated)
  const result = await client.query<AccessRow & { id: string }>(
    `SELECT u.id::text AS id, ${sql.columns}
       FROM public.auth_users u
       ${sql.join}
      WHERE u.status = 'approved'`,
  )
  const required = teamPermissions(module)
  return result.rows
    .filter((row) => row.id !== excludeUserId)
    .filter((row) => {
      const access = resolveAccess(row)
      return access !== null && required.every((permission) => access.permissions.includes(permission))
    })
    .map((row) => row.id)
}

async function fanOut(client: Client, input: PublishInput) {
  const audience = audienceOf(input.type)
  const context: EventContext = {
    ...input.context,
    // Comentários e motivos já chegam protegidos: a redação abaixo cobre o que vai para fora.
    reason: input.context?.reason ? redactForOutbound(input.context.reason) : input.context?.reason,
    conditions: input.context?.conditions ? redactForOutbound(input.context.conditions) : input.context?.conditions,
    changes: input.context?.changes?.map((change) => ({
      campo: change.campo,
      de: change.de === null ? null : redactForOutbound(change.de),
      para: change.para === null ? null : redactForOutbound(change.para),
    })),
    // O trecho de uma viagem não é necessário para acompanhar a solicitação.
    title: input.module === 'flights' ? undefined : input.context?.title,
    module: input.module,
    protocol: input.protocol,
  }

  const created = await client.query<{ id: string }>(
    `INSERT INTO public.integration_events (event_key, event_type, module, resource_id, protocol, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      input.key,
      input.type,
      input.module,
      input.resourceId,
      input.protocol,
      JSON.stringify(context),
    ],
  )
  // Mesmo acontecimento já registrado: nada a repetir.
  const eventId = created.rows[0]?.id
  if (!eventId) return

  // E-mails: sem serviço ativo, ficam registrados e só saem por reprocessamento autorizado.
  const subject = renderSubject(input.type, context)
  // Avisar por e-mail que o e-mail falhou poderia falhar de novo e gerar outro aviso, sem fim.
  const emailAllowed = !(input.type === 'integration_failure' && context.channel === 'email')
  const groupMinutes = groupableEvents.includes(input.type) ? quotaSettings().adminGroupMinutes : 0
  const enqueue = (audienceName: 'requester' | 'internal', recipient: string, cc: string[]) =>
    enqueueEmail(client, { eventId, templateKey: input.type, audience: audienceName, recipient, cc, subject, groupMinutes })

  const notified = new Map<string, readonly string[]>()

  if (audience.toRequester && (input.requesterId || input.requesterEmail)) {
    const requester = input.requesterId
      ? await client.query<{ email: string }>(
          `SELECT email FROM public.auth_users WHERE id = $1 AND status = 'approved'`,
          [input.requesterId],
        )
      : null
    const email = (requester?.rows[0]?.email ?? input.requesterEmail)?.trim().toLowerCase()
    if (email) await enqueue('requester', email, carbonCopies(input.module).filter((cc) => cc !== email))
    if (input.requesterId && input.requesterId !== input.actorId) {
      notified.set(input.requesterId, requesterPermissions(input.module))
    }
  }

  if (audience.toTeam) {
    if (emailAllowed) {
      for (const recipient of internalRecipients(input.module)) {
        await enqueue('internal', recipient, [])
      }
    }
    for (const userId of await loadTeam(client, input.module, input.actorId)) {
      if (!notified.has(userId)) notified.set(userId, teamPermissions(input.module))
    }
  }

  if (audience.toResponsible && input.responsibleId && input.responsibleId !== input.actorId) {
    notified.set(input.responsibleId, requesterPermissions(input.module))
    if (audience.emailResponsible) {
      const email = await responsibleAddress(client, input.module, input.responsibleId)
      if (email) await enqueue('internal', email, [])
    }
  }

  // Pessoa dona da conta: o endereço vem da transação, sem nenhuma notificação na plataforma,
  // porque o cadastro pode estar pendente, rejeitado ou desativado.
  if (audience.toAccount && input.accountEmail?.trim()) {
    await enqueue('requester', input.accountEmail.trim().toLowerCase(), [])
  }

  if (audience.toHolders) {
    for (const holder of await loadHolders(client, [audience.toHolders], input.actorId)) {
      if (holder.email) await enqueue('internal', holder.email, [])
      if (!notified.has(holder.id)) notified.set(holder.id, [audience.toHolders])
    }
  }

  if (audience.toDriver && input.driverUserId) {
    const driver = await client.query<{ email: string | null }>(
      `SELECT email FROM public.auth_users WHERE id = $1 AND status = 'approved'`,
      [input.driverUserId],
    )
    const email = driver.rows[0]?.email?.trim().toLowerCase()
    if (email) await enqueue('internal', email, [])
    notified.set(input.driverUserId, ['driver_portal:access'])
  }

  // Notificações internas: texto mínimo, com o destino da informação.
  const notification = renderNotification(input.type, context)
  // O motorista não abre a tela da Frota: o aviso leva ao portal dele.
  const link = audience.toDriver ? '/motorista' : linkPathOf(input.type, input.module, input.resourceId)
  for (const [userId, required] of notified) {
    await client.query(
      `INSERT INTO public.user_notifications
        (event_id, user_id, category, title, message, link, required_permissions)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_id, user_id) DO NOTHING`,
      [eventId, userId, notification.category, notification.title, notification.message, link, required],
    )
  }
}
