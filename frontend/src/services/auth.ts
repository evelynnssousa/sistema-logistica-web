export type AccountRole = 'admin' | 'operator'

export type ModulePermission =
  | 'maintenance:read'
  | 'maintenance:write'
  | 'fleet:read'
  | 'fleet:write'
  | 'flights:read'
  | 'flights:write'
  | 'flights:cpf:read'
  | 'warehouse:read'
  | 'warehouse:write'
  | 'settings:read'
  | 'settings:write'

export interface AuthUser {
  id: string
  fullName: string
  email: string
  sector: string
  status: 'approved'
  role: AccountRole
  permissions: ModulePermission[]
}

export interface RegistrationRequest {
  id: string
  fullName: string
  email: string
  sector: string
  status: 'pending'
  role: AccountRole | null
  permissions: ModulePermission[]
  createdAt: string
}

export interface RegistrationDecisionResult {
  user: {
    id: string
    fullName: string
    email: string
    sector: string
    status: 'approved' | 'rejected'
    role: AccountRole | null
    permissions: ModulePermission[]
  }
}

interface ErrorResponse {
  error?: { code?: string; message?: string }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorResponse
    throw new Error(body.error?.message ?? 'Não foi possível concluir a solicitação.')
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export async function getCurrentSession(): Promise<{ user: AuthUser; csrfToken: string }> {
  return request('/api/auth/session')
}

export async function signIn(email: string, password: string): Promise<{ user: AuthUser; csrfToken: string }> {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function signOut(csrfToken: string): Promise<void> {
  await request('/api/auth/logout', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken },
  })
}

export async function registerAccount(input: {
  fullName: string
  email: string
  sector: string
  password: string
  passwordConfirmation: string
}): Promise<{ message: string }> {
  return request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function getPendingRequests(csrfToken: string): Promise<RegistrationRequest[]> {
  const result = await request<{ requests: RegistrationRequest[] }>('/api/admin/registration-requests', {
    headers: { 'X-CSRF-Token': csrfToken },
  })
  return result.requests
}

export async function decideRegistration(
  id: string,
  csrfToken: string,
  decision:
    | { action: 'reject' }
    | { action: 'approve'; role: AccountRole; permissions: ModulePermission[] },
): Promise<RegistrationDecisionResult> {
  return request(`/api/admin/registration-requests/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(decision),
  })
}