import { createHash } from 'node:crypto'
import { resolveAttachmentStorage } from '../attachments/storage.js'
import type { AttachmentStorage } from '../attachments/storage.js'
import { CommunicationRepository } from '../database/communicationRepository.js'
import type { ClaimedManualEmail } from '../database/communicationRepository.js'
import { IntegrationRepository } from '../database/integrationRepository.js'
import type { ClaimedEmail } from '../database/integrationRepository.js'
import { getDatabasePool } from '../database/pool.js'
import { readSystemSettings } from '../database/settingsRepository.js'
import { withTransaction } from '../database/withTransaction.js'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'
import { describeError, logSecurityEvent } from '../security/logger.js'
import { readPublishedConfigs } from '../database/configRepository.js'
import { isEventType, linkPathOf, maxAgeHoursOf, missingEmailData, renderEmail } from './catalog.js'
import type { TemplateOverride } from './catalog.js'
import { pendingReminderDays, publicLink } from './config.js'
import { publishIntegrationEvent } from './publisher.js'
import { nextQuotaDay, quotaEnforcedFor, reserveEmailQuota } from './emailQuota.js'
import { RECIPIENT_OUTSIDE_TEST_LIST, recipientDomains, recipientsOutsideList, restrictionEnforcedFor } from './recipientAllowlist.js'
import { recordAuthAuditEvent } from '../database/authAuditRepository.js'
import type { QuotaReservation } from './emailQuota.js'
import {
  IntegrationError,
  resolveEmailTransport,
} from './transports.js'
import type { EmailTransport } from './transports.js'

/**
 * Processa as filas fora das requisições: uma falha no provedor nunca chega ao usuário que
 * registrou a solicitação. Cada item é reservado, tratado e marcado em transações separadas,
 * e nenhuma conexão com o banco fica presa enquanto o provedor responde.
 */

const batchSize = 20

/**
 * Códigos que não são falha do serviço: o aviso perdeu a validade, o destinatário perdeu o acesso ou a
 * situação mudou. Ficam no histórico como falha definitiva, sem alerta à equipe.
 */
const silentCodes = new Set([
  'NOTICE_OBSOLETE',
  'EXPIRED',
  'RECIPIENT_ACCESS_REVOKED',
  'RECIPIENT_ADDRESS_CHANGED',
  'RECIPIENT_PREFERENCE_DISABLED',
  RECIPIENT_OUTSIDE_TEST_LIST,
  'BLOCKED_BEFORE_ACTIVATION',
])

/** Algum endereço da mensagem está fora da lista de testes: nada sai, e a cota não é tocada. */
class RecipientBlocked extends IntegrationError {
  constructor(readonly domains: string[]) {
    super(RECIPIENT_OUTSIDE_TEST_LIST, false)
  }
}

/** Confere a lista de destinatários permitidos para o provedor deste worker. */
function assertRecipientsAllowed(provider: string, addresses: readonly string[]) {
  if (!restrictionEnforcedFor(provider)) return
  const outside = recipientsOutsideList(addresses)
  if (outside.length > 0) throw new RecipientBlocked(recipientDomains(outside))
}

/** O mesmo bloqueio, sem lançar: usado ao adiar o resto de um lote por falta de cota. */
function blockedByList(provider: string, addresses: readonly string[]) {
  try {
    assertRecipientsAllowed(provider, addresses)
    return null
  } catch (error) {
    if (error instanceof RecipientBlocked) return error
    throw error
  }
}

/** Bloqueio na auditoria: canal, modelo e domínios. O endereço completo nunca é gravado. */
async function auditBlocked(channel: string, template: string, domains: string[]) {
  await recordAuthAuditEvent({
    actorUserId: null,
    actorKind: 'system',
    subjectUserId: null,
    sessionId: null,
    eventType: 'email_recipient_blocked',
    result: 'denied',
    details: { channel, template, domains },
  })
}

/** A cota do dia acabou, ou não pôde ser conferida: a mensagem volta à fila, sem contar tentativa. */
class QuotaDeferral extends Error {
  constructor(readonly code: Exclude<QuotaReservation, { allowed: true }>['code']) {
    super(code)
  }
}

function deferralTime(code: QuotaDeferral['code'], now = new Date()) {
  return code === 'DAILY_LIMIT_REACHED' ? nextQuotaDay(now) : new Date(now.getTime() + 60 * 60 * 1000)
}

/** Reserva na cota do dia, com o mesmo banco do worker. */
function quotaReserver(transport: EmailTransport) {
  const enforced = quotaEnforcedFor(transport.provider)
  return async (units: number) => {
    const reservation = await reserveEmailQuota(getDatabasePool(), 'notification', units, { enforced })
    if (!reservation.allowed) throw new QuotaDeferral(reservation.code)
  }
}

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
  const reserve = quotaReserver(transport)
  let sent = 0
  let failed = 0
  let deferred = 0
  const claimed = await repository.claimEmails(batchSize)
  for (const [index, item] of claimed.entries()) {
    try {
      const { messageId } = await sendOne(transport, item, overrides[item.templateKey], repository, reserve)
      await repository.markEmailSent(item, {
        provider: transport.provider,
        simulated: transport.simulated,
        messageId,
      })
      sent += 1
    } catch (error) {
      if (error instanceof QuotaDeferral) {
        // Sem capacidade: esta e as demais já reservadas voltam à fila, sem tentativa gasta.
        // Quem está fora da lista de testes é bloqueado de vez, como seria se a cota não tivesse
        // acabado: o resultado não depende da ordem do lote nem de quantos workers rodam juntos.
        const until = deferralTime(error.code)
        for (const [restIndex, rest] of claimed.slice(index).entries()) {
          const blocked = restIndex > 0 ? blockedByList(transport.provider, [rest.recipient, ...rest.cc]) : null
          if (blocked) {
            failed += 1
            await repository.markEmailFailed(rest, outcomeOf(blocked))
            await auditBlocked('fila', rest.templateKey, blocked.domains)
            continue
          }
          await repository.deferEmail(rest, until, error.code)
          deferred += 1
        }
        logSecurityEvent('email_queue_deferred', { code: error.code, total: deferred })
        break
      }
      failed += 1
      const final = await repository.markEmailFailed(item, outcomeOf(error))
      logSecurityEvent('email_delivery_failed', { final, code: outcomeOf(error).code })
      if (error instanceof RecipientBlocked) await auditBlocked('fila', item.templateKey, error.domains)
      // Aviso vencido, obsoleto ou a quem perdeu o acesso não é falha do serviço: sem alerta à equipe.
      if (final && !silentCodes.has(outcomeOf(error).code)) {
        recordTechnicalEvent('email', 'email_delivery_failed', error)
        await reportFailure('email', item, item.protocol)
      }
    }
  }
  // "deferred" só aparece quando houve adiamento, para não mudar o retorno conhecido.
  return { sent, failed, ...(deferred > 0 ? { deferred } : {}) }
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
  const reserve = quotaReserver(transport)
  let sent = 0
  let failed = 0
  const claimed = await repository.claim(batchSize)
  for (const [index, item] of claimed.entries()) {
    try {
      const attachments = await loadManualAttachments(item, storage)
      const [first, ...others] = item.recipients
      // Lista de testes antes da cota: mensagem bloqueada não consome nada.
      assertRecipientsAllowed(transport.provider, [...item.recipients, ...item.cc])
      // Mensagem manual também consome a cota das notificações: cada destinatário e cópia conta.
      await reserve(item.recipients.length + item.cc.length)
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
      if (error instanceof QuotaDeferral) {
        const until = deferralTime(error.code)
        let deferred = 0
        for (const [restIndex, rest] of claimed.slice(index).entries()) {
          const blocked = restIndex > 0 ? blockedByList(transport.provider, [...rest.recipients, ...rest.cc]) : null
          if (blocked) {
            failed += 1
            await repository.markFailed(rest, outcomeOf(blocked))
            await auditBlocked('mensagem_manual', 'manual_message', blocked.domains)
            continue
          }
          await repository.defer(rest.id, until, error.code)
          deferred += 1
        }
        logSecurityEvent('manual_email_deferred', { code: error.code, total: deferred })
        break
      }
      failed += 1
      const final = await repository.markFailed(item, outcomeOf(error))
      if (error instanceof RecipientBlocked) await auditBlocked('mensagem_manual', 'manual_message', error.domains)
      logSecurityEvent('manual_email_failed', { final, code: outcomeOf(error).code })
      if (final && !silentCodes.has(outcomeOf(error).code)) recordTechnicalEvent('email', 'manual_email_failed', error)
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
        for await (const chunk of await storage.open(attachment.storageKey)) chunks.push(chunk as Buffer)
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
  reserve: (units: number) => Promise<void> = async () => undefined,
) {
  if (!isEventType(item.templateKey)) {
    throw new IntegrationError('TEMPLATE_UNKNOWN', false)
  }
  // Validade do evento: passado o prazo, o aviso não sai mais, nem que o serviço tenha acabado de ser ligado.
  if (Date.now() - new Date(item.createdAt).getTime() > maxAgeHoursOf(item.templateKey) * 3_600_000) {
    throw new IntegrationError('EXPIRED', false)
  }
  // Dados atuais do banco. Sem eles, a mensagem segue, e as linhas que dependem deles somem.
  const fresh = await repository.templateData(item.module, item.resourceId).catch(() => ({}))
  const context = { ...fresh, ...item.context, module: item.module, protocol: item.protocol }
  if (item.module === 'demands') {
    // Conferido de novo no envio: quem perdeu o acesso, desligou o e-mail ou silenciou o tipo
    // não recebe, e a demanda que ficou restrita depois do aviso perde o título.
    const check = await repository.demandEmailCheck(item.resourceId, item.recipient, item.templateKey)
    if (!check.allowed) throw new IntegrationError(check.code, false)
    if (check.restricted) {
      context.restricted = true
      delete context.title
    }
  } else {
    // Conta, segurança, administração e responsável: conferidos de novo, segundo cada evento.
    const check = await repository.noticeRecipientCheck(item)
    if (!check.allowed) throw new IntegrationError(check.code, false)
    if (check.accountName) context.accountName = check.accountName
  }
  if (item.groupedCount > 1) context.groupedCount = item.groupedCount
  // Lista de testes antes da cota: destinatário e cópias. Mensagem bloqueada não consome nada.
  assertRecipientsAllowed(transport.provider, [item.recipient, ...item.cc])
  if (missingEmailData(item.templateKey, context).length > 0) {
    throw new IntegrationError('TEMPLATE_DATA_MISSING', false)
  }
  const path = linkPathOf(item.templateKey, item.module, item.resourceId)
  const message = renderEmail(item.templateKey, context, path === null ? null : publicLink(path), override)
  // A cota é reservada só para o que de fato vai sair: cada destinatário e cópia conta.
  await reserve(1 + item.cc.length)
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
  repository?: IntegrationRepository
  intervalMs?: number
}

export function startIntegrationWorker(dependencies: WorkerDependencies = {}) {
  const emailTransport =
    dependencies.emailTransport === undefined ? resolveEmailTransport() : dependencies.emailTransport
  const repository = dependencies.repository ?? new IntegrationRepository()

  let tick = 0
  let running = false
  const run = async () => {
    // Um ciclo demorado não se sobrepõe ao seguinte.
    if (running) return
    running = true
    try {
      // A validade vale com ou sem serviço ativo: o que venceu fica registrado, e nada é reenviado.
      await repository.expireStaleEmails().catch((error: unknown) =>
        logSecurityEvent('email_expiry_failed', describeError(error)),
      )
      await processEmailQueue(emailTransport, repository)
      await processManualEmailQueue(emailTransport)
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

