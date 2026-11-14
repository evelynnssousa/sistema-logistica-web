import { Router } from 'express'
import type { Request, Response } from 'express'
import { resolveAttachmentStorage } from '../attachments/storage.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { notFound, sendModuleError } from '../database/moduleErrors.js'
import {
  confirmationPhrases,
  databaseEnvironment,
  isPurgeGroup,
  purgeGroupLabels,
  purgeGroups,
  singleRecordScope,
  TestDataPurge,
} from '../database/testDataPurge.js'
import type { PurgeGroup, SingleRecord } from '../database/testDataPurge.js'
import { getDatabasePool } from '../database/pool.js'
import { requireAuthorization } from '../middleware/requireAuthorization.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { asBody, RequestValidationError } from '../requests/validation.js'

/**
 * Limpeza dos dados de teste. Só o Administrador, com a permissão de alterar configurações.
 * Prévia (contagens) -> cópia em JSON (com a impressão digital) -> limpeza com frase de confirmação.
 */

const router = Router()
const purge = new TestDataPurge()

router.use('/admin/test-data', requireAuth, requireCsrf, requirePermission('settings:manage'), requireAuthorization('administrator'))

type Handler = (request: Request, response: Response) => Promise<void>
const guarded = (handler: Handler): Handler => async (request, response) => {
  try {
    await handler(request, response)
  } catch (error) {
    sendModuleError(response, error)
  }
}

function readGroups(value: unknown): Set<PurgeGroup> {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const groups = new Set<PurgeGroup>()
  for (const item of list) {
    if (!isPurgeGroup(item)) throw new RequestValidationError('Escolha o que limpar.')
    groups.add(item)
  }
  if (groups.size === 0) throw new RequestValidationError('Escolha ao menos um módulo para limpar.')
  return groups
}

router.get(
  '/admin/test-data',
  guarded(async (request, response) => {
    const environment = databaseEnvironment()
    const query = asBody(request.query)
    response.json({
      success: true,
      environment,
      confirmation: confirmationPhrases[environment],
      groups: purgeGroups.map((key) => ({ key, label: purgeGroupLabels[key] })),
      preview: query.groups ? await purge.preview(readGroups(query.groups)) : null,
    })
  }),
)

router.get(
  '/admin/test-data/copy',
  guarded(async (request, response) => {
    const copy = await purge.exportCopy(readGroups(asBody(request.query).groups))
    const stamp = copy.generatedAt.replace(/[:.]/g, '-')
    response.set('Content-Type', 'application/json; charset=utf-8')
    response.set('Content-Disposition', `attachment; filename="copia-dados-de-teste-${stamp}.json"`)
    response.set('X-Copy-Fingerprint', copy.fingerprint)
    response.send(JSON.stringify(copy))
  }),
)

router.post(
  '/admin/test-data/purge',
  guarded(async (request, response) => {
    const body = asBody(request.body)
    if (typeof body.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(body.fingerprint)) {
      throw new RequestValidationError('Baixe a cópia antes de limpar.')
    }
    const storage = resolveAttachmentStorage()
    const result = await purge.purge(
      response.locals.authenticatedUser as AuthenticatedIdentity,
      {
        groups: readGroups(body.groups),
        fingerprint: body.fingerprint,
        confirmation: typeof body.confirmation === 'string' ? body.confirmation : '',
      },
      storage ? (key) => storage.remove(key) : null,
    )
    response.json({ success: true, ...result })
  }),
)

// ---------------------------------------------------------------------------
// Excluir uma solicitação (14/11/2026): botão no detalhe, só para o Administrador. O mesmo plano da
// limpeza, restrito ao registro: cópia baixada antes, protocolo digitado e registro na Auditoria.
// ---------------------------------------------------------------------------
const recordKinds: Record<string, SingleRecord['table']> = { solicitacao: 'service_requests', 'pedido-material': 'material_requests' }

async function readRecord(request: Request) {
  const table = recordKinds[String(request.params.kind)]
  const id = String(request.params.recordId)
  if (!table || !/^[0-9a-f-]{36}$/i.test(id)) throw notFound()
  const only: SingleRecord = { table, id }
  const scope = await singleRecordScope(getDatabasePool(), only)
  if (!scope) throw notFound()
  // Sem protocolo (registro anterior à numeração), a frase é EXCLUIR.
  return { only, groups: new Set<PurgeGroup>([scope.group]), phrase: scope.protocol ?? 'EXCLUIR' }
}

router.get(
  '/admin/test-data/record/:kind/:recordId',
  guarded(async (request, response) => {
    const record = await readRecord(request)
    response.json({
      success: true,
      environment: databaseEnvironment(),
      confirmation: record.phrase,
      preview: await purge.preview(record.groups, record.only),
    })
  }),
)

router.get(
  '/admin/test-data/record/:kind/:recordId/copy',
  guarded(async (request, response) => {
    const record = await readRecord(request)
    const copy = await purge.exportCopy(record.groups, record.only)
    response.set('Content-Type', 'application/json; charset=utf-8')
    response.set('Content-Disposition', `attachment; filename="copia-${record.phrase.replace(/[^A-Za-z0-9-]/g, '')}.json"`)
    response.set('X-Copy-Fingerprint', copy.fingerprint)
    response.send(JSON.stringify(copy))
  }),
)

router.post(
  '/admin/test-data/record/:kind/:recordId/purge',
  guarded(async (request, response) => {
    const record = await readRecord(request)
    const body = asBody(request.body)
    if (typeof body.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(body.fingerprint)) {
      throw new RequestValidationError('Baixe a cópia antes de excluir.')
    }
    const storage = resolveAttachmentStorage()
    const result = await purge.purge(
      response.locals.authenticatedUser as AuthenticatedIdentity,
      {
        groups: record.groups,
        only: record.only,
        phrase: record.phrase,
        fingerprint: body.fingerprint,
        confirmation: typeof body.confirmation === 'string' ? body.confirmation : '',
      },
      storage ? (key) => storage.remove(key) : null,
    )
    response.json({ success: true, ...result })
  }),
)

export default router
