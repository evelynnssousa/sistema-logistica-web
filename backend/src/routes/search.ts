import { Router } from 'express'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { sendModuleError } from '../database/moduleErrors.js'
import { searchCategories, SearchRepository } from '../database/searchRepository.js'
import type { SearchCategory } from '../database/searchRepository.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { asBody, readPage, readPeriod, readSearch, RequestValidationError } from '../requests/validation.js'

const router = Router()
const repository = new SearchRepository()

router.use('/search', requireAuth, requireCsrf)

const modules = ['maintenance', 'fleet', 'flights', 'warehouse', 'demands'] as const

router.get('/search', async (request, response) => {
  try {
    const query = asBody(request.query)
    const term = readSearch(query.q)
    if (term.length < 2) throw new RequestValidationError('Digite ao menos 2 caracteres.')

    const results = await repository.search(response.locals.authenticatedUser as AuthenticatedIdentity, {
      term,
      module: modules.find((module) => module === query.module),
      status: typeof query.status === 'string' && query.status ? query.status.slice(0, 40) : undefined,
      ...readPeriod(query),
      category: searchCategories.find((category): category is SearchCategory => category === query.category),
      page: readPage(query.page),
    })
    response.json({ success: true, results })
  } catch (error) {
    sendModuleError(response, error)
  }
})

export default router
