
import express from 'express'
import cors from 'cors'

const app = express()
const PORT = Number(process.env.PORT) || 3000

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  }),
)

app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: 'API do Sistema de Serviços de Logística e Manutenção funcionando.',
    environment: 'development',
  })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API iniciada na porta ${PORT}`)
})
