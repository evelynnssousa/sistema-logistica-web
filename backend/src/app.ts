import express from 'express'
import cors from 'cors'
import { isTestRuntime } from './database/databaseSafety.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import apiRouter from './routes/index.js'
import { parseTrustProxy, securityHeaders } from './security/securityHeaders.js'

const app = express()

app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY))

app.use(securityHeaders())

// Só em teste de navegador: permite conferir que quem respondeu é o backend isolado.
const e2eRunId = isTestRuntime() ? process.env.E2E_RUN_ID : undefined
if (e2eRunId) {
  app.use((_request, response, next) => {
    response.set('X-SLM-E2E-Run', e2eRunId)
    next()
  })
}

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  }),
)

app.use(express.json({ limit: '100kb' }))

// Respostas da API podem conter dados da conta e o token de CSRF.
app.use('/api', (_request, response, next) => {
  response.set('Cache-Control', 'no-store')
  next()
})
app.use('/api', apiRouter)

app.use(notFoundHandler)
app.use(errorHandler)

export default app
