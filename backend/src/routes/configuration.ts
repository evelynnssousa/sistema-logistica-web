import { Router } from 'express'
import type { Request, Response } from 'express'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { insertAuthAuditEvent } from '../database/authAuditRepository.js'
import { ConfigRepository, readPublishedConfig } from '../database/configRepository.js'
import { conflict, ModuleError, notFound, sendModuleError } from '../database/moduleErrors.js'
import { getDatabasePool } from '../database/pool.js'
import { UserRepository } from '../database/userRepository.js'
import {
  allowedVariables,
  defaultTemplateContent,
  eventCatalog,
  factKeys,
  factLabels,
  isEventType,
  moduleNames,
  renderEmail,
  sampleContext,
} from '../integrations/catalog.js'
import type { EventType, FactKey, TemplateOverride } from '../integrations/catalog.js'
import {
  citedVariables,
  requiredBodyVariables,
  templateTextProblem,
  templateVariables,
} from '../integrations/templateVariables.js'
import { IntegrationError, resolveEmailTransport } from '../integrations/transports.js'
import { quotaEnforcedFor, reserveEmailQuota } from '../integrations/emailQuota.js'
import {
  RECIPIENT_OUTSIDE_TEST_LIST,
  recipientDomains,
  recipientsOutsideList,
  restrictionEnforcedFor,
} from '../integrations/recipientAllowlist.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requirePermission } from '../middleware/requirePermission.js'
import {
  catalogSources,
  defaultForms,
  isManagedForm,
  managedFieldTypes,
  attachmentFieldForms,
  managedForms,
  fixedLayoutForms,
  validateFormContent,
} from '../requests/formRules.js'
import type { ManagedForm, ManagedFormContent } from '../requests/formRules.js'
import { asBody, optionalText, readPage, RequestValidationError } from '../requests/validation.js'

/**
 * Gerenciadores de modelos de e-mail e de formulários. Toda permissão é conferida aqui, e o que
 * é salvo passa pelas mesmas regras na edição, na publicação e na restauração. Disparo,
 * destinatários e credenciais dos serviços de e-mail não têm rota nem campo de configuração.
 */

const router = Router()
const versions = new ConfigRepository()
const users = new UserRepository()

router.use('/config', requireAuth, requireCsrf)

function identityOf(response: Response) {
  return response.locals.authenticatedUser as AuthenticatedIdentity
}

type Handler = (request: Request, response: Response) => Promise<void>

function guarded(handler: Handler): Handler {
  return async (request, response) => {
    try {
      await handler(request, response)
    } catch (error) {
      sendModuleError(response, error)
    }
  }
}

// ---------------------------------------------------------------------------
// Modelos de e-mail
// ---------------------------------------------------------------------------
export type TemplateContent = {
  name: string
  event: EventType
  active: boolean
  subject: string
  greeting: string
  body: string
  closing: string
  signature: string
  facts: FactKey[]
}

function templateText(value: unknown, label: string, max: number, allowed: readonly string[]) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new RequestValidationError(`${label} inválido.`)
  const text = value.trim()
  if (text.length > max) throw new RequestValidationError(`${label} deve ter no máximo ${max} caracteres.`)
  const problem = templateTextProblem(text, allowed)
  if (problem) throw new RequestValidationError(`${label} ${problem}.`)
  return text
}

/** Também é usada ao restaurar: uma versão antiga passa pelas regras de hoje. */
export function validateTemplateContent(raw: unknown): TemplateContent {
  const body = asBody(raw)
  const event = String(body.event ?? '')
  if (!isEventType(event)) throw new RequestValidationError('Selecione o evento do modelo.')
  const allowed = allowedVariables(event)
  const name = templateText(body.name, 'O nome do modelo', 120, [])
  if (!name) throw new RequestValidationError('Informe o nome do modelo.')
  const subject = templateText(body.subject, 'O assunto', 150, allowed)
  if (!subject) throw new RequestValidationError('Informe o assunto.')
  const text = templateText(body.body, 'O texto principal', 4000, allowed)
  if (!text) throw new RequestValidationError('Informe o texto principal.')
  const signature = templateText(body.signature, 'A assinatura', 500, [])
  if (!signature) throw new RequestValidationError('A assinatura institucional é obrigatória.')
  for (const required of requiredBodyVariables[event] ?? []) {
    if (!citedVariables(text).includes(required)) {
      throw new RequestValidationError(`O texto principal precisa citar {{${required}}}.`)
    }
  }
  const facts = Array.isArray(body.facts) ? body.facts : [...factKeys]
  if (facts.some((item) => !factKeys.includes(item as FactKey))) {
    throw new RequestValidationError('Há uma informação inválida na lista.')
  }
  return {
    name,
    event,
    active: body.active !== false,
    subject,
    greeting: templateText(body.greeting, 'A saudação', 300, allowed),
    body: text,
    closing: templateText(body.closing, 'O encerramento', 500, allowed),
    signature,
    facts: [...new Set(facts as FactKey[])],
  }
}

function templateKey(request: Request) {
  const key = String(request.params.key)
  if (!isEventType(key) && !/^custom-[a-z0-9-]{1,60}$/.test(key)) throw notFound()
  return key
}

function overrideOf(content: TemplateContent): TemplateOverride {
  const { subject, greeting, body, closing, signature, facts } = content
  return { subject, greeting, body, closing, signature, facts }
}

function noteOf(request: Request) {
  return optionalText(asBody(request.body).observacao, 'Observação', 500)
}

router.get(
  '/config/email-templates',
  requirePermission('email_templates:read'),
  guarded(async (_request, response) => {
    const stored = new Map((await versions.keys('email_template')).map((item) => [item.key, item]))
    const events = (Object.keys(eventCatalog) as EventType[]).map((key) => ({
      key,
      label: eventCatalog[key].label,
      modules: (eventCatalog[key].modules as readonly (keyof typeof moduleNames)[]).map((module) => moduleNames[module]),
      variables: allowedVariables(key),
      required: requiredBodyVariables[key] ?? [],
      published: stored.get(key)?.published ?? null,
      hasDraft: stored.get(key)?.hasDraft ?? false,
    }))
    // Modelos criados pela administração, além do modelo de cada evento.
    const custom = await Promise.all(
      [...stored.values()]
        .filter((item) => !isEventType(item.key))
        .map(async (item) => {
          const [latest] = await versions.history<TemplateContent>('email_template', item.key)
          return {
            key: item.key,
            name: latest?.content.name ?? item.key,
            event: latest?.content.event ?? '',
            published: item.published,
            hasDraft: item.hasDraft,
          }
        }),
    )
    response.json({
      success: true,
      events,
      custom,
      variables: templateVariables,
      facts: factKeys.map((key) => ({ key, label: factLabels[key] })),
    })
  }),
)

router.get(
  '/config/email-templates/:key',
  requirePermission('email_templates:read'),
  guarded(async (request, response) => {
    const key = templateKey(request)
    const history = await versions.history<TemplateContent>('email_template', key)
    response.json({
      success: true,
      default: isEventType(key) ? { ...defaultTemplateContent(key), active: true } : null,
      latest: history[0] ?? null,
      published: history.find((item) => item.status === 'publicada') ?? null,
      history,
    })
  }),
)

router.put(
  '/config/email-templates/:key/draft',
  requirePermission('email_templates:edit'),
  guarded(async (request, response) => {
    const version = await versions.saveDraft(
      identityOf(response),
      'email_template',
      templateKey(request),
      validateTemplateContent(asBody(request.body).conteudo),
      noteOf(request),
    )
    response.json({ success: true, version })
  }),
)

router.post(
  '/config/email-templates/:key/publish',
  requirePermission('email_templates:publish'),
  guarded(async (request, response) => {
    const version = await versions.publish(
      identityOf(response),
      'email_template',
      templateKey(request),
      validateTemplateContent(asBody(request.body).conteudo),
      noteOf(request),
    )
    response.json({ success: true, version })
  }),
)

router.post(
  '/config/email-templates/:key/restore',
  requirePermission('config_versions:restore'),
  guarded(async (request, response) => {
    const version = await versions.restore(
      identityOf(response),
      'email_template',
      templateKey(request),
      readPage(asBody(request.body).versao),
      validateTemplateContent,
    )
    response.json({ success: true, version })
  }),
)

router.post(
  '/config/email-templates/:key/preview',
  requirePermission('email_templates:read'),
  guarded(async (request, response) => {
    templateKey(request)
    const content = validateTemplateContent(asBody(request.body).conteudo)
    const message = renderEmail(content.event, sampleContext(content.event), null, overrideOf(content))
    response.json({ success: true, simulated: true, ...message })
  }),
)

/** Envio direto, sem fila nem evento: não muda status, não cria agenda e não avisa ninguém mais. */
router.post(
  '/config/email-templates/:key/test',
  requirePermission('email_templates:edit'),
  guarded(async (request, response) => {
    templateKey(request)
    const body = asBody(request.body)
    const content = validateTemplateContent(body.conteudo)
    const identity = identityOf(response)
    const account = await users.findActiveById(identity.userId)
    // Endereço autorizado: o da própria conta. Assim um teste nunca chega a terceiros.
    if (!account?.email) throw conflict('Sua conta não tem e-mail para receber o teste.')
    const transport = resolveEmailTransport()
    if (!transport) throw conflict('O serviço de e-mail não está ativo neste ambiente. Use a visualização prévia.')

    const message = renderEmail(content.event, sampleContext(content.event), null, overrideOf(content))
    // Lista de testes antes da cota: o endereço da própria conta também precisa estar autorizado.
    if (restrictionEnforcedFor(transport.provider) && recipientsOutsideList([account.email]).length > 0) {
      await insertAuthAuditEvent(getDatabasePool(), {
        actorUserId: identity.userId,
        actorKind: 'user',
        subjectUserId: null,
        sessionId: null,
        eventType: 'email_recipient_blocked',
        result: 'denied',
        details: { channel: 'teste_modelo', template: content.event, domains: recipientDomains([account.email]) },
      }).catch(() => undefined)
      throw new ModuleError(
        'O e-mail da sua conta não está na lista de destinatários autorizados para testes. Nada foi enviado.',
        422,
        RECIPIENT_OUTSIDE_TEST_LIST,
      )
    }
    // O teste também consome a cota diária das notificações, nunca a reserva da recuperação de senha.
    const quota = await reserveEmailQuota(getDatabasePool(), 'notification', 1, {
      enforced: quotaEnforcedFor(transport.provider),
    })
    if (!quota.allowed) {
      throw new ModuleError(
        quota.code === 'DAILY_LIMIT_REACHED'
          ? 'O limite diário de e-mails das notificações foi atingido. Nada foi enviado.'
          : 'O limite diário de e-mails não está configurado ou não pôde ser conferido. Nada foi enviado.',
        429,
        'EMAIL_QUOTA_UNAVAILABLE',
      )
    }
    try {
      await transport.send({
        idempotencyKey: `slm-teste-${identity.userId}-${Date.now()}`,
        to: account.email,
        cc: [],
        subject: `[TESTE] ${message.subject}`,
        text: `MENSAGEM DE TESTE, COM DADOS DE EXEMPLO.\n\n${message.text}`,
        html: `<p style="font-family:Arial,sans-serif;font-weight:bold">MENSAGEM DE TESTE, COM DADOS DE EXEMPLO.</p>${message.html}`,
      })
    } catch (error) {
      // Só o código do erro: a resposta do provedor pode repetir endereço ou conteúdo.
      const code = error instanceof IntegrationError ? error.code : 'UNEXPECTED'
      await insertAuthAuditEvent(getDatabasePool(), {
        actorUserId: identity.userId,
        actorKind: 'user',
        subjectUserId: null,
        sessionId: null,
        eventType: 'email_template_test_failed',
        result: 'failure',
        details: { event: content.event, code },
      }).catch(() => undefined)
      throw new ModuleError(
        code === 'RESERVED_ADDRESS'
          ? 'O endereço da sua conta é reservado a testes: nada foi enviado.'
          : `O serviço de e-mail não aceitou o envio de teste (código ${code}). Nada foi enviado.`,
        502,
        'EMAIL_TEST_FAILED',
      )
    }
    await insertAuthAuditEvent(getDatabasePool(), {
      actorUserId: identity.userId,
      actorKind: 'user',
      subjectUserId: null,
      sessionId: null,
      eventType: 'email_template_test_sent',
      details: { event: content.event },
    })
    response.json({ success: true, simulated: transport.simulated })
  }),
)

// ---------------------------------------------------------------------------
// Formulários
// ---------------------------------------------------------------------------
function formKey(request: Request): ManagedForm {
  const key = String(request.params.key)
  if (!isManagedForm(key)) throw notFound()
  return key
}

router.get(
  '/config/forms',
  requirePermission('forms:read'),
  guarded(async (_request, response) => {
    const stored = new Map((await versions.keys('form')).map((item) => [item.key, item]))
    response.json({
      success: true,
      forms: (Object.keys(managedForms) as ManagedForm[]).map((key) => ({
        key,
        label: managedForms[key],
        fixedLayout: fixedLayoutForms.includes(key),
        published: stored.get(key)?.published ?? null,
        hasDraft: stored.get(key)?.hasDraft ?? false,
      })),
      fieldTypes: managedFieldTypes,
      attachmentForms: attachmentFieldForms,
      catalogs: catalogSources,
    })
  }),
)

router.get(
  '/config/forms/:key',
  requirePermission('forms:read'),
  guarded(async (request, response) => {
    const key = formKey(request)
    const history = await versions.history<ManagedFormContent>('form', key)
    response.json({
      success: true,
      default: defaultForms[key],
      latest: history[0] ?? null,
      published: history.find((item) => item.status === 'publicada') ?? null,
      history,
    })
  }),
)

router.post(
  '/config/forms/:key/validate',
  requirePermission('forms:read'),
  guarded(async (request, response) => {
    response.json({ success: true, content: validateFormContent(formKey(request), asBody(request.body).conteudo) })
  }),
)

router.put(
  '/config/forms/:key/draft',
  requirePermission('forms:edit'),
  guarded(async (request, response) => {
    const key = formKey(request)
    const version = await versions.saveDraft(
      identityOf(response),
      'form',
      key,
      validateFormContent(key, asBody(request.body).conteudo),
      noteOf(request),
    )
    response.json({ success: true, version })
  }),
)

router.post(
  '/config/forms/:key/publish',
  requirePermission('forms:publish'),
  guarded(async (request, response) => {
    const key = formKey(request)
    const version = await versions.publish(
      identityOf(response),
      'form',
      key,
      validateFormContent(key, asBody(request.body).conteudo),
      noteOf(request),
    )
    response.json({ success: true, version })
  }),
)

router.post(
  '/config/forms/:key/restore',
  requirePermission('config_versions:restore'),
  guarded(async (request, response) => {
    const key = formKey(request)
    const version = await versions.restore(
      identityOf(response),
      'form',
      key,
      readPage(asBody(request.body).versao),
      (content) => validateFormContent(key, content),
    )
    response.json({ success: true, version })
  }),
)

/** A tela de cadastro abre sem sessão. Só textos e regras dos campos, sem histórico nem autoria. */
router.get('/public/forms/registration', async (_request, response) => {
  try {
    const published = await readPublishedConfig<ManagedFormContent>(getDatabasePool(), 'form', 'registration')
    response.json({ success: true, form: published?.content ?? null, version: published?.version ?? null })
  } catch (error) {
    sendModuleError(response, error)
  }
})

export default router
