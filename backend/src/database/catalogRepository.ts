import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import type { AuthAuditEventType } from './authAuditRepository.js'
import { conflict, notFound, ModuleError } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'
import { sortByName } from './naturalOrder.js'

export const catalogCategories = [
  'sectors',
  'floors',
  'serviceTypes',
  'warehouseCategories',
  'measurementUnits',
] as const

export type CatalogCategory = (typeof catalogCategories)[number]

export function isCatalogCategory(value: string): value is CatalogCategory {
  return (catalogCategories as readonly string[]).includes(value)
}

const databaseCategory: Record<Exclude<CatalogCategory, 'sectors'>, string> = {
  floors: 'floor',
  serviceTypes: 'service_type',
  warehouseCategories: 'warehouse_category',
  measurementUnits: 'measurement_unit',
}

export type CatalogOption = {
  id: string
  label: string
  acronym: string | null
  active: boolean
}

type OptionRow = {
  id: string
  categoria: string
  nome: string
  sigla: string | null
  ativo: boolean
}

function toOption(row: OptionRow): CatalogOption {
  return { id: row.id, label: row.nome, acronym: row.sigla, active: row.ativo }
}

const sectorColumns = `id::text AS id, 'sector' AS categoria, nome, sigla, ativo`
const optionColumns = `id::text AS id, categoria, nome, NULL::text AS sigla, ativo`

function emptyCatalog(): Record<CatalogCategory, CatalogOption[]> {
  return {
    sectors: [],
    floors: [],
    serviceTypes: [],
    warehouseCategories: [],
    measurementUnits: [],
  }
}

export type ResolvedOption = { id: string; name: string }

export class CatalogRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async list({ activeOnly }: { activeOnly: boolean }) {
    const pool = this.poolProvider()
    const filter = activeOnly ? 'WHERE ativo' : ''
    const [sectors, options] = await Promise.all([
      pool.query<OptionRow>(
        `SELECT ${sectorColumns} FROM public.setores ${filter} ORDER BY lower(nome)`,
      ),
      pool.query<OptionRow>(
        `SELECT ${optionColumns} FROM public.catalog_options ${filter} ORDER BY lower(nome)`,
      ),
    ])

    const catalog = emptyCatalog()
    // Ordem alfabética do português, igual em todos os formulários (o ORDER BY do banco
    // depende da configuração do servidor e põe nomes acentuados no fim).
    catalog.sectors = sortByName(sectors.rows, (row) => row.nome).map(toOption)
    for (const [category, stored] of Object.entries(databaseCategory)) {
      catalog[category as CatalogCategory] = sortByName(
        options.rows.filter((row) => row.categoria === stored),
        (row) => row.nome,
      ).map(toOption)
    }
    return catalog
  }

  async create(
    actor: AuthenticatedIdentity,
    category: CatalogCategory,
    input: { label: string; acronym: string | null },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      await assertMigrated(client)
      await assertNameAvailable(client, category, input.label)

      const result =
        category === 'sectors'
          ? await client.query<OptionRow>(
              `INSERT INTO public.setores (nome, sigla) VALUES ($1, $2)
               RETURNING ${sectorColumns}`,
              [input.label, input.acronym],
            )
          : await client.query<OptionRow>(
              `INSERT INTO public.catalog_options (categoria, nome) VALUES ($1, $2)
               RETURNING ${optionColumns}`,
              [databaseCategory[category], input.label],
            )

      const option = toOption(result.rows[0])
      await audit(client, actor, 'settings_created', category, option.id, { label: option.label })
      return option
    })
  }

  async update(
    actor: AuthenticatedIdentity,
    category: CatalogCategory,
    id: string,
    input: { label: string; acronym: string | null },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      await assertMigrated(client)
      const current = await lockOption(client, category, id)
      await assertNameAvailable(client, category, input.label, id)

      const result =
        category === 'sectors'
          ? await client.query<OptionRow>(
              `UPDATE public.setores SET nome = $2, sigla = $3 WHERE id = $1
               RETURNING ${sectorColumns}`,
              [id, input.label, input.acronym],
            )
          : await client.query<OptionRow>(
              `UPDATE public.catalog_options SET nome = $2 WHERE id = $1
               RETURNING ${optionColumns}`,
              [id, input.label],
            )

      const option = toOption(result.rows[0])
      await audit(client, actor, 'settings_updated', category, id, {
        from: current.nome,
        to: option.label,
      })
      return option
    })
  }

  /** Só muda a disponibilidade: os registros antigos guardam o nome usado e não mudam. */
  async setActive(
    actor: AuthenticatedIdentity,
    category: CatalogCategory,
    id: string,
    active: boolean,
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      await assertMigrated(client)
      const current = await lockOption(client, category, id)

      if (active && !current.ativo) {
        await assertNameAvailable(client, category, current.nome, id)
      }

      const table = category === 'sectors' ? 'setores' : 'catalog_options'
      const columns = category === 'sectors' ? sectorColumns : optionColumns
      const result = await client.query<OptionRow>(
        `UPDATE public.${table} SET ativo = $2 WHERE id = $1 RETURNING ${columns}`,
        [id, active],
      )

      if (current.ativo !== active) {
        await audit(
          client,
          actor,
          active ? 'settings_activated' : 'settings_deactivated',
          category,
          id,
          { label: current.nome },
        )
      }
      return toOption(result.rows[0])
    })
  }
}

/**
 * Setores existem desde antes da 005. Sem ela, nenhuma gravação de configuração acontece,
 * para o comportamento ser o mesmo em todas as listas.
 */
async function assertMigrated(client: PoolClient) {
  await client.query('SELECT 1 FROM public.catalog_options LIMIT 0')
}

async function audit(
  client: PoolClient,
  actor: AuthenticatedIdentity,
  eventType: AuthAuditEventType,
  category: CatalogCategory,
  id: string,
  details: Record<string, string>,
) {
  await insertAuthAuditEvent(client, {
    actorUserId: actor.userId,
    actorKind: 'user',
    subjectUserId: null,
    sessionId: id,
    eventType,
    details: { category, ...details },
  })
}

async function lockOption(client: PoolClient, category: CatalogCategory, id: string) {
  const result =
    category === 'sectors'
      ? await client.query<OptionRow>(
          `SELECT ${sectorColumns} FROM public.setores WHERE id = $1 FOR UPDATE`,
          [id],
        )
      : await client.query<OptionRow>(
          `SELECT ${optionColumns} FROM public.catalog_options
            WHERE id = $1 AND categoria = $2 FOR UPDATE`,
          [id, databaseCategory[category]],
        )
  const row = result.rows[0]
  if (!row) throw notFound()
  return row
}

async function assertNameAvailable(
  client: PoolClient,
  category: CatalogCategory,
  label: string,
  exceptId?: string,
) {
  const parameters = exceptId ? [label, exceptId] : [label]
  const excluding = exceptId ? 'AND id <> $2' : ''
  const result =
    category === 'sectors'
      ? await client.query(
          `SELECT 1 FROM public.setores
            WHERE lower(trim(nome)) = lower(trim($1)) ${excluding}`,
          parameters,
        )
      : await client.query(
          `SELECT 1 FROM public.catalog_options
            WHERE categoria = '${databaseCategory[category]}'
              AND lower(trim(nome)) = lower(trim($1)) ${excluding}`,
          parameters,
        )
  if (result.rows.length > 0) {
    throw conflict('Já existe um cadastro com esse nome nesta lista.')
  }
}

/** Opção ativa, para uso em um novo registro. Opção desativada não é aceita. */
export async function requireActiveOption(
  client: Pick<PoolClient, 'query'>,
  category: Exclude<CatalogCategory, 'sectors'>,
  id: string,
  label: string,
): Promise<ResolvedOption> {
  const result = await client.query<{ id: string; nome: string }>(
    `SELECT id::text AS id, nome FROM public.catalog_options
      WHERE id = $1 AND categoria = $2 AND ativo`,
    [id, databaseCategory[category]],
  )
  const row = result.rows[0]
  if (!row) throw new ModuleError(`${label} indisponível. Selecione outra opção.`, 400)
  return { id: row.id, name: row.nome }
}

export async function requireActiveSector(
  client: Pick<PoolClient, 'query'>,
  id: string,
): Promise<ResolvedOption> {
  const result = await client.query<{ id: string; nome: string }>(
    `SELECT id::text AS id, nome FROM public.setores WHERE id = $1 AND ativo`,
    [id],
  )
  const row = result.rows[0]
  if (!row) throw new ModuleError('Setor indisponível. Selecione outra opção.', 400)
  return { id: row.id, name: row.nome }
}

/** Liga o texto do setor da conta ao cadastro de setores, quando houver correspondência. */
export async function findSectorIdByName(
  client: Pick<PoolClient, 'query'>,
  name: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM public.setores WHERE lower(trim(nome)) = lower(trim($1))`,
    [name],
  )
  return result.rows[0]?.id ?? null
}
