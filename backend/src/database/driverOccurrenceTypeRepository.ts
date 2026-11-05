import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { defaultOccurrenceTypes, occurrenceTypeKey, occurrenceTypesHistorySection } from '../requests/driverPortalRules.js'
import type { OccurrenceType } from '../requests/driverPortalRules.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { conflict, ModuleError, notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'

type Queryable = Pick<PoolClient, 'query'>

const columns = `chave, nome, ativo, exige_justificativa, permite_anexos, pede_atraso`

type Row = { chave: string; nome: string; ativo: boolean; exige_justificativa: boolean; permite_anexos: boolean; pede_atraso: boolean }

const present = (row: Row): OccurrenceType => ({
  key: row.chave,
  label: row.nome,
  active: row.ativo,
  requiresJustification: row.exige_justificativa,
  allowsAttachments: row.permite_anexos,
  asksDelay: row.pede_atraso,
})

const maxTypes = 60

/** Todos os tipos, ativos e inativos. Sem a migração 017, valem os padrões documentados. */
export async function readOccurrenceTypes(queryable: Queryable): Promise<OccurrenceType[]> {
  const schema = await queryable.query<{ present: boolean }>(
    `SELECT to_regclass('public.driver_occurrence_types') IS NOT NULL AS present`,
  )
  if (!schema.rows[0]?.present) return defaultOccurrenceTypes.map((type) => ({ ...type }))
  const found = await queryable.query<Row>(
    `SELECT ${columns} FROM public.driver_occurrence_types ORDER BY ordem, chave`,
  )
  return found.rows.map(present)
}

type TypeInput = Omit<OccurrenceType, 'key'>

/** Não há exclusão: desativar tira o tipo das próximas escolhas, e as ocorrências guardam o nome usado. */
export class DriverOccurrenceTypeRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  list() {
    return readOccurrenceTypes(this.poolProvider())
  }

  private duplicated(error: unknown) {
    return (error as { code?: unknown }).code === '23505' ? conflict('Já existe um tipo de ocorrência com este nome.') : error
  }

  private async record(client: Queryable, actor: AuthenticatedIdentity, before: OccurrenceType | null, after: OccurrenceType) {
    await client.query(
      `INSERT INTO public.settings_change_history (secao, valor_anterior, valor_novo, usuario_id)
       VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
      [occurrenceTypesHistorySection, before && JSON.stringify(before), JSON.stringify(after), actor.userId],
    )
    await insertAuthAuditEvent(client, {
      actorUserId: actor.userId,
      actorKind: 'user',
      subjectUserId: null,
      sessionId: null,
      eventType: 'settings_updated',
      details: { section: occurrenceTypesHistorySection },
    })
  }

  private async assertAnotherActive(client: Queryable, key: string) {
    const others = await client.query(
      `SELECT 1 FROM public.driver_occurrence_types WHERE ativo AND chave <> $1 LIMIT 1`,
      [key],
    )
    if (others.rows.length === 0) {
      throw new ModuleError('Mantenha ao menos um tipo ativo. Para impedir novos registros, desative as ocorrências no acesso ao portal.', 400)
    }
  }

  async create(actor: AuthenticatedIdentity, input: TypeInput) {
    try {
      return await withTransaction(this.poolProvider(), async (client) => {
        // Dois cadastros ao mesmo tempo não escapam do limite nem disputam a mesma chave.
        await client.query(`LOCK TABLE public.driver_occurrence_types IN SHARE ROW EXCLUSIVE MODE`)
        const existing = await client.query<{ chave: string; ordem: number }>(
          `SELECT chave, ordem FROM public.driver_occurrence_types`,
        )
        if (existing.rows.length >= maxTypes) throw new ModuleError(`Mantenha no máximo ${maxTypes} tipos de ocorrência.`, 400)
        const used = new Set(existing.rows.map((row) => row.chave))
        const base = occurrenceTypeKey(input.label)
        let key = base
        for (let suffix = 2; used.has(key); suffix += 1) key = `${base}_${suffix}`
        const order = Math.max(0, ...existing.rows.map((row) => row.ordem)) + 10

        const created = await client.query<Row>(
          `INSERT INTO public.driver_occurrence_types
             (chave, nome, ativo, exige_justificativa, permite_anexos, pede_atraso, ordem, atualizado_por)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${columns}`,
          [key, input.label, input.active, input.requiresJustification, input.allowsAttachments, input.asksDelay, order, actor.userId],
        )
        const type = present(created.rows[0])
        await this.record(client, actor, null, type)
        return type
      })
    } catch (error) {
      throw this.duplicated(error)
    }
  }

  async update(actor: AuthenticatedIdentity, key: string, input: TypeInput) {
    try {
      return await withTransaction(this.poolProvider(), async (client) => {
        const found = await client.query<Row>(
          `SELECT ${columns} FROM public.driver_occurrence_types WHERE chave = $1 FOR UPDATE`,
          [key],
        )
        if (!found.rows[0]) throw notFound()
        const before = present(found.rows[0])
        if (before.active && !input.active) await this.assertAnotherActive(client, key)

        const updated = await client.query<Row>(
          `UPDATE public.driver_occurrence_types
              SET nome = $2, ativo = $3, exige_justificativa = $4, permite_anexos = $5, pede_atraso = $6, atualizado_por = $7
            WHERE chave = $1
            RETURNING ${columns}`,
          [key, input.label, input.active, input.requiresJustification, input.allowsAttachments, input.asksDelay, actor.userId],
        )
        const type = present(updated.rows[0])
        if (JSON.stringify(before) !== JSON.stringify(type)) await this.record(client, actor, before, type)
        return type
      })
    } catch (error) {
      throw this.duplicated(error)
    }
  }
}
