import { Router } from 'express'

export const healthRouter = Router()

healthRouter.get('/health', (_request, response) => {
  response.json({
    success: true,
    message: 'API do Sistema de Serviços de Logística e Manutenção funcionando.',
    environment: 'development',
  })
})