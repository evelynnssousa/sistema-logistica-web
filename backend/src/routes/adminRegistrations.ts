
import { Router } from 'express'
import { isAuthRole } from '../auth/roles.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { UserRepository, AccountAuthorizationError } from '../database/userRepository.js'
import { requireAuthentication } from '../middleware/requireAuthentication.js'
import { requireAuthorization } from '../middleware/requireAuthorization.js'
import { SessionService } from '../auth/session.js'
import { PostgresSessionStore } from '../database/postgresSessionStore.js'


const router = Router()
const users = new UserRepository()
const sessions = new SessionService(new PostgresSessionStore())

router.use(requireAuthentication(sessions))
router.use(requireAuthorization('administrator'))

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
      { action: 'approve', role },
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
