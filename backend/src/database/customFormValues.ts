import type { PoolClient } from 'pg'
import { defaultForms, validateCustomValues } from '../requests/formRules.js'
import type { ManagedForm, ManagedFormContent } from '../requests/formRules.js'
import { readPublishedConfig } from './configRepository.js'
import { ModuleError } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'

/**
 * Campos criados pelo Gerenciador de formulários nos formulários de leiaute fixo (13/11/2026).
 * Valida contra a versão publicada (ou o padrão) e grava valores e nomes junto do registro, para o
 * registro não mudar quando o formulário mudar depois. Coluna da migração 022.
 */

export type CustomFormResult = { values: Record<string, string>; labels: Record<string, string>; version: number | null }

export async function publishedFormContent(key: ManagedForm) {
  const published = await readPublishedConfig<ManagedFormContent>(getDatabasePool(), 'form', key)
  return { content: published?.content ?? defaultForms[key], version: published?.version ?? null }
}

export async function readCustomForm(key: ManagedForm, raw: unknown, { staff = true } = {}): Promise<CustomFormResult> {
  const { content, version } = await publishedFormContent(key)
  const { values, labels } = validateCustomValues(content, raw, { staff })
  return { values, labels, version }
}

const targets = {
  material_requests: 'campos_personalizados',
  material_requests_delivery: 'campos_entrega',
  demands: 'campos_personalizados',
  contract_instruments: 'campos_personalizados',
  vehicles: 'campos_personalizados',
  equipments: 'campos_personalizados',
  materials: 'campos_personalizados',
  fleet_drivers: 'campos_personalizados',
} as const

export type CustomFieldTarget = keyof typeof targets

async function columnExists(client: Pick<PoolClient, 'query'>, table: string, column: string) {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2) AS present`,
    [table, column],
  )
  return rows[0].present
}

/** Sem campo novo preenchido e sem formulário publicado, nada é gravado (funciona sem a 022). */
export async function saveCustomFields(
  target: CustomFieldTarget,
  id: string,
  result: CustomFormResult,
  client: Pick<PoolClient, 'query'> = getDatabasePool(),
) {
  const hasValues = Object.keys(result.values).length > 0
  if (!hasValues) return
  const table = target === 'material_requests_delivery' ? 'material_requests' : target
  const column = targets[target]
  if (!(await columnExists(client, table, column))) {
    throw new ModuleError('Os campos novos deste formulário dependem da migração 022, ainda não aplicada neste banco.', 409)
  }
  const stored = JSON.stringify({ values: result.values, labels: result.labels, version: result.version })
  await client.query(`UPDATE public.${table} SET ${column} = $2::jsonb WHERE id = $1`, [id, stored])
}

/**
 * Para tabelas cujo registro não muda depois de gravado (cotações, execuções e ocorrências): as
 * colunas extras entram no próprio INSERT. "next" é o número do próximo parâmetro.
 */
export async function customInsertColumns(
  client: Pick<PoolClient, 'query'>,
  table: 'flight_quotes' | 'maintenance_executions' | 'request_occurrences',
  result: CustomFormResult | undefined,
  next: number,
) {
  if (!result || Object.keys(result.values).length === 0) return { columns: '', placeholders: '', values: [] as unknown[] }
  if (!(await columnExists(client, table, 'campos_personalizados'))) {
    throw new ModuleError('Os campos novos deste formulário dependem da migração 022, ainda não aplicada neste banco.', 409)
  }
  return {
    columns: ', campos_personalizados, formulario_versao',
    placeholders: ', $' + next + '::jsonb, $' + (next + 1),
    values: [JSON.stringify({ values: result.values, labels: result.labels, version: result.version }), result.version] as unknown[],
  }
}

/** Valores para exibição: [{ nome, valor }], na ordem gravada. Sem nada, lista vazia. */
export function presentCustomFields(stored: unknown) {
  if (!stored || typeof stored !== 'object') return []
  const { values, labels } = stored as { values?: Record<string, string>; labels?: Record<string, string> }
  return Object.entries(values ?? {}).map(([id, value]) => ({ id, label: labels?.[id] ?? id, value }))
}
