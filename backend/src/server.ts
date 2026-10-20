
import { createApp } from './app'
import { pool } from './database/pool'

const PORT = Number(process.env.PORT) || 3000

const app = createApp()

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API iniciada na porta ${PORT}`)
})

async function shutdown(): Promise<void> {
  try {
    await pool?.end()
  } finally {
    process.exit(0)
  }
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
