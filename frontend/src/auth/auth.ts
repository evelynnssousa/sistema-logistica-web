import { ApiError, apiRequest, setCsrfToken } from './apiClient'

export type AuthenticatedUser = {
  id: string
  name: string
  email: string | null
  username: string | null
  role: 'administrator' | 'slm_operator' | 'requester'
  sector?: string
  permissions: string[]
  slmMember: boolean
}

type AuthResponse = {
  success: boolean
  message?: string
  code?: string
  csrfToken?: string
  user?: AuthenticatedUser
}

function authRequest(
  path: string,
  options: RequestInit = {},
): Promise<AuthResponse> {
  return apiRequest<AuthResponse>(`/auth/${path}`, options)
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

export async function register(input: {
  fullName: string
  email: string
  sector: string
  password: string
  passwordConfirmation: string
}): Promise<string> {
  const data = await authRequest('register', {
    method: 'POST',
    body: JSON.stringify(input),
  })

  return data.message || 'Solicitação enviada para aprovação.'
}

export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  try {
    const data = await authRequest('me')
    return data.user ?? null
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      setCsrfToken(null)
      return null
    }

    throw error
  }
}

export async function logout(): Promise<void> {
  await authRequest('logout', { method: 'POST' })
  setCsrfToken(null)
}


export async function requestPasswordRecovery(email: string): Promise<string> {
  const data = await authRequest('password-recovery/request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  return data.message || 'Se houver uma conta ativa associada a esse e-mail, você receberá instruções.'
}

export async function resetPassword(input: {
  email: string
  code: string
  password: string
  passwordConfirmation: string
}): Promise<string> {
  const data = await authRequest('password-recovery/reset', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return data.message || 'Senha alterada com sucesso.'
}
