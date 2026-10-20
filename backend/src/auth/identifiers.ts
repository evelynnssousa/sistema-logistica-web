export type LoginIdentifiersInput = {
  email?: string | null
  username?: string | null
}

export type NormalizedLoginIdentifiers = {
  email: string | null
  username: string | null
}

const emailPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
const usernamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/

function normalizeOptionalIdentifier(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new Error('Identificador de acesso inválido.')
  }

  const normalized = value.trim().toLowerCase()
  return normalized || null
}

export function normalizeLoginIdentifiers(
  input: LoginIdentifiersInput,
): NormalizedLoginIdentifiers {
  const email = normalizeOptionalIdentifier(input.email)
  const username = normalizeOptionalIdentifier(input.username)

  if (
    (email === null && username === null) ||
    (email !== null &&
      (email.length > 254 || !emailPattern.test(email))) ||
    (username !== null && !usernamePattern.test(username))
  ) {
    throw new Error('Identificador de acesso inválido.')
  }

  return { email, username }
}