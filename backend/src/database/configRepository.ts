import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { conflict, notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'

/**
 * Versões de modelos de e-mail e formulários. Nada é sobrescrito: salvar acrescenta uma versão,
 * publicar acrescenta outra, e restaurar republica uma cópia. Em um banco sem a migração 012, as
 * leituras respondem vazio, e o sistema segue com os textos e campos padrão.
 */

export type ConfigKind = 'email_template' | 'form'
type Queryable = Pick<PoolClient, 'query'>

export type ConfigVersion<Content = unknown> = {
  id: string
  key: string
  version: number
  status: 'rascunho' | 'publicada'
  content: Content
  note: string | null
  user: string | null
  at: Date
}

type Row = {
  id: string
  chave: string
  versao: number
  situacao: 'rascunho' | 'publicada'
  conteudo: unknown
  observacao: string | null
  usuario: string | null
  created_at: Date
}

const select = `SELECT v.id::text AS id, v.chave, v.versao, v.situacao, v.conteudo, v.observacao,
                       u.full_name AS usuario, v.created_at
                  FROM public.config_versions v
                  LEFT JOIN public.auth_users u ON u.id = v.usuario_id`

function toVersion<Content>(row: Row): ConfigVersion<Content> {
  return {
    id: row.id,
    key: row.chave,
    version: row.versao,
    status: row.situacao,
    content: row.conteudo as Content,
    note: row.observacao,
    user: row.usuario,
    at: row.created_at,
  }
}

export async function configTableExists(queryable: Queryable) {
  const result = await queryable.query<{ present: boolean }>(
    `SELECT to_regclass('public.config_versions') IS NOT NULL AS present`,
  )
  return result.rows[0]?.present === true
}

/** O que está em uso: a versão publicada mais recente de cada chave. */
export async function readPublishedConfigs<Content>(queryable: Queryable, kind: ConfigKind) {
  if (!(await configTableExists(queryable))) return [] as ConfigVersion<Content>[]
  const result = await queryable.query<Row>(
    `SELECT DISTINCT ON (v.chave) v.id::text AS id, v.chave, v.versao, v.situacao, v.conteudo,
            v.observacao, NULL::text AS usuario, v.created_at
       FROM public.config_versions v
      WHERE v.tipo = $1 AND v.situacao = 'publicada'
      ORDER BY v.chave, v.versao DESC`,
    [kind],
  )
  return result.rows.map((row) => toVersion<Content>(row))
}

export async function readPublishedConfig<Content>(queryable: Queryable, kind: ConfigKind, key: string) {
  if (!(await configTableExists(queryable))) return null
  const result = await queryable.query<Row>(
    `SELECT v.id::text AS id, v.chave, v.versao, v.situacao, v.conteudo, v.observacao,
            NULL::text AS usuario, v.created_at
       FROM public.config_versions v
      WHERE v.tipo = $1 AND v.chave = $2 AND v.situacao = 'publicada'
      ORDER BY v.versao DESC LIMIT 1`,
    [kind, key],
  )
  return result.rows[0] ? toVersion<Content>(result.rows[0]) : null
}

export class ConfigRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async history<Content>(kind: ConfigKind, key: string) {
    const pool = this.poolProvider()
    if (!(await configTableExists(pool))) return [] as ConfigVersion<Content>[]
    const result = await pool.query<Row>(
      `${select} WHERE v.tipo = $1 AND v.chave = $2 ORDER BY v.versao DESC LIMIT 100`,
      [kind, key],
    )
    return result.rows.map((row) => toVersion<Content>(row))
  }

  async keys(kind: ConfigKind) {
    const pool = this.poolProvider()
    if (!(await configTableExists(pool))) return [] as { key: string; latest: number; published: number | null; hasDraft: boolean }[]
    const result = await pool.query<{ chave: string; ultima: number; publicada: number | null; situacao: string }>(
      `SELECT chave, max(versao)::int AS ultima,
              max(versao) FILTER (WHERE situacao = 'publicada')::int AS publicada,
              (array_agg(situacao ORDER BY versao DESC))[1] AS situacao
         FROM public.config_versions WHERE tipo = $1 GROUP BY chave ORDER BY chave`,
      [kind],
    )
    return result.rows.map((row) => ({
      key: row.chave,
      latest: row.ultima,
      published: row.publicada,
      hasDraft: row.situacao === 'rascunho',
    }))
  }

  /** A trava por chave faz dois salvamentos simultâneos receberem números diferentes. */
  private async append(
    client: PoolClient,
    actor: AuthenticatedIdentity,
    input: { kind: ConfigKind; key: string; status: 'rascunho' | 'publicada'; content: unknown; note: string | null },
  ) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`config:${input.kind}:${input.key}`])
    const next = await client.query<{ versao: number }>(
      `SELECT COALESCE(max(versao), 0)::int + 1 AS versao FROM public.config_versions WHERE tipo = $1 AND chave = $2`,
      [input.kind, input.key],
    )
    const version = next.rows[0].versao
    await client.query(
      `INSERT INTO public.config_versions (tipo, chave, versao, situacao, conteudo, observacao, usuario_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [input.kind, input.key, version, input.status, JSON.stringify(input.content), input.note, actor.userId],
    )
    return version
  }

  private audit(
    client: PoolClient,
    actor: AuthenticatedIdentity,
    eventType: 'config_draft_saved' | 'config_published' | 'config_restored',
    input: { kind: ConfigKind; key: string; version: number; from?: number },
  ) {
    return insertAuthAuditEvent(client, {
      actorUserId: actor.userId,
      actorKind: 'user',
      subjectUserId: null,
      sessionId: null,
      eventType,
      details: {
        kind: input.kind,
        key: input.key,
        version: String(input.version),
        ...(input.from ? { from: String(input.from) } : {}),
      },
    })
  }

  saveDraft(actor: AuthenticatedIdentity, kind: ConfigKind, key: string, content: unknown, note: string | null) {
    return withTransaction(this.poolProvider(), async (client) => {
      const version = await this.append(client, actor, { kind, key, status: 'rascunho', content, note })
      await this.audit(client, actor, 'config_draft_saved', { kind, key, version })
      return version
    })
  }

  publish(actor: AuthenticatedIdentity, kind: ConfigKind, key: string, content: unknown, note: string | null) {
    return withTransaction(this.poolProvider(), async (client) => {
      const version = await this.append(client, actor, { kind, key, status: 'publicada', content, note })
      await this.audit(client, actor, 'config_published', { kind, key, version })
      return version
    })
  }

  /** Publica de novo o conteúdo de uma versão. `check` confere se ele ainda é válido hoje. */
  restore(
    actor: AuthenticatedIdentity,
    kind: ConfigKind,
    key: string,
    version: number,
    check: (content: unknown) => unknown,
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const found = await client.query<{ conteudo: unknown }>(
        `SELECT conteudo FROM public.config_versions WHERE tipo = $1 AND chave = $2 AND versao = $3`,
        [kind, key, version],
      )
      if (!found.rows[0]) throw notFound()
      let content: unknown
      try {
        content = check(found.rows[0].conteudo)
      } catch (error) {
        throw conflict(`Esta versão não atende mais às regras atuais: ${(error as Error).message}`)
      }
      const created = await this.append(client, actor, {
        kind,
        key,
        status: 'publicada',
        content,
        note: `Restaurada a partir da versão ${version}`,
      })
      await this.audit(client, actor, 'config_restored', { kind, key, version: created, from: version })
      return created
    })
  }
}
