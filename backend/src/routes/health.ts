import { Router } from 'express'

const healthRouter = Router()

healthRouter.get('/health', (_req, res) => {
  res.json({
    success: true,
    message: 'API do Sistema de Serviços de Logística e Manutenção funcionando.',
    environment: 'development',
  })
})

export default healthRouter
