import express from 'express'
import cors from 'cors'
import apiRouter from './routes/index.js'

const app = express()

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  }),
)

app.use(express.json())
app.use('/api', apiRouter)

export default app
