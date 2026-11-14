import { randomBytes, randomUUID } from 'node:crypto'
import express, { Router } from 'express'
import type { Request, Response } from 'express'
import { AttachmentRejectedError, detectKind, sanitizeFileName } from '../attachments/fileValidation.js'
import { resolveAttachmentStorage } from '../attachments/storage.js'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'
import { requireAuth } from '../auth/sessionRuntime.js'
import { ModuleError, notFound, sendModuleError } from '../database/moduleErrors.js'
import { getDatabasePool } from '../database/pool.js'
import { readSystemSettings } from '../database/settingsRepository.js'
import { requireCsrf } from '../middleware/requireCsrf.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { activeAnnouncement } from '../requests/adminSettingsRules.js'

/**
 * Página inicial pública e Ajuda (13/11/2026). O conteúdo vem de Configurações → Página inicial.
 * As fotos da equipe ficam em system_settings (linhas "foto_equipe:<id>"), fora das seções comuns:
 * cada uma é enviada sozinha, já reduzida pela tela, e só imagens JPEG, PNG ou WebP são aceitas.
 */

const router = Router()

const photoPrefix = 'foto_equipe:'
const maxPhotoBytes = 400 * 1024
const photoBody = express.raw({ type: () => true, limit: maxPhotoBytes + 1024 })
const imageTypes: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

type Handler = (request: Request, response: Response) => Promise<void>
const guarded = (handler: Handler): Handler => async (request, response) => {
  try {
    await handler(request, response)
  } catch (error) {
    sendModuleError(response, error)
  }
}

/** Conteúdo público: só o que a página mostra. Nada de configuração interna. */
router.get(
  '/public/home',
  guarded(async (_request, response) => {
    const settings = await readSystemSettings(getDatabasePool())
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
    const page = settings.publicPage
    response.set('Cache-Control', 'no-store')
    response.json({
      success: true,
      page: {
        ...page,
        manuals: (page.manuals ?? []).map((manual) => ({
          title: manual.title,
          audience: manual.audience,
          fileName: manual.fileName,
          sizeBytes: manual.sizeBytes,
          url: `/api/public/manuals/${manual.fileId}`,
        })),
        team: page.team.map((member) => ({
          name: member.name,
          role: member.role,
          photoUrl: member.photoId ? `/api/public/team-photos/${member.photoId}` : null,
        })),
      },
      modules: settings.modules,
      loginMessage: settings.texts.loginMessage,
      announcement: activeAnnouncement(settings.announcement, today),
    })
  }),
)

router.get(
  '/public/team-photos/:photoId',
  guarded(async (request, response) => {
    const id = String(request.params.photoId)
    if (!/^[0-9a-f]{32}$/.test(id)) throw notFound()
    const { rows } = await getDatabasePool().query<{ valor: { type?: string; data?: string } }>(
      `SELECT valor FROM public.system_settings WHERE secao = $1`,
      [`${photoPrefix}${id}`],
    )
    const photo = rows[0]?.valor
    if (!photo?.data || !photo.type || !Object.values(imageTypes).includes(photo.type)) throw notFound()
    const content = Buffer.from(photo.data, 'base64')
    response.set('Content-Type', photo.type)
    response.set('Cache-Control', 'public, max-age=86400')
    response.set('Content-Security-Policy', "default-src 'none'; sandbox")
    response.send(content)
  }),
)

/** Envio de uma foto da equipe. A foto só aparece quando a página é salva com ela. */
router.post(
  '/settings/public-page/photos',
  requireAuth,
  requireCsrf,
  requirePermission('settings:manage'),
  photoBody,
  guarded(async (request, response) => {
    const content = request.body
    if (!Buffer.isBuffer(content) || content.length === 0) throw new ModuleError('Envie a foto.', 400)
    if (content.length > maxPhotoBytes) throw new ModuleError('A foto passa de 400 KB. Use uma imagem menor.', 413)
    const kind = detectKind(content)
    if (!kind || !imageTypes[kind]) throw new ModuleError('Envie uma foto em JPEG, PNG ou WebP.', 400)
    const id = randomBytes(16).toString('hex')
    await getDatabasePool().query(
      `INSERT INTO public.system_settings (secao, valor, atualizado_por) VALUES ($1, $2, $3)`,
      [`${photoPrefix}${id}`, JSON.stringify({ type: imageTypes[kind], data: content.toString('base64') }), (response.locals.authenticatedUser as { userId: string }).userId],
    )
    response.status(201).json({ success: true, photoId: id, photoUrl: `/api/public/team-photos/${id}` })
  }),
)

// ---------------------------------------------------------------------------
// Manuais em PDF (14/11/2026). O arquivo vai para o armazenamento de anexos (Supabase, SharePoint ou
// disco) com uma linha "manual_pdf:<id>" em system_settings, com o nome e o tamanho. Só fica público
// quando a página é salva com ele: antes disso, o endereço não abre.
// ---------------------------------------------------------------------------
const manualPrefix = 'manual_pdf:'
const maxManualBytes = 25 * 1024 * 1024
const manualBody = express.raw({ type: () => true, limit: maxManualBytes + 1024 })
const manualIdPattern = /^[0-9a-f-]{36}$/

router.post(
  '/settings/public-page/manuals',
  requireAuth,
  requireCsrf,
  requirePermission('settings:manage'),
  manualBody,
  guarded(async (request, response) => {
    const content = request.body
    if (!Buffer.isBuffer(content) || content.length === 0) throw new ModuleError('Envie o arquivo do manual.', 400)
    if (content.length > maxManualBytes) throw new ModuleError('O manual passa de 25 MB. Reduza as imagens do PDF e envie de novo.', 413)
    let kind
    try {
      kind = detectKind(content)
    } catch (error) {
      if (error instanceof AttachmentRejectedError) throw new ModuleError(error.message, 400)
      throw error
    }
    if (kind !== 'pdf') throw new ModuleError('O manual precisa ser um arquivo PDF.', 400)
    const storage = resolveAttachmentStorage()
    if (!storage) throw new ModuleError('O armazenamento de arquivos não está configurado. Fale com a equipe técnica.', 503)
    const rawName = typeof request.query.nome === 'string' ? request.query.nome : 'manual.pdf'
    const cleaned = sanitizeFileName(rawName) || 'manual.pdf'
    const fileName = /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`
    const id = randomUUID()
    await storage.save(id, content)
    await getDatabasePool().query(
      `INSERT INTO public.system_settings (secao, valor, atualizado_por) VALUES ($1, $2, $3)`,
      [`${manualPrefix}${id}`, JSON.stringify({ fileName, sizeBytes: content.length }), (response.locals.authenticatedUser as { userId: string }).userId],
    )
    response.status(201).json({ success: true, fileId: id, fileName, sizeBytes: content.length })
  }),
)

/** Ao salvar a página: cada manual precisa de um arquivo enviado; o nome e o tamanho vêm do servidor. */
export async function attachManualFiles<T extends { fileId: string; fileName: string; sizeBytes: number; title: string }>(manuals: T[]) {
  if (manuals.length === 0) return manuals
  const { rows } = await getDatabasePool().query<{ secao: string; valor: { fileName?: string; sizeBytes?: number } }>(
    `SELECT secao, valor FROM public.system_settings WHERE secao = ANY($1::text[])`,
    [manuals.map((manual) => `${manualPrefix}${manual.fileId}`)],
  )
  const files = new Map(rows.map((row) => [row.secao.slice(manualPrefix.length), row.valor]))
  return manuals.map((manual) => {
    const file = files.get(manual.fileId)
    if (!file) throw new ModuleError(`O arquivo do manual "${manual.title}" não foi encontrado. Envie o PDF de novo.`, 400)
    return { ...manual, fileName: file.fileName ?? 'manual.pdf', sizeBytes: file.sizeBytes ?? 0 }
  })
}

/** Manuais que a página salva já não usa: saem do armazenamento e do banco (depois de um dia). */
export async function prunePublicPageManuals(keep: readonly string[]) {
  const { rows } = await getDatabasePool().query<{ secao: string }>(
    `DELETE FROM public.system_settings
      WHERE secao LIKE 'manual\\_pdf:%' AND NOT (substring(secao FROM 12) = ANY($1::text[]))
        AND updated_at < now() - interval '1 day'
      RETURNING secao`,
    [keep],
  )
  const storage = resolveAttachmentStorage()
  for (const row of rows) {
    await storage?.remove(row.secao.slice(manualPrefix.length)).catch((error: unknown) => recordTechnicalEvent('storage', 'manual_remove_failed', error))
  }
}

router.get(
  '/public/manuals/:fileId',
  guarded(async (request, response) => {
    const id = String(request.params.fileId)
    if (!manualIdPattern.test(id)) throw notFound()
    // Só o que está publicado na página abre; um arquivo enviado e não salvo, não.
    const manual = (await readSystemSettings(getDatabasePool())).publicPage.manuals?.find((item) => item.fileId === id)
    if (!manual) throw notFound()
    const storage = resolveAttachmentStorage()
    if (!storage) throw notFound()
    const stream = await storage.open(id)
    response.set('Content-Type', 'application/pdf')
    response.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(manual.fileName)}`)
    response.set('Cache-Control', 'public, max-age=300')
    response.set('X-Content-Type-Options', 'nosniff')
    response.set('Content-Security-Policy', "default-src 'none'; sandbox")
    stream.on('error', () => response.destroy())
    stream.pipe(response)
  }),
)

router.use('/settings/public-page', (error: unknown, _request: Request, response: Response, next: (error?: unknown) => void) => {
  if (error && typeof error === 'object' && (error as { type?: string }).type === 'entity.too.large') {
    const manual = _request.path.startsWith('/manuals')
    sendModuleError(response, new ModuleError(manual ? 'O manual passa de 25 MB. Reduza as imagens do PDF e envie de novo.' : 'A foto passa de 400 KB. Use uma imagem menor.', 413))
    return
  }
  next(error)
})

/** Fotos que a página salva já não usa saem do banco. Chamado depois de salvar a seção. */
export async function prunePublicPagePhotos(keep: readonly string[]) {
  await getDatabasePool().query(
    `DELETE FROM public.system_settings
      WHERE secao LIKE 'foto\\_equipe:%' AND NOT (substring(secao FROM 13) = ANY($1::text[]))
        AND updated_at < now() - interval '1 day'`,
    [keep],
  )
}

export default router
