export const sessionCookieName = 'slm_session'

const sessionTokenPattern = /^[A-Za-z0-9_-]{43}$/

export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null

  const matchingCookies = cookieHeader.split(';').flatMap((cookie) => {
    const separator = cookie.indexOf('=')
    if (separator < 0 || cookie.slice(0, separator).trim() !== sessionCookieName) {
      return []
    }
    return [cookie.slice(separator + 1).trim()]
  })

  if (matchingCookies.length !== 1) return null
  return sessionTokenPattern.test(matchingCookies[0])
    ? matchingCookies[0]
    : null
}

// Em produção é sempre Secure. Fora dela, COOKIE_SECURE=true liga o atributo
// em ambientes de desenvolvimento servidos por HTTPS, como o Codespaces.
function usesSecureCookie(environment: NodeJS.ProcessEnv) {
  return (
    environment.NODE_ENV === 'production' ||
    environment.COOKIE_SECURE?.trim() === 'true'
  )
}

function cookieSecurityAttributes(environment: NodeJS.ProcessEnv) {
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(usesSecureCookie(environment) ? ['Secure'] : []),
  ]
}

export function createSessionCookie(
  token: string,
  expiresAt: number,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!sessionTokenPattern.test(token) || !Number.isFinite(expiresAt)) {
    throw new Error('Não foi possível criar o cookie de sessão.')
  }

  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  return [
    `${sessionCookieName}=${token}`,
    ...cookieSecurityAttributes(environment),
    `Max-Age=${maxAge}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ].join('; ')
}

export function createClearedSessionCookie(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return [
    `${sessionCookieName}=`,
    ...cookieSecurityAttributes(environment),
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].join('; ')
}