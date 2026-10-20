interface HealthResponse {
  success: boolean
}

export async function getApiHealth(): Promise<boolean> {
  const response = await fetch('/api/health', {
    headers: { Accept: 'application/json' },
  })

  if (!response.ok) {
    throw new Error('API indisponível')
  }

  const data = (await response.json()) as HealthResponse
  return data.success === true
}