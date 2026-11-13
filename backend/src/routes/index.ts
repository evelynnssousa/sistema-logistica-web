import { Router } from 'express'
import healthRouter from './health.js'
import authRouter from './auth.js'
import adminRegistrationsRouter from './adminRegistrations.js'
import adminUsersRouter from './adminUsers.js'
import attachmentsRouter from './attachments.js'
import communicationsRouter from './communications.js'
import configurationRouter from './configuration.js'
import demandsRouter from './demands.js'
import driverRouter from './driver.js'
import flightsRouter from './flights.js'
import insightsRouter from './insights.js'
import instrumentsRouter from './instruments.js'
import moduleExtensionsRouter from './moduleExtensions.js'
import monitoringRouter from './monitoring.js'
import integrationsRouter from './integrations.js'
import requestsRouter from './requests.js'
import searchRouter from './search.js'
import settingsRouter from './settings.js'
import slmRouter from './slm.js'
import warehouseRouter from './warehouse.js'

const apiRouter = Router()

apiRouter.use(healthRouter)
apiRouter.use(authRouter)
apiRouter.use(adminRegistrationsRouter)
apiRouter.use(adminUsersRouter)
apiRouter.use(flightsRouter)
apiRouter.use(requestsRouter)
apiRouter.use(slmRouter)
apiRouter.use(attachmentsRouter)
apiRouter.use(searchRouter)
apiRouter.use(settingsRouter)
apiRouter.use(configurationRouter)
apiRouter.use(communicationsRouter)
apiRouter.use(warehouseRouter)
// Depois dos roteadores de cada módulo, que conferem a sessão pelo prefixo.
apiRouter.use(moduleExtensionsRouter)
apiRouter.use(driverRouter)
apiRouter.use(monitoringRouter)
apiRouter.use(insightsRouter)
apiRouter.use(integrationsRouter)
apiRouter.use(demandsRouter)
apiRouter.use(instrumentsRouter)

export default apiRouter
