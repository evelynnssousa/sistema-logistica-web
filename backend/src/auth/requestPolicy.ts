import { isEligibleForRestrictedPermission } from './permissions.js'
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

/** Exige a concessão e a elegibilidade, para a regra valer sobre qualquer identidade. */
function holdsRestricted(identity: AuthenticatedIdentity, permission: Permission) {
  return (
    holds(identity, permission) &&
    isEligibleForRestrictedPermission(permission, identity.role, identity.slmMember)
  )
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

/** Vale também para administradores: exige equipe SLM, perfil elegível e concessão. */
export function canActOnBehalfOfOtherSectors(identity: AuthenticatedIdentity) {
  return (
    identity.slmMember &&
    holdsRestricted(identity, 'requests:create_on_behalf')
  )
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
    holdsRestricted(identity, 'requests:schedule') &&
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

/** Situações em que o próprio solicitante ainda pode cancelar: antes de a SLM começar a tratar. */
export const ownCancellableStatuses: Record<RequestModule, readonly string[]> = {
  maintenance: ['aguardando_agendamento'],
  fleet: ['aguardando_agendamento'],
  flights: ['em_cotacao'],
}

/**
 * O solicitante cancela a própria solicitação, só antes do agendamento (ou da cotação, em
 * Passagens) e só com a concessão individual. A situação é conferida de novo na transação.
 */
export function canCancelOwnRequest(
  identity: AuthenticatedIdentity,
  request: RequestScope & { status: string },
): boolean {
  return (
    holds(identity, 'requests:cancel_own') &&
    holds(identity, `${request.module}:read`) &&
    request.requesterId === identity.userId &&
    ownCancellableStatuses[request.module].includes(request.status)
  )
}

/** Autorização da pessoa, sem considerar qual solicitação está sendo consultada. */
export function hasCpfAuthorization(identity: AuthenticatedIdentity): boolean {
  return (
    holdsRestricted(identity, 'flights:cpf:read') &&
    holds(identity, 'flights:read')
  )
}

export function canReadFullCpf(
  identity: AuthenticatedIdentity,
  request: { requesterId: string },
): boolean {
  return (
    hasCpfAuthorization(identity) &&
    canReadRequest(identity, { module: 'flights', requesterId: request.requesterId })
  )
}

/** Mantém apenas os seis dígitos centrais, como no padrão usado pelo governo. */
export function maskCpf(cpf: string): string {
  const digits = cpf.replace(/\D/g, '')
  if (digits.length !== 11) return '***.***.***-**'
  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`
}
