
import { Router } from 'express'
import { isAuthRole } from '../auth/roles.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { InstitutionalLinkRepository } from '../database/institutionalLinkRepository.js'
import { ModuleError, sendModuleError } from '../database/moduleErrors.js'
import { UserRepository, AccountAuthorizationError, UserManagementError } from '../database/userRepository.js'
import { readInstitutionalLinks } from '../demands/demandValidation.js'
import { isPermission } from '../auth/permissions.js'
import type { Permission } from '../auth/permissions.js'
import { asBody, optionalText, RequestValidationError } from '../requests/validation.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { describeError, logSecurityEvent } from '../security/logger.js'


const router = Router()
const users = new UserRepository()
const institutional = new InstitutionalLinkRepository()

// Limitado a este caminho: um router.use sem caminho alcançaria as rotas montadas depois.
router.use(
  '/admin/registrations',
  requireAuth,
  requirePermission('users:approve'),
  requireCsrf,
)

function getIdentity(response: {
  locals: { authenticatedUser?: AuthenticatedIdentity }
}): AuthenticatedIdentity {
  return response.locals.authenticatedUser as AuthenticatedIdentity
}

function sendError(
  error: unknown,
  response: {
    status: (code: number) => { json: (body: unknown) => void }
  },
) {
  if (error instanceof AccountAuthorizationError) {
    response.status(403).json({
      success: false,
      message: 'Ação administrativa não autorizada.',
    })
    return
  }

  if (error instanceof UserManagementError) {
    response.status(error.status).json({ success: false, message: error.message })
    return
  }
  if (error instanceof RequestValidationError || error instanceof ModuleError) {
    sendModuleError(response as never, error)
    return
  }

  const message = error instanceof Error ? error.message : ''

  if (
    message === 'Identificador de usuário inválido.' ||
    message === 'Perfil de aprovação inválido.'
  ) {
    response.status(400).json({
      success: false,
      message,
    })
    return
  }

  if (message === 'Solicitação não encontrada.') {
    response.status(404).json({
      success: false,
      message,
    })
    return
  }

  if (message === 'Esta solicitação já foi decidida.') {
    response.status(409).json({
      success: false,
      message,
    })
    return
  }

  logSecurityEvent('admin_registration_failed', describeError(error))
  response.status(503).json({
    success: false,
    message: 'Não foi possível concluir a operação neste momento.',
  })
}

router.get('/admin/registrations/pending', async (_request, response) => {
  try {
    const registrations = await users.listPendingRegistrations(
      getIdentity(response),
    )

    response.json({ success: true, registrations })
  } catch (error) {
    sendError(error, response)
  }
})

router.get('/admin/registrations/institutional-options', async (_request, response) => {
  try {
    response.json({ success: true, options: await institutional.options() })
  } catch (error) {
    sendError(error, response)
  }
})

/**
 * Vínculos e concessões vêm só dentro de "setup", pedidos de forma expressa pela tela.
 * Os mesmos nomes soltos no corpo continuam ignorados. Sem "setup", a aprovação segue como antes.
 */
function readApprovalLinks(raw: Record<string, unknown>) {
  const body = asBody(raw.setup)
  const granted = body.grantedPermissions
  if (granted !== undefined && (!Array.isArray(granted) || !granted.every(isPermission))) {
    throw new RequestValidationError('Permissões adicionais inválidas.')
  }
  return {
    ...(typeof body.slmMember === 'boolean' ? { slmMember: body.slmMember } : {}),
    ...(granted ? { grantedPermissions: [...new Set(granted as Permission[])] } : {}),
    ...(body.lotation ? { lotation: optionalText(body.lotation, 'Setor de lotação', 120) } : {}),
    ...(body.institutional ? { links: readInstitutionalLinks(body.institutional) } : {}),
  }
}

router.post('/admin/registrations/:userId/approve', async (request, response) => {
  const { role } = request.body ?? {}

  if (!isAuthRole(role)) {
    response.status(400).json({
      success: false,
      message: 'Selecione um perfil válido para a aprovação.',
    })
    return
  }

  try {
    const result = await users.decidePendingRegistration(
      getIdentity(response),
      request.params.userId,
      { action: 'approve', role, ...readApprovalLinks(request.body ?? {}) },
    )

    response.json({
      success: true,
      message: 'Cadastro aprovado com sucesso.',
      registration: result,
    })
  } catch (error) {
    sendError(error, response)
  }
})

router.post('/admin/registrations/:userId/reject', async (request, response) => {
  try {
    const result = await users.decidePendingRegistration(
      getIdentity(response),
      request.params.userId,
      { action: 'reject' },
    )

    response.json({
      success: true,
      message: 'Cadastro rejeitado.',
      registration: result,
    })
  } catch (error) {
    sendError(error, response)
  }
})

export default router
