import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { defaultSettings, mergeSettings } from '../requests/settingsRules.js'
import type { SettingsSection, SystemSettings } from '../requests/settingsRules.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'

type Queryable = Pick<PoolClient, 'query'>

/**
 * Lê os parâmetros sem exigir a migração 007: em um banco sem ela, valem os padrões. A
 * conferência vem antes da consulta porque, dentro de uma transação, tabela inexistente a
 * interromperia por inteiro.
 */
export async function readSystemSettings(queryable: Queryable): Promise<SystemSettings> {
  const present = await queryable.query<{ present: boolean }>(
    `SELECT to_regclass('public.system_settings') IS NOT NULL AS present`,
  )
  if (!present.rows[0]?.present) return structuredClone(defaultSettings)

  const result = await queryable.query<{ secao: string; valor: unknown }>(
    // As fotos da página inicial ficam na mesma tabela, mas só são lidas pela rota da foto.
    `SELECT secao, valor FROM public.system_settings WHERE secao NOT LIKE 'foto\\_equipe:%'`,
  )
  return mergeSettings(result.rows)
}

export class SettingsRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  read() {
    return readSystemSettings(this.poolProvider())
  }

  async save(actor: AuthenticatedIdentity, section: SettingsSection, value: unknown) {
    await withTransaction(this.poolProvider(), async (client) => {
      const previous = await client.query<{ valor: unknown }>(
        `SELECT valor FROM public.system_settings WHERE secao = $1 FOR UPDATE`,
        [section],
      )
      const before = previous.rows[0]?.valor ?? null
      await client.query(
        `INSERT INTO public.system_settings (secao, valor, atualizado_por)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (secao) DO UPDATE
           SET valor = EXCLUDED.valor, atualizado_por = EXCLUDED.atualizado_por`,
        [section, JSON.stringify(value), actor.userId],
      )
      // Sem a migração 012, o parâmetro é salvo e a auditoria registra; só o antes e depois não fica.
      const present = await client.query<{ present: boolean }>(
        `SELECT to_regclass('public.settings_change_history') IS NOT NULL AS present`,
      )
      if (present.rows[0].present) {
        await client.query(
          `INSERT INTO public.settings_change_history (secao, valor_anterior, valor_novo, usuario_id)
           VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
          [section, before === null ? null : JSON.stringify(before), JSON.stringify(value), actor.userId],
        )
      }
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: null,
        sessionId: null,
        eventType: 'settings_updated',
        details: { section },
      })
    })
  }

  /** Histórico administrativo. Vazio em um banco sem a migração 012. */
  async history(section?: SettingsSection | readonly string[]) {
    const pool = this.poolProvider()
    const present = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.settings_change_history') IS NOT NULL AS present`,
    )
    if (!present.rows[0].present) return []
    const result = await pool.query<{ id: string; secao: string; valor_anterior: unknown; valor_novo: unknown; usuario: string | null; created_at: Date }>(
      `SELECT h.id::text AS id, h.secao, h.valor_anterior, h.valor_novo, u.full_name AS usuario, h.created_at
         FROM public.settings_change_history h
         LEFT JOIN public.auth_users u ON u.id = h.usuario_id
        WHERE ($1::text[] IS NULL OR h.secao = ANY($1::text[]))
        ORDER BY h.created_at DESC
        LIMIT 100`,
      [section === undefined ? null : typeof section === 'string' ? [section] : section],
    )
    return result.rows.map((row) => ({
      id: row.id,
      section: row.secao,
      before: row.valor_anterior,
      after: row.valor_novo,
      user: row.usuario,
      at: row.created_at,
    }))
  }
}
