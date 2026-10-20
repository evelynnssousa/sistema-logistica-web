import { createHash, randomBytes } from 'node:crypto'
import { isAuthRole } from './roles.js'
import type { AuthRole, AuthenticatedIdentity } from './roles.js'

export const defaultSessionTtlMs = 8 * 60 * 60 * 1000

export type StoredSession = AuthenticatedIdentity & {
  tokenHash: string
  issuedAt: number
  expiresAt: number
}

export type ResolvedSession = AuthenticatedIdentity & {
  expiresAt: number
}

export interface SessionStore {
  save(session: StoredSession): Promise<void>
  findByTokenHash(tokenHash: string): Promise<StoredSession | null>
  deleteByTokenHash(tokenHash: string): Promise<void>
}

export type SessionServiceOptions = {
  ttlMs?: number
  now?: () => number
}

const tokenPattern = /^[A-Za-z0-9_-]{43}$/

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export class SessionService {
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(
    private readonly store: SessionStore,
    options: SessionServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? defaultSessionTtlMs
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new Error('A duração da sessão deve ser positiva.')
    }
  }

  async issue(identity: AuthenticatedIdentity) {
    if (
      typeof identity.userId !== 'string' ||
      identity.userId.trim().length === 0 ||
      !isAuthRole(identity.role)
    ) {
      throw new Error('Identidade autenticada inválida.')
    }

    const token = randomBytes(32).toString('base64url')
    const issuedAt = this.now()
    const expiresAt = issuedAt + this.ttlMs
    await this.store.save({
      tokenHash: hashToken(token),
      userId: identity.userId,
      role: identity.role as AuthRole,
      issuedAt,
      expiresAt,
    })
    return { token, expiresAt }
  }

  async resolve(token: string): Promise<ResolvedSession | null> {
    if (!tokenPattern.test(token)) return null

    const tokenHash = hashToken(token)
    const session = await this.store.findByTokenHash(tokenHash)
    if (!session) return null

    if (
      session.expiresAt <= this.now() ||
      typeof session.userId !== 'string' ||
      session.userId.trim().length === 0 ||
      !isAuthRole(session.role)
    ) {
      await this.store.deleteByTokenHash(tokenHash)
      return null
    }

    return {
      userId: session.userId,
      role: session.role,
      expiresAt: session.expiresAt,
    }
  }

  async revoke(token: string): Promise<void> {
    if (tokenPattern.test(token)) {
      await this.store.deleteByTokenHash(hashToken(token))
    }
  }
}