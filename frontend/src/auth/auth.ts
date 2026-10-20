export type AuthenticatedUser = {
  id: string
  name: string
  email: string | null
  username: string | null
  role: 'administrator' | 'slm_operator'
}

type AuthResponse = {
  success: boolean
  message?: string
  user?: AuthenticatedUser
}

async function authRequest(
  path: string,
  options: RequestInit = {},
): Promise<AuthResponse> {
  const response = await fetch(`/api/auth/${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  const data = (await response.json()) as AuthResponse

  if (!response.ok || !data.success) {
    throw new Error(data.message || 'Não foi possível realizar a operação.')
  }

  return data
}

export async function login(
  identifier: string,
  password: string,
): Promise<AuthenticatedUser> {
  const data = await authRequest('login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password }),
  })

  if (!data.user) {
    throw new Error('A API não retornou os dados do usuário.')
  }

  return data.user
}

export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  try {
    const data = await authRequest('me')
    return data.user ?? null
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Autenticação necessária.'
    ) {
      return null
    }

    throw error
  }
}

export async function logout(): Promise<void> {
  await authRequest('logout', { method: 'POST' })
}
