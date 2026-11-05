import type { ErrorRequestHandler, RequestHandler } from 'express'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'

export const notFoundHandler: RequestHandler = (_request, response) => {
  response.status(404).json({
    success: false,
    message: 'Recurso não encontrado.',
  })
}

function clientErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const { status } = error as { status?: unknown }
  return typeof status === 'number' && status >= 400 && status < 500
    ? status
    : null
}

/**
 * Última barreira da API: responde sempre em JSON, sem stack trace nem caminhos,
 * e não registra a mensagem original, que pode conter o corpo da requisição.
 */
export const errorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  _next,
) => {
  if (response.headersSent) {
    response.destroy()
    return
  }

  const clientStatus = clientErrorStatus(error)

  if (clientStatus !== null) {
    response.status(clientStatus).json({
      success: false,
      message:
        clientStatus === 413
          ? 'A requisição excede o tamanho permitido.'
          : 'Requisição inválida.',
    })
    return
  }

  recordTechnicalEvent('api', 'unhandled_error', error)

  response.status(500).json({
    success: false,
    message: 'Ocorreu um erro interno. Tente novamente mais tarde.',
  })
}
