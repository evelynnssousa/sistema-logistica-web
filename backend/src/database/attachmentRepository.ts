import { randomUUID, createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import type { AttachmentStorage } from '../attachments/storage.js'
import { redactOptional } from '../integrations/redaction.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { ModuleError, notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { recordHistory } from './serviceRequestRepository.js'
import { withTransaction } from './withTransaction.js'

export type AttachmentOwner =
  | { type: 'service_request'; id: string }
  | { type: 'material_request'; id: string }

export const attachmentCategories = [
  'orcamento',
  'comprovante',
  'fotografia_antes',
  'fotografia_depois',
  'fotografia',
  'execucao',
  'bilhete',
  'relatorio',
  'outro',
] as const

type Row = {
  id: string
  request_id: string | null
  material_request_id: string | null
  categoria: string
  nome_original: string
  tipo: string
  tamanho_bytes: string
  sha256: string
  storage_key: string
  restrito: boolean
  enviado_por: string
  enviado_por_nome: string
  created_at: Date
  removido_em: Date | null
  removido_por_nome: string | null
  motivo_remocao: string | null
}

const select = `
  SELECT a.id::text AS id, a.request_id::text AS request_id,
         a.material_request_id::text AS material_request_id, a.categoria, a.nome_original, a.tipo,
         a.tamanho_bytes::text AS tamanho_bytes, a.sha256, a.storage_key, a.restrito,
         a.enviado_por::text AS enviado_por, enviou.full_name AS enviado_por_nome, a.created_at,
         a.removido_em, removeu.full_name AS removido_por_nome, a.motivo_remocao
    FROM public.request_attachments a
    JOIN public.auth_users enviou ON enviou.id = a.enviado_por
    LEFT JOIN public.auth_users removeu ON removeu.id = a.removido_por`

/** O que a tela recebe. A chave de armazenamento nunca sai do servidor. */
function present(row: Row) {
  return {
    id: row.id,
    category: row.categoria,
    name: row.nome_original,
    kind: row.tipo,
    sizeBytes: Number(row.tamanho_bytes),
    sha256: row.sha256,
    restricted: row.restrito,
    uploadedBy: row.enviado_por_nome,
    uploadedById: row.enviado_por,
    uploadedAt: row.created_at,
    removedAt: row.removido_em,
    removedBy: row.removido_por_nome,
    removalReason: row.motivo_remocao,
  }
}

async function appendHistory(
  client: Pick<PoolClient, 'query'>,
  owner: AttachmentOwner,
  actor: AuthenticatedIdentity,
  action: string,
  comment: string | null,
  details: Record<string, unknown>,
) {
  if (owner.type === 'service_request') {
    const current = await client.query<{ status: string }>(
      `SELECT status FROM public.service_requests WHERE id = $1 FOR UPDATE`,
      [owner.id],
    )
    await recordHistory(client, {
      requestId: owner.id,
      userId: actor.userId,
      action,
      from: current.rows[0].status,
      to: current.rows[0].status,
      comment,
      details,
    })
    return
  }
  const current = await client.query<{ status: string }>(
    `SELECT status FROM public.material_requests WHERE id = $1 FOR UPDATE`,
    [owner.id],
  )
  await client.query(
    `INSERT INTO public.material_request_history
      (material_request_id, usuario_id, acao, status_anterior, status_novo, comentario, detalhes)
     VALUES ($1, $2, $3, $4, $4, $5, $6::jsonb)`,
    [owner.id, actor.userId, action, current.rows[0].status, redactOptional(comment), JSON.stringify(details)],
  )
}

export class AttachmentRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async list(owner: AttachmentOwner) {
    const column = owner.type === 'service_request' ? 'a.request_id' : 'a.material_request_id'
    const result = await this.poolProvider().query<Row>(
      `${select} WHERE ${column} = $1 ORDER BY a.created_at DESC, a.id DESC`,
      [owner.id],
    )
    return result.rows.map(present)
  }

  async find(id: string) {
    const result = await this.poolProvider().query<Row>(`${select} WHERE a.id = $1`, [id])
    const row = result.rows[0]
    if (!row) return null
    const owner: AttachmentOwner = row.request_id
      ? { type: 'service_request', id: row.request_id }
      : { type: 'material_request', id: row.material_request_id as string }
    return { ...present(row), owner, storageKey: row.storage_key }
  }

  async usedBytes() {
    const result = await this.poolProvider().query<{ total: string; arquivos: number }>(
      `SELECT coalesce(sum(tamanho_bytes), 0)::text AS total, count(*)::int AS arquivos
         FROM public.request_attachments`,
    )
    const demands = await this.demandAttachmentUsage()
    return {
      bytes: Number(result.rows[0].total) + demands.bytes,
      files: result.rows[0].arquivos + demands.files,
    }
  }

  /** Os anexos do Controle de Demandas ocupam o mesmo armazenamento. Sem a migração 014, nada. */
  private async demandAttachmentUsage() {
    try {
      const result = await this.poolProvider().query<{ total: string; arquivos: number }>(
        `SELECT coalesce(sum(tamanho_bytes), 0)::text AS total, count(*)::int AS arquivos
           FROM public.demand_attachments`,
      )
      // Atas e contratos (021) usam o mesmo armazenamento. Sem a 021, nada a somar.
      const contracts = await this.poolProvider().query<{ total: string; arquivos: number }>(
        `SELECT coalesce(sum(tamanho_bytes), 0)::text AS total, count(*)::int AS arquivos
           FROM public.contract_instrument_attachments
          WHERE to_regclass('public.contract_instrument_attachments') IS NOT NULL`,
      ).catch((error: unknown) => {
        if ((error as { code?: unknown }).code === '42P01') return { rows: [{ total: '0', arquivos: 0 }] }
        throw error
      })
      return {
        bytes: Number(result.rows[0].total) + Number(contracts.rows[0].total),
        files: result.rows[0].arquivos + contracts.rows[0].arquivos,
      }
    } catch (error) {
      if ((error as { code?: unknown }).code === '42P01') return { bytes: 0, files: 0 }
      throw error
    }
  }

  /**
   * Grava o arquivo antes do registro. Se o banco recusar, o arquivo é apagado; se o processo cair
   * nesse intervalo, resta um arquivo sem registro, inacessível pela API.
   */
  async add(
    actor: AuthenticatedIdentity,
    storage: AttachmentStorage,
    owner: AttachmentOwner,
    input: {
      content: Buffer
      name: string
      kind: string
      category: string
      restricted: boolean
      maxTotalBytes: number
    },
  ) {
    const id = randomUUID()
    const storageKey = randomUUID()
    const sha256 = createHash('sha256').update(input.content).digest('hex')

    const { bytes } = await this.usedBytes()
    if (bytes + input.content.length > input.maxTotalBytes) {
      throw new ModuleError('A capacidade de armazenamento de anexos foi atingida.', 507)
    }

    await storage.save(storageKey, input.content)
    try {
      await withTransaction(this.poolProvider(), async (client) => {
        await client.query(
          `INSERT INTO public.request_attachments
            (id, request_id, material_request_id, categoria, nome_original, tipo, tamanho_bytes,
             sha256, storage_key, restrito, enviado_por)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            id,
            owner.type === 'service_request' ? owner.id : null,
            owner.type === 'material_request' ? owner.id : null,
            input.category,
            input.name,
            input.kind,
            input.content.length,
            sha256,
            storageKey,
            input.restricted,
            actor.userId,
          ],
        )
        // O nome pode trazer dado pessoal: o histórico diz só o tipo e a categoria.
        await appendHistory(client, owner, actor, 'anexo_incluido', null, {
          anexoId: id,
          categoria: input.category,
        })
        await insertAuthAuditEvent(client, {
          actorUserId: actor.userId,
          actorKind: 'user',
          subjectUserId: null,
          sessionId: owner.id,
          eventType: 'attachment_uploaded',
          details: { attachmentId: id, category: input.category, kind: input.kind },
        })
      })
    } catch (error) {
      await storage.remove(storageKey).catch(() => undefined)
      throw error
    }
    return id
  }

  /** Remoção lógica: o registro e o arquivo permanecem, para a rastreabilidade. */
  async remove(actor: AuthenticatedIdentity, id: string, reason: string) {
    await withTransaction(this.poolProvider(), async (client) => {
      const found = await client.query<{
        request_id: string | null
        material_request_id: string | null
        removido_em: Date | null
      }>(
        `SELECT request_id::text AS request_id, material_request_id::text AS material_request_id, removido_em
           FROM public.request_attachments WHERE id = $1 FOR UPDATE`,
        [id],
      )
      const current = found.rows[0]
      if (!current) throw notFound()
      if (current.removido_em) throw new ModuleError('Este anexo já foi removido.', 409)

      await client.query(
        `UPDATE public.request_attachments
            SET removido_em = now(), removido_por = $2, motivo_remocao = $3
          WHERE id = $1`,
        [id, actor.userId, redactOptional(reason)],
      )
      const owner: AttachmentOwner = current.request_id
        ? { type: 'service_request', id: current.request_id }
        : { type: 'material_request', id: current.material_request_id as string }
      await appendHistory(client, owner, actor, 'anexo_removido', reason, { anexoId: id })
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: null,
        sessionId: owner.id,
        eventType: 'attachment_removed',
        details: { attachmentId: id },
      })
    })
  }

  async recordDownload(actor: AuthenticatedIdentity, id: string, owner: AttachmentOwner) {
    await insertAuthAuditEvent(this.poolProvider(), {
      actorUserId: actor.userId,
      actorKind: 'user',
      subjectUserId: null,
      sessionId: owner.id,
      eventType: 'attachment_downloaded',
      details: { attachmentId: id },
    })
  }
}
