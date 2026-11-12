import { Router } from 'express'
import type { Request, Response } from 'express'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { IntegrationRepository } from '../database/integrationRepository.js'
import { conflict, notFound, sendModuleError } from '../database/moduleErrors.js'
import { listTemplates } from '../integrations/catalog.js'
import { configuredReminderDays } from '../integrations/worker.js'
import { emailMode, integrationStatus } from '../integrations/config.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { asBody, isUuid, readPage, readSearch } from '../requests/validation.js'

/**
 * Notificações da própria pessoa e administração das integrações. Nenhuma resposta traz
 * credenciais, e-mails completos ou o conteúdo das mensagens já enviadas.
 */

const router = Router()
const integrations = new IntegrationRepository()

router.use('/notifications', requireAuth, requireCsrf)
router.use('/integrations', requireAuth, requireCsrf)

const read = requirePermission('integrations:read')
const manage = requirePermission('integrations:manage')

function identityOf(response: Response) {
  return response.locals.authenticatedUser as AuthenticatedIdentity
}

type Handler = (request: Request, response: Response) => Promise<void>

function guarded(handler: Handler): Handler {
  return async (request, response) => {
    try {
      await handler(request, response)
    } catch (error) {
      sendModuleError(response, error)
    }
  }
}

function idParam(request: Request, name: string) {
  const value = String(request.params[name])
  if (!isUuid(value)) throw notFound()
  return value
}

const emailStatuses = ['pending', 'sending', 'sent', 'failed', 'not_configured']
const modules = ['maintenance', 'fleet', 'flights', 'warehouse', 'system', 'demands']

function oneOf(allowed: readonly string[], value: unknown) {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined
}

// ---------------------------------------------------------------------------
// Notificações
// ---------------------------------------------------------------------------
router.get(
  '/notifications',
  guarded(async (request, response) => {
    const query = asBody(request.query)
    response.json({
      success: true,
      ...(await integrations.listNotifications(identityOf(response), {
        unreadOnly: query.unread === 'true',
        pendingOnly: query.pending === 'true',
        page: readPage(query.page),
      })),
    })
  }),
)

router.get(
  '/notifications/unread-count',
  guarded(async (_request, response) => {
    response.json({ success: true, unread: await integrations.unreadCount(identityOf(response)) })
  }),
)

router.post(
  '/notifications/read-all',
  guarded(async (_request, response) => {
    await integrations.markAllRead(identityOf(response))
    response.json({ success: true })
  }),
)

router.post(
  '/notifications/:notificationId/read',
  guarded(async (request, response) => {
    await integrations.markRead(identityOf(response), idParam(request, 'notificationId'))
    response.json({ success: true })
  }),
)

// ---------------------------------------------------------------------------
// Administração
// ---------------------------------------------------------------------------
router.get(
  '/integrations/status',
  read,
  guarded(async (_request, response) => {
    // O aviso de paradas é ajustado pela tela: mostra o valor que realmente vale.
    response.json({
      success: true,
      status: {
        ...integrationStatus(),
        pendingReminderDays: await configuredReminderDays(),
        // Só totais e datas: o que está guardado sem serviço, o que expirou e o consumo do dia.
        queue: await integrations.queueOverview(),
      },
    })
  }),
)

router.get(
  '/integrations/templates',
  read,
  guarded(async (_request, response) => {
    response.json({ success: true, templates: listTemplates() })
  }),
)

router.get(
  '/integrations/emails',
  read,
  guarded(async (request, response) => {
    const query = asBody(request.query)
    response.json({
      success: true,
      ...(await integrations.listEmails({
        status: oneOf(emailStatuses, query.status),
        module: oneOf(modules, query.module),
        search: readSearch(query.search),
        page: readPage(query.page),
      })),
    })
  }),
)

router.get(
  '/integrations/emails/:itemId/attempts',
  read,
  guarded(async (request, response) => {
    response.json({
      success: true,
      attempts: await integrations.attemptsOf('email', idParam(request, 'itemId')),
    })
  }),
)

router.post(
  '/integrations/emails/:itemId/retry',
  manage,
  guarded(async (request, response) => {
    const id = idParam(request, 'itemId')
    if (emailMode() === 'none') {
      throw conflict('O serviço de e-mail não está configurado. Nada foi reprocessado.')
    }
    await integrations.retry(identityOf(response), 'email', id)
    response.json({ success: true })
  }),
)

export default router
