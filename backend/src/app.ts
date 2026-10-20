import cors from 'cors'
import express from 'express'
import { AuthError } from './auth/errors'
import type { AuthRepository } from './auth/types'
import { createPostgresAuthRepository } from './auth/postgres.repository'
import { createAdminRouter } from './routes/admin.routes'
import { createAuthRouter } from './routes/auth.routes'
import { healthRouter } from './routes/health.routes'

export function createApp(repository: AuthRepository | null = createPostgresAuthRepository()) {
  const app = express()
  const primaryOrigin = process.env.FRONTEND_URL || (
    process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173'
  )
  const allowedOrigins = [
    ...new Set([
      ...(primaryOrigin ? [primaryOrigin] : []),
      ...(process.env.NODE_ENV !== 'production' ? ['https://localhost:5173'] : []),
      ...(process.env.FRONTEND_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
    ]),
  ]
  const authOptions = {
    repository,
    allowedEmailDomains: (process.env.INSTITUTIONAL_EMAIL_DOMAINS ?? '')
      .split(',')
      .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean),
    allowedOrigins,
    secureCookies: process.env.NODE_ENV === 'production',
  }

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) callback(null, true)
        else callback(null, false)
      },
      credentials: true,
    }),
  )
  app.use(express.json({ limit: '32kb' }))
  app.use('/api', healthRouter)
  app.use('/api/auth', createAuthRouter(authOptions))
  app.use('/api/admin', createAdminRouter(authOptions))

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof AuthError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } })
      return
    }
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
      response.status(413).json({ error: { code: 'REQUEST_TOO_LARGE', message: 'A solicitação excede o limite permitido.' } })
      return
    }
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.parse.failed') {
      response.status(400).json({ error: { code: 'INVALID_JSON', message: 'O corpo da solicitação não é um JSON válido.' } })
      return
    }
    if (isDatabaseUnavailable(error)) {
      response.status(503).json({
        error: {
          code: 'AUTH_DATABASE_UNAVAILABLE',
          message: 'Autenticação indisponível. O banco ou o schema de autenticação ainda não está preparado.',
        },
      })
      return
    }
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Não foi possível concluir a solicitação.' } })
  })

  return app
}

function isDatabaseUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    '28P01',
    '42501',
    '53300',
    '3D000',
    '42P01',
  ]).has(String(error.code))
}