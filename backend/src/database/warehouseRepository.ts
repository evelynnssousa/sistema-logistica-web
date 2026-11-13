import { presentCustomFields } from './customFormValues.js'
import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { warehouseEventFor } from '../integrations/catalog.js'
import { publishIntegrationEvent } from '../integrations/publisher.js'
import { redactOptional } from '../integrations/redaction.js'
import { deliveryStatusOf, todayInSaoPaulo } from '../requests/deliveryRules.js'
import { likePattern } from '../requests/validation.js'
import {
  canMoveWarehouseStatus,
  inventoryItemSituation,
  warehouseStatusMatchesItems,
} from '../requests/workflow.js'
import type { WarehouseStatus } from '../requests/workflow.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import type { AuthAuditEventType } from './authAuditRepository.js'
import {
  findSectorIdByName,
  requireActiveOption,
  requireActiveSector,
} from './catalogRepository.js'
import { conflict, ModuleError, notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { optionalColumnSql, protocolSql } from './protocolSql.js'
import { readSystemSettings } from './settingsRepository.js'
import { debitDelivery } from './warehouseFinanceRepository.js'
import { withTransaction } from './withTransaction.js'
import { otherReasonKey } from '../requests/justificationRules.js'

/**
 * O JUCESP não se comunica com o sistema governamental. Pedidos de origem "governamental"
 * são cópias digitadas aqui, e editá-las nunca altera o pedido original.
 */

const pageSize = 25

type Actor = AuthenticatedIdentity

async function audit(
  client: Pick<PoolClient, 'query'>,
  actor: Actor,
  eventType: AuthAuditEventType,
  resourceId: string,
  details: Record<string, string | readonly string[]>,
) {
  await insertAuthAuditEvent(client, {
    actorUserId: actor.userId,
    actorKind: 'user',
    subjectUserId: null,
    sessionId: resourceId,
    eventType,
    details,
  })
}

async function recordHistory(
  client: Pick<PoolClient, 'query'>,
  input: {
    requestId: string
    userId: string
    action: string
    from: string | null
    to: string | null
    comment?: string | null
    details?: Record<string, unknown>
  },
) {
  await client.query(
    `INSERT INTO public.material_request_history
      (material_request_id, usuario_id, acao, status_anterior, status_novo, comentario, detalhes)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.requestId,
      input.userId,
      input.action,
      input.from,
      input.to,
      redactOptional(input.comment ?? null),
      JSON.stringify(input.details ?? {}),
    ],
  )
}

export type MaterialInput = {
  code: string | null
  name: string
  description: string | null
  unitId: string
  categoryId: string | null
  active: boolean
}

export type ItemInput = {
  materialId: string
  requested: number
  fulfilled: number
  /** Motivo de disponibilizar menos que o solicitado, e observação interna. */
  reasonCode?: string | null
  note?: string | null
}

async function decisionSchemaExists(client: Pick<PoolClient, 'query'>) {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('public.material_item_changes') IS NOT NULL AS exists`,
  )
  return result.rows[0].exists
}

async function loadActiveMaterials(
  client: Pick<PoolClient, 'query'>,
  materialIds: readonly string[],
) {
  const result = await client.query<{ id: string; nome: string; unidade: string }>(
    `SELECT id::text AS id, nome, unidade FROM public.materials
      WHERE id = ANY($1::uuid[]) AND ativo`,
    [materialIds],
  )
  const byId = new Map(result.rows.map((row) => [row.id, row]))
  for (const id of materialIds) {
    if (!byId.has(id)) {
      throw new ModuleError('Há um material inexistente ou inativo no pedido.', 400)
    }
  }
  return byId
}

function assertItems(items: readonly ItemInput[]) {
  if (items.length === 0) throw new ModuleError('Inclua ao menos um item.', 400)
  if (new Set(items.map((item) => item.materialId)).size !== items.length) {
    throw new ModuleError('O mesmo material foi incluído mais de uma vez.', 400)
  }
  if (items.some((item) => item.fulfilled > item.requested)) {
    throw new ModuleError('A quantidade atendida não pode superar a solicitada.', 400)
  }
}

async function insertItems(
  client: Pick<PoolClient, 'query'>,
  requestId: string,
  items: readonly ItemInput[],
  materials: Map<string, { nome: string; unidade: string }>,
) {
  for (const item of items) {
    const material = materials.get(item.materialId)!
    await client.query(
      `INSERT INTO public.material_request_items
        (material_request_id, material_id, material_nome, unidade,
         quantidade_solicitada, quantidade_atendida)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [requestId, item.materialId, material.nome, material.unidade, item.requested, item.fulfilled],
    )
  }
}

type RequestRow = {
  id: string
  protocolo: string
  status: WarehouseStatus
  origem: 'interna' | 'governamental'
  referencia_externa: string | null
  solicitante_externo: string | null
  solicitante_id: string
  solicitante_nome: string
  registrado_por_nome: string | null
  setor_nome: string | null
  observacao: string | null
  atendido_por_nome: string | null
  atendido_em: Date | null
  entregue_em: Date | null
  entregue_por_nome: string | null
  recebido_por: string | null
  previsao_entrega: string | null
  previsao_revisao: string | null
  solicitante_email: string | null
  total_itens: number
  created_at: Date
  updated_at: Date
  campos_personalizados: unknown
  campos_entrega: unknown
}

const requestSelect = `
  SELECT r.id::text AS id, ${protocolSql('r')} AS protocolo, r.status, r.origem,
         r.referencia_externa, r.solicitante_externo,
         r.solicitante_id::text AS solicitante_id,
         solicitante.full_name AS solicitante_nome,
         registrou.full_name AS registrado_por_nome,
         r.setor_nome, r.observacao,
         atendeu.full_name AS atendido_por_nome, r.atendido_em,
         r.entregue_em, entregou.full_name AS entregue_por_nome, r.recebido_por,
         ${optionalColumnSql('r', 'previsao_entrega')} AS previsao_entrega,
         ${optionalColumnSql('r', 'previsao_revisao')} AS previsao_revisao,
         ${optionalColumnSql('r', 'solicitante_email')} AS solicitante_email,
         (SELECT count(*)::int FROM public.material_request_items i
           WHERE i.material_request_id = r.id) AS total_itens,
         r.created_at, r.updated_at,
         to_jsonb(r)->'campos_personalizados' AS campos_personalizados,
         to_jsonb(r)->'campos_entrega' AS campos_entrega
    FROM public.material_requests r
    JOIN public.auth_users solicitante ON solicitante.id = r.solicitante_id
    LEFT JOIN public.auth_users registrou ON registrou.id = r.registrado_por
    LEFT JOIN public.auth_users atendeu ON atendeu.id = r.atendido_por
    LEFT JOIN public.auth_users entregou ON entregou.id = r.entregue_por`

function toRequest(row: RequestRow) {
  const forecastRevision = Number(row.previsao_revisao ?? 0)
  return {
    id: row.id,
    protocol: row.protocolo,
    status: row.status,
    origin: row.origem,
    externalReference: row.referencia_externa,
    externalRequester: row.solicitante_externo,
    externalRequesterEmail: row.solicitante_email,
    requesterId: row.solicitante_id,
    requester: row.solicitante_nome,
    registeredBy: row.registrado_por_nome,
    sector: row.setor_nome,
    note: row.observacao,
    attendedBy: row.atendido_por_nome,
    attendedAt: row.atendido_em,
    deliveredAt: row.entregue_em,
    deliveredBy: row.entregue_por_nome,
    receivedBy: row.recebido_por,
    deliveryForecast: row.previsao_entrega,
    deliveryStatus: deliveryStatusOf({ status: row.status, forecastRevision }),
    itemCount: row.total_itens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Campos novos do Gerenciador de formulários (022): do pedido e, internos, da entrega.
    customFields: presentCustomFields(row.campos_personalizados),
    deliveryFields: presentCustomFields(row.campos_entrega),
  }
}

const openStatuses = ['pendente', 'em_analise', 'atendido_parcial', 'atendido']

/** Conta aprovada dona do e-mail informado em um pedido digitado. Nula em um banco sem a 011. */
const identifiedRequesterSql = (alias: string, userParameter: string) => `(
  ${alias}.origem = 'governamental'
  AND lower(${optionalColumnSql(alias, 'solicitante_email')}) = (
    SELECT lower(u.email) FROM public.auth_users u
     WHERE u.id = ${userParameter} AND u.status = 'approved'
  )
)`

async function deliveryHistoryExists(client: Pick<PoolClient, 'query'>) {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('public.material_delivery_history') IS NOT NULL AS exists`,
  )
  return result.rows[0].exists
}

type DeliveryHistoryEntry = {
  requestId: string
  action: 'previsao_informada' | 'previsao_alterada' | 'entrega_registrada'
  previousForecast?: string | null
  newForecast?: string | null
  effectiveDate?: string | null
  comment?: string | null
  userId: string
}

async function recordDeliveryHistory(client: Pick<PoolClient, 'query'>, entry: DeliveryHistoryEntry) {
  await client.query(
    `INSERT INTO public.material_delivery_history
      (material_request_id, acao, previsao_anterior, previsao_nova, entrega_efetiva, comentario, usuario_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.requestId,
      entry.action,
      entry.previousForecast ?? null,
      entry.newForecast ?? null,
      entry.effectiveDate ?? null,
      redactOptional(entry.comment ?? null),
      entry.userId,
    ],
  )
}

export class WarehouseRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  // -------------------------------------------------------------------------
  // Catálogo de materiais
  // -------------------------------------------------------------------------
  /** Localização do material (022). Sem a migração, só aceita deixar em branco. */
  async setMaterialLocation(id: string, location: string | null) {
    const pool = this.poolProvider()
    const { rows } = await pool.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                       AND table_name = 'materials' AND column_name = 'localizacao') AS present`,
    )
    if (!rows[0].present) {
      if (location) throw new ModuleError('A localização do material depende da migração 022, ainda não aplicada neste banco.', 409)
      return
    }
    await pool.query(`UPDATE public.materials SET localizacao = $2 WHERE id = $1`, [id, location])
  }

  async listMaterials(filters: {
    search?: string
    includeInactive: boolean
    withCustom?: boolean
  }) {
    const parameters: unknown[] = []
    const conditions: string[] = []
    if (!filters.includeInactive) conditions.push('ativo')
    if (filters.search) {
      parameters.push(likePattern(filters.search))
      conditions.push(`(nome ILIKE $1 OR codigo ILIKE $1)`)
    }

    const result = await this.poolProvider().query<{
      id: string
      codigo: string | null
      nome: string
      descricao: string | null
      unidade: string
      categoria_id: string | null
      categoria_nome: string | null
      ativo: boolean
    }>(
      `SELECT id::text AS id, codigo, nome, descricao, unidade,
              categoria_id::text AS categoria_id, categoria_nome, ativo,
              to_jsonb(materials)->'campos_personalizados' AS campos_personalizados,
              to_jsonb(materials)->>'localizacao' AS localizacao
         FROM public.materials
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY lower(nome)
        LIMIT 500`,
      parameters,
    )

    return result.rows.map((row) => ({
      id: row.id,
      code: row.codigo,
      name: row.nome,
      description: row.descricao,
      unit: row.unidade,
      categoryId: row.categoria_id,
      category: row.categoria_nome,
      active: row.ativo,
      // Campos novos do cadastro: só para quem administra o Almoxarifado.
      ...(filters.withCustom
        ? {
            customFields: presentCustomFields((row as { campos_personalizados?: unknown }).campos_personalizados),
            // Onde o material fica: informação interna da equipe do Almoxarifado.
            location: (row as { localizacao?: string | null }).localizacao ?? null,
          }
        : {}),
    }))
  }

  private async resolveMaterialOptions(
    client: PoolClient,
    input: MaterialInput,
    current?: { unidade: string; categoria_id: string | null; categoria_nome: string | null },
  ) {
    const unit = await requireActiveOption(client, 'measurementUnits', input.unitId, 'Unidade de medida')
    if (!input.categoryId) return { unit: unit.name, categoryId: null, categoryName: null }
    if (current && input.categoryId === current.categoria_id) {
      return { unit: unit.name, categoryId: current.categoria_id, categoryName: current.categoria_nome }
    }
    const category = await requireActiveOption(client, 'warehouseCategories', input.categoryId, 'Categoria')
    return { unit: unit.name, categoryId: category.id, categoryName: category.name }
  }

  async createMaterial(actor: Actor, input: MaterialInput) {
    return withTransaction(this.poolProvider(), async (client) => {
      const options = await this.resolveMaterialOptions(client, input)
      const result = await client.query<{ id: string }>(
        `INSERT INTO public.materials
          (codigo, nome, descricao, unidade, categoria_id, categoria_nome, ativo)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id::text AS id`,
        [
          input.code,
          input.name,
          input.description,
          options.unit,
          options.categoryId,
          options.categoryName,
          input.active,
        ],
      )
      const { id } = result.rows[0]
      await audit(client, actor, 'material_created', id, { name: input.name })
      return id
    })
  }

  /** Pedidos e conferências antigos guardam o nome e a unidade usados e não mudam. */
  async updateMaterial(actor: Actor, id: string, input: MaterialInput) {
    return withTransaction(this.poolProvider(), async (client) => {
      const found = await client.query<{
        ativo: boolean
        unidade: string
        categoria_id: string | null
        categoria_nome: string | null
      }>(
        `SELECT ativo, unidade, categoria_id::text AS categoria_id, categoria_nome
           FROM public.materials WHERE id = $1 FOR UPDATE`,
        [id],
      )
      const current = found.rows[0]
      if (!current) throw notFound()

      const options = await this.resolveMaterialOptions(client, input, current)
      await client.query(
        `UPDATE public.materials
            SET codigo = $2, nome = $3, descricao = $4, unidade = $5,
                categoria_id = $6, categoria_nome = $7, ativo = $8
          WHERE id = $1`,
        [
          id,
          input.code,
          input.name,
          input.description,
          options.unit,
          options.categoryId,
          options.categoryName,
          input.active,
        ],
      )
      await audit(client, actor, 'material_updated', id, {
        name: input.name,
        ...(current.ativo !== input.active ? { active: String(input.active) } : {}),
      })
    })
  }

  // -------------------------------------------------------------------------
  // Central de pedidos
  // -------------------------------------------------------------------------
  async listRequests(
    scope: { allRequests: boolean; userId: string },
    filters: {
      status?: WarehouseStatus
      origin?: 'interna' | 'governamental'
      search?: string
      from?: Date | null
      to?: Date | null
      page?: number
    },
  ) {
    const parameters: unknown[] = []
    const conditions: string[] = []
    const bind = (value: unknown) => {
      parameters.push(value)
      return `$${parameters.length}`
    }

    if (!scope.allRequests) {
      const user = bind(scope.userId)
      conditions.push(`(r.solicitante_id = ${user} OR ${identifiedRequesterSql('r', user)})`)
    }
    if (filters.status) conditions.push(`r.status = ${bind(filters.status)}`)
    if (filters.origin) conditions.push(`r.origem = ${bind(filters.origin)}`)
    if (filters.from) conditions.push(`r.created_at >= ${bind(filters.from)}`)
    if (filters.to) conditions.push(`r.created_at <= ${bind(filters.to)}`)
    if (filters.search) {
      const pattern = bind(likePattern(filters.search))
      conditions.push(
        `(r.protocolo::text ILIKE ${pattern} OR ${protocolSql('r')} ILIKE ${pattern} OR r.referencia_externa ILIKE ${pattern}
          OR solicitante.full_name ILIKE ${pattern} OR r.solicitante_externo ILIKE ${pattern}
          OR r.setor_nome ILIKE ${pattern})`,
      )
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const page = Math.max(1, filters.page ?? 1)
    const pool = this.poolProvider()
    const [rows, total] = await Promise.all([
      pool.query<RequestRow>(
        `${requestSelect} ${where}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        parameters,
      ),
      pool.query<{ total: number }>(
        `SELECT count(*)::int AS total
           FROM public.material_requests r
           JOIN public.auth_users solicitante ON solicitante.id = r.solicitante_id
           ${where}`,
        parameters,
      ),
    ])

    return {
      requests: rows.rows.map(toRequest),
      total: total.rows[0].total,
      page,
      pageSize,
    }
  }

  async findRequest(id: string) {
    const pool = this.poolProvider()
    const result = await pool.query<RequestRow>(`${requestSelect} WHERE r.id = $1`, [id])
    const row = result.rows[0]
    return row ? toRequest(row) : null
  }

  /** A pessoa foi indicada pelo e-mail em um pedido digitado, sem ser quem o registrou. */
  async isIdentifiedRequester(
    request: { origin: string; externalRequesterEmail: string | null },
    userId: string,
  ) {
    if (request.origin !== 'governamental' || !request.externalRequesterEmail) return false
    const result = await this.poolProvider().query(
      `SELECT 1 FROM public.auth_users
        WHERE id = $1 AND status = 'approved' AND lower(email) = lower($2)`,
      [userId, request.externalRequesterEmail],
    )
    return result.rows.length > 0
  }

  /** Histórico interno de previsões e entrega. Vazio em um banco sem a migração 011. */
  async deliveryHistory(id: string) {
    const pool = this.poolProvider()
    if (!(await deliveryHistoryExists(pool))) return []
    const result = await pool.query<{
      id: string
      acao: string
      previsao_anterior: string | null
      previsao_nova: string | null
      entrega_efetiva: string | null
      comentario: string | null
      usuario: string | null
      created_at: Date
    }>(
      `SELECT h.id::text AS id, h.acao,
              to_char(h.previsao_anterior, 'YYYY-MM-DD') AS previsao_anterior,
              to_char(h.previsao_nova, 'YYYY-MM-DD') AS previsao_nova,
              to_char(h.entrega_efetiva, 'YYYY-MM-DD') AS entrega_efetiva,
              h.comentario, u.full_name AS usuario, h.created_at
         FROM public.material_delivery_history h
         LEFT JOIN public.auth_users u ON u.id = h.usuario_id
        WHERE h.material_request_id = $1
        ORDER BY h.created_at, h.id`,
      [id],
    )
    return result.rows.map((row) => ({
      id: row.id,
      action: row.acao,
      previousForecast: row.previsao_anterior,
      newForecast: row.previsao_nova,
      effectiveDate: row.entrega_efetiva,
      comment: row.comentario,
      user: row.usuario,
      at: row.created_at,
    }))
  }

  async requestItems(id: string) {
    const result = await this.poolProvider().query<{
      id: string
      material_id: string
      material_nome: string
      unidade: string
      quantidade_solicitada: string
      quantidade_atendida: string
      motivo_codigo: string | null
      motivo_nome: string | null
      observacao: string | null
    }>(
      `SELECT i.id::text AS id, i.material_id::text AS material_id,
              COALESCE(i.material_nome, m.nome) AS material_nome,
              COALESCE(i.unidade, m.unidade) AS unidade,
              i.quantidade_solicitada, i.quantidade_atendida,
              to_jsonb(i)->>'motivo_codigo' AS motivo_codigo,
              to_jsonb(i)->>'motivo_nome' AS motivo_nome,
              to_jsonb(i)->>'observacao' AS observacao
         FROM public.material_request_items i
         JOIN public.materials m ON m.id = i.material_id
        WHERE i.material_request_id = $1
        ORDER BY lower(COALESCE(i.material_nome, m.nome))`,
      [id],
    )
    return result.rows.map((row) => ({
      id: row.id,
      materialId: row.material_id,
      material: row.material_nome,
      unit: row.unidade,
      requested: Number(row.quantidade_solicitada),
      fulfilled: Number(row.quantidade_atendida),
      notProvided: Math.max(0, Number(row.quantidade_solicitada) - Number(row.quantidade_atendida)),
      reasonCode: row.motivo_codigo,
      reason: row.motivo_nome,
      note: row.observacao,
    }))
  }

  /** Histórico interno das quantidades. Vazio em um banco sem a migração 012. */
  async itemChanges(id: string) {
    const pool = this.poolProvider()
    if (!(await decisionSchemaExists(pool))) return []
    const result = await pool.query<{
      id: string
      material_nome: string
      unidade: string
      solicitada: string
      atendida_anterior: string | null
      atendida_nova: string
      motivo_nome: string | null
      observacao: string | null
      usuario: string | null
      created_at: Date
    }>(
      `SELECT c.id::text AS id, c.material_nome, c.unidade, c.solicitada, c.atendida_anterior, c.atendida_nova,
              c.motivo_nome, c.observacao, u.full_name AS usuario, c.created_at
         FROM public.material_item_changes c
         LEFT JOIN public.auth_users u ON u.id = c.usuario_id
        WHERE c.material_request_id = $1
        ORDER BY c.created_at, c.id`,
      [id],
    )
    return result.rows.map((row) => ({
      id: row.id,
      material: row.material_nome,
      unit: row.unidade,
      requested: Number(row.solicitada),
      previous: row.atendida_anterior === null ? null : Number(row.atendida_anterior),
      fulfilled: Number(row.atendida_nova),
      reason: row.motivo_nome,
      note: row.observacao,
      user: row.usuario,
      at: row.created_at,
    }))
  }

  // -------------------------------------------------------------------------
  // Controle interno. Não é pedido de materiais e não movimenta saldo.
  // -------------------------------------------------------------------------
  async createControlRecord(
    actor: Actor,
    input: {
      reference: string | null
      sectorId: string | null
      materialId: string
      description: string | null
      referenceQuantity: number | null
      countedQuantity: number | null
      providedQuantity: number | null
      notes: string | null
      justification: string | null
      customFields: Record<string, unknown>
      formVersion: number | null
    },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const sector = input.sectorId ? await requireActiveSector(client, input.sectorId) : null
      const materials = await loadActiveMaterials(client, [input.materialId])
      const material = materials.get(input.materialId)!
      const created = await client.query<{ id: string }>(
        `INSERT INTO public.warehouse_control_records
          (referencia_externa, setor_id, setor_nome, material_id, material_nome, unidade, descricao,
           quantidade_referencia, quantidade_conferida, quantidade_disponibilizada, observacoes,
           justificativa, campos_adicionais, formulario_versao, registrado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
         RETURNING id::text AS id`,
        [
          input.reference, sector?.id ?? null, sector?.name ?? null, input.materialId, material.nome,
          material.unidade, redactOptional(input.description), input.referenceQuantity, input.countedQuantity,
          input.providedQuantity, redactOptional(input.notes), redactOptional(input.justification),
          JSON.stringify(input.customFields), input.formVersion, actor.userId,
        ],
      )
      const { id } = created.rows[0]
      await audit(client, actor, 'warehouse_control_recorded', id, {
        material: material.nome,
        ...(input.formVersion ? { formVersion: String(input.formVersion) } : {}),
      })
      return id
    })
  }

  async listControlRecords(page: number) {
    const pool = this.poolProvider()
    const result = await pool.query<{
      id: string; referencia_externa: string | null; setor_nome: string | null; material_nome: string; unidade: string
      descricao: string | null; quantidade_referencia: string | null; quantidade_conferida: string | null
      quantidade_disponibilizada: string | null; observacoes: string | null; justificativa: string | null
      campos_adicionais: Record<string, unknown>; formulario_versao: number | null; usuario: string | null; created_at: Date
    }>(
      `SELECT c.id::text AS id, c.referencia_externa, c.setor_nome, c.material_nome, c.unidade, c.descricao,
              c.quantidade_referencia, c.quantidade_conferida, c.quantidade_disponibilizada, c.observacoes,
              c.justificativa, c.campos_adicionais, c.formulario_versao, u.full_name AS usuario, c.created_at
         FROM public.warehouse_control_records c
         LEFT JOIN public.auth_users u ON u.id = c.registrado_por
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ${pageSize + 1} OFFSET ${(page - 1) * pageSize}`,
    )
    const quantity = (value: string | null) => (value === null ? null : Number(value))
    return {
      records: result.rows.slice(0, pageSize).map((row) => ({
        id: row.id,
        reference: row.referencia_externa,
        sector: row.setor_nome,
        material: row.material_nome,
        unit: row.unidade,
        description: row.descricao,
        referenceQuantity: quantity(row.quantidade_referencia),
        countedQuantity: quantity(row.quantidade_conferida),
        providedQuantity: quantity(row.quantidade_disponibilizada),
        notes: row.observacoes,
        justification: row.justificativa,
        customFields: row.campos_adicionais,
        formVersion: row.formulario_versao,
        user: row.usuario,
        at: row.created_at,
      })),
      page,
      hasMore: result.rows.length > pageSize,
    }
  }

  async requestHistory(id: string) {
    const result = await this.poolProvider().query<{
      id: string
      acao: string
      status_anterior: string | null
      status_novo: string | null
      comentario: string | null
      detalhes: Record<string, unknown>
      usuario: string | null
      created_at: Date
    }>(
      `SELECT h.id::text AS id, h.acao, h.status_anterior, h.status_novo, h.comentario,
              h.detalhes, u.full_name AS usuario, h.created_at
         FROM public.material_request_history h
         LEFT JOIN public.auth_users u ON u.id = h.usuario_id
        WHERE h.material_request_id = $1
        ORDER BY h.created_at, h.id`,
      [id],
    )
    return result.rows.map((row) => ({
      id: row.id,
      action: row.acao,
      from: row.status_anterior,
      to: row.status_novo,
      comment: row.comentario,
      details: row.detalhes,
      user: row.usuario,
      at: row.created_at,
    }))
  }

  async createInternalRequest(
    actor: Actor,
    input: { note: string | null; items: readonly ItemInput[]; privacyNotice?: string | null },
  ) {
    assertItems(input.items)

    return withTransaction(this.poolProvider(), async (client) => {
      const materials = await loadActiveMaterials(
        client,
        input.items.map((item) => item.materialId),
      )
      const sectorId = await findSectorIdByName(client, actor.sector)
      const created = await client.query<{ id: string; protocolo: string }>(
        `INSERT INTO public.material_requests
          (origem, status, solicitante_id, registrado_por, setor_id, setor_nome, observacao)
         VALUES ('interna', 'pendente', $1, $1, $2, $3, $4)
         RETURNING id::text AS id, ${protocolSql('material_requests')} AS protocolo`,
        [actor.userId, sectorId, actor.sector, input.note],
      )
      const { id, protocolo } = created.rows[0]

      await insertItems(client, id, input.items, materials)
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'criado',
        from: null,
        to: 'pendente',
        details: {
          origem: 'interna',
          itens: input.items.length,
          ...(input.privacyNotice ? { avisoPrivacidade: input.privacyNotice } : {}),
        },
      })
      await audit(client, actor, 'warehouse_request_created', id, {
        origin: 'interna',
        protocol: protocolo,
      })
      await publishIntegrationEvent(client, {
        type: 'warehouse_received',
        key: `${id}:received`,
        module: 'warehouse',
        resourceId: id,
        protocol: protocolo,
        actorId: actor.userId,
        requesterId: actor.userId,
      })
      return { id, protocol: protocolo }
    })
  }

  async createExternalRequest(
    actor: Actor,
    input: {
      externalReference: string | null
      externalRequester: string | null
      externalRequesterEmail: string | null
      sectorId: string
      note: string | null
      items: readonly ItemInput[]
    },
  ) {
    assertItems(input.items)

    return withTransaction(this.poolProvider(), async (client) => {
      const sector = await requireActiveSector(client, input.sectorId)
      const materials = await loadActiveMaterials(
        client,
        input.items.map((item) => item.materialId),
      )
      const created = await client.query<{ id: string; protocolo: string }>(
        `INSERT INTO public.material_requests
          (origem, status, referencia_externa, solicitante_externo, solicitante_id, registrado_por,
           setor_id, setor_nome, observacao)
         VALUES ('governamental', 'pendente', $1, $2, $3, $3, $4, $5, $6)
         RETURNING id::text AS id, ${protocolSql('material_requests')} AS protocolo`,
        [
          input.externalReference,
          input.externalRequester,
          actor.userId,
          sector.id,
          sector.name,
          input.note,
        ],
      )
      const { id, protocolo } = created.rows[0]

      // Sem e-mail, a coluna nem é citada: registrar continua possível em um banco sem a 011.
      if (input.externalRequesterEmail) {
        await client.query(`UPDATE public.material_requests SET solicitante_email = $2 WHERE id = $1`, [
          id,
          input.externalRequesterEmail,
        ])
      }

      await insertItems(client, id, input.items, materials)
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'registrado_externo',
        from: null,
        to: 'pendente',
        details: {
          origem: 'governamental',
          referencia: input.externalReference,
          itens: input.items.length,
        },
      })
      await audit(client, actor, 'warehouse_request_created', id, {
        origin: 'governamental',
        protocol: protocolo,
      })
      // A pessoa do pedido externo não tem conta aqui: só a equipe é avisada.
      await publishIntegrationEvent(client, {
        type: 'warehouse_external_registered',
        key: `${id}:received`,
        module: 'warehouse',
        resourceId: id,
        protocol: protocolo,
        actorId: actor.userId,
      })
      return { id, protocol: protocolo }
    })
  }

  private async lockRequest(client: PoolClient, id: string) {
    const result = await client.query<{
      status: WarehouseStatus
      protocolo: string
      solicitante_id: string
      origem: string
      referencia_externa: string | null
      solicitante_externo: string | null
      observacao: string | null
      setor_id: string | null
      setor_nome: string | null
      previsao_entrega: string | null
      previsao_revisao: string | null
      solicitante_email: string | null
    }>(
      `SELECT status, ${protocolSql('material_requests')} AS protocolo, solicitante_id::text AS solicitante_id,
              origem, referencia_externa, solicitante_externo, observacao,
              setor_id::text AS setor_id, setor_nome,
              ${optionalColumnSql('material_requests', 'previsao_entrega')} AS previsao_entrega,
              ${optionalColumnSql('material_requests', 'previsao_revisao')} AS previsao_revisao,
              ${optionalColumnSql('material_requests', 'solicitante_email')} AS solicitante_email
         FROM public.material_requests WHERE id = $1 FOR UPDATE`,
      [id],
    )
    const row = result.rows[0]
    if (!row) throw notFound()
    return row
  }

  /** Só altera o registro local. Nunca há comunicação com o sistema governamental. */
  async updateRequest(
    actor: Actor,
    id: string,
    input: {
      note: string | null
      externalReference: string | null
      externalRequester: string | null
      externalRequesterEmail?: string | null
    },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lockRequest(client, id)
      if (!openStatuses.includes(current.status)) {
        throw conflict('Pedidos encerrados não podem ser editados.')
      }
      const external = current.origem === 'governamental'
      const reference = external ? input.externalReference : null
      const requester = external ? input.externalRequester : null
      const email =
        external && input.externalRequesterEmail !== undefined
          ? input.externalRequesterEmail
          : current.solicitante_email
      const emailChanged = email !== current.solicitante_email

      await client.query(
        `UPDATE public.material_requests
            SET observacao = $2, referencia_externa = $3, solicitante_externo = $4
          WHERE id = $1`,
        [id, input.note, reference, requester],
      )
      if (emailChanged) {
        await client.query(`UPDATE public.material_requests SET solicitante_email = $2 WHERE id = $1`, [
          id,
          email,
        ])
      }

      const changed = [
        current.observacao !== input.note && 'observacao',
        current.referencia_externa !== reference && 'referenciaExterna',
        current.solicitante_externo !== requester && 'solicitanteExterno',
        emailChanged && 'emailSolicitante',
      ].filter((item): item is string => Boolean(item))

      if (changed.length > 0) {
        await recordHistory(client, {
          requestId: id,
          userId: actor.userId,
          action: 'editado',
          from: current.status,
          to: current.status,
          details: { campos: changed },
        })
        await audit(client, actor, 'warehouse_request_updated', id, { fields: changed })
      }

      // Previsão já definida e endereço novo: essa pessoa ainda não foi avisada. O endereço entra
      // só resumido na chave, que impede repetir a comunicação a ele.
      if (emailChanged && email && current.previsao_entrega) {
        const contact = createHash('sha256').update(email).digest('hex').slice(0, 16)
        await publishIntegrationEvent(client, {
          type: 'warehouse_forecast_set',
          key: `${id}:forecast:${current.previsao_revisao}:contact:${contact}`,
          module: 'warehouse',
          resourceId: id,
          protocol: current.protocolo,
          actorId: actor.userId,
          ...(await this.forecastRecipient(client, { ...current, solicitante_email: email })),
          context: { forecastDate: current.previsao_entrega },
        })
      }
    })
  }

  /** A quem avisar: a conta de quem pediu ou, no pedido digitado, o e-mail informado e sua conta. */
  private async forecastRecipient(
    client: PoolClient,
    current: { origem: string; solicitante_id: string; solicitante_email: string | null },
  ) {
    const internal = current.origem === 'interna'
    if (!internal && !current.solicitante_email) return { requesterId: null, requesterEmail: null }
    const account = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM public.auth_users
        WHERE status = 'approved' AND ${internal ? 'id = $1' : 'lower(email) = lower($1)'}`,
      [internal ? current.solicitante_id : current.solicitante_email],
    )
    return {
      requesterId: account.rows[0]?.id ?? null,
      requesterEmail: internal ? null : current.solicitante_email,
    }
  }

  /**
   * Informa ou altera a previsão. A mesma data de novo, por clique duplo ou reprocessamento, não
   * muda nada nem avisa ninguém. A revisão na chave faz cada mudança real gerar uma só comunicação.
   */
  async setDeliveryForecast(
    actor: Actor,
    id: string,
    input: { date: string; justification: string | null },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lockRequest(client, id)
      if (!openStatuses.includes(current.status)) {
        throw conflict('Só é possível informar a previsão de pedidos em aberto.')
      }

      const previous = current.previsao_entrega
      if (previous === input.date) return { changed: false, requesterNotified: false }
      if (previous && (input.justification?.length ?? 0) < 3) {
        throw new ModuleError('Informe a justificativa da alteração.', 400)
      }
      const justification = previous ? input.justification : null

      const revision = Number(current.previsao_revisao ?? 0) + 1
      await client.query(
        `UPDATE public.material_requests
            SET previsao_entrega = $2, previsao_revisao = $3
          WHERE id = $1`,
        [id, input.date, revision],
      )
      await recordDeliveryHistory(client, {
        requestId: id,
        action: previous ? 'previsao_alterada' : 'previsao_informada',
        previousForecast: previous,
        newForecast: input.date,
        comment: justification,
        userId: actor.userId,
      })
      // A justificativa fica só no histórico interno: nem a auditoria nem o aviso a levam.
      await audit(client, actor, previous ? 'warehouse_forecast_changed' : 'warehouse_forecast_set', id, {
        protocol: current.protocolo,
        to: input.date,
        ...(previous ? { from: previous } : {}),
      })

      const recipient = await this.forecastRecipient(client, current)
      await publishIntegrationEvent(client, {
        type: previous ? 'warehouse_forecast_changed' : 'warehouse_forecast_set',
        key: `${id}:forecast:${revision}`,
        module: 'warehouse',
        resourceId: id,
        protocol: current.protocolo,
        actorId: actor.userId,
        ...recipient,
        context: { forecastDate: input.date, previousForecastDate: previous },
      })
      return {
        changed: true,
        requesterNotified: Boolean(recipient.requesterId || recipient.requesterEmail),
      }
    })
  }

  async replaceItems(actor: Actor, id: string, items: readonly ItemInput[]) {
    assertItems(items)

    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lockRequest(client, id)
      if (!openStatuses.includes(current.status)) {
        throw conflict('Pedidos encerrados não podem ser editados.')
      }
      // Completar um atendimento parcial é o caminho até "Atendido": sem isso, a transição
      // prevista no fluxo nunca poderia acontecer.
      const completingPartial =
        current.status === 'atendido_parcial' &&
        items.every((item) => item.fulfilled >= item.requested)
      if (!completingPartial && !warehouseStatusMatchesItems(current.status, items)) {
        throw conflict('As quantidades não correspondem ao status atual do pedido.')
      }

      const existing = await client.query<{
        material_id: string
        quantidade_solicitada: string
        quantidade_atendida: string
        motivo_codigo: string | null
        observacao: string | null
      }>(
        `SELECT material_id::text AS material_id, quantidade_solicitada, quantidade_atendida,
                to_jsonb(i)->>'motivo_codigo' AS motivo_codigo, to_jsonb(i)->>'observacao' AS observacao
           FROM public.material_request_items i WHERE material_request_id = $1 FOR UPDATE`,
        [id],
      )
      const known = new Map(existing.rows.map((row) => [row.material_id, row]))

      // Material já no pedido continua mesmo se foi desativado depois.
      const newItems = items.filter((item) => !known.has(item.materialId))
      const materials = await loadActiveMaterials(client, newItems.map((item) => item.materialId))
      await insertItems(client, id, newItems, materials)

      for (const item of items.filter((candidate) => known.has(candidate.materialId))) {
        await client.query(
          `UPDATE public.material_request_items
              SET quantidade_solicitada = $3, quantidade_atendida = $4
            WHERE material_request_id = $1 AND material_id = $2`,
          [id, item.materialId, item.requested, item.fulfilled],
        )
      }

      const kept = new Set(items.map((item) => item.materialId))
      const removed = [...known.keys()].filter((materialId) => !kept.has(materialId))
      if (removed.length > 0) {
        await client.query(
          `DELETE FROM public.material_request_items
            WHERE material_request_id = $1 AND material_id = ANY($2::uuid[])`,
          [id, removed],
        )
      }

      // Motivos e histórico das quantidades. Sem a migração 012, as quantidades seguem como antes.
      if (await decisionSchemaExists(client)) {
        const settings = await readSystemSettings(client)
        const names = await client.query<{ id: string; nome: string; unidade: string }>(
          `SELECT m.id::text AS id, COALESCE(i.material_nome, m.nome) AS nome, COALESCE(i.unidade, m.unidade) AS unidade
             FROM public.materials m
             LEFT JOIN public.material_request_items i ON i.material_id = m.id AND i.material_request_id = $1
            WHERE m.id = ANY($2::uuid[])`,
          [id, items.map((item) => item.materialId)],
        )
        for (const item of items) {
          const short = item.fulfilled < item.requested
          const option = short && item.reasonCode
            ? settings.reasons.warehouse.find((reason) => reason.key === item.reasonCode && reason.active)
            : null
          if (short && item.reasonCode && !option) throw new ModuleError('Selecione um motivo válido.', 400)
          if (option?.key === otherReasonKey && (item.note?.length ?? 0) < 3) {
            throw new ModuleError('Descreva o motivo na observação do item.', 400)
          }
          const note = item.note ? redactOptional(item.note) : null
          await client.query(
            `UPDATE public.material_request_items
                SET motivo_codigo = $3, motivo_nome = $4, observacao = $5
              WHERE material_request_id = $1 AND material_id = $2`,
            [id, item.materialId, option?.key ?? null, option?.label ?? null, note],
          )
          const before = known.get(item.materialId)
          // Salvar de novo o mesmo conteúdo não é uma alteração.
          if (
            before &&
            Number(before.quantidade_atendida) === item.fulfilled &&
            (before.motivo_codigo ?? null) === (option?.key ?? null) &&
            (before.observacao ?? null) === note
          ) continue
          const name = names.rows.find((row) => row.id === item.materialId)
          await client.query(
            `INSERT INTO public.material_item_changes
              (material_request_id, material_id, material_nome, unidade, solicitada, atendida_anterior,
               atendida_nova, motivo_codigo, motivo_nome, observacao, usuario_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              id, item.materialId, name?.nome ?? '', name?.unidade ?? '', item.requested,
              before ? Number(before.quantidade_atendida) : null, item.fulfilled,
              option?.key ?? null, option?.label ?? null, note, actor.userId,
            ],
          )
          await audit(client, actor, 'warehouse_quantity_changed', id, {
            material: item.materialId,
            from: before ? String(Number(before.quantidade_atendida)) : '0',
            to: String(item.fulfilled),
            ...(option ? { reason: option.key } : {}),
          })
        }
      }

      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'itens_alterados',
        from: current.status,
        to: current.status,
        details: {
          antes: existing.rows.map((row) => ({
            materialId: row.material_id,
            solicitada: Number(row.quantidade_solicitada),
            atendida: Number(row.quantidade_atendida),
          })),
          depois: items.map((item) => ({
            materialId: item.materialId,
            solicitada: item.requested,
            atendida: item.fulfilled,
          })),
        },
      })
      await audit(client, actor, 'warehouse_request_updated', id, { fields: ['itens'] })
    })
  }

  async changeStatus(
    actor: Actor,
    id: string,
    input: { status: WarehouseStatus; comment: string | null },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lockRequest(client, id)
      if (input.status === 'entregue') {
        throw conflict('Use o registro de entrega para concluir o pedido.')
      }
      if (!canMoveWarehouseStatus(current.status, input.status)) {
        throw conflict('Esta mudança de status não é permitida.')
      }
      if (['rejeitado', 'cancelado'].includes(input.status) && !input.comment) {
        throw new ModuleError('Informe o motivo.', 400)
      }

      const items = await this.lockedQuantities(client, id)
      if (!warehouseStatusMatchesItems(input.status, items)) {
        throw conflict('O status não corresponde às quantidades atendidas. Atualize os itens antes.')
      }
      // Fornecer menos que o pedido é uma decisão: precisa de motivo registrado em cada item.
      if (input.status === 'atendido_parcial' && (await decisionSchemaExists(client))) {
        const missing = await client.query(
          `SELECT 1 FROM public.material_request_items
            WHERE material_request_id = $1 AND quantidade_atendida < quantidade_solicitada
              AND motivo_codigo IS NULL LIMIT 1`,
          [id],
        )
        if (missing.rows.length > 0) {
          throw new ModuleError('Informe o motivo de cada item disponibilizado em quantidade menor que a solicitada.', 400)
        }
      }

      const attended = ['atendido', 'atendido_parcial'].includes(input.status)
      await client.query(
        `UPDATE public.material_requests
            SET status = $2,
                atendido_por = CASE WHEN $3 THEN $4::uuid ELSE atendido_por END,
                atendido_em = CASE WHEN $3 THEN now() ELSE atendido_em END
          WHERE id = $1`,
        [id, input.status, attended, actor.userId],
      )
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'status_alterado',
        from: current.status,
        to: input.status,
        comment: input.comment,
      })
      await audit(client, actor, 'warehouse_status_changed', id, {
        from: current.status,
        to: input.status,
      })
      await this.publishStatus(client, actor, id, current, input.status, input.comment)
    })
  }

  /** Pedido digitado de outro sistema não tem solicitante com conta: ninguém é avisado. */
  private async publishStatus(
    client: PoolClient,
    actor: Actor,
    id: string,
    current: { protocolo: string; solicitante_id: string; origem: string },
    status: WarehouseStatus,
    comment: string | null,
  ) {
    const type = warehouseEventFor(status)
    if (!type || current.origem !== 'interna') return
    await publishIntegrationEvent(client, {
      type,
      key: `${id}:status:${status}`,
      module: 'warehouse',
      resourceId: id,
      protocol: current.protocolo,
      actorId: actor.userId,
      requesterId: current.solicitante_id,
      context: { reason: comment },
    })
  }

  private async lockedQuantities(client: PoolClient, id: string) {
    const result = await client.query<{
      quantidade_solicitada: string
      quantidade_atendida: string
    }>(
      `SELECT quantidade_solicitada, quantidade_atendida
         FROM public.material_request_items WHERE material_request_id = $1`,
      [id],
    )
    return result.rows.map((row) => ({
      requested: Number(row.quantidade_solicitada),
      fulfilled: Number(row.quantidade_atendida),
    }))
  }

  async registerDelivery(
    actor: Actor,
    id: string,
    input: {
      receivedBy: string
      deliveredAt: Date
      comment: string | null
      deliveryNote?: string | null
    },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const current = await this.lockRequest(client, id)
      if (!canMoveWarehouseStatus(current.status, 'entregue')) {
        throw conflict('Só é possível registrar a entrega de pedidos atendidos.')
      }

      await client.query(
        `UPDATE public.material_requests
            SET status = 'entregue', entregue_em = $2, entregue_por = $3, recebido_por = $4
          WHERE id = $1`,
        [id, input.deliveredAt, actor.userId, input.receivedBy],
      )
      await recordHistory(client, {
        requestId: id,
        userId: actor.userId,
        action: 'entregue',
        from: current.status,
        to: 'entregue',
        comment: input.comment,
        details: { entregueEm: input.deliveredAt.toISOString() },
      })
      // Sem a 011 a entrega continua sendo registrada. Só uma observação, que não caberia em outro
      // lugar sem chegar ao solicitante, faz a gravação falhar e pedir a migração.
      if (input.deliveryNote || (await deliveryHistoryExists(client))) {
        await recordDeliveryHistory(client, {
          requestId: id,
          action: 'entrega_registrada',
          previousForecast: current.previsao_entrega,
          effectiveDate: todayInSaoPaulo(input.deliveredAt),
          comment: input.deliveryNote,
          userId: actor.userId,
        })
      }
      // Baixa automática do saldo interno (12/11/2026), com o custo médio quando há a 020.
      const debit = await debitDelivery(client, { requestId: id, protocol: current.protocolo, userId: actor.userId })
      await audit(client, actor, 'warehouse_delivered', id, { from: current.status })
      await this.publishStatus(client, actor, id, current, 'entregue', null)
      return { stockDebit: debit }
    })
  }

  // -------------------------------------------------------------------------
  // Conferência de inventário
  // -------------------------------------------------------------------------
  async listChecks(page: number) {
    const pool = this.poolProvider()
    const result = await pool.query<{
      id: string
      protocolo: string
      titulo: string
      data_referencia: string
      status: string
      criado_por_nome: string
      encerrado_por_nome: string | null
      encerrado_em: Date | null
      total: number
      contados: number
      divergentes: number
      created_at: Date
    }>(
      `SELECT c.id::text AS id, ${protocolSql('c')} AS protocolo, c.titulo,
              to_char(c.data_referencia, 'YYYY-MM-DD') AS data_referencia, c.status,
              criou.full_name AS criado_por_nome,
              encerrou.full_name AS encerrado_por_nome, c.encerrado_em,
              (SELECT count(*)::int FROM public.inventory_check_items i WHERE i.check_id = c.id) AS total,
              (SELECT count(*)::int FROM public.inventory_check_items i
                WHERE i.check_id = c.id AND i.quantidade_contada IS NOT NULL) AS contados,
              (SELECT count(*)::int FROM public.inventory_check_items i
                WHERE i.check_id = c.id AND i.diferenca <> 0) AS divergentes,
              c.created_at
         FROM public.inventory_checks c
         JOIN public.auth_users criou ON criou.id = c.criado_por
         LEFT JOIN public.auth_users encerrou ON encerrou.id = c.encerrado_por
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ${pageSize + 1} OFFSET ${(page - 1) * pageSize}`,
    )

    return {
      checks: result.rows.slice(0, pageSize).map((row) => ({
        id: row.id,
        protocol: row.protocolo,
        title: row.titulo,
        referenceDate: row.data_referencia,
        status: row.status,
        createdBy: row.criado_por_nome,
        closedBy: row.encerrado_por_nome,
        closedAt: row.encerrado_em,
        total: row.total,
        counted: row.contados,
        divergent: row.divergentes,
        createdAt: row.created_at,
      })),
      page,
      hasMore: result.rows.length > pageSize,
    }
  }

  async findCheck(id: string) {
    const pool = this.poolProvider()
    const found = await pool.query<{
      id: string
      protocolo: string
      titulo: string
      data_referencia: string
      observacao: string | null
      status: string
    }>(
      `SELECT id::text AS id, ${protocolSql('inventory_checks')} AS protocolo, titulo,
              to_char(data_referencia, 'YYYY-MM-DD') AS data_referencia, observacao, status
         FROM public.inventory_checks WHERE id = $1`,
      [id],
    )
    const check = found.rows[0]
    if (!check) return null

    const items = await pool.query<{
      material_id: string
      material_nome: string
      unidade: string
      quantidade_governamental: string
      quantidade_contada: string | null
      diferenca: string | null
      observacao: string | null
      atualizado_por_nome: string | null
      updated_at: Date
    }>(
      `SELECT i.material_id::text AS material_id, i.material_nome, i.unidade,
              i.quantidade_governamental, i.quantidade_contada, i.diferenca, i.observacao,
              u.full_name AS atualizado_por_nome, i.updated_at, to_jsonb(m)->>'localizacao' AS localizacao
         FROM public.inventory_check_items i
         JOIN public.materials m ON m.id = i.material_id
         LEFT JOIN public.auth_users u ON u.id = i.atualizado_por
        WHERE i.check_id = $1
        -- Ordem de contagem: pela localização (armário por armário), e dentro dela pelo nome.
        ORDER BY lower(to_jsonb(m)->>'localizacao') NULLS LAST, lower(i.material_nome)`,
      [id],
    )

    return {
      id: check.id,
      protocol: check.protocolo,
      title: check.titulo,
      referenceDate: check.data_referencia,
      note: check.observacao,
      status: check.status,
      items: items.rows.map((row) => {
        const government = Number(row.quantidade_governamental)
        const counted = row.quantidade_contada === null ? null : Number(row.quantidade_contada)
        return {
          location: (row as { localizacao?: string | null }).localizacao ?? null,
          materialId: row.material_id,
          material: row.material_nome,
          unit: row.unidade,
          governmentQuantity: government,
          countedQuantity: counted,
          difference: row.diferenca === null ? null : Number(row.diferenca),
          situation: inventoryItemSituation(government, counted),
          note: row.observacao,
          updatedBy: row.atualizado_por_nome,
          updatedAt: row.updated_at,
        }
      }),
    }
  }

  async createCheck(
    actor: Actor,
    input: {
      title: string
      referenceDate: string
      note: string | null
      items: readonly { materialId: string; governmentQuantity: number }[]
    },
  ) {
    if (input.items.length === 0) throw new ModuleError('Inclua ao menos um material.', 400)
    if (new Set(input.items.map((item) => item.materialId)).size !== input.items.length) {
      throw new ModuleError('O mesmo material foi incluído mais de uma vez.', 400)
    }

    return withTransaction(this.poolProvider(), async (client) => {
      const materials = await loadActiveMaterials(
        client,
        input.items.map((item) => item.materialId),
      )
      const created = await client.query<{ id: string; protocolo: string }>(
        `INSERT INTO public.inventory_checks (titulo, data_referencia, observacao, criado_por)
         VALUES ($1, $2, $3, $4)
         RETURNING id::text AS id, ${protocolSql('inventory_checks')} AS protocolo`,
        [input.title, input.referenceDate, input.note, actor.userId],
      )
      const { id, protocolo } = created.rows[0]

      for (const item of input.items) {
        const material = materials.get(item.materialId)!
        await client.query(
          `INSERT INTO public.inventory_check_items
            (check_id, material_id, material_nome, unidade, quantidade_governamental)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, item.materialId, material.nome, material.unidade, item.governmentQuantity],
        )
      }
      await audit(client, actor, 'inventory_created', id, { protocol: protocolo })
      return { id, protocol: protocolo }
    })
  }

  async updateCheckItem(
    actor: Actor,
    checkId: string,
    materialId: string,
    input: { governmentQuantity: number; countedQuantity: number | null; note: string | null },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      await this.lockOpenCheck(client, checkId)
      const updated = await client.query(
        `UPDATE public.inventory_check_items
            SET quantidade_governamental = $3, quantidade_contada = $4, observacao = $5,
                atualizado_por = $6, updated_at = now()
          WHERE check_id = $1 AND material_id = $2`,
        [
          checkId,
          materialId,
          input.governmentQuantity,
          input.countedQuantity,
          input.note,
          actor.userId,
        ],
      )
      if (updated.rowCount === 0) throw notFound()
      await audit(client, actor, 'inventory_item_updated', checkId, { materialId })
    })
  }

  private async lockOpenCheck(client: PoolClient, id: string) {
    const found = await client.query<{ status: string }>(
      `SELECT status FROM public.inventory_checks WHERE id = $1 FOR UPDATE`,
      [id],
    )
    const check = found.rows[0]
    if (!check) throw notFound()
    if (check.status !== 'em_andamento') {
      throw conflict('Esta conferência já foi encerrada e não pode ser alterada.')
    }
  }

  async closeCheck(
    actor: Actor,
    id: string,
    input: { outcome: 'concluida' | 'cancelada'; comment: string | null },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      await this.lockOpenCheck(client, id)

      if (input.outcome === 'concluida') {
        const pending = await client.query(
          `SELECT 1 FROM public.inventory_check_items
            WHERE check_id = $1 AND quantidade_contada IS NULL LIMIT 1`,
          [id],
        )
        if (pending.rows.length > 0) {
          throw conflict('Ainda há itens sem contagem.')
        }
      } else if (!input.comment) {
        throw new ModuleError('Informe o motivo do cancelamento.', 400)
      }

      await client.query(
        `UPDATE public.inventory_checks
            SET status = $2, encerrado_por = $3, encerrado_em = now(),
                observacao = COALESCE($4, observacao)
          WHERE id = $1`,
        [id, input.outcome, actor.userId, input.comment],
      )
      await audit(client, actor, 'inventory_closed', id, { outcome: input.outcome })
    })
  }

  // -------------------------------------------------------------------------
  // Relatório do almoxarifado
  // -------------------------------------------------------------------------
  async topMaterials(period: { from: Date | null; to: Date | null }) {
    const result = await this.poolProvider().query<{
      material: string
      unidade: string
      solicitada: string
      atendida: string
    }>(
      `SELECT COALESCE(i.material_nome, m.nome) AS material,
              COALESCE(i.unidade, m.unidade) AS unidade,
              sum(i.quantidade_solicitada) AS solicitada,
              sum(i.quantidade_atendida) AS atendida
         FROM public.material_request_items i
         JOIN public.material_requests r ON r.id = i.material_request_id
         JOIN public.materials m ON m.id = i.material_id
        WHERE ($1::timestamptz IS NULL OR r.created_at >= $1)
          AND ($2::timestamptz IS NULL OR r.created_at <= $2)
          AND r.status NOT IN ('cancelado', 'rejeitado')
        GROUP BY 1, 2
        ORDER BY sum(i.quantidade_solicitada) DESC
        LIMIT 20`,
      [period.from, period.to],
    )
    return result.rows.map((row) => ({
      material: row.material,
      unit: row.unidade,
      requested: Number(row.solicitada),
      fulfilled: Number(row.atendida),
    }))
  }
}
