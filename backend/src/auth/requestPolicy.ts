import type { Permission } from './permissions.js'
import type { AuthenticatedIdentity } from './roles.js'

/**
 * Regras de acesso às solicitações, em um só lugar, para uso das rotas dos
 * módulos. Recebem a identidade resolvida no servidor, nunca dados do navegador.
 */

export type RequestModule = 'maintenance' | 'fleet' | 'flights'

export type RequestScope = {
  module: RequestModule
  requesterId: string
}

const scheduleByModule: Record<RequestModule, Permission> = {
  maintenance: 'maintenance:schedule',
  fleet: 'fleet:schedule',
  // O módulo de passagens não tem permissão própria de agendamento.
  flights: 'flights:update',
}

function holds(identity: AuthenticatedIdentity, permission: Permission) {
  return identity.permissions.includes(permission)
}

function sameSector(first: string, second: string) {
  return first.trim().toLowerCase() === second.trim().toLowerCase()
}

/**
 * O setor do usuário vem da sessão, e não de quem chama: assim, uma rota não tem
 * como usar um valor enviado pelo navegador para burlar a regra.
 */
export function canCreateRequest(
  identity: AuthenticatedIdentity,
  request: { module: RequestModule; targetSector: string },
): boolean {
  if (
    !holds(identity, 'requests:create') ||
    !holds(identity, `${request.module}:create`) ||
    !request.targetSector.trim()
  ) {
    return false
  }

  return (
    sameSector(request.targetSector, identity.sector) ||
    canActOnBehalfOfOtherSectors(identity)
  )
}

/**
 * Define o dono de uma nova solicitação. O solicitante é sempre quem está na
 * sessão: não há como informar outro. As rotas devem gravar este resultado, e não
 * campos do corpo da requisição. Devolve null quando a abertura não é permitida.
 */
export function resolveRequestOwnership(
  identity: AuthenticatedIdentity,
  request: { module: RequestModule; targetSector?: string },
) {
  const targetSector = request.targetSector?.trim() || identity.sector

  if (!canCreateRequest(identity, { module: request.module, targetSector })) {
    return null
  }

  const onBehalf = !sameSector(targetSector, identity.sector)

  return {
    requesterId: identity.userId,
    sector: onBehalf ? targetSector : identity.sector,
    onBehalf,
  }
}

/** Exige a permissão e a equipe SLM: pertencer ao setor CPC não é suficiente. */
export function canActOnBehalfOfOtherSectors(identity: AuthenticatedIdentity) {
  return identity.slmMember && holds(identity, 'requests:create_on_behalf')
}

export function canReadRequest(
  identity: AuthenticatedIdentity,
  request: RequestScope,
): boolean {
  if (!holds(identity, `${request.module}:read`)) return false
  if (holds(identity, 'requests:read_all')) return true

  return (
    holds(identity, 'requests:read_own') &&
    request.requesterId === identity.userId
  )
}

export function canUpdateRequest(
  identity: AuthenticatedIdentity,
  module: RequestModule,
): boolean {
  return holds(identity, 'requests:update') && holds(identity, `${module}:update`)
}

export function canScheduleRequest(
  identity: AuthenticatedIdentity,
  module: RequestModule,
): boolean {
  return (
    holds(identity, 'requests:schedule') &&
    holds(identity, scheduleByModule[module])
  )
}

export function canCancelRequest(
  identity: AuthenticatedIdentity,
  request: RequestScope,
): boolean {
  return (
    holds(identity, 'requests:cancel') &&
    canReadRequest(identity, request)
  )
}

export function canReadFullCpf(identity: AuthenticatedIdentity): boolean {
  return holds(identity, 'flights:cpf:read')
}

/** Mantém apenas os seis dígitos centrais, como no padrão usado pelo governo. */
export function maskCpf(cpf: string): string {
  const digits = cpf.replace(/\D/g, '')
  if (digits.length !== 11) return '***.***.***-**'
  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`
}
