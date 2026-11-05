import { createHash, randomBytes } from 'node:crypto'
import { deriveCsrfToken, hashCsrfToken } from './csrf.js'
import { isAuthRole } from './roles.js'
import type { Permission } from './permissions.js'
import type { AuthRole, SessionIdentity } from './roles.js'

export const defaultSessionTtlMs = 8 * 60 * 60 * 1000
export const defaultSessionIdleTimeoutMs = 2 * 60 * 60 * 1000
const defaultTouchIntervalMs = 5 * 60 * 1000

export type StoredSession = SessionIdentity & {
  permissions?: readonly Permission[]
  slmMember?: boolean
  sector?: string
  tokenHash: string
  csrfTokenHash: string
  issuedAt: number
  expiresAt: number
  lastSeenAt: number
}

export type ResolvedSession = SessionIdentity & {
  permissions: readonly Permission[]
  slmMember: boolean
  sector: string
  expiresAt: number
  csrfTokenHash: string
}

export type SessionEndReason = 'logout' | 'expired' | 'idle_timeout'

export interface SessionStore {
  save(session: StoredSession): Promise<void>
  findByTokenHash(tokenHash: string): Promise<StoredSession | null>
  deleteByTokenHash(tokenHash: string, reason?: SessionEndReason): Promise<void>
  touch(tokenHash: string, lastSeenAt: number): Promise<void>
  deleteExpired(idleCutoff: number): Promise<number>
}

export type SessionServiceOptions = {
  ttlMs?: number
  idleTimeoutMs?: number
  touchIntervalMs?: number
  now?: () => number
}

const tokenPattern = /^[A-Za-z0-9_-]{43}$/

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export const hashSessionToken = hashToken

export class SessionService {
  private readonly ttlMs: number
  private readonly idleTimeoutMs: number
  private readonly touchIntervalMs: number
  private readonly now: () => number

  constructor(
    private readonly store: SessionStore,
    options: SessionServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? defaultSessionTtlMs
    this.idleTimeoutMs = options.idleTimeoutMs ?? defaultSessionIdleTimeoutMs
    this.touchIntervalMs = options.touchIntervalMs ?? defaultTouchIntervalMs
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new Error('A duração da sessão deve ser positiva.')
    }
    if (!Number.isSafeInteger(this.idleTimeoutMs) || this.idleTimeoutMs < 1) {
      throw new Error('O tempo de inatividade da sessão deve ser positivo.')
    }
  }

  async issue(identity: SessionIdentity) {
    if (
      typeof identity.userId !== 'string' ||
      identity.userId.trim().length === 0 ||
      !isAuthRole(identity.role)
    ) {
      throw new Error('Identidade autenticada inválida.')
    }

    const token = randomBytes(32).toString('base64url')
    const csrfToken = deriveCsrfToken(token)
    const issuedAt = this.now()
    const expiresAt = issuedAt + this.ttlMs
    await this.store.save({
      tokenHash: hashToken(token),
      csrfTokenHash: hashCsrfToken(csrfToken),
      userId: identity.userId,
      role: identity.role as AuthRole,
      issuedAt,
      expiresAt,
      lastSeenAt: issuedAt,
    })
    return { token, expiresAt, csrfToken }
  }

  async resolve(token: string): Promise<ResolvedSession | null> {
    if (!tokenPattern.test(token)) return null

    const tokenHash = hashToken(token)
    const session = await this.store.findByTokenHash(tokenHash)
    if (!session) return null

    const now = this.now()
    if (
      session.expiresAt <= now ||
      typeof session.userId !== 'string' ||
      session.userId.trim().length === 0 ||
      !isAuthRole(session.role)
    ) {
      await this.store.deleteByTokenHash(tokenHash, 'expired')
      return null
    }

    if (session.lastSeenAt + this.idleTimeoutMs <= now) {
      await this.store.deleteByTokenHash(tokenHash, 'idle_timeout')
      return null
    }

    // Grava a atividade de tempos em tempos, e não a cada requisição.
    if (session.lastSeenAt + this.touchIntervalMs <= now) {
      await this.store.touch(tokenHash, now)
    }

    return {
      userId: session.userId,
      role: session.role,
      // Sem permissões informadas pelo armazenamento, nenhuma é concedida.
      permissions: session.permissions ?? [],
      slmMember: session.slmMember ?? false,
      sector: session.sector ?? '',
      expiresAt: session.expiresAt,
      csrfTokenHash: session.csrfTokenHash,
    }
  }

  async revoke(token: string): Promise<void> {
    if (tokenPattern.test(token)) {
      await this.store.deleteByTokenHash(hashToken(token), 'logout')
    }
  }

  /** Remove as sessões vencidas ou inativas e devolve quantas foram removidas. */
  purgeExpired(): Promise<number> {
    return this.store.deleteExpired(this.now() - this.idleTimeoutMs)
  }
}
