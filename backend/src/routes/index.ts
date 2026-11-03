import { Router } from 'express'
import healthRouter from './health.js'
import authRouter from './auth.js'
import adminRegistrationsRouter from './adminRegistrations.js'
//import setoresRouter from './setores.js'
//import materialsRouter from './materials.js'

const apiRouter = Router()

apiRouter.use(healthRouter)
apiRouter.use(authRouter)
apiRouter.use(adminRegistrationsRouter)
//apiRouter.use(setoresRouter)
//apiRouter.use(materialsRouter)

export default apiRouter
