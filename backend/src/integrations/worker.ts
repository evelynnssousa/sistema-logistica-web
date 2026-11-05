import { createHash } from 'node:crypto'
import { resolveAttachmentStorage } from '../attachments/storage.js'
import type { AttachmentStorage } from '../attachments/storage.js'
import { CommunicationRepository } from '../database/communicationRepository.js'
import type { ClaimedManualEmail } from '../database/communicationRepository.js'
import { IntegrationRepository } from '../database/integrationRepository.js'
import type { ClaimedCalendarItem, ClaimedEmail } from '../database/integrationRepository.js'
import { getDatabasePool } from '../database/pool.js'
import { readSystemSettings } from '../database/settingsRepository.js'
import { withTransaction } from '../database/withTransaction.js'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'
import { describeError, logSecurityEvent } from '../security/logger.js'
import { readPublishedConfigs } from '../database/configRepository.js'
import { isEventType, missingEmailData, moduleNames, renderEmail, resourcePath } from './catalog.js'
import type { TemplateOverride } from './catalog.js'
import { pendingReminderDays, publicLink } from './config.js'
import { publishIntegrationEvent } from './publisher.js'
import { redactForOutbound } from './redaction.js'
import {
  externalEventId,
  IntegrationError,
  resolveCalendarTransport,
  resolveEmailTransport,
} from './transports.js'
import type { CalendarTransport, EmailTransport } from './transports.js'

/**
 * Processa as filas fora das requisições: uma falha no provedor nunca chega ao usuário que
 * registrou a solicitação. Cada item é reservado, tratado e marcado em transações separadas,
 * e nenhuma conexão com o banco fica presa enquanto o provedor responde.
 */

const batchSize = 20

function outcomeOf(error: unknown) {
  return error instanceof IntegrationError
    ? { code: error.code, retryable: error.retryable }
    : { code: 'UNEXPECTED', retryable: true }
}

async function reportFailure(
  channel: 'email' | 'calendar',
  item: { id: string; attempts: number },
  protocol: string,
) {
  try {
    await withTransaction(getDatabasePool(), (client) =>
      publishIntegrationEvent(client, {
        type: 'integration_failure',
        key: `failure:${channel}:${item.id}:${item.attempts + 1}`,
        module: 'system',
        resourceId: null,
        protocol,
        actorId: null,
        context: { channel },
      }),
    )
  } catch (error) {
    logSecurityEvent('integration_failure_report_failed', { channel, ...describeError(error) })
  }
}

export async function processEmailQueue(
  transport: EmailTransport | null,
  repository = new IntegrationRepository(),
) {
  // Sem serviço ativo, nada é reservado: não há tentativa nem falha a registrar.
  if (!transport) return { sent: 0, failed: 0 }

  const overrides = await templateOverrides()
  let sent = 0
  let failed = 0
  for (const item of await repository.claimEmails(batchSize)) {
    try {
      const { messageId } = await sendOne(transport, item, overrides[item.templateKey], repository)
      await repository.markEmailSent(item, {
        provider: transport.provider,
        simulated: transport.simulated,
        messageId,
      })
      sent += 1
    } catch (error) {
      failed += 1
      const final = await repository.markEmailFailed(item, outcomeOf(error))
      logSecurityEvent('email_delivery_failed', { final, code: outcomeOf(error).code })
      if (final) {
        recordTechnicalEvent('email', 'email_delivery_failed', error)
        await reportFailure('email', item, item.protocol)
      }
    }
  }
  return { sent, failed }
}

/** Sem os parâmetros, valem os modelos do código: um problema aqui não atrasa a fila. */
/**
 * Mensagens escritas pelos operadores. "Enviado" só depois de o serviço aceitar. A mesma chave em
 * todas as tentativas impede o provedor de duplicar, se a resposta anterior se perdeu.
 */
export async function processManualEmailQueue(
  transport: EmailTransport | null,
  repository = new CommunicationRepository(),
  storage = resolveAttachmentStorage(),
) {
  if (!transport) return { sent: 0, failed: 0 }
  let sent = 0
  let failed = 0
  for (const item of await repository.claim(batchSize)) {
    try {
      const attachments = await loadManualAttachments(item, storage)
      const [first, ...others] = item.recipients
      const { messageId } = await transport.send({
        idempotencyKey: `slm-manual-${item.id}`,
        to: first,
        moreTo: others,
        cc: item.cc,
        subject: item.subject,
        text: item.text,
        html: item.html,
        attachments,
      })
      await repository.markSent(item.id, { provider: transport.provider, simulated: transport.simulated, messageId })
      sent += 1
    } catch (error) {
      failed += 1
      const final = await repository.markFailed(item, outcomeOf(error))
      logSecurityEvent('manual_email_failed', { final, code: outcomeOf(error).code })
      if (final) recordTechnicalEvent('email', 'manual_email_failed', error)
    }
  }
  return { sent, failed }
}

/** Confere cada arquivo de novo antes de sair: removido ou alterado depois do registro não vai. */
async function loadManualAttachments(item: ClaimedManualEmail, storage: AttachmentStorage | null) {
  if (item.attachments.length === 0) return []
  if (!storage) throw new IntegrationError('ATTACHMENT_STORAGE_MISSING', false)
  return Promise.all(
    item.attachments.map(async (attachment) => {
      if (attachment.removed) throw new IntegrationError('ATTACHMENT_REMOVED', false)
      const chunks: Buffer[] = []
      try {
        for await (const chunk of storage.open(attachment.storageKey)) chunks.push(chunk as Buffer)
      } catch {
        throw new IntegrationError('ATTACHMENT_UNREADABLE', false)
      }
      const content = Buffer.concat(chunks)
      if (createHash('sha256').update(content).digest('hex') !== attachment.sha256) {
        throw new IntegrationError('ATTACHMENT_CHANGED', false)
      }
      return { filename: attachment.name, content }
    }),
  )
}

async function templateOverrides(): Promise<Record<string, TemplateOverride>> {
  const pool = getDatabasePool()
  let overrides: Record<string, TemplateOverride> = {}
  try {
    overrides = { ...(await readSystemSettings(pool)).emailTemplates.overrides }
  } catch {
    return overrides
  }
  try {
    // Modelo publicado no gerenciador vale para o evento dele; o mais recente prevalece.
    const published = await readPublishedConfigs<TemplateOverride & { event?: string; active?: boolean }>(pool, 'email_template')
    for (const item of [...published].sort((first, second) => first.at.getTime() - second.at.getTime())) {
      const { event, active, ...content } = item.content
      if (event && active !== false) overrides[event] = content
    }
  } catch {
    // Sem as versões, valem os parâmetros já lidos.
  }
  return overrides
}

async function sendOne(
  transport: EmailTransport,
  item: ClaimedEmail,
  override: TemplateOverride | undefined,
  repository: IntegrationRepository,
) {
  if (!isEventType(item.templateKey)) {
    throw new IntegrationError('TEMPLATE_UNKNOWN', false)
  }
  // Dados atuais do banco. Sem eles, a mensagem segue, e as linhas que dependem deles somem.
  const fresh = await repository.templateData(item.module, item.resourceId).catch(() => ({}))
  const context = { ...fresh, ...item.context, module: item.module, protocol: item.protocol }
  if (missingEmailData(item.templateKey, context).length > 0) {
    throw new IntegrationError('TEMPLATE_DATA_MISSING', false)
  }
  const message = renderEmail(
    item.templateKey,
    context,
    publicLink(resourcePath(item.module, item.resourceId)),
    override,
  )
  return transport.send({
    idempotencyKey: `slm-${item.id}`,
    to: item.recipient,
    cc: item.cc,
    ...message,
  })
}

export async function refreshDeliveryStatuses(
  transport: EmailTransport | null,
  repository = new IntegrationRepository(),
) {
  if (!transport?.deliveryStatus) return 0

  let checked = 0
  for (const item of await repository.emailsAwaitingDeliveryStatus(batchSize)) {
    try {
      await repository.saveDeliveryStatus(item.id, await transport.deliveryStatus(item.messageId))
      checked += 1
    } catch (error) {
      await repository.saveDeliveryStatus(item.id, null)
      logSecurityEvent('email_status_check_failed', describeError(error))
    }
  }
  return checked
}

export async function processCalendarQueue(
  transport: CalendarTransport | null,
  repository = new IntegrationRepository(),
) {
  if (!transport) return { synced: 0, failed: 0 }

  let synced = 0
  let failed = 0
  for (const item of await repository.claimCalendarItems(batchSize)) {
    let protocol = ''
    try {
      const data = await repository.calendarEventData(item.requestId)
      protocol = data?.protocolo ?? ''
      await syncOne(transport, item, data)
      await repository.markCalendarSynced(item, {
        simulated: transport.simulated,
        externalEventId: item.action === 'upsert' ? externalEventId(item.requestId) : null,
      })
      synced += 1
    } catch (error) {
      failed += 1
      const final = await repository.markCalendarFailed(item, outcomeOf(error))
      logSecurityEvent('calendar_sync_failed', { final, code: outcomeOf(error).code })
      if (final) {
        recordTechnicalEvent('calendar', 'calendar_sync_failed', error)
        await reportFailure('calendar', item, protocol)
      }
    }
  }
  return { synced, failed }
}

const calendarStatusLabels: Record<string, string> = {
  agendado: 'Agendado',
  agendada: 'Agendado',
  reagendado: 'Reagendado',
  em_andamento: 'Em andamento',
  concluido: 'Concluído',
  concluida: 'Concluído',
}

/** O evento leva só o necessário: sem solicitante, descrição, passageiros ou responsável. */
function syncOne(
  transport: CalendarTransport,
  item: ClaimedCalendarItem,
  data: Awaited<ReturnType<IntegrationRepository['calendarEventData']>>,
) {
  const eventId = externalEventId(item.requestId)
  if (item.action === 'delete') return transport.remove(item.module, eventId)
  if (!data?.data_agendada) throw new IntegrationError('REQUEST_NOT_SCHEDULED', false)

  const link = publicLink(resourcePath(item.module, item.requestId))
  return transport.upsert({
    eventId,
    module: item.module,
    summary: redactForOutbound(
      `${moduleNames[item.module]} ${/^\d+$/.test(data.protocolo) ? '#' : ''}${data.protocolo}: ${data.titulo}`,
    ),
    description: [
      `Protocolo: ${data.protocolo}`,
      `Situação: ${calendarStatusLabels[data.status] ?? data.status}`,
      ...(data.setor_nome ? [`Setor: ${data.setor_nome}`] : []),
      ...(link ? [`Solicitação: ${link}`] : []),
    ].join('\n'),
    start: data.data_agendada,
    end: data.agendamento_fim,
  })
}

/** Um resumo por módulo e por dia, só para quem atende: a chave impede a repetição no dia. */
export async function publishPendingReminders(
  days: number | null,
  repository = new IntegrationRepository(),
  now = new Date(),
) {
  if (!days) return 0
  const today = now.toISOString().slice(0, 10)
  const counts = await repository.stalePendingCounts(days)
  for (const { modulo, total } of counts) {
    await withTransaction(getDatabasePool(), (client) =>
      publishIntegrationEvent(client, {
        type: 'pending_reminder',
        key: `pending:${modulo}:${today}`,
        module: modulo,
        resourceId: null,
        protocol: '',
        actorId: null,
        context: { total, days },
      }),
    )
  }
  return counts.length
}

const moduleByStoredType: Record<string, 'maintenance' | 'fleet' | 'flights'> = {
  manutencao: 'maintenance',
  frota: 'fleet',
  passagem: 'flights',
}

/** Avisa o responsável uma única vez por prazo vencido. Reabrir o prazo gera um novo aviso. */
export async function publishOverdueAlerts(repository = new IntegrationRepository()) {
  const overdue = await repository.overdueRequests(batchSize)
  for (const item of overdue) {
    const stamp = item.prazo_em.toISOString().slice(0, 16).replace(/[-:T]/g, '')
    await withTransaction(getDatabasePool(), (client) =>
      publishIntegrationEvent(client, {
        type: 'request_overdue',
        key: `${item.id}:overdue:${stamp}`,
        module: moduleByStoredType[item.tipo],
        resourceId: item.id,
        protocol: item.protocolo,
        actorId: null,
        responsibleId: item.responsavel_id,
      }),
    )
  }
  return overdue.length
}

/** O valor da tela prevalece. Sem ele, vale a variável de ambiente; sem ambos, não há lembrete. */
export async function configuredReminderDays(environment: NodeJS.ProcessEnv = process.env) {
  const settings = await readSystemSettings(getDatabasePool())
  return settings.notifications.pendingReminderDays ?? pendingReminderDays(environment)
}

const defaultIntervalMs = 30_000
const statusIntervalTicks = 20
const reminderIntervalTicks = 120

export type WorkerDependencies = {
  emailTransport?: EmailTransport | null
  calendarTransport?: CalendarTransport | null
  repository?: IntegrationRepository
  intervalMs?: number
}

export function startIntegrationWorker(dependencies: WorkerDependencies = {}) {
  const emailTransport =
    dependencies.emailTransport === undefined ? resolveEmailTransport() : dependencies.emailTransport
  const calendarTransport =
    dependencies.calendarTransport === undefined
      ? resolveCalendarTransport()
      : dependencies.calendarTransport
  const repository = dependencies.repository ?? new IntegrationRepository()

  let tick = 0
  let running = false
  const run = async () => {
    // Um ciclo demorado não se sobrepõe ao seguinte.
    if (running) return
    running = true
    try {
      await processEmailQueue(emailTransport, repository)
      await processManualEmailQueue(emailTransport)
      await processCalendarQueue(calendarTransport, repository)
      if (tick % statusIntervalTicks === 0) await refreshDeliveryStatuses(emailTransport, repository)
      if (tick % reminderIntervalTicks === 0) {
        await publishPendingReminders(await configuredReminderDays(), repository)
        await publishOverdueAlerts(repository)
      }
    } catch (error) {
      recordTechnicalEvent('worker', 'integration_worker_cycle_failed', error)
    } finally {
      tick += 1
      running = false
    }
  }

  void run()
  const timer = setInterval(() => void run(), dependencies.intervalMs ?? defaultIntervalMs)
  timer.unref()
  return timer
}

