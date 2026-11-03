import { Router } from 'express'
import type { Response } from 'express'
import {
  allPermissions,
  isPermission,
  permissionGroups,
  permissionsForProfile,
} from '../auth/permissions.js'
import type { Permission } from '../auth/permissions.js'
import { authRoles, isAuthRole } from '../auth/roles.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { AccessMigrationRequiredError } from '../database/accessSchema.js'
import {
  AccountAuthorizationError,
  UserManagementError,
  UserRepository,
} from '../database/userRepository.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { describeError, logSecurityEvent } from '../security/logger.js'

const router = Router()
const users = new UserRepository()

for (const path of ['/admin/users', '/admin/permissions', '/admin/audit']) {
  router.use(path, requireAuth, requireCsrf)
}

function identityOf(response: Response) {
  return response.locals.authenticatedUser as AuthenticatedIdentity
}

function sendError(error: unknown, response: Response) {
  if (error instanceof AccountAuthorizationError) {
    response.status(403).json({ success: false, message: error.message })
    return
  }
  if (error instanceof AccessMigrationRequiredError) {
    response.status(503).json({
      success: false,
      code: 'ACCESS_MIGRATION_REQUIRED',
      message: error.message,
    })
    return
  }
  if (error instanceof UserManagementError) {
    response.status(error.status).json({ success: false, message: error.message })
    return
  }

  const cause = error instanceof Error ? error.cause : undefined
  if ((cause as { code?: unknown } | undefined)?.code === '23505') {
    response.status(409).json({
      success: false,
      message: 'Já existe uma conta com esse e-mail.',
    })
    return
  }

  logSecurityEvent('admin_users_failed', describeError(error))
  response.status(503).json({
    success: false,
    message: 'Não foi possível concluir a operação neste momento.',
  })
}

function invalid(response: Response, message: string) {
  response.status(400).json({ success: false, message })
}

function readText(value: unknown, maximum = 200) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

// Valores absurdos, como 1e400, não chegam à consulta.
function readPage(value: unknown) {
  const page = Number(value)
  return Number.isSafeInteger(page) && page >= 1 && page <= 100_000 ? page : 1
}

function readPermissionList(value: unknown): Permission[] | null {
  if (
    !Array.isArray(value) ||
    value.length > allPermissions.length ||
    !value.every(isPermission)
  ) {
    return null
  }
  return [...new Set(value)]
}

router.get(
  '/admin/permissions',
  requirePermission('users:read'),
  (_request, response) => {
    response.json({
      success: true,
      groups: permissionGroups,
      profiles: authRoles.map((role) => ({
        key: role,
        permissions: permissionsForProfile(role),
      })),
    })
  },
)

router.get(
  '/admin/audit',
  requirePermission('audit:read'),
  async (request, response) => {
    try {
      const page = await users.listAuditEvents(identityOf(response), {
        page: readPage(request.query.page),
      })
      response.json({ success: true, ...page })
    } catch (error) {
      sendError(error, response)
    }
  },
)

router.get(
  '/admin/users',
  requirePermission('users:read'),
  async (request, response) => {
    const { search, role, status, slm, page } = request.query

    if (role !== undefined && role !== '' && !isAuthRole(role)) {
      invalid(response, 'Perfil inválido.')
      return
    }

    try {
      const result = await users.listUsers(identityOf(response), {
        search: readText(search),
        role: isAuthRole(role) ? role : undefined,
        status: readText(status, 20) || undefined,
        slmMember: slm === 'true' ? true : slm === 'false' ? false : undefined,
        page: readPage(page),
      })
      response.json({ success: true, ...result })
    } catch (error) {
      sendError(error, response)
    }
  },
)

router.get(
  '/admin/users/:userId',
  requirePermission('users:read'),
  async (request, response) => {
    try {
      const user = await users.getUser(identityOf(response), String(request.params.userId))
      response.json({ success: true, user })
    } catch (error) {
      sendError(error, response)
    }
  },
)

router.get(
  '/admin/users/:userId/history',
  requirePermission('users:read'),
  async (request, response) => {
    try {
      const events = await users.getPermissionHistory(
        identityOf(response),
        String(request.params.userId),
      )
      response.json({ success: true, events })
    } catch (error) {
      sendError(error, response)
    }
  },
)

router.patch(
  '/admin/users/:userId',
  requirePermission('users:manage'),
  async (request, response) => {
    const { name, email, sector } = request.body ?? {}

    try {
      const user = await users.updateUserData(
        identityOf(response),
        String(request.params.userId),
        { name, email, sector },
      )
      response.json({ success: true, user, message: 'Dados atualizados.' })
    } catch (error) {
      sendError(error, response)
    }
  },
)

/**
 * Substitui o acesso por inteiro: os quatro campos são obrigatórios, para que uma
 * requisição parcial nunca mantenha uma permissão sem que isso tenha sido pedido.
 */
router.put(
  '/admin/users/:userId/access',
  requirePermission('users:manage'),
  async (request, response) => {
    const { role, slmMember, grantedPermissions, deniedPermissions } =
      request.body ?? {}
    const granted = readPermissionList(grantedPermissions)
    const denied = readPermissionList(deniedPermissions)

    if (
      !isAuthRole(role) ||
      typeof slmMember !== 'boolean' ||
      !granted ||
      !denied
    ) {
      invalid(response, 'Informe perfil, equipe SLM e permissões válidos.')
      return
    }

    try {
      const user = await users.updateUserAccess(
        identityOf(response),
        String(request.params.userId),
        { role, slmMember, grantedPermissions: granted, deniedPermissions: denied },
      )
      response.json({ success: true, user, message: 'Acesso atualizado.' })
    } catch (error) {
      sendError(error, response)
    }
  },
)

for (const [action, isActive] of [
  ['activate', true],
  ['deactivate', false],
] as const) {
  router.post(
    `/admin/users/:userId/${action}`,
    requirePermission('users:manage'),
    async (request, response) => {
      try {
        const user = await users.setUserActive(
          identityOf(response),
          String(request.params.userId),
          isActive,
        )
        response.json({
          success: true,
          user,
          message: isActive ? 'Conta ativada.' : 'Conta desativada.',
        })
      } catch (error) {
        sendError(error, response)
      }
    },
  )
}

export default router
