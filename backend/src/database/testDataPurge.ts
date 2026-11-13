import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { ModuleError } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'

/**
 * Limpeza dos dados de teste (13/11/2026, pedido da responsável), só para o Administrador.
 *
 * O histórico do sistema é permanente: dezenas de gatilhos recusam apagar solicitações, históricos,
 * movimentações e anexos. Esta operação é a única exceção, e funciona assim:
 *   1. Monta, numa transação, a lista exata do que será apagado em cada tabela.
 *   2. A pessoa baixa a cópia (JSON) de tudo isso. A cópia tem uma impressão digital (hash).
 *   3. Para apagar, a pessoa reenvia a impressão e digita a frase de confirmação. Se os dados mudaram
 *      desde a cópia, nada é apagado.
 *   4. Na mesma transação: desliga só os gatilhos de proteção das tabelas tocadas, apaga na ordem
 *      dos vínculos, religa os gatilhos e recalcula a numeração dos protocolos (volta a 00001 quando
 *      não sobra nenhum, e nunca repete um número que sobrou). Qualquer erro desfaz tudo.
 * A auditoria (auth_audit_events) nunca é apagada: registra quem limpou, quando e quantos registros.
 * Os arquivos anexados saem do armazenamento depois da gravação.
 */

export const purgeGroups = [
  'maintenance', 'fleet', 'flights', 'warehouse_requests', 'warehouse_stock', 'demands', 'patrimony',
] as const
export type PurgeGroup = (typeof purgeGroups)[number]

export const purgeGroupLabels: Record<PurgeGroup, string> = {
  maintenance: 'Manutenção: solicitações',
  fleet: 'Frota: solicitações e viagens',
  flights: 'Passagens aéreas: solicitações',
  warehouse_requests: 'Almoxarifado: pedidos de materiais',
  warehouse_stock: 'Almoxarifado: estoque, movimentações, inventários e controle interno (os saldos voltam a zero; o cadastro de materiais fica)',
  demands: 'Controle de Demandas: demandas e recorrências (atas e contratos ficam)',
  patrimony: 'Patrimônio: bens, histórico e conferências',
}

export function isPurgeGroup(value: unknown): value is PurgeGroup {
  return typeof value === 'string' && (purgeGroups as readonly string[]).includes(value)
}

/**
 * Onde a API está ligada, pelo banco que ela de fato usa (a conexão do pool). Muda a frase de
 * confirmação. Na dúvida, vale "principal", que pede a frase mais forte.
 */
export function databaseEnvironment(pool: Pool = getDatabasePool()) {
  const options = (pool as unknown as { options?: { connectionString?: string; host?: string; user?: string } }).options ?? {}
  let host = options.host ?? ''
  let user = options.user ?? ''
  try {
    if (options.connectionString) {
      const url = new URL(options.connectionString)
      host = url.hostname
      user = decodeURIComponent(url.username)
    }
  } catch {
    return 'principal' as const
  }
  if (/^(localhost|127\.|::1$|\[::1\])/.test(host)) return 'local' as const
  if (user.endsWith('.rrqulhpnghoetgrdswqr') || host.includes('rrqulhpnghoetgrdswqr')) return 'homologacao' as const
  return 'principal' as const
}

export const confirmationPhrases = {
  local: 'APAGAR DADOS DE TESTE',
  homologacao: 'APAGAR DADOS DE TESTE',
  principal: 'APAGAR DADOS DO BANCO PRINCIPAL',
} as const

type Client = Pick<PoolClient, 'query'>

/** Uma tabela do plano: o filtro do que sai, ou a coluna que só perde o vínculo. */
type Step =
  | { table: string; where: string; action: 'delete'; core?: boolean }
  | { table: string; where: string; action: 'unlink'; column: string }

const serviceTypes: Partial<Record<PurgeGroup, string>> = { maintenance: 'manutencao', fleet: 'frota', flights: 'passagem' }

/** Funções de gatilho que protegem o histórico. Só elas são desligadas, e só durante a limpeza. */
const protectiveFunctions = [
  'reject_history_change', 'reject_integration_record_change', 'protect_flight_quote', 'protect_manual_email',
  'protect_attachment_record', 'protect_request_return',
]

async function tableExists(client: Client, table: string) {
  const { rows } = await client.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`])
  return rows[0].ok
}

async function columnExists(client: Client, table: string, column: string) {
  const { rowCount } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  )
  return Boolean(rowCount)
}

/**
 * Preenche as listas temporárias de identificadores (apagadas no fim da transação) e devolve as
 * etapas, na ordem em que podem ser apagadas sem ferir nenhum vínculo.
 */
async function prepare(client: Client, groups: ReadonlySet<PurgeGroup>): Promise<Step[]> {
  const has = (table: string) => tableExists(client, table)
  const temp = async (name: string, select: string, parameters: unknown[] = []) => {
    await client.query(`CREATE TEMP TABLE ${name} (id uuid PRIMARY KEY) ON COMMIT DROP`)
    if (select) await client.query(`INSERT INTO ${name} ${select} ON CONFLICT DO NOTHING`, parameters)
  }
  const types = Object.entries(serviceTypes).filter(([group]) => groups.has(group as PurgeGroup)).map(([, type]) => type)

  await temp('purge_sr', types.length ? `SELECT id FROM public.service_requests WHERE tipo = ANY($1::text[])` : '', types.length ? [types] : [])
  await temp('purge_mr', groups.has('warehouse_requests') ? `SELECT id FROM public.material_requests` : '')
  await temp('purge_dm', groups.has('demands') && (await has('demands')) ? `SELECT id FROM public.demands` : '')
  await temp('purge_ds', groups.has('demands') && (await has('demand_series')) ? `SELECT id FROM public.demand_series` : '')
  await temp('purge_ic', groups.has('warehouse_stock') ? `SELECT id FROM public.inventory_checks` : '')
  await temp('purge_resources', `SELECT id FROM purge_sr UNION SELECT id FROM purge_mr UNION SELECT id FROM purge_dm UNION SELECT id FROM purge_ic`)

  const integrations = await has('integration_events')
  await temp('purge_ev', integrations ? `SELECT id FROM public.integration_events WHERE resource_id IN (SELECT id FROM purge_resources)` : '')
  await temp('purge_ed', integrations ? `SELECT id FROM public.email_deliveries WHERE event_id IN (SELECT id FROM purge_ev)` : '')
  await temp('purge_cal', (await has('calendar_sync_items')) ? `SELECT id FROM public.calendar_sync_items WHERE request_id IN (SELECT id FROM purge_sr)` : '')
  const manualEmails = await has('manual_emails')
  await temp(
    'purge_me',
    manualEmails
      ? `SELECT id FROM (
           WITH RECURSIVE chain AS (
             SELECT id FROM public.manual_emails
              WHERE request_id IN (SELECT id FROM purge_sr) OR material_request_id IN (SELECT id FROM purge_mr)
             UNION SELECT m.id FROM public.manual_emails m JOIN chain c ON m.reenvio_de = c.id
           ) SELECT id FROM chain) AS emails`
      : '',
  )
  const attachments = await has('request_attachments')
  await temp(
    'purge_att',
    attachments
      ? `SELECT id FROM public.request_attachments WHERE request_id IN (SELECT id FROM purge_sr) OR material_request_id IN (SELECT id FROM purge_mr)`
      : '',
  )
  await temp('purge_occ', (await has('request_occurrences')) ? `SELECT id FROM public.request_occurrences WHERE request_id IN (SELECT id FROM purge_sr)` : '')

  const steps: Step[] = [
    { table: 'integration_attempts', where: `item_id IN (SELECT id FROM purge_ed UNION SELECT id FROM purge_cal)`, action: 'delete' },
    { table: 'user_notifications', where: `event_id IN (SELECT id FROM purge_ev)`, action: 'delete' },
    { table: 'email_deliveries', where: `id IN (SELECT id FROM purge_ed)`, action: 'delete' },
    { table: 'integration_events', where: `id IN (SELECT id FROM purge_ev)`, action: 'delete' },
    { table: 'calendar_sync_items', where: `id IN (SELECT id FROM purge_cal)`, action: 'delete' },
    { table: 'manual_email_attachments', where: `email_id IN (SELECT id FROM purge_me) OR attachment_id IN (SELECT id FROM purge_att)`, action: 'delete' },
    { table: 'manual_emails', where: `id IN (SELECT id FROM purge_me)`, action: 'unlink', column: 'reenvio_de' },
    // A situação do e-mail manual muda com o envio: fora da impressão digital, como as filas.
    { table: 'manual_emails', where: `id IN (SELECT id FROM purge_me)`, action: 'delete' },
    { table: 'request_occurrence_attachments', where: `occurrence_id IN (SELECT id FROM purge_occ) OR attachment_id IN (SELECT id FROM purge_att)`, action: 'delete' },
    { table: 'request_occurrences', where: `id IN (SELECT id FROM purge_occ)`, action: 'delete', core: true },
    { table: 'request_attachments', where: `id IN (SELECT id FROM purge_att)`, action: 'delete', core: true },
    // Vínculos informativos de demandas que ficam com solicitações que saem.
    { table: 'demand_links', where: `recurso_id IN (SELECT id FROM purge_sr UNION SELECT id FROM purge_mr) OR demand_id IN (SELECT id FROM purge_dm)`, action: 'delete', core: true },
  ]
  for (const table of [
    'fleet_execution_corrections', 'flight_quotes', 'flight_request_passengers', 'maintenance_executions', 'request_history',
    'request_internal_notes', 'request_returns', 'vehicle_logs',
  ]) {
    steps.push({ table, where: `request_id IN (SELECT id FROM purge_sr)`, action: 'delete', core: true })
  }
  steps.push({ table: 'service_requests', where: `id IN (SELECT id FROM purge_sr)`, action: 'delete', core: true })

  if (groups.has('warehouse_stock')) {
    steps.push(
      { table: 'contract_instrument_usages', where: `stock_movement_id IS NOT NULL`, action: 'delete', core: true },
      { table: 'stock_movements', where: `true`, action: 'delete', core: true },
      { table: 'material_value_adjustments', where: `true`, action: 'delete', core: true },
      { table: 'inventory_check_items', where: `check_id IN (SELECT id FROM purge_ic)`, action: 'delete', core: true },
      { table: 'inventory_checks', where: `id IN (SELECT id FROM purge_ic)`, action: 'delete', core: true },
      { table: 'warehouse_control_records', where: `true`, action: 'delete', core: true },
    )
  } else {
    // As movimentações de estoque ficam (o saldo continua batendo), só sem o pedido que sai.
    steps.push({ table: 'stock_movements', where: `material_request_id IN (SELECT id FROM purge_mr)`, action: 'unlink', column: 'material_request_id' })
  }
  for (const table of ['material_delivery_history', 'material_item_changes', 'material_request_history', 'material_request_items']) {
    steps.push({ table, where: `material_request_id IN (SELECT id FROM purge_mr)`, action: 'delete', core: true })
  }
  steps.push({ table: 'material_requests', where: `id IN (SELECT id FROM purge_mr)`, action: 'delete', core: true })

  if (groups.has('demands')) {
    steps.push(
      { table: 'contract_instruments', where: `renovacao_demanda_id IN (SELECT id FROM purge_dm)`, action: 'unlink', column: 'renovacao_demanda_id' },
      { table: 'contract_instrument_usages', where: `demanda_id IN (SELECT id FROM purge_dm)`, action: 'unlink', column: 'demanda_id' },
    )
    for (const table of [
      'demand_attachments', 'demand_agenda_events', 'demand_comments', 'demand_history', 'demand_participants',
      'demand_sector_links', 'demand_series_occurrences',
    ]) {
      steps.push({ table, where: `demand_id IN (SELECT id FROM purge_dm)${table === 'demand_history' || table === 'demand_series_occurrences' ? ' OR series_id IN (SELECT id FROM purge_ds)' : ''}`, action: 'delete', core: true })
    }
    steps.push(
      { table: 'demand_subtasks', where: `demand_id IN (SELECT id FROM purge_dm)`, action: 'delete', core: true },
      { table: 'demands', where: `id IN (SELECT id FROM purge_dm)`, action: 'delete', core: true },
      { table: 'demand_series', where: `id IN (SELECT id FROM purge_ds)`, action: 'delete', core: true },
    )
  }
  if (groups.has('patrimony')) {
    for (const table of ['patrimony_check_reads', 'patrimony_checks', 'patrimony_movements', 'patrimony_assets']) {
      steps.push({ table, where: `true`, action: 'delete', core: true })
    }
  }

  // Sem a tabela ou a coluna (banco com migração faltando), a etapa simplesmente não existe.
  const present: Step[] = []
  for (const step of steps) {
    if (!(await has(step.table))) continue
    if (step.action === 'unlink' && !(await columnExists(client, step.table, step.column))) continue
    if (/renovacao_demanda_id|demanda_id|stock_movement_id|series_id|recurso_id/.test(step.where)) {
      const columns = [...step.where.matchAll(/\b(renovacao_demanda_id|demanda_id|stock_movement_id|series_id|recurso_id)\b/g)].map((match) => match[1])
      let ok = true
      for (const column of columns) if (!(await columnExists(client, step.table, column))) ok = false
      if (!ok) continue
    }
    present.push(step)
  }
  return present
}

type Snapshot = { tables: Record<string, unknown[]>; counts: Record<string, number>; fingerprint: string; storageKeys: string[] }

/** Todas as linhas que sairão, em ordem estável, e a impressão digital das tabelas principais. */
async function snapshot(client: Client, steps: readonly Step[]): Promise<Snapshot> {
  const tables: Record<string, unknown[]> = {}
  const counts: Record<string, number> = {}
  const hash = createHash('sha256')
  for (const step of steps) {
    if (step.action !== 'delete') continue
    const { rows } = await client.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM public.${step.table} t WHERE ${step.where} ORDER BY md5(to_jsonb(t)::text)`,
    )
    if (rows.length === 0) continue
    tables[step.table] = [...(tables[step.table] ?? []), ...rows.map((row) => row.row)]
    counts[step.table] = (counts[step.table] ?? 0) + rows.length
    // As filas de e-mail e notificações mudam sozinhas (tentativas, leitura): ficam fora da impressão.
    if (step.core) hash.update(`${step.table}:${JSON.stringify(rows.map((row) => row.row))}`)
  }
  const storageKeys = [
    ...((tables.request_attachments ?? []) as { storage_key?: string }[]),
    ...((tables.demand_attachments ?? []) as { storage_key?: string }[]),
  ].map((row) => row.storage_key).filter((key): key is string => Boolean(key))
  return { tables, counts, fingerprint: hash.digest('hex'), storageKeys }
}

async function protectiveTriggers(client: Client, tables: readonly string[]) {
  const { rows } = await client.query<{ tabela: string; gatilho: string }>(
    `SELECT c.relname AS tabela, t.tgname AS gatilho
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = 'public' AND NOT t.tgisinternal AND c.relname = ANY($1::text[]) AND p.proname = ANY($2::text[])`,
    [[...new Set(tables)].filter((table) => table !== 'auth_audit_events'), protectiveFunctions],
  )
  return rows
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`

/** Recalcula cada contador pelo maior número que sobrou: sem nenhum, volta a 00001; nunca repete. */
async function recalculateCounters(client: Client) {
  if (!(await tableExists(client, 'protocol_counters'))) return []
  const sources: string[] = []
  for (const [table, column] of [
    ['service_requests', 'protocolo_codigo'], ['material_requests', 'protocolo_codigo'], ['inventory_checks', 'protocolo_codigo'], ['demands', 'numero'],
  ] as const) {
    if (await columnExists(client, table, column)) sources.push(`SELECT ${column} AS codigo FROM public.${table}`)
  }
  const { rows } = await client.query<{ prefixo: string; ano: number; ultimo: number; maximo: number | null }>(
    `SELECT c.prefixo, c.ano, c.ultimo,
            (SELECT max(substring(s.codigo FROM '([0-9]+)$')::int) FROM (${sources.join(' UNION ALL ')}) s
              WHERE s.codigo LIKE c.prefixo || '-' || c.ano || '-%') AS maximo
       FROM public.protocol_counters c`,
  )
  const changes: { prefix: string; year: number; from: number; to: number }[] = []
  for (const row of rows) {
    if (row.maximo === null) {
      await client.query(`DELETE FROM public.protocol_counters WHERE prefixo = $1 AND ano = $2`, [row.prefixo, row.ano])
      changes.push({ prefix: row.prefixo, year: row.ano, from: row.ultimo, to: 0 })
    } else if (row.maximo < row.ultimo) {
      await client.query(`UPDATE public.protocol_counters SET ultimo = $3 WHERE prefixo = $1 AND ano = $2`, [row.prefixo, row.ano, row.maximo])
      changes.push({ prefix: row.prefixo, year: row.ano, from: row.ultimo, to: row.maximo })
    }
  }
  // Número antigo (anterior à migração 007): recomeça só com a tabela vazia.
  for (const table of ['service_requests', 'material_requests']) {
    const { rows: empty } = await client.query<{ vazio: boolean }>(`SELECT NOT EXISTS (SELECT 1 FROM public.${table}) AS vazio`)
    if (empty[0].vazio) await client.query(`ALTER TABLE public.${table} ALTER COLUMN protocolo RESTART WITH 1`)
  }
  return changes
}

export class TestDataPurge {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  /** Prévia e cópia: as listas temporárias exigem escrita, mas a transação é sempre desfeita. */
  private async inRolledBack<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await this.poolProvider().connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      return await work(client)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  }

  /** Quantos registros sairiam de cada tabela, sem baixar o conteúdo. */
  async preview(groups: ReadonlySet<PurgeGroup>) {
    return this.inRolledBack(async (client) => {
      const steps = await prepare(client, groups)
      const { counts, fingerprint, storageKeys } = await snapshot(client, steps)
      return { counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0), fingerprint, files: storageKeys.length }
    })
  }

  /** A cópia completa, em JSON, com a impressão digital que autoriza a limpeza. */
  async exportCopy(groups: ReadonlySet<PurgeGroup>) {
    return this.inRolledBack(async (client) => {
      const steps = await prepare(client, groups)
      const { tables, counts, fingerprint } = await snapshot(client, steps)
      return {
        format: 'slm-limpeza-de-teste-v1',
        generatedAt: new Date().toISOString(),
        database: databaseEnvironment(this.poolProvider()),
        groups: [...groups],
        fingerprint,
        counts,
        tables,
      }
    })
  }

  async purge(
    actor: AuthenticatedIdentity,
    input: { groups: ReadonlySet<PurgeGroup>; fingerprint: string; confirmation: string },
    removeFile: ((key: string) => Promise<void>) | null,
  ) {
    const environment = databaseEnvironment(this.poolProvider())
    if (input.confirmation.trim() !== confirmationPhrases[environment]) {
      throw new ModuleError(`Digite exatamente: ${confirmationPhrases[environment]}`, 400)
    }
    const client = await this.poolProvider().connect()
    let storageKeys: string[] = []
    let result: { counts: Record<string, number>; total: number; counters: Awaited<ReturnType<typeof recalculateCounters>> }
    try {
      await client.query('BEGIN')
      // Uma limpeza por vez; e nada de novo entra nas tabelas tocadas até o fim.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('slm:test-data-purge'))`)
      const steps = await prepare(client, input.groups)
      const tables = [...new Set(steps.map((step) => step.table))]
      for (const table of tables) await client.query(`LOCK TABLE public.${quote(table)} IN SHARE ROW EXCLUSIVE MODE`)
      const copy = await snapshot(client, steps)
      if (copy.fingerprint !== input.fingerprint) {
        throw new ModuleError('Os dados mudaram depois da cópia. Baixe a cópia de novo e repita a limpeza.', 409, 'COPY_OUTDATED')
      }
      storageKeys = copy.storageKeys
      const triggers = await protectiveTriggers(client, tables)
      for (const trigger of triggers) {
        await client.query(`ALTER TABLE public.${quote(trigger.tabela)} DISABLE TRIGGER ${quote(trigger.gatilho)}`)
      }
      for (const step of steps) {
        if (step.action === 'unlink') {
          await client.query(`UPDATE public.${quote(step.table)} SET ${quote(step.column)} = NULL WHERE ${step.where}`)
        } else {
          await client.query(`DELETE FROM public.${quote(step.table)} WHERE ${step.where}`)
        }
      }
      if (input.groups.has('warehouse_stock') && (await tableExists(client, 'materials'))) {
        const sets = ['estoque_atual = 0']
        if (await columnExists(client, 'materials', 'valor_estoque')) sets.push('valor_estoque = 0')
        if (await columnExists(client, 'materials', 'quantidade_reservada')) sets.push('quantidade_reservada = 0')
        await client.query(`UPDATE public.materials SET ${sets.join(', ')}`)
      }
      for (const trigger of triggers) {
        await client.query(`ALTER TABLE public.${quote(trigger.tabela)} ENABLE TRIGGER ${quote(trigger.gatilho)}`)
      }
      const counters = await recalculateCounters(client)
      result = { counts: copy.counts, total: Object.values(copy.counts).reduce((sum, value) => sum + value, 0), counters }
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: null,
        sessionId: actor.userId,
        eventType: 'test_data_purged',
        details: {
          groups: [...input.groups],
          total: String(result.total),
          database: environment,
          fingerprint: input.fingerprint.slice(0, 16),
        },
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      if (error instanceof ModuleError) throw error
      const code = (error as { code?: string }).code
      if (code === '42501') throw new ModuleError('O usuário do banco não tem permissão para esta limpeza. Nada foi apagado.', 409)
      throw error
    } finally {
      client.release()
    }
    // Arquivos: depois da gravação. Uma falha aqui não traz os registros de volta; só fica contada.
    let filesRemoved = 0
    let filesFailed = 0
    if (removeFile) {
      for (const key of storageKeys) {
        try {
          await removeFile(key)
          filesRemoved += 1
        } catch {
          filesFailed += 1
        }
      }
    }
    return { ...result, filesRemoved, filesFailed: removeFile ? filesFailed : storageKeys.length }
  }
}
