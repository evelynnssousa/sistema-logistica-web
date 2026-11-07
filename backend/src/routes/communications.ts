import { holdsPermission } from '../auth/permissions.js'
import { Router } from 'express'
import type { Request, Response } from 'express'
import { emailPattern } from '../auth/identifiers.js'
import { isInstitutionalEmailAllowed } from '../auth/institutionalEmail.js'
import { canUpdateRequest } from '../auth/requestPolicy.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { CommunicationRepository, ticketStatusOf } from '../database/communicationRepository.js'
import type { CommunicationResource, ResourceType } from '../database/communicationRepository.js'
import { configTableExists, readPublishedConfigs } from '../database/configRepository.js'
import { FlightPassengerRepository } from '../database/flightPassengerRepository.js'
import { IntegrationRepository } from '../database/integrationRepository.js'
import { notFound, sendModuleError } from '../database/moduleErrors.js'
import { getDatabasePool } from '../database/pool.js'
import { readSystemSettings } from '../database/settingsRepository.js'
import {
  defaultTemplateContent,
  eventCatalog,
  isEventType,
  isManualEvent,
  renderManualEmail,
  resourcePath,
  valuesOf,
} from '../integrations/catalog.js'
import type { EventContext, EventType } from '../integrations/catalog.js'
import { emailMode, publicLink } from '../integrations/config.js'
import { fillLines, fillTemplate } from '../integrations/templateVariables.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { asBody, isUuid, optionalText, requiredText, RequestValidationError } from '../requests/validation.js'
import type { TemplateContent } from './configuration.js'

/**
 * Central de comunicação. O envio é sempre pelo servidor, depois da confirmação de quem escreveu.
 * Cada rota confere a permissão de comunicação e o acesso ao módulo da solicitação. Sem acesso,
 * responde 404, para não revelar que o registro existe.
 */

const router = Router()
const repository = new CommunicationRepository()
const passengers = new FlightPassengerRepository()
const integrations = new IntegrationRepository()

router.use('/communications', requireAuth, requireCsrf)

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

/** Quem atende o módulo. Ler o módulo não basta: o histórico traz endereços e documentos. */
function attendsModule(identity: AuthenticatedIdentity, resource: CommunicationResource) {
  return resource.module === 'warehouse'
    ? holdsPermission(identity, 'warehouse:manage')
    : canUpdateRequest(identity, resource.module)
}

async function loadResource(request: Request, response: Response) {
  const type = String(request.params.resourceType)
  const id = String(request.params.resourceId)
  if ((type !== 'service_request' && type !== 'material_request') || !isUuid(id)) throw notFound()
  const resource = await repository.findResource(type as ResourceType, id)
  if (!resource || !attendsModule(identityOf(response), resource)) throw notFound()
  return resource
}

const pathOf = (resource: CommunicationResource) => publicLink(resourcePath(resource.module, resource.id))

function readAddressList(value: unknown, label: string) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new RequestValidationError(`${label} inválidos.`)
  const list = value.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
  for (const address of list) {
    if (address.length > 254 || !emailPattern.test(address)) {
      throw new RequestValidationError(`${label}: endereço inválido.`)
    }
  }
  return [...new Set(list)]
}

function readText(body: Record<string, unknown>) {
  const subject = requiredText(body.assunto, 'o assunto', { min: 1, max: 200 }).replace(/[\r\n]+/g, ' ')
  const text = requiredText(body.mensagem, 'a mensagem', { min: 1, max: 20000 })
  if (/\{\{/.test(`${subject}${text}`)) {
    throw new RequestValidationError('Há um campo de modelo sem preencher na mensagem. Revise o texto antes de enviar.')
  }
  return { subject, text }
}

const segmentText = (segment: unknown) => {
  if (!segment || typeof segment !== 'object') return null
  const { origem, destino, data, horario } = segment as Record<string, string | undefined>
  return `${origem} → ${destino}, ${data?.split('-').reverse().join('/')} às ${horario}`
}

/** Modelos oferecidos: os da central, com o texto publicado ou o padrão. */
async function availableTemplates(resource: CommunicationResource) {
  const pool = getDatabasePool()
  const published = (await configTableExists(pool))
    ? await readPublishedConfigs<TemplateContent>(pool, 'email_template')
    : []
  const fits = (event: EventType) =>
    isManualEvent(event) && (eventCatalog[event].modules as readonly string[]).includes(resource.module)
  const result = new Map<string, { key: string; name: string; event: EventType; content: TemplateContent }>()
  for (const event of Object.keys(eventCatalog) as EventType[]) {
    if (fits(event)) {
      result.set(event, { key: event, name: eventCatalog[event].label, event, content: { ...defaultTemplateContent(event), active: true } })
    }
  }
  for (const item of published) {
    const event = item.content.event
    if (isEventType(event) && fits(event) && item.content.active !== false) {
      result.set(item.key, { key: item.key, name: item.content.name, event, content: item.content })
    }
  }
  return [...result.values()]
}

router.get(
  '/communications/:resourceType/:resourceId',
  requirePermission('communications:read'),
  guarded(async (request, response) => {
    const identity = identityOf(response)
    const resource = await loadResource(request, response)
    const settings = await readSystemSettings(getDatabasePool())
    const history = await repository.list(resource)
    const canSend = identity.permissions.includes('communications:send')
    const tickets = history.filter((item) => item.kind === 'passagem')
    response.json({
      success: true,
      history,
      canSend,
      // Só o estado: credenciais e endereço de envio ficam no servidor.
      service: emailMode() === 'none' ? 'nao_configurado' : emailMode() === 'simulated' ? 'simulado' : 'ativo',
      limits: settings.communications,
      attachmentLimits: { maxFileMb: settings.attachments.maxFileMb, allowedKinds: settings.attachments.allowedKinds },
      recipients: resource.requesterEmail ? [{ label: `Solicitante: ${resource.requesterName ?? ''}`.trim(), email: resource.requesterEmail }] : [],
      templates: canSend ? (await availableTemplates(resource)).map(({ key, name, event }) => ({ key, name, event })) : [],
      ...(resource.module === 'flights'
        ? {
            passengers: await passengers.listMasked(resource.id),
            ticketStatus: ticketStatusOf(tickets[0]?.status),
          }
        : {}),
    })
  }),
)

/** Preenche o modelo com dados reais. O operador ainda pode corrigir tudo antes de enviar. */
router.post(
  '/communications/:resourceType/:resourceId/compose',
  requirePermission('communications:send'),
  guarded(async (request, response) => {
    const resource = await loadResource(request, response)
    const body = asBody(request.body)
    const key = String(body.modelo ?? '')
    const template = (await availableTemplates(resource)).find((item) => item.key === key)
    if (!template) throw new RequestValidationError('Selecione um modelo disponível.')

    const fresh = await integrations.templateData(resource.module === 'warehouse' ? 'warehouse' : resource.module, resource.id).catch(() => ({}))
    const context: EventContext & { situation?: string } = {
      ...fresh,
      module: resource.module,
      protocol: resource.protocol,
      situation: resource.status,
    }
    let suggestedRecipient: string | null = null
    if (resource.module === 'flights') {
      const passengerId = isUuid(body.passageiroId) ? body.passageiroId : null
      const list = await passengers.listMasked(resource.id)
      const passenger = list.find((item) => item.id === passengerId)
      const quote = await repository.selectedQuote(resource.id)
      context.passengerName = passenger?.name ?? null
      context.airline = quote?.companhia ?? null
      context.flights = quote?.voos ?? null
      context.outbound = segmentText(resource.details.ida)
      context.inbound = segmentText(resource.details.volta)
      context.locator = optionalText(body.localizador, 'Localizador', 40)
      if (passenger) suggestedRecipient = await repository.lastPassengerAddress(resource.id, passenger.id)
    }
    const values = valuesOf(context)
    const { subject, greeting, closing, signature } = template.content
    response.json({
      success: true,
      assunto: fillTemplate(subject, values),
      mensagem: [greeting, template.content.body, closing, signature]
        .filter(Boolean)
        .flatMap((part) => fillLines(part, values))
        .join('\n'),
      destinatarioSugerido: suggestedRecipient,
    })
  }),
)

/** Exatamente o que sairá, com o cabeçalho institucional e o CPF digitado por engano mascarado. */
router.post(
  '/communications/:resourceType/:resourceId/preview',
  requirePermission('communications:send'),
  guarded(async (request, response) => {
    const resource = await loadResource(request, response)
    const { subject, text } = readText(asBody(request.body))
    response.json({
      success: true,
      ...renderManualEmail({ module: resource.module, protocol: resource.protocol, subject, body: text, link: pathOf(resource) }),
    })
  }),
)

router.post(
  '/communications/:resourceType/:resourceId/send',
  requirePermission('communications:send'),
  guarded(async (request, response) => {
    const identity = identityOf(response)
    const resource = await loadResource(request, response)
    const body = asBody(request.body)
    if (body.confirmado !== true) {
      throw new RequestValidationError('Confira a mensagem e confirme o envio.')
    }
    if (!isUuid(body.chave)) throw new RequestValidationError('Envio sem identificação. Atualize a página.')

    const kind = body.tipo === 'passagem' ? 'passagem' : 'geral'
    if (kind === 'passagem' && resource.module !== 'flights') throw notFound()
    const passengerId = kind === 'passagem' && isUuid(body.passageiroId) ? body.passageiroId : null
    if (kind === 'passagem') {
      const list = await passengers.listMasked(resource.id)
      if (!list.some((item) => item.id === passengerId)) throw new RequestValidationError('Selecione o passageiro.')
    }

    const pool = getDatabasePool()
    const settings = (await readSystemSettings(pool)).communications
    const recipients = readAddressList(body.destinatarios, 'Destinatários')
    const cc = readAddressList(body.copias, 'Cópias').filter((address) => !recipients.includes(address))
    if (recipients.length === 0) throw new RequestValidationError('Informe ao menos um destinatário.')
    if (recipients.length + cc.length > settings.maxRecipients) {
      throw new RequestValidationError(`O limite é de ${settings.maxRecipients} destinatários por mensagem.`)
    }
    // O passageiro pode não ter endereço institucional. Fora disso, vale a regra da administração.
    const known = new Set([resource.requesterEmail?.toLowerCase()])
    const externalAllowed = settings.allowExternalRecipients
    for (const [index, address] of [...recipients, ...cc].entries()) {
      const isPassengerAddress = kind === 'passagem' && index === 0
      if (!known.has(address) && !isPassengerAddress && !externalAllowed && !isInstitutionalEmailAllowed(address)) {
        throw new RequestValidationError(`Endereço fora da instituição não permitido: ${address}.`)
      }
    }

    const attachmentIds = Array.isArray(body.anexos) ? body.anexos.map(String) : []
    if (attachmentIds.some((id) => !isUuid(id))) throw new RequestValidationError('Há um anexo inválido.')
    if (attachmentIds.length > 20) throw new RequestValidationError('O limite é de 20 anexos por mensagem.')
    if (kind === 'passagem' && attachmentIds.length === 0) {
      throw new RequestValidationError('Anexe o bilhete eletrônico antes de enviar.')
    }

    const { subject, text } = readText(body)
    const rendered = renderManualEmail({ module: resource.module, protocol: resource.protocol, subject, body: text, link: pathOf(resource) })
    const queued = await repository.queue(identity, resource, {
      kind,
      template: typeof body.modelo === 'string' && body.modelo ? body.modelo.slice(0, 80) : null,
      passengerId,
      recipients,
      cc,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      idempotencyKey: body.chave,
      attachmentIds,
      maxBytes: settings.maxEmailMb * 1048576,
    })
    response.status(queued.repeated ? 200 : 201).json({ success: true, ...queued })
  }),
)

/** Cria outra mensagem, igual à original. O registro anterior continua como está. */
router.post(
  '/communications/emails/:emailId/resend',
  requirePermission('communications:send'),
  guarded(async (request, response) => {
    const id = String(request.params.emailId)
    if (!isUuid(id)) throw notFound()
    const body = asBody(request.body)
    if (body.confirmado !== true) throw new RequestValidationError('Confirme o reenvio.')
    if (!isUuid(body.chave)) throw new RequestValidationError('Envio sem identificação. Atualize a página.')

    const original = await repository.original(id)
    const type: ResourceType = original.request_id ? 'service_request' : 'material_request'
    const resource = await repository.findResource(type, (original.request_id ?? original.material_request_id) as string)
    if (!resource || !attendsModule(identityOf(response), resource)) throw notFound()
    const settings = (await readSystemSettings(getDatabasePool())).communications

    const queued = await repository.queue(identityOf(response), resource, {
      kind: original.tipo === 'passagem' ? 'passagem' : 'geral',
      template: original.modelo,
      passengerId: original.passageiro_id,
      recipients: original.destinatarios,
      cc: original.copias,
      subject: original.assunto,
      text: original.corpo_texto,
      html: original.corpo_html,
      idempotencyKey: body.chave,
      attachmentIds: original.anexos ?? [],
      maxBytes: settings.maxEmailMb * 1048576,
      resentFrom: id,
    })
    response.status(queued.repeated ? 200 : 201).json({ success: true, ...queued })
  }),
)

export default router
