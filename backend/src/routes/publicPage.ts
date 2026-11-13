import { randomBytes } from 'node:crypto'
import express, { Router } from 'express'
import type { Request, Response } from 'express'
import { detectKind } from '../attachments/fileValidation.js'
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

router.use('/settings/public-page', (error: unknown, _request: Request, response: Response, next: (error?: unknown) => void) => {
  if (error && typeof error === 'object' && (error as { type?: string }).type === 'entity.too.large') {
    sendModuleError(response, new ModuleError('A foto passa de 400 KB. Use uma imagem menor.', 413))
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
