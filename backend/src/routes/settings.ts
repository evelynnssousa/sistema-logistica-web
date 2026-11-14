import { publishedFormContent } from '../database/customFormValues.js'
import { fixedLayoutForms, isManagedForm } from '../requests/formRules.js'
import { codePermissionsForProfile, permissionGroups } from '../auth/permissions.js'
import { adjustablePermissions, adjustableProfiles } from '../requests/adminSettingsRules.js'
import { Router } from 'express'
import type { Request, Response } from 'express'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { refreshAdminSettings } from '../database/adminSettingsRuntime.js'
import { attachManualFiles, prunePublicPageManuals, prunePublicPagePhotos } from './publicPage.js'
import { activeAnnouncement } from '../requests/adminSettingsRules.js'
import { CatalogRepository, isCatalogCategory } from '../database/catalogRepository.js'
import type { CatalogCategory } from '../database/catalogRepository.js'
import { notFound, sendModuleError } from '../database/moduleErrors.js'
import { DriverOccurrenceTypeRepository } from '../database/driverOccurrenceTypeRepository.js'
import { SettingsRepository } from '../database/settingsRepository.js'
import { readPublishedConfigs } from '../database/configRepository.js'
import { getDatabasePool } from '../database/pool.js'
import { defaultForms } from '../requests/formRules.js'
import type { ManagedFormContent } from '../requests/formRules.js'
import { eventCatalog } from '../integrations/catalog.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requirePermission } from '../middleware/requirePermission.js'
import {
  driverHistorySections,
  driverNotificationEvents,
  readOccurrenceType,
  tripFields,
} from '../requests/driverPortalRules.js'
import {
  attachmentKinds,
  formKeys,
  isSettingsSection,
  notificationCategories,
  validateSettings,
} from '../requests/settingsRules.js'
import { asBody, isUuid, optionalText, requiredText } from '../requests/validation.js'

/**
 * Listas compartilhadas dos formulários. Não existe exclusão: desativar tira a opção dos
 * novos formulários, e os registros antigos guardam o nome que usaram.
 */

const router = Router()
const catalog = new CatalogRepository()
const parameters = new SettingsRepository()
const occurrenceTypes = new DriverOccurrenceTypeRepository()

router.use('/catalog', requireAuth, requireCsrf)
router.use('/forms', requireAuth, requireCsrf)
router.use('/settings', requireAuth, requireCsrf)

function identityOf(response: Response) {
  return response.locals.authenticatedUser as AuthenticatedIdentity
}

function categoryOf(request: Request): CatalogCategory {
  const category = String(request.params.category)
  if (!isCatalogCategory(category)) throw notFound()
  return category
}

function optionIdOf(request: Request) {
  const id = String(request.params.optionId)
  if (!isUuid(id)) throw notFound()
  return id
}

function readOption(raw: unknown, category: CatalogCategory) {
  const body = asBody(raw)
  return {
    label: requiredText(body.label, 'o nome', { min: 1, max: 120 }),
    acronym: category === 'sectors' ? optionalText(body.acronym, 'Sigla', 20) : null,
  }
}

// Opções ativas para os seletores dos formulários. Qualquer pessoa autenticada precisa delas.
router.get('/catalog', async (_request, response) => {
  try {
    response.json({ success: true, catalog: await catalog.list({ activeOnly: true }) })
  } catch (error) {
    sendModuleError(response, error)
  }
})

// Informações administrativas que toda tela usa: módulos ligados, aviso geral, mensagem da página
// inicial, feriados e padrões das atas. Nenhum dado pessoal.
router.get('/system/info', requireAuth, async (_request, response) => {
  try {
    const settings = await parameters.read()
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
    response.json({
      success: true,
      modules: settings.modules,
      announcement: activeAnnouncement(settings.announcement, today),
      homeMessage: settings.texts.homeMessage,
      holidays: settings.holidays.list,
      contracts: settings.contracts,
    })
  } catch (error) {
    sendModuleError(response, error)
  }
})

// A tela de entrada abre sem sessão: só a mensagem dela e o aviso geral.
router.get('/public/screen', async (_request, response) => {
  try {
    const settings = await parameters.read()
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
    response.json({
      success: true,
      loginMessage: settings.texts.loginMessage,
      announcement: activeAnnouncement(settings.announcement, today),
    })
  } catch (error) {
    sendModuleError(response, error)
  }
})

// Formulário publicado (ou o padrão) de qualquer formulário administrável: quem preenche precisa dele.
router.get('/forms/managed/:key', async (request, response) => {
  try {
    const key = String(request.params.key)
    if (!isManagedForm(key)) throw notFound()
    const { content, version } = await publishedFormContent(key)
    response.json({ success: true, content, version, fixedLayout: fixedLayoutForms.includes(key) })
  } catch (error) {
    sendModuleError(response, error)
  }
})

// Quem preenche um formulário precisa dos campos dele. Nula sem personalização gravada.
router.get('/forms/definitions', async (_request, response) => {
  try {
    const settings = await parameters.read()
    // O que foi publicado no gerenciador prevalece sobre a personalização anterior.
    const published = await readPublishedConfigs<ManagedFormContent>(getDatabasePool(), 'form')
    const versions = Object.fromEntries(published.map((item) => [item.key, item.version]))
    const sections = Object.fromEntries(published.map((item) => [item.key, item.content.sections]))
    const fromManager = Object.fromEntries(
      published.filter((item) => (formKeys as readonly string[]).includes(item.key)).map((item) => [item.key, item.content.fields]),
    )
    const hasManager = Object.keys(fromManager).length > 0
    response.json({
      success: true,
      definitions: hasManager
        ? {
            ...(settings.forms.definitions ?? Object.fromEntries(formKeys.map((key) => [key, defaultForms[key].fields]))),
            ...fromManager,
          }
        : settings.forms.definitions,
      versions,
      sections,
    })
  } catch (error) {
    sendModuleError(response, error)
  }
})

router.get('/settings/catalog', requirePermission('settings:read'), async (_request, response) => {
  try {
    response.json({ success: true, catalog: await catalog.list({ activeOnly: false }) })
  } catch (error) {
    sendModuleError(response, error)
  }
})

router.post(
  '/settings/catalog/:category',
  requirePermission('settings:manage'),
  async (request, response) => {
    try {
      const category = categoryOf(request)
      const option = await catalog.create(
        identityOf(response),
        category,
        readOption(request.body, category),
      )
      response.status(201).json({ success: true, option })
    } catch (error) {
      sendModuleError(response, error)
    }
  },
)

router.patch(
  '/settings/catalog/:category/:optionId',
  requirePermission('settings:manage'),
  async (request, response) => {
    try {
      const category = categoryOf(request)
      const id = optionIdOf(request)
      const option = await catalog.update(
        identityOf(response),
        category,
        id,
        readOption(request.body, category),
      )
      response.json({ success: true, option })
    } catch (error) {
      sendModuleError(response, error)
    }
  },
)

for (const [action, active] of [['activate', true], ['deactivate', false]] as const) {
  router.post(
    `/settings/catalog/:category/:optionId/${action}`,
    requirePermission('settings:manage'),
    async (request, response) => {
      try {
        const option = await catalog.setActive(
          identityOf(response),
          categoryOf(request),
          optionIdOf(request),
          active,
        )
        response.json({ success: true, option })
      } catch (error) {
        sendModuleError(response, error)
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Parâmetros de prazos, notificações, anexos, expediente e modelos de e-mail
// ---------------------------------------------------------------------------
router.get('/settings/parameters', requirePermission('settings:read'), async (_request, response) => {
  try {
    response.json({
      success: true,
      settings: await parameters.read(),
      options: {
        reasonGroups: [
          { key: 'scheduling', label: 'Agendamento, alteração e reagendamento' },
          { key: 'cancellation', label: 'Cancelamento' },
          { key: 'warehouse', label: 'Atendimento parcial ou não fornecimento de materiais' },
        ],
        notificationCategories,
        attachmentKinds,
        templates: Object.entries(eventCatalog).map(([key, definition]) => ({
          key,
          label: definition.label,
        })),
        driverPortal: { notificationEvents: driverNotificationEvents, tripFields },
        // Permissões padrão: o que o código dá a cada perfil e o que pode ser ajustado na tela.
        profileDefaults: {
          adjustable: adjustablePermissions.map((key) => ({
            key,
            label: (permissionGroups as readonly { permissions: readonly { key: string; label: string }[] }[])
              .flatMap((group) => group.permissions)
              .find((item) => item.key === key)?.label ?? key,
          })),
          base: Object.fromEntries(adjustableProfiles.map((role) => [role, codePermissionsForProfile(role)])),
        },
      },
    })
  } catch (error) {
    sendModuleError(response, error)
  }
})

router.get('/settings/history', requirePermission('settings:read'), async (request, response) => {
  try {
    const section = String(asBody(request.query).section ?? '')
    const filter = section === 'driverPortal' ? driverHistorySections : isSettingsSection(section) ? section : undefined
    response.json({ success: true, history: await parameters.history(filter) })
  } catch (error) {
    sendModuleError(response, error)
  }
})

router.put('/settings/parameters/:section', requirePermission('settings:manage'), async (request, response) => {
  try {
    const section = String(request.params.section)
    if (!isSettingsSection(section)) throw notFound()
    let value = validateSettings(section, request.body, Object.keys(eventCatalog))
    if (section === 'publicPage') {
      const page = value as { manuals: { fileId: string; fileName: string; sizeBytes: number; title: string; audience: string }[] }
      value = { ...page, manuals: await attachManualFiles(page.manuals) } as typeof value
    }
    await parameters.save(response.locals.authenticatedUser as AuthenticatedIdentity, section, value)
    // Permissões padrão valem já na próxima requisição de cada pessoa.
    if (section === 'profileDefaults') await refreshAdminSettings()
    if (section === 'publicPage') {
      await prunePublicPagePhotos((value as { team: { photoId: string | null }[] }).team.map((member) => member.photoId).filter((id): id is string => Boolean(id)))
      await prunePublicPageManuals((value as { manuals: { fileId: string }[] }).manuals.map((manual) => manual.fileId))
    }
    response.json({ success: true, value })
  } catch (error) {
    sendModuleError(response, error)
  }
})

// ---------------------------------------------------------------------------
// Tipos de ocorrência do Portal do Motorista. Sem rota de exclusão: só desativar.
// ---------------------------------------------------------------------------
function occurrenceTypeKeyOf(request: Request) {
  const key = String(request.params.typeKey)
  if (!/^[a-z0-9_]{1,60}$/.test(key)) throw notFound()
  return key
}

router.get('/settings/driver-occurrence-types', requirePermission('settings:read'), async (_request, response) => {
  try {
    response.json({ success: true, types: await occurrenceTypes.list() })
  } catch (error) {
    sendModuleError(response, error)
  }
})

router.post('/settings/driver-occurrence-types', requirePermission('settings:manage'), async (request, response) => {
  try {
    response.status(201).json({ success: true, type: await occurrenceTypes.create(identityOf(response), readOccurrenceType(request.body)) })
  } catch (error) {
    sendModuleError(response, error)
  }
})

router.patch('/settings/driver-occurrence-types/:typeKey', requirePermission('settings:manage'), async (request, response) => {
  try {
    const key = occurrenceTypeKeyOf(request)
    response.json({ success: true, type: await occurrenceTypes.update(identityOf(response), key, readOccurrenceType(request.body)) })
  } catch (error) {
    sendModuleError(response, error)
  }
})

export default router
