export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  // Corpo da resposta, para erros que trazem mais do que a mensagem.
  readonly data?: unknown

  constructor(message: string, status: number, code?: string, data?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.data = data
  }
}

export type ApiResponse = {
  success?: boolean
  message?: string
  code?: string
  csrfToken?: string
}

/** Avisa a tela de que a API recusou um acesso, para reler as permissões atuais. */
export const accessRefusedEvent = 'slm:access-refused'

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

// Fica só em memória: é recebido de novo a cada carregamento da página.
let csrfToken: string | null = null

export function setCsrfToken(token: string | null) {
  csrfToken = token
}

function fallbackMessage(status: number) {
  if (status === 401) return 'Sua sessão expirou. Entre novamente no sistema.'
  if (status === 403) return 'Você não tem permissão para realizar esta ação.'
  if (status === 404) return 'O recurso solicitado não foi encontrado.'
  if (status === 409) return 'Este registro já foi alterado. Atualize a lista.'
  if (status === 429) return 'Muitas tentativas. Aguarde alguns minutos.'
  return 'Não foi possível comunicar com o servidor. Tente novamente.'
}

export async function apiRequest<Response extends ApiResponse>(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const method = (options.method ?? 'GET').toUpperCase()

  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken && !safeMethods.has(method)
        ? { 'X-CSRF-Token': csrfToken }
        : {}),
      ...options.headers,
    },
  })

  let data: Response | null = null
  try {
    data = (await response.json()) as Response
  } catch {
    // A API pode estar fora do ar e a resposta vir vazia ou sem JSON.
  }

  if (!response.ok || !data?.success) {
    if (
      (response.status === 401 || response.status === 403) &&
      !path.startsWith('/auth/')
    ) {
      window.dispatchEvent(new Event(accessRefusedEvent))
    }

    throw new ApiError(
      data?.message || fallbackMessage(response.status),
      response.status,
      data?.code,
      data,
    )
  }

  if (data.csrfToken) setCsrfToken(data.csrfToken)

  return data
}
