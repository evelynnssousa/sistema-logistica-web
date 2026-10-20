import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import type { AuthRepository, PublicUser, SessionRecord, UserRecord } from './types'

export const sessionCookieName = 'slm_session'
export const csrfCookieName = 'slm_csrf'
export const sessionDurationMs = 8 * 60 * 60 * 1000

export interface AuthContext {
  user: UserRecord
  session: SessionRecord
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.cookie?.split(';') ?? []
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=')
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

export function publicUser(user: UserRecord): PublicUser | null {
  if (user.status !== 'approved' || !user.role) return null
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    sector: user.sector,
    status: user.status,
    role: user.role,
    permissions: user.permissions,
  }
}

export function setSessionCookies(
  response: Response,
  sessionToken: string,
  csrfToken: string,
  secure: boolean,
): void {
  const common = { secure, sameSite: 'lax' as const, path: '/api', maxAge: sessionDurationMs }
  response.cookie(sessionCookieName, sessionToken, { ...common, httpOnly: true })
  response.cookie(csrfCookieName, csrfToken, { ...common, httpOnly: false })
}

export function clearSessionCookies(response: Response, secure: boolean): void {
  const common = { secure, sameSite: 'lax' as const, path: '/api' }
  response.clearCookie(sessionCookieName, { ...common, httpOnly: true })
  response.clearCookie(csrfCookieName, { ...common, httpOnly: false })
}

export async function readAuthContext(
  request: Request,
  repository: AuthRepository,
): Promise<AuthContext | null> {
  const rawToken = readCookie(request, sessionCookieName)
  if (!rawToken || rawToken.length > 128) return null

  const tokenHash = hashToken(rawToken)
  const session = await repository.findSessionByTokenHash(tokenHash)
  if (!session || session.expiresAt.getTime() <= Date.now()) return null

  const user = await repository.findUserById(session.userId)
  if (!user || user.status !== 'approved' || !user.role) {
    await repository.deleteSession(tokenHash)
    return null
  }
  return { user, session }
}

export function csrfMatches(request: Request, session: SessionRecord): boolean {
  const cookieToken = readCookie(request, csrfCookieName)
  const headerToken = request.header('x-csrf-token')
  if (!cookieToken || !headerToken || cookieToken !== headerToken || headerToken.length > 128) {
    return false
  }

  const providedHash = Buffer.from(hashToken(headerToken), 'hex')
  const expectedHash = Buffer.from(session.csrfTokenHash, 'hex')
  return providedHash.length === expectedHash.length && timingSafeEqual(providedHash, expectedHash)
}

export function getCsrfCookie(request: Request): string | null {
  return readCookie(request, csrfCookieName)
}

export function createTokens(): { sessionToken: string; csrfToken: string } {
  return {
    sessionToken: randomBytes(32).toString('base64url'),
    csrfToken: randomBytes(32).toString('base64url'),
  }
}