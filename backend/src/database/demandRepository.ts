import { holdsPermission } from '../auth/permissions.js'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { AttachmentStorage } from '../attachments/storage.js'
import { canReadRequest } from '../auth/requestPolicy.js'
import type { RequestModule } from '../auth/requestPolicy.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { keepThoseWithAccess, notifyDemand } from '../demands/demandNotifications.js'
import { creationScope, resolveDemandAccess, visibilityLevel, visibleDemandSql } from '../demands/demandPolicy.js'
import type { DemandAccess, DemandContext, DemandFacts } from '../demands/demandPolicy.js'
import { actionForField, collaborationChanges, demandFieldChanges } from '../demands/demandHistoryChanges.js'
import type { CollaborationState, FieldChange } from '../demands/demandHistoryChanges.js'
import { readRecurrenceInput } from '../demands/demandValidation.js'
import { requirePublishable, terminalStatuses } from '../demands/demandValidation.js'
import type {
  Collaborator,
  DemandFilters,
  DemandInput,
  DemandPatch,
  DemandStatus,
  LinkModule,
  WaitingDetails,
} from '../demands/demandValidation.js'
import { resourcePath } from '../integrations/catalog.js'
import { redactOptional } from '../integrations/redaction.js'
import { likePattern, RequestValidationError } from '../requests/validation.js'
import { moduleTypes } from '../requests/workflow.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { loadDemandPeople } from './demandConfigRepository.js'
import { canRespondFor, createSeriesFor, DemandSeriesRepository, nextDemandNumber, recordDemandHistory } from './demandSeriesRepository.js'
import type { SeriesTemplate } from './demandSeriesRepository.js'
import { conflict, ModuleError, notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { protocolSql } from './protocolSql.js'
import { withTransaction } from './withTransaction.js'

type Client = Pick<PoolClient, 'query'>

export const todaySql = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`
export const closedStatusesSql = `('concluida', 'cancelada')`

export function overdueSql(alias: string) {
  return `(NOT ${alias}.rascunho AND ${alias}.prazo < ${todaySql} AND ${alias}.status NOT IN ('concluida', 'cancelada', 'suspensa'))`
}

const dueSoonDays = 3

const baseSelect = `
  SELECT d.id::text AS id, d.numero, d.titulo, d.descricao, d.categoria_id::text AS categoria_id, c.nome AS categoria_nome,
         d.setor_origem_id::text AS setor_origem_id, so.nome AS setor_origem_nome,
         d.setor_responsavel_id::text AS setor_responsavel_id, sr.nome AS setor_responsavel_nome,
         d.solicitante_id::text AS solicitante_id, us.full_name AS solicitante_nome,
         d.responsavel_id::text AS responsavel_id, ur.full_name AS responsavel_nome,
         d.gestor_acompanhamento_id::text AS gestor_id, ug.full_name AS gestor_nome,
         d.criado_por::text AS criado_por, uc.full_name AS criado_por_nome,
         d.data_abertura, d.inicio_previsto::text AS inicio_previsto, d.prazo::text AS prazo, d.prioridade, d.status,
         d.rascunho, d.restrita, d.observacoes, d.referencias, d.lembrete_dias, d.aguardando_quem,
         d.suspensao_motivo, d.suspensao_retomada::text AS suspensao_retomada,
         d.conclusao_realizado, d.conclusao_resultado, d.conclusao_observacoes, d.concluida_em,
         uf.full_name AS concluida_por_nome, d.reaberturas, d.cancelamento_motivo, d.cancelada_em,
         ux.full_name AS cancelada_por_nome, d.series_id::text AS series_id,
         d.data_ocorrencia::text AS data_ocorrencia, d.ocorrencia_personalizada, d.recorrencia_rascunho,
         d.versao, d.ultima_atividade_em, d.created_at,
         d.prazo < ${todaySql} AND d.status NOT IN ('concluida', 'cancelada', 'suspensa') AND NOT d.rascunho AS atrasada,
         d.prazo BETWEEN ${todaySql} AND ${todaySql} + ${dueSoonDays} AND d.status NOT IN ('concluida', 'cancelada', 'suspensa') AND NOT d.rascunho AS vence_em_breve,
         (SELECT count(*)::int FROM public.demand_sector_links l WHERE l.demand_id = d.id) AS setores_colaboradores,
         (SELECT count(*) FILTER (WHERE t.status <> 'cancelada')::int FROM public.demand_subtasks t WHERE t.demand_id = d.id) AS etapas,
         (SELECT count(*) FILTER (WHERE t.status = 'concluida')::int FROM public.demand_subtasks t WHERE t.demand_id = d.id) AS etapas_concluidas
    FROM public.demands d
    LEFT JOIN public.demand_categories c ON c.id = d.categoria_id
    LEFT JOIN public.demand_sectors so ON so.id = d.setor_origem_id
    LEFT JOIN public.demand_sectors sr ON sr.id = d.setor_responsavel_id
    LEFT JOIN public.auth_users us ON us.id = d.solicitante_id
    LEFT JOIN public.auth_users ur ON ur.id = d.responsavel_id
    LEFT JOIN public.auth_users ug ON ug.id = d.gestor_acompanhamento_id
    LEFT JOIN public.auth_users uc ON uc.id = d.criado_por
    LEFT JOIN public.auth_users uf ON uf.id = d.concluida_por
    LEFT JOIN public.auth_users ux ON ux.id = d.cancelada_por`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export function presentSummary(row: Row) {
  return {
    id: row.id as string,
    number: row.numero as string,
    title: row.titulo as string,
    category: row.categoria_nome as string | null,
    categoryId: row.categoria_id as string | null,
    originSector: row.setor_origem_nome as string | null,
    originSectorId: row.setor_origem_id as string | null,
    responsibleSector: row.setor_responsavel_nome as string | null,
    responsibleSectorId: row.setor_responsavel_id as string | null,
    requester: row.solicitante_nome as string | null,
    requesterId: row.solicitante_id as string | null,
    responsible: row.responsavel_nome as string | null,
    responsibleId: row.responsavel_id as string | null,
    openedAt: row.data_abertura as Date,
    startDate: row.inicio_previsto as string | null,
    dueDate: row.prazo as string | null,
    priority: row.prioridade as string,
    status: row.status as DemandStatus,
    draft: row.rascunho as boolean,
    restricted: row.restrita as boolean,
    overdue: row.atrasada === true,
    dueSoon: row.vence_em_breve === true,
    shared: (row.setores_colaboradores as number) > 0,
    recurring: Boolean(row.series_id),
    occurrenceDate: row.data_ocorrencia as string | null,
    subtasks: row.etapas as number,
    subtasksDone: row.etapas_concluidas as number,
    progress: row.etapas > 0 ? Math.round((row.etapas_concluidas / row.etapas) * 100) : null,
    version: row.versao as number,
    updatedAt: row.ultima_atividade_em as Date,
  }
}

function presentDetail(row: Row) {
  return {
    ...presentSummary(row),
    description: row.descricao as string | null,
    createdById: row.criado_por as string,
    createdBy: row.criado_por_nome as string,
    followUpManagerId: row.gestor_id as string | null,
    followUpManager: row.gestor_nome as string | null,
    notes: row.observacoes as string | null,
    references: row.referencias as string | null,
    reminderDays: row.lembrete_dias as number | null,
    waitingFor: row.aguardando_quem as string | null,
    suspensionReason: row.suspensao_motivo as string | null,
    resumeDate: row.suspensao_retomada as string | null,
    completion: row.concluida_em
      ? {
          done: row.conclusao_realizado as string,
          result: row.conclusao_resultado as string | null,
          notes: row.conclusao_observacoes as string | null,
          at: row.concluida_em as Date,
          by: row.concluida_por_nome as string,
        }
      : null,
    reopenings: row.reaberturas as number,
    cancellation: row.cancelada_em
      ? { reason: row.cancelamento_motivo as string, at: row.cancelada_em as Date, by: row.cancelada_por_nome as string }
      : null,
    customOccurrence: row.ocorrencia_personalizada as boolean,
    draftRecurrence: row.recorrencia_rascunho as unknown,
  }
}

/** Monta o filtro das listas, painéis e relatórios. A visibilidade é sempre a primeira condição. */
export class FilterBuilder {
  readonly values: unknown[]
  private readonly conditions: string[]

  constructor(context: DemandContext, alias = 'd') {
    this.values = [context.userId, visibilityLevel(context)]
    this.conditions = [visibleDemandSql(alias, '$1::uuid', '$2')]
  }

  add(value: unknown) {
    this.values.push(value)
    return `$${this.values.length}`
  }

  where(condition: string) {
    this.conditions.push(condition)
  }

  get sql() {
    return this.conditions.join(' AND ')
  }
}

export function applyDemandFilters(builder: FilterBuilder, filters: DemandFilters, context: DemandContext, alias = 'd') {
  if (filters.scope === 'drafts') {
    builder.where(`${alias}.rascunho`)
  } else {
    builder.where(`NOT ${alias}.rascunho`)
  }
  if (filters.scope === 'mine') {
    builder.where(`(${alias}.responsavel_id = $1::uuid
      OR EXISTS (SELECT 1 FROM public.demand_participants mp WHERE mp.demand_id = ${alias}.id AND mp.user_id = $1::uuid AND mp.tipo = 'colaborador')
      OR EXISTS (SELECT 1 FROM public.demand_subtasks mt WHERE mt.demand_id = ${alias}.id AND mt.responsavel_id = $1::uuid AND mt.status NOT IN ('concluida', 'cancelada')))`)
  }
  // Quem vê a Diretoria inteira escolhe o setor no filtro; os demais ficam nos próprios setores.
  if (filters.scope === 'sector' && visibilityLevel(context) === 0) {
    const own = builder.add(context.memberships.map((item) => item.sectorId))
    builder.where(`${alias}.setor_responsavel_id = ANY(${own}::uuid[])`)
  }
  if (filters.scope === 'shared' || filters.shared === true) {
    builder.where(`EXISTS (SELECT 1 FROM public.demand_sector_links sl WHERE sl.demand_id = ${alias}.id)`)
  }
  if (filters.shared === false) {
    builder.where(`NOT EXISTS (SELECT 1 FROM public.demand_sector_links sl WHERE sl.demand_id = ${alias}.id)`)
  }
  if (filters.search) {
    const term = builder.add(likePattern(filters.search))
    builder.where(`(${alias}.numero ILIKE ${term} OR ${alias}.titulo ILIKE ${term} OR ${alias}.descricao ILIKE ${term}
      OR EXISTS (SELECT 1 FROM public.auth_users su WHERE su.id IN (${alias}.responsavel_id, ${alias}.solicitante_id) AND su.full_name ILIKE ${term})
      OR EXISTS (SELECT 1 FROM public.demand_sectors ss WHERE ss.id IN (${alias}.setor_responsavel_id, ${alias}.setor_origem_id) AND ss.nome ILIKE ${term})
      OR EXISTS (SELECT 1 FROM public.demand_categories sc WHERE sc.id = ${alias}.categoria_id AND sc.nome ILIKE ${term}))`)
  }
  if (filters.number) builder.where(`${alias}.numero ILIKE ${builder.add(likePattern(filters.number))}`)
  if (filters.text) {
    const term = builder.add(likePattern(filters.text))
    builder.where(`(${alias}.titulo ILIKE ${term} OR ${alias}.descricao ILIKE ${term})`)
  }
  if (filters.requester) {
    builder.where(`EXISTS (SELECT 1 FROM public.auth_users ru WHERE ru.id = ${alias}.solicitante_id AND ru.full_name ILIKE ${builder.add(likePattern(filters.requester))})`)
  }
  if (filters.statuses.length > 0) builder.where(`${alias}.status = ANY(${builder.add(filters.statuses)}::text[])`)
  if (filters.priority) builder.where(`${alias}.prioridade = ${builder.add(filters.priority)}`)
  if (filters.sectorId) {
    const sector = builder.add(filters.sectorId)
    builder.where(`(${alias}.setor_responsavel_id = ${sector}::uuid OR ${alias}.setor_origem_id = ${sector}::uuid
      OR EXISTS (SELECT 1 FROM public.demand_sector_links fl WHERE fl.demand_id = ${alias}.id AND fl.sector_id = ${sector}::uuid))`)
  }
  if (filters.responsibleId) builder.where(`${alias}.responsavel_id = ${builder.add(filters.responsibleId)}::uuid`)
  if (filters.unassigned) builder.where(`${alias}.responsavel_id IS NULL`)
  if (filters.categoryId) builder.where(`${alias}.categoria_id = ${builder.add(filters.categoryId)}::uuid`)
  if (filters.from) builder.where(`${alias}.data_abertura >= ${builder.add(filters.from)}`)
  if (filters.to) builder.where(`${alias}.data_abertura <= ${builder.add(filters.to)}`)
  if (filters.dueFrom) builder.where(`${alias}.prazo >= ${builder.add(filters.dueFrom)}::date`)
  if (filters.dueTo) builder.where(`${alias}.prazo <= ${builder.add(filters.dueTo)}::date`)
  if (filters.recurring !== null) builder.where(`${alias}.series_id IS ${filters.recurring ? 'NOT ' : ''}NULL`)
  if (filters.overdue) builder.where(overdueSql(alias))
}

const sortOrders: Record<string, string> = {
  prazo: `d.prazo ASC NULLS LAST, d.data_abertura DESC`,
  abertura: `d.data_abertura DESC`,
  prioridade: `CASE d.prioridade WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, d.prazo ASC NULLS LAST`,
  atualizacao: `d.ultima_atividade_em DESC`,
}

async function loadFacts(client: Client, demandId: string): Promise<DemandFacts | null> {
  const found = await client.query<Row>(
    `SELECT d.criado_por::text AS criado_por, d.solicitante_id::text AS solicitante_id,
            d.responsavel_id::text AS responsavel_id, d.gestor_acompanhamento_id::text AS gestor_id,
            d.rascunho, d.restrita,
            d.setor_origem_id::text AS setor_origem_id, d.setor_responsavel_id::text AS setor_responsavel_id,
            ARRAY(SELECT l.sector_id::text FROM public.demand_sector_links l WHERE l.demand_id = d.id) AS setores,
            ARRAY(SELECT p.user_id::text FROM public.demand_participants p WHERE p.demand_id = d.id) AS participantes,
            ARRAY(SELECT t.responsavel_id::text FROM public.demand_subtasks t
                   WHERE t.demand_id = d.id AND t.responsavel_id IS NOT NULL) AS etapas
       FROM public.demands d
      WHERE d.id = $1 AND d.excluida_em IS NULL`,
    [demandId],
  )
  const row = found.rows[0]
  if (!row) return null
  return {
    createdBy: row.criado_por,
    requesterId: row.solicitante_id,
    responsibleId: row.responsavel_id,
    followUpManagerId: row.gestor_id,
    draft: row.rascunho,
    restricted: row.restrita,
    originSectorId: row.setor_origem_id,
    responsibleSectorId: row.setor_responsavel_id,
    collaboratorSectorIds: row.setores,
    participantIds: row.participantes,
    subtaskAssigneeIds: row.etapas,
  }
}

async function assertPeople(client: Client, ids: readonly (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (wanted.length === 0) return
  const known = new Set((await loadDemandPeople(client)).map((person) => person.id))
  if (wanted.some((id) => !known.has(id))) {
    throw new RequestValidationError('Uma das pessoas indicadas não integra os setores do módulo.')
  }
}

async function assertActive(client: Client, table: 'demand_categories' | 'demand_sectors', ids: readonly (string | null)[], label: string) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (wanted.length === 0) return
  const { rows } = await client.query(`SELECT 1 FROM public.${table} WHERE id = ANY($1::uuid[]) AND ativo`, [wanted])
  if (rows.length !== wanted.length) throw new RequestValidationError(`${label} inválido ou desativado.`)
}

async function assertSectorMember(client: Client, userId: string | null, sectorId: string | null) {
  if (!userId || !sectorId) return
  if (!(await canRespondFor(client, userId, sectorId))) {
    throw new RequestValidationError('O responsável principal precisa integrar o setor responsável.')
  }
}

async function assertManager(client: Client, userId: string | null | undefined) {
  if (!userId) return
  const person = (await loadDemandPeople(client)).find((item) => item.id === userId)
  if (!person?.isManager) throw new RequestValidationError('Selecione um diretor para o acompanhamento.')
}

/** Fora o Diretor, a demanda cadastrada precisa ser do próprio setor: na origem e no responsável. */
function assertCanCreateIn(context: DemandContext, sectorIds: readonly (string | null)[]) {
  const scope = creationScope(context)
  if (!scope.anywhere && scope.sectorIds.length === 0) {
    throw new ModuleError('Você não tem autorização para cadastrar demandas.', 403)
  }
  if (!scope.anywhere && sectorIds.some((id) => id && !scope.sectorIds.includes(id))) {
    throw new ModuleError('Você só pode cadastrar demandas para um setor que integra.', 403)
  }
}

async function sectorLeadIds(client: Client, sectorId: string | null) {
  if (!sectorId) return []
  const { rows } = await client.query<{ user_id: string }>(
    `SELECT user_id::text AS user_id FROM public.demand_sector_members
      WHERE sector_id = $1 AND ativo AND papel = 'responsavel'`,
    [sectorId],
  )
  return rows.map((row) => row.user_id)
}

/** Quem não alcança a demanda não pode ser indicado nela: ninguém é incluído sem conseguir abrir o registro. */
async function assertCanOpenDemand(client: Client, demandId: string, ids: readonly string[]) {
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return
  if ((await keepThoseWithAccess(client, demandId, wanted)).length !== wanted.length) {
    throw new RequestValidationError('Uma das pessoas indicadas não integra os setores desta demanda.')
  }
}

const collaborationPeople = (input: { collaborators: readonly Collaborator[]; authorizedUserIds: readonly string[] }) => [
  ...input.collaborators.map((item) => item.userId),
  ...input.authorizedUserIds,
]

function stakeholders(facts: DemandFacts) {
  return [facts.requesterId, facts.responsibleId, facts.followUpManagerId, facts.createdBy, ...facts.participantIds]
}

const noticeOf = (row: Row) => ({
  // Só estes campos saem para a notificação.
  id: row.id as string,
  number: row.numero as string,
  title: row.titulo as string,
  restricted: row.restrita as boolean,
})

const moduleByType = moduleTypes as Record<RequestModule, string>

/** Erros de validação atravessam a transação com a mensagem intacta, como os de regra de negócio. */
function transact<Result>(pool: Pool, operation: (client: PoolClient) => Promise<Result>) {
  return withTransaction(pool, async (client) => {
    try {
      return await operation(client)
    } catch (error) {
      if (error instanceof RequestValidationError) throw new ModuleError(error.message, 400)
      throw error
    }
  })
}

export class DemandRepository {
  private readonly series: DemandSeriesRepository

  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {
    this.series = new DemandSeriesRepository(poolProvider)
  }

  async accessTo(context: DemandContext, demandId: string): Promise<{ access: DemandAccess; facts: DemandFacts } | null> {
    const facts = await loadFacts(this.poolProvider(), demandId)
    if (!facts) return null
    return { access: resolveDemandAccess(context, facts), facts }
  }

  async list(context: DemandContext, filters: DemandFilters, options: { sort: string; page: number; pageSize: number }) {
    const builder = new FilterBuilder(context)
    applyDemandFilters(builder, filters, context)
    const pool = this.poolProvider()
    const order = sortOrders[options.sort] ?? sortOrders.atualizacao
    const [rows, total] = await Promise.all([
      pool.query<Row>(
        `${baseSelect} WHERE ${builder.sql} ORDER BY ${order}, d.id
         LIMIT ${options.pageSize} OFFSET ${(options.page - 1) * options.pageSize}`,
        builder.values,
      ),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM public.demands d WHERE ${builder.sql}`, builder.values),
    ])
    return { demands: rows.rows.map(presentSummary), total: total.rows[0].total, page: options.page, pageSize: options.pageSize }
  }

  async detail(identity: AuthenticatedIdentity, context: DemandContext, demandId: string) {
    const resolved = await this.accessTo(context, demandId)
    if (!resolved?.access.read) throw notFound()
    const { access } = resolved
    const pool = this.poolProvider()

    const [row, participants, sectors, subtasks, comments, history, attachments, links, series] = await Promise.all([
      pool.query<Row>(`${baseSelect} WHERE d.id = $1`, [demandId]),
      pool.query(
        `SELECT p.user_id::text AS user_id, u.full_name, p.tipo, p.atividade, p.prazo::text AS prazo
           FROM public.demand_participants p JOIN public.auth_users u ON u.id = p.user_id
          WHERE p.demand_id = $1 ORDER BY u.full_name`,
        [demandId],
      ),
      pool.query(
        `SELECT s.id::text AS id, s.nome FROM public.demand_sector_links l
           JOIN public.demand_sectors s ON s.id = l.sector_id WHERE l.demand_id = $1 ORDER BY s.nome`,
        [demandId],
      ),
      pool.query(
        `SELECT t.id::text AS id, t.titulo, t.descricao, t.responsavel_id::text AS responsavel_id,
                u.full_name AS responsavel_nome, t.prazo::text AS prazo, t.status, t.observacoes, t.concluida_em,
                t.prazo < ${todaySql} AND t.status NOT IN ('concluida', 'cancelada') AS atrasada
           FROM public.demand_subtasks t LEFT JOIN public.auth_users u ON u.id = t.responsavel_id
          WHERE t.demand_id = $1 ORDER BY t.created_at, t.id`,
        [demandId],
      ),
      pool.query(
        `SELECT c.id::text AS id, c.tipo, c.texto, c.created_at, u.full_name AS autor,
                ARRAY(SELECT m.full_name FROM public.auth_users m WHERE m.id = ANY(c.mencoes)) AS mencoes
           FROM public.demand_comments c JOIN public.auth_users u ON u.id = c.autor_id
          WHERE c.demand_id = $1 ORDER BY c.created_at, c.id`,
        [demandId],
      ),
      pool.query(
        `SELECT h.id::text AS id, h.acao, h.comentario, h.detalhes, h.created_at, u.full_name AS usuario
           FROM public.demand_history h LEFT JOIN public.auth_users u ON u.id = h.usuario_id
          WHERE h.demand_id = $1 ORDER BY h.created_at, h.id`,
        [demandId],
      ),
      pool.query(
        `SELECT a.id::text AS id, a.nome_original, a.tipo, a.categoria, a.tamanho_bytes::text AS tamanho_bytes,
                a.subtask_id::text AS subtask_id, a.created_at, u.full_name AS enviado_por,
                a.enviado_por::text AS enviado_por_id, a.removido_em, ur.full_name AS removido_por, a.motivo_remocao
           FROM public.demand_attachments a
           JOIN public.auth_users u ON u.id = a.enviado_por
           LEFT JOIN public.auth_users ur ON ur.id = a.removido_por
          WHERE a.demand_id = $1 ORDER BY a.created_at DESC, a.id DESC`,
        [demandId],
      ),
      pool.query(
        `SELECT l.id::text AS id, l.modulo, l.recurso_id::text AS recurso_id, l.protocolo, l.created_at
           FROM public.demand_links l WHERE l.demand_id = $1 AND l.removido_em IS NULL ORDER BY l.created_at`,
        [demandId],
      ),
      this.series.detail(demandId, visibleDemandSql('d', '$1::uuid', '$2'), [context.userId, visibilityLevel(context)]),
    ])
    const attachmentNames = new Map(attachments.rows.map((item) => [item.id as string, item.nome_original as string]))

    return {
      demand: presentDetail(row.rows[0]),
      access,
      following: participants.rows.some((item) => item.user_id === context.userId && item.tipo === 'acompanhante'),
      participants: participants.rows.map((item) => ({
        userId: item.user_id,
        name: item.full_name,
        kind: item.tipo,
        activity: item.atividade,
        dueDate: item.prazo,
      })),
      collaboratorSectors: sectors.rows.map((item) => ({ id: item.id, name: item.nome })),
      subtasks: subtasks.rows.map((item) => ({
        id: item.id,
        title: item.titulo,
        description: item.descricao,
        responsibleId: item.responsavel_id,
        responsible: item.responsavel_nome,
        dueDate: item.prazo,
        status: item.status,
        notes: item.observacoes,
        completedAt: item.concluida_em,
        overdue: item.atrasada === true,
        canUpdate: access.subtasksManage,
      })),
      comments: comments.rows.map((item) => ({
        id: item.id,
        kind: item.tipo,
        text: item.texto,
        at: item.created_at,
        author: item.autor,
        mentions: item.mencoes,
      })),
      history: history.rows.map((item) => ({
        id: item.id,
        action: item.acao,
        comment: item.comentario,
        // O nome do arquivo não é copiado para o histórico: vem do próprio anexo, que quem lê
        // a demanda já vê na lista de anexos (inclusive os removidos).
        details:
          typeof item.detalhes?.anexoId === 'string' && attachmentNames.has(item.detalhes.anexoId)
            ? { ...item.detalhes, arquivo: attachmentNames.get(item.detalhes.anexoId) }
            : item.detalhes,
        at: item.created_at,
        user: item.usuario,
      })),
      attachments: attachments.rows.map((item) => ({
        id: item.id,
        name: item.nome_original,
        kind: item.tipo,
        category: item.categoria,
        sizeBytes: Number(item.tamanho_bytes),
        subtaskId: item.subtask_id,
        uploadedAt: item.created_at,
        uploadedBy: item.enviado_por,
        removedAt: item.removido_em,
        removedBy: item.removido_por,
        removalReason: item.motivo_remocao,
        canRemove: !item.removido_em && access.edit,
      })),
      links: links.rows.map((item) => ({
        id: item.id,
        module: item.modulo,
        protocol: item.protocolo,
        // O vínculo não dá acesso ao registro: quem não tem o módulo vê só o protocolo.
        path: identity.permissions.includes(`${item.modulo}:read` as never)
          ? resourcePath(item.modulo as LinkModule, item.recurso_id)
          : null,
      })),
      series,
    }
  }

  async create(identity: AuthenticatedIdentity, context: DemandContext, input: DemandInput) {
    assertCanCreateIn(context, [input.originSectorId, input.responsibleSectorId])
    return transact(this.poolProvider(), async (client) => {
      await assertActive(client, 'demand_categories', [input.categoryId], 'Categoria')
      await assertActive(client, 'demand_sectors', [input.originSectorId, input.responsibleSectorId, ...input.collaboratorSectorIds], 'Setor')
      await assertSectorMember(client, input.responsibleId, input.responsibleSectorId)
      if (input.draft && input.responsibleId && !input.responsibleSectorId) {
        throw new RequestValidationError('Selecione o setor responsável antes do responsável principal.')
      }
      await assertManager(client, input.followUpManagerId)
      const requesterId = input.requesterId ?? identity.userId
      await assertPeople(client, [
        input.requesterId,
        ...input.collaborators.map((item) => item.userId),
        ...input.authorizedUserIds,
      ])

      const number = await nextDemandNumber(client)
      const created = await client.query<{ id: string }>(
        `INSERT INTO public.demands
           (numero, titulo, descricao, categoria_id, setor_origem_id, setor_responsavel_id, solicitante_id,
            responsavel_id, criado_por, inicio_previsto, prazo, prioridade, status, rascunho, restrita,
            observacoes, referencias, lembrete_dias, aguardando_quem, suspensao_motivo, suspensao_retomada,
            recorrencia_rascunho, gestor_acompanhamento_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23)
         RETURNING id::text AS id`,
        [
          number,
          redactOptional(input.title),
          redactOptional(input.description),
          input.categoryId,
          input.originSectorId,
          input.responsibleSectorId,
          requesterId,
          input.responsibleId,
          identity.userId,
          input.startDate,
          input.dueDate,
          input.priority,
          input.status,
          input.draft,
          input.restricted,
          redactOptional(input.notes),
          redactOptional(input.references),
          input.reminderDays,
          input.statusDetails.waitingFor,
          redactOptional(input.statusDetails.suspensionReason),
          input.statusDetails.resumeDate,
          input.draft && input.recurrence ? JSON.stringify(storedRecurrence(input.recurrence)) : null,
          input.followUpManagerId,
        ],
      )
      const id = created.rows[0].id
      await this.saveCollaboration(client, id, identity.userId, input)
      if (!input.draft) await assertCanOpenDemand(client, id, collaborationPeople(input))
      await recordDemandHistory(client, {
        demandId: id,
        userId: identity.userId,
        action: input.draft ? 'rascunho_criado' : 'criada',
        details: {
          numero: number,
          status: input.status,
          prioridade: input.priority,
          prazo: input.dueDate,
          // Quem cadastrou fica em criado_por; a origem pode ser outro setor, se houver autorização.
          emNomeDeOutroSetor: Boolean(input.originSectorId) && !creationScope(context).sectorIds.includes(input.originSectorId as string),
        },
      })
      await insertAuthAuditEvent(client, {
        actorUserId: identity.userId,
        actorKind: 'user',
        subjectUserId: null,
        sessionId: id,
        eventType: 'demand_created',
        details: { number, restricted: String(input.restricted), draft: String(input.draft) },
      })

      let firstDate: string | null = null
      if (!input.draft) {
        if (input.recurrence) {
          const { firstDate: first } = await createSeriesFor(client, {
            demandId: id,
            template: await buildTemplate(client, id),
            recurrence: input.recurrence,
            actorId: identity.userId,
          })
          firstDate = first
        }
        await this.notifyPublished(client, id, identity.userId)
      }
      return { id, number, firstDate }
    })
  }

  private async saveCollaboration(
    client: Client,
    demandId: string,
    actorId: string,
    input: { collaborators: readonly Collaborator[]; collaboratorSectorIds: readonly string[]; authorizedUserIds: readonly string[] },
  ) {
    for (const item of input.collaborators) {
      await client.query(
        `INSERT INTO public.demand_participants (demand_id, user_id, tipo, atividade, prazo, adicionado_por)
         VALUES ($1, $2, 'colaborador', $3, $4, $5)`,
        [demandId, item.userId, redactOptional(item.activity), item.dueDate, actorId],
      )
    }
    for (const userId of input.authorizedUserIds) {
      await client.query(
        `INSERT INTO public.demand_participants (demand_id, user_id, tipo, adicionado_por)
         VALUES ($1, $2, 'autorizado', $3)`,
        [demandId, userId, actorId],
      )
    }
    for (const sectorId of input.collaboratorSectorIds) {
      await client.query(`INSERT INTO public.demand_sector_links (demand_id, sector_id) VALUES ($1, $2)`, [demandId, sectorId])
    }
  }

  private async notifyPublished(client: Client, demandId: string, actorId: string) {
    const row = await lockDemand(client, demandId)
    const facts = (await loadFacts(client, demandId)) as DemandFacts
    const collaborators = await client.query<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM public.demand_participants WHERE demand_id = $1 AND tipo = 'colaborador'`,
      [demandId],
    )
    await notifyDemand(client, {
      kind: 'atribuicao',
      key: `${demandId}:atribuida:${row.responsavel_id ?? 'sem'}`,
      demand: noticeOf(row),
      recipients: [facts.responsibleId, ...collaborators.rows.map((item) => item.user_id)],
      actorId,
    })
    if (!facts.responsibleId) {
      await notifyDemand(client, {
        kind: 'providencia',
        key: `${demandId}:sem-responsavel`,
        demand: noticeOf(row),
        recipients: await sectorLeadIds(client, facts.responsibleSectorId),
        actorId,
      })
    }
  }

  async publish(identity: AuthenticatedIdentity, context: DemandContext, demandId: string) {
    return transact(this.poolProvider(), async (client) => {
      const row = await lockDemand(client, demandId)
      if (!row.rascunho) throw conflict('Esta demanda já foi publicada.')
      requirePublishable({
        description: row.descricao,
        categoryId: row.categoria_id,
        originSectorId: row.setor_origem_id,
        responsibleSectorId: row.setor_responsavel_id,
      })
      assertCanCreateIn(context, [row.setor_origem_id, row.setor_responsavel_id])
      await assertActive(client, 'demand_categories', [row.categoria_id], 'Categoria')
      await assertActive(client, 'demand_sectors', [row.setor_origem_id, row.setor_responsavel_id], 'Setor')
      await assertSectorMember(client, row.responsavel_id, row.setor_responsavel_id)
      const invited = await client.query<{ user_id: string }>(
        `SELECT user_id::text AS user_id FROM public.demand_participants WHERE demand_id = $1`,
        [demandId],
      )
      await assertCanOpenDemand(client, demandId, invited.rows.map((item) => item.user_id))
      await client.query(
        `UPDATE public.demands
            SET rascunho = false, data_abertura = now(), recorrencia_rascunho = NULL,
                versao = versao + 1, ultima_atividade_em = now()
          WHERE id = $1`,
        [demandId],
      )
      await recordDemandHistory(client, { demandId, userId: identity.userId, action: 'criada', details: { numero: row.numero } })
      if (row.recorrencia_rascunho) {
        await createSeriesFor(client, {
          demandId,
          template: await buildTemplate(client, demandId),
          recurrence: readRecurrenceInput(row.recorrencia_rascunho),
          actorId: identity.userId,
        })
      }
      await this.notifyPublished(client, demandId, identity.userId)
    })
  }

  /** Só rascunhos saem de circulação, e mesmo assim o registro continua no banco. */
  async discard(identity: AuthenticatedIdentity, demandId: string, reason: string | null) {
    await transact(this.poolProvider(), async (client) => {
      const row = await lockDemand(client, demandId)
      if (!row.rascunho) throw conflict('Só rascunhos podem ser descartados. Use o cancelamento.')
      await client.query(
        `UPDATE public.demands SET excluida_em = now(), excluida_por = $2, motivo_exclusao = $3 WHERE id = $1`,
        [demandId, identity.userId, redactOptional(reason)],
      )
      await recordDemandHistory(client, { demandId, userId: identity.userId, action: 'rascunho_descartado', comment: reason })
    })
  }

  async patch(
    identity: AuthenticatedIdentity,
    demandId: string,
    input: {
      patch: DemandPatch
      scope: 'this' | 'future'
      version: number | null
      draftExtras: {
        requesterId?: string | null
        responsibleId?: string | null
        collaboration?: { collaborators: Collaborator[]; collaboratorSectorIds: string[]; authorizedUserIds: string[] }
        recurrence?: ReturnType<typeof readRecurrenceInput> | null
      }
    },
    access: DemandAccess,
    context: DemandContext,
  ) {
    const { patch, scope } = input
    await transact(this.poolProvider(), async (client) => {
      const row = await lockDemand(client, demandId)
      assertVersion(row, input.version)
      if (terminalStatuses.includes(row.status)) {
        throw conflict('Uma demanda concluída ou cancelada não pode ser editada. Reabra-a, se for o caso.')
      }

      const changesSector = 'responsibleSectorId' in patch && patch.responsibleSectorId !== row.setor_responsavel_id
      if (changesSector && !access.transfer) {
        throw new ModuleError('Só o Diretor pode transferir a demanda para outro setor.', 403)
      }
      if ('originSectorId' in patch && patch.originSectorId !== row.setor_origem_id && !access.transfer) {
        throw new ModuleError('Só o Diretor pode alterar o setor solicitante.', 403)
      }
      if (patch.categoryId && patch.categoryId !== row.categoria_id) {
        await assertActive(client, 'demand_categories', [patch.categoryId], 'Categoria')
      }
      const sectors = [
        patch.originSectorId !== row.setor_origem_id ? patch.originSectorId : null,
        patch.responsibleSectorId !== row.setor_responsavel_id ? patch.responsibleSectorId : null,
      ].filter((id): id is string => Boolean(id))
      // No rascunho vale a mesma regra do cadastro: só os setores em que a pessoa pode cadastrar.
      if (row.rascunho) assertCanCreateIn(context, sectors)
      await assertActive(client, 'demand_sectors', sectors, 'Setor')

      const merged = {
        description: 'description' in patch ? (patch.description ?? null) : row.descricao,
        categoryId: 'categoryId' in patch ? (patch.categoryId ?? null) : row.categoria_id,
        originSectorId: 'originSectorId' in patch ? (patch.originSectorId ?? null) : row.setor_origem_id,
        responsibleSectorId: 'responsibleSectorId' in patch ? (patch.responsibleSectorId ?? null) : row.setor_responsavel_id,
      }
      if (!row.rascunho) requirePublishable(merged)

      if (patch.followUpManagerId && patch.followUpManagerId !== row.gestor_id) await assertManager(client, patch.followUpManagerId)
      const start = 'startDate' in patch ? patch.startDate : row.inicio_previsto
      const due = 'dueDate' in patch ? patch.dueDate : row.prazo
      if (start && due && due < start) throw new RequestValidationError('O prazo não pode ser anterior ao início previsto.')

      await applyFields(client, demandId, patch)

      // Mudar de setor com responsável de fora deixa a demanda sem responsável, para nova distribuição.
      if (changesSector && row.responsavel_id && merged.responsibleSectorId) {
        if (!(await canRespondFor(client, row.responsavel_id, merged.responsibleSectorId))) {
          await client.query(`UPDATE public.demands SET responsavel_id = NULL WHERE id = $1`, [demandId])
          await recordDemandHistory(client, {
            demandId,
            userId: identity.userId,
            action: 'responsavel_alterado',
            details: { de: row.responsavel_nome, para: null, motivo: 'transferencia_de_setor' },
          })
        }
      }

      if (row.rascunho) await this.applyDraftExtras(client, demandId, identity.userId, input.draftExtras)

      await recordPatchHistory(client, identity.userId, demandId, row, patch, scope)
      await bump(client, demandId, scope === 'this' && Boolean(row.series_id))

      if (patch.restricted !== undefined && patch.restricted !== row.restrita) {
        await this.applyRestriction(client, identity, demandId, row, patch.restricted)
      }

      if (patch.dueDate !== undefined && patch.dueDate !== row.prazo && !row.rascunho) {
        const facts = (await loadFacts(client, demandId)) as DemandFacts
        await notifyDemand(client, {
          kind: 'prazo_alterado',
          key: `${demandId}:prazo:${row.versao}`,
          demand: noticeOf({ ...row, titulo: patch.title ?? row.titulo, restrita: patch.restricted ?? row.restrita }),
          recipients: stakeholders(facts),
          actorId: identity.userId,
        })
      }

      if (scope === 'future' && row.series_id) {
        await this.applyToFuture(client, identity.userId, row, patch)
      }
    })
  }

  private async applyDraftExtras(
    client: Client,
    demandId: string,
    actorId: string,
    extras: {
      requesterId?: string | null
      responsibleId?: string | null
      collaboration?: { collaborators: Collaborator[]; collaboratorSectorIds: string[]; authorizedUserIds: string[] }
      recurrence?: ReturnType<typeof readRecurrenceInput> | null
    },
  ) {
    const current = await client.query<{ solicitante_id: string | null; responsavel_id: string | null; setor_responsavel_id: string | null }>(
      `SELECT solicitante_id::text AS solicitante_id, responsavel_id::text AS responsavel_id,
              setor_responsavel_id::text AS setor_responsavel_id
         FROM public.demands WHERE id = $1`,
      [demandId],
    )
    const stored = current.rows[0]
    // Troca de pessoa no rascunho: quem saiu e quem entrou, como nas demais alterações.
    const recordPerson = async (action: string, from: string | null, to: string | null) => {
      if (from === to) return
      const names = await namesOf(client, 'person', [from, to])
      await recordDemandHistory(client, {
        demandId,
        userId: actorId,
        action,
        details: { de: from ? (names.get(from) ?? null) : null, para: to ? (names.get(to) ?? null) : null, deId: from, paraId: to },
      })
    }
    if (extras.requesterId !== undefined) {
      await assertPeople(client, [extras.requesterId])
      const requesterId = extras.requesterId ?? actorId
      await client.query(`UPDATE public.demands SET solicitante_id = $2 WHERE id = $1`, [demandId, requesterId])
      await recordPerson('solicitante_alterado', stored.solicitante_id, requesterId)
    }
    if (extras.responsibleId !== undefined) {
      await assertSectorMember(client, extras.responsibleId, stored.setor_responsavel_id)
      await client.query(`UPDATE public.demands SET responsavel_id = $2 WHERE id = $1`, [demandId, extras.responsibleId])
      await recordPerson('responsavel_alterado', stored.responsavel_id, extras.responsibleId)
    }
    if (extras.collaboration) {
      await assertPeople(client, [
        ...extras.collaboration.collaborators.map((item) => item.userId),
        ...extras.collaboration.authorizedUserIds,
      ])
      await assertActive(client, 'demand_sectors', extras.collaboration.collaboratorSectorIds, 'Setor')
      const previousState = await readCollaborationState(client, demandId)
      await client.query(`DELETE FROM public.demand_participants WHERE demand_id = $1 AND tipo IN ('colaborador', 'autorizado')`, [demandId])
      await client.query(`DELETE FROM public.demand_sector_links WHERE demand_id = $1`, [demandId])
      await this.saveCollaboration(client, demandId, actorId, extras.collaboration)
      await recordCollaborationChanges(client, demandId, actorId, previousState, extras.collaboration)
    }
    if (extras.recurrence !== undefined) {
      await client.query(`UPDATE public.demands SET recorrencia_rascunho = $2::jsonb WHERE id = $1`, [
        demandId,
        extras.recurrence ? JSON.stringify(storedRecurrence(extras.recurrence)) : null,
      ])
    }
  }

  private async applyRestriction(client: Client, identity: AuthenticatedIdentity, demandId: string, row: Row, restricted: boolean) {
    if (restricted) {
      // Quem só acompanhava deixa de ter acesso; quem restringiu continua autorizado.
      await client.query(`DELETE FROM public.demand_participants WHERE demand_id = $1 AND tipo = 'acompanhante'`, [demandId])
      await client.query(
        `INSERT INTO public.demand_participants (demand_id, user_id, tipo, adicionado_por)
         VALUES ($1, $2, 'autorizado', $2) ON CONFLICT DO NOTHING`,
        [demandId, identity.userId],
      )
    }
    await insertAuthAuditEvent(client, {
      actorUserId: identity.userId,
      actorKind: 'user',
      subjectUserId: null,
      sessionId: demandId,
      eventType: 'demand_restriction_changed',
      details: { number: row.numero, restricted: String(restricted) },
    })
  }

  /** Datas ficam fora: cada ocorrência tem o próprio prazo. */
  private async applyToFuture(client: Client, actorId: string, row: Row, patch: DemandPatch) {
    const { startDate: _start, dueDate: _due, ...shared } = patch
    const others = await client.query<{ id: string; numero: string }>(
      `SELECT id::text AS id, numero FROM public.demands
        WHERE series_id = $1 AND data_ocorrencia > $2::date AND id <> $3
          AND status NOT IN ('concluida', 'cancelada')
        ORDER BY data_ocorrencia FOR UPDATE`,
      [row.series_id, row.data_ocorrencia, row.id],
    )
    for (const other of others.rows) {
      // Cada ocorrência tem os próprios valores: o registro mostra o que mudou nela.
      const otherRow = await lockDemand(client, other.id)
      await applyFields(client, other.id, shared)
      // Mesma regra de restringir uma demanda: quem só acompanhava deixa de ter acesso.
      if (shared.restricted === true) {
        await client.query(`DELETE FROM public.demand_participants WHERE demand_id = $1 AND tipo = 'acompanhante'`, [other.id])
      }
      await bump(client, other.id, false)
      const alteracoes = await nameReferences(client, demandFieldChanges(otherRow, shared))
      if (alteracoes.length === 0) continue
      await recordDemandHistory(client, {
        demandId: other.id,
        seriesId: row.series_id,
        userId: actorId,
        action: 'alterada_em_serie',
        details: { alteracoes, campos: alteracoes.map((item) => item.campo), origem: row.numero },
      })
    }
    const template: Record<string, unknown> = {}
    if (shared.title !== undefined) template.title = redactOptional(shared.title)
    if (shared.description !== undefined) template.description = redactOptional(shared.description)
    if (shared.categoryId !== undefined) template.categoryId = shared.categoryId
    if (shared.originSectorId !== undefined) template.originSectorId = shared.originSectorId
    if (shared.responsibleSectorId !== undefined) template.responsibleSectorId = shared.responsibleSectorId
    if (shared.priority !== undefined) template.priority = shared.priority
    if (shared.restricted !== undefined) template.restricted = shared.restricted
    if (shared.notes !== undefined) template.notes = redactOptional(shared.notes)
    if (shared.references !== undefined) template.references = redactOptional(shared.references)
    if (shared.reminderDays !== undefined) template.reminderDays = shared.reminderDays
    if (shared.followUpManagerId !== undefined) template.followUpManagerId = shared.followUpManagerId
    await mergeTemplate(client, row.series_id, template)
    await recordDemandHistory(client, {
      demandId: row.id,
      seriesId: row.series_id,
      userId: actorId,
      action: 'recorrencia_alterada',
      details: { campos: demandFieldChanges(row, shared).map((item) => item.campo), alcance: 'esta_e_futuras', ocorrencias: others.rows.length },
    })
  }

  async assign(
    identity: AuthenticatedIdentity,
    demandId: string,
    input: { responsibleId: string | null; reason: string | null; scope: 'this' | 'future'; version: number | null },
  ) {
    await transact(this.poolProvider(), async (client) => {
      const row = await lockDemand(client, demandId)
      assertVersion(row, input.version)
      if (terminalStatuses.includes(row.status)) throw conflict('Esta demanda já foi encerrada.')
      await assertSectorMember(client, input.responsibleId, row.setor_responsavel_id)
      if (input.responsibleId === row.responsavel_id && input.scope === 'this') return

      const newName = input.responsibleId
        ? (await client.query<{ full_name: string }>(`SELECT full_name FROM public.auth_users WHERE id = $1`, [input.responsibleId])).rows[0]?.full_name
        : null
      await client.query(`UPDATE public.demands SET responsavel_id = $2 WHERE id = $1`, [demandId, input.responsibleId])
      await bump(client, demandId, input.scope === 'this' && Boolean(row.series_id))
      await recordDemandHistory(client, {
        demandId,
        userId: identity.userId,
        action: 'responsavel_alterado',
        comment: input.reason,
        details: { de: row.responsavel_nome, para: newName },
      })
      if (!row.rascunho) {
        await notifyDemand(client, {
          kind: 'atribuicao',
          key: `${demandId}:atribuida:${row.versao}`,
          demand: noticeOf(row),
          recipients: [input.responsibleId],
          actorId: identity.userId,
        })
        await notifyDemand(client, {
          kind: 'responsavel',
          key: `${demandId}:responsavel:${row.versao}`,
          demand: noticeOf(row),
          recipients: [row.responsavel_id, row.solicitante_id],
          actorId: identity.userId,
        })
      }
      if (input.scope === 'future' && row.series_id) {
        const others = await client.query<{ id: string }>(
          `UPDATE public.demands SET responsavel_id = $2, versao = versao + 1, ultima_atividade_em = now()
            WHERE series_id = $1 AND data_ocorrencia > $3::date AND id <> $4
              AND status NOT IN ('concluida', 'cancelada')
            RETURNING id::text AS id`,
          [row.series_id, input.responsibleId, row.data_ocorrencia, demandId],
        )
        for (const other of others.rows) {
          await recordDemandHistory(client, {
            demandId: other.id,
            seriesId: row.series_id,
            userId: identity.userId,
            action: 'responsavel_alterado',
            details: { para: newName, origem: row.numero },
          })
        }
        await mergeTemplate(client, row.series_id, { responsibleId: input.responsibleId })
      }
    })
  }

  async setCollaboration(
    identity: AuthenticatedIdentity,
    demandId: string,
    input: { collaborators: Collaborator[]; collaboratorSectorIds: string[]; authorizedUserIds: string[]; scope: 'this' | 'future' },
  ) {
    await transact(this.poolProvider(), async (client) => {
      const row = await lockDemand(client, demandId)
      if (terminalStatuses.includes(row.status)) throw conflict('Esta demanda já foi encerrada.')
      await assertPeople(client, [...input.collaborators.map((item) => item.userId), ...input.authorizedUserIds])
      await assertActive(client, 'demand_sectors', input.collaboratorSectorIds, 'Setor')

      const previousState = await readCollaborationState(client, demandId)
      const before = new Set(previousState.collaborators.map((item) => item.userId))
      await client.query(`DELETE FROM public.demand_participants WHERE demand_id = $1 AND tipo IN ('colaborador', 'autorizado')`, [demandId])
      await client.query(`DELETE FROM public.demand_sector_links WHERE demand_id = $1`, [demandId])
      await this.saveCollaboration(client, demandId, identity.userId, input)
      if (!row.rascunho) await assertCanOpenDemand(client, demandId, collaborationPeople(input))
      await bump(client, demandId, input.scope === 'this' && Boolean(row.series_id))
      const alcance = row.series_id ? { alcance: input.scope === 'future' ? 'esta_e_futuras' : 'somente_esta' } : {}
      await recordCollaborationChanges(client, demandId, identity.userId, previousState, input, alcance)
      if (!row.rascunho) {
        await notifyDemand(client, {
          kind: 'atribuicao',
          key: `${demandId}:colaboracao:${row.versao}`,
          demand: noticeOf(row),
          recipients: input.collaborators.map((item) => item.userId).filter((id) => !before.has(id)),
          actorId: identity.userId,
        })
      }
      if (input.scope === 'future' && row.series_id) {
        await mergeTemplate(client, row.series_id, {
          collaborators: input.collaborators.map(({ userId, activity }) => ({ userId, activity: redactOptional(activity) })),
          collaboratorSectorIds: input.collaboratorSectorIds,
          authorizedUserIds: input.authorizedUserIds,
        })
      }
    })
  }

  async follow(context: DemandContext, demandId: string, following: boolean) {
    if (following) {
      await this.poolProvider().query(
        `INSERT INTO public.demand_participants (demand_id, user_id, tipo, adicionado_por)
         VALUES ($1, $2, 'acompanhante', $2) ON CONFLICT DO NOTHING`,
        [demandId, context.userId],
      )
    } else {
      await this.poolProvider().query(
        `DELETE FROM public.demand_participants WHERE demand_id = $1 AND user_id = $2 AND tipo = 'acompanhante'`,
        [demandId, context.userId],
      )
    }
  }

  async changeStatus(
    identity: AuthenticatedIdentity,
    demandId: string,
    input: { status: DemandStatus; details: WaitingDetails; version: number | null },
  ) {
    await transact(this.poolProvider(), async (client) => {
      const row = await lockDemand(client, demandId)
      assertVersion(row, input.version)
      if (row.rascunho) throw conflict('Publique o rascunho antes de alterar o status.')
      if (terminalStatuses.includes(row.status)) throw conflict('Esta demanda já foi encerrada.')
      if (row.status === input.status) return

      await client.query(
        `UPDATE public.demands
            SET status = $2, aguardando_quem = $3, suspensao_motivo = $4, suspensao_retomada = $5
          WHERE id = $1`,
        [demandId, input.status, input.details.waitingFor, redactOptional(input.details.suspensionReason), input.details.resumeDate],
      )
      await bump(client, demandId, false)
      await recordDemandHistory(client, {
        demandId,
        userId: identity.userId,
        action: 'status_alterado',
        comment: input.details.suspensionReason,
        details: {
          de: row.status,
          para: input.status,
          aguardando: input.details.waitingFor,
          retomadaPrevista: input.details.resumeDate,
        },
      })
      const facts = (await loadFacts(client, demandId)) as DemandFacts
      await notifyDemand(client, {
        kind: 'status',
        key: `${demandId}:status:${row.versao}`,
        demand: noticeOf(row),
        recipients: stakeholders(facts),
        actorId: identity.userId,
      })
      if (input.status === 'aguardando_terceiros' || input.status === 'aguardando_autorizacao') {
        await notifyDemand(client, {
          kind: 'providencia',
          key: `${demandId}:providencia:${row.versao}`,
          demand: noticeOf(row),
          recipients: [row.responsavel_id, ...(await sectorLeadIds(client, row.setor_responsavel_id))],
          actorId: identity.userId,
        })
      }
    })
  }

  /** Etapas em aberto impedem a conclusão: concluir etapas nunca encerra a demanda sozinho. */
  async complete(
    identity: AuthenticatedIdentity,
    demandId: string,
    input: { done: string; result: string | null; notes: string | null; version: number | null },
  ) {
    await transact(this.poolProvider(), async (client) => {
      const row = await lockDemand(client, demandId)
      assertVersion(row, input.version)
      if (row.rascunho) throw conflict('Publique o rascunho antes de concluir.')
      if (terminalStatuses.includes(row.status)) throw conflict('Esta demanda já foi encerrada.')
      const open = await client.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM public.demand_subtasks
          WHERE demand_id = $1 AND status NOT IN ('concluida', 'cancelada')`,
        [demandId],
      )
      if (open.rows[0].total > 0) {
        throw conflict(`Há ${open.rows[0].total} etapa(s) em aberto. Conclua ou cancele as etapas antes de concluir a demanda.`)
      }
      await client.query(
        `UPDATE public.demands
            SET status = 'concluida', conclusao_realizado = $2, conclusao_resultado = $3, conclusao_observacoes = $4,
                concluida_em = now(), concluida_por = $5, aguardando_quem = NULL,
                suspensao_motivo = NULL, suspensao_retomada = NULL
          WHERE id = $1`,
        [demandId, redactOptional(input.done), redactOptional(input.result), redactOptional(input.notes), identity.userId],
      )
      await bump(client, demandId, false)
      await recordDemandHistory(client, { demandId, userId: identity.userId, action: 'concluida', details: { de: row.status, para: 'concluida' } })
      const facts = (await loadFacts(client, demandId)) as DemandFacts
      await notifyDemand(client, {
        kind: 'status',
        key: `${demandId}:status:${row.versao}`,
        demand: noticeOf(row),
        recipients: stakeholders(facts),
        actorId: identity.userId,
      })
    })
  }

  /** A conclusão anterior vai para o histórico, e a demanda volta ao trabalho. */
  async reopen(identity: AuthenticatedIdentity, demandId: string, reason: string) {
    await transact(this.poolProvider(), async (client) => {
      const row = await lockDemand(client, demandId)
      if (row.status !== 'concluida') throw conflict('Só demandas concluídas podem ser reabertas.')
      await client.query(
        `UPDATE public.demands
            SET status = 'em_andamento', conclusao_realizado = NULL, conclusao_resultado = NULL,
                conclusao_observacoes = NULL, concluida_em = NULL, concluida_por = NULL, reaberturas = reaberturas + 1
          WHERE id = $1`,
        [demandId],
      )
      await bump(client, demandId, false)
      await recordDemandHistory(client, {
        demandId,
        userId: identity.userId,
        action: 'reaberta',
        comment: reason,
        details: {
          de: 'concluida',
          para: 'em_andamento',
          conclusaoAnterior: {
            realizado: row.conclusao_realizado,
            resultado: row.conclusao_resultado,
            observacoes: row.conclusao_observacoes,
            em: row.concluida_em,
            por: row.concluida_por_nome,
          },
        },
      })
      const facts = (await loadFacts(client, demandId)) as DemandFacts
      await notifyDemand(client, {
        kind: 'status',
        key: `${demandId}:status:${row.versao}`,
        demand: noticeOf(row),
        recipients: stakeholders(facts),
        actorId: identity.userId,
      })
    })
  }

  async cancel(identity: AuthenticatedIdentity, demandId: string, reason: string) {
    await transact(this.poolProvider(), async (client) => {
      const row = await lockDemand(client, demandId)
      if (row.rascunho) throw conflict('Rascunhos são descartados, e não cancelados.')
      if (terminalStatuses.includes(row.status)) throw conflict('Esta demanda já foi encerrada.')
      await client.query(
        `UPDATE public.demands
            SET status = 'cancelada', cancelamento_motivo = $2, cancelada_em = now(), cancelada_por = $3,
                aguardando_quem = NULL, suspensao_motivo = NULL, suspensao_retomada = NULL
          WHERE id = $1`,
        [demandId, redactOptional(reason), identity.userId],
      )
      await bump(client, demandId, false)
      await recordDemandHistory(client, { demandId, userId: identity.userId, action: 'cancelada', comment: reason, details: { de: row.status, para: 'cancelada' } })
      const facts = (await loadFacts(client, demandId)) as DemandFacts
      await notifyDemand(client, {
        kind: 'status',
        key: `${demandId}:status:${row.versao}`,
        demand: noticeOf(row),
        recipients: stakeholders(facts),
        actorId: identity.userId,
      })
    })
  }

  async addComment(
    identity: AuthenticatedIdentity,
    demandId: string,
    facts: DemandFacts,
    input: { kind: string; text: string; mentions: string[] },
    now = new Date(),
  ) {
    return transact(this.poolProvider(), async (client) => {
      const row = await lockDemand(client, demandId)
      await assertPeople(client, input.mentions)
      await assertCanOpenDemand(client, demandId, input.mentions)
      const directlyInvolved = new Set(
        [facts.createdBy, facts.requesterId, facts.responsibleId, ...facts.participantIds, ...facts.subtaskAssigneeIds].filter(Boolean),
      )
      const outsiders = input.mentions.filter((id) => !directlyInvolved.has(id))
      if (row.restrita && outsiders.length > 0) {
        throw new RequestValidationError('Em demanda restrita, só é possível mencionar quem já está autorizado.')
      }
      // Mencionar traz a pessoa para a conversa: passa a acompanhar e pode abrir a demanda.
      for (const userId of outsiders) {
        await client.query(
          `INSERT INTO public.demand_participants (demand_id, user_id, tipo, adicionado_por)
           VALUES ($1, $2, 'acompanhante', $3) ON CONFLICT DO NOTHING`,
          [demandId, userId, identity.userId],
        )
      }

      const created = await client.query<{ id: string }>(
        `INSERT INTO public.demand_comments (demand_id, tipo, texto, mencoes, autor_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id::text AS id`,
        [demandId, input.kind, redactOptional(input.text), input.mentions, identity.userId],
      )
      await bump(client, demandId, false)
      await recordDemandHistory(client, {
        demandId,
        userId: identity.userId,
        action: 'registro_incluido',
        details: { tipo: input.kind, registro: created.rows[0].id },
      })
      if (input.mentions.length > 0) {
        await notifyDemand(client, {
          kind: 'mencao',
          key: `${demandId}:mencao:${created.rows[0].id}`,
          demand: noticeOf(row),
          recipients: input.mentions,
          actorId: identity.userId,
        })
      }
      // Uma conversa em andamento gera um único aviso a cada dez minutos para quem acompanha.
      const bucket = Math.floor(now.getTime() / 600_000)
      const mentioned = new Set(input.mentions)
      await notifyDemand(client, {
        kind: 'comentario',
        key: `${demandId}:comentario:${bucket}`,
        demand: noticeOf(row),
        recipients: stakeholders(facts).filter((id) => !id || !mentioned.has(id)),
        actorId: identity.userId,
      })
      return created.rows[0].id
    })
  }

  async addSubtask(
    identity: AuthenticatedIdentity,
    demandId: string,
    input: { title: string; description: string | null; responsibleId: string | null; dueDate: string | null; notes: string | null },
  ) {
    return transact(this.poolProvider(), async (client) => {
      const row = await lockDemand(client, demandId)
      if (terminalStatuses.includes(row.status)) throw conflict('Esta demanda já foi encerrada.')
      await assertPeople(client, [input.responsibleId])
      const created = await client.query<{ id: string }>(
        `INSERT INTO public.demand_subtasks (demand_id, titulo, descricao, responsavel_id, prazo, observacoes, criado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
        [demandId, redactOptional(input.title), redactOptional(input.description), input.responsibleId, input.dueDate, redactOptional(input.notes), identity.userId],
      )
      await bump(client, demandId, false)
      await recordDemandHistory(client, {
        demandId,
        userId: identity.userId,
        action: 'etapa_criada',
        details: { etapa: created.rows[0].id, titulo: input.title },
      })
      if (!row.rascunho) {
        await notifyDemand(client, {
          kind: 'atribuicao',
          key: `${demandId}:etapa:${created.rows[0].id}`,
          demand: noticeOf(row),
          recipients: [input.responsibleId],
          actorId: identity.userId,
        })
      }
      return created.rows[0].id
    })
  }

  /** Quem só responde pela etapa altera o andamento e as observações. O resto é de quem administra. */
  async updateSubtask(
    identity: AuthenticatedIdentity,
    demandId: string,
    subtaskId: string,
    input: Partial<{
      title: string
      description: string | null
      responsibleId: string | null
      dueDate: string | null
      notes: string | null
      status: string
    }>,
  ) {
    await transact(this.poolProvider(), async (client) => {
      const row = await lockDemand(client, demandId)
      if (terminalStatuses.includes(row.status)) throw conflict('Esta demanda já foi encerrada.')
      const found = await client.query<Row>(
        `SELECT id::text AS id, titulo, descricao, observacoes, responsavel_id::text AS responsavel_id, status, prazo::text AS prazo
           FROM public.demand_subtasks WHERE id = $1 AND demand_id = $2 FOR UPDATE`,
        [subtaskId, demandId],
      )
      const current = found.rows[0]
      if (!current) throw notFound()
      if (input.responsibleId !== undefined) await assertPeople(client, [input.responsibleId])

      // Só o que muda de fato entra no histórico; sem mudança, nada é gravado.
      const alteracoes: FieldChange[] = []
      const compare = (campo: string, before: unknown, after: unknown) => {
        if (after !== undefined && (before ?? null) !== (after ?? null)) alteracoes.push({ campo, de: before ?? null, para: after ?? null })
      }
      compare('titulo', current.titulo, input.title === undefined ? undefined : redactOptional(input.title))
      compare('descricao', current.descricao, input.description === undefined ? undefined : redactOptional(input.description))
      compare('prazo', current.prazo, input.dueDate)
      compare('observacoes', current.observacoes, input.notes === undefined ? undefined : redactOptional(input.notes))
      compare('status', current.status, input.status)
      if (input.responsibleId !== undefined && input.responsibleId !== current.responsavel_id) {
        const names = await namesOf(client, 'person', [current.responsavel_id, input.responsibleId])
        alteracoes.push({
          campo: 'responsavel',
          de: current.responsavel_id ? (names.get(current.responsavel_id) ?? null) : null,
          para: input.responsibleId ? (names.get(input.responsibleId) ?? null) : null,
          deId: current.responsavel_id,
          paraId: input.responsibleId,
        })
      }
      if (alteracoes.length === 0) return

      const sets: string[] = []
      const values: unknown[] = [subtaskId]
      const set = (column: string, value: unknown) => {
        values.push(value)
        sets.push(`${column} = $${values.length}`)
      }
      if (input.title !== undefined) set('titulo', redactOptional(input.title))
      if (input.description !== undefined) set('descricao', redactOptional(input.description))
      if (input.responsibleId !== undefined) set('responsavel_id', input.responsibleId)
      if (input.dueDate !== undefined) set('prazo', input.dueDate)
      if (input.notes !== undefined) set('observacoes', redactOptional(input.notes))
      if (input.status !== undefined) {
        set('status', input.status)
        set('concluida_em', input.status === 'concluida' ? new Date() : null)
        set('concluida_por', input.status === 'concluida' ? identity.userId : null)
      }
      if (sets.length === 0) return
      await client.query(`UPDATE public.demand_subtasks SET ${sets.join(', ')} WHERE id = $1`, values)
      await bump(client, demandId, false)
      await recordDemandHistory(client, {
        demandId,
        userId: identity.userId,
        action: 'etapa_alterada',
        details: {
          etapa: subtaskId,
          titulo: current.titulo,
          alteracoes,
          campos: alteracoes.map((item) => item.campo),
          statusDe: current.status,
          statusPara: input.status ?? current.status,
        },
      })
      if (input.responsibleId && input.responsibleId !== current.responsavel_id && !row.rascunho) {
        await notifyDemand(client, {
          kind: 'atribuicao',
          key: `${demandId}:etapa:${subtaskId}:${row.versao}`,
          demand: noticeOf(row),
          recipients: [input.responsibleId],
          actorId: identity.userId,
        })
      }
    })
  }

  async addLink(identity: AuthenticatedIdentity, demandId: string, input: { module: LinkModule; protocol: string }) {
    return transact(this.poolProvider(), async (client) => {
      await lockDemand(client, demandId)
      const target = await findLinkTarget(client, identity, input.module, input.protocol)
      if (!target) throw new ModuleError('Registro não encontrado neste módulo, ou sem acesso para você.', 404)
      const duplicate = await client.query(
        `SELECT 1 FROM public.demand_links WHERE demand_id = $1 AND modulo = $2 AND recurso_id = $3 AND removido_em IS NULL`,
        [demandId, input.module, target.id],
      )
      if (duplicate.rowCount) throw conflict('Este registro já está vinculado à demanda.')
      const created = await client.query<{ id: string }>(
        `INSERT INTO public.demand_links (demand_id, modulo, recurso_id, protocolo, criado_por)
         VALUES ($1, $2, $3, $4, $5) RETURNING id::text AS id`,
        [demandId, input.module, target.id, target.protocol, identity.userId],
      )
      await bump(client, demandId, false)
      await recordDemandHistory(client, {
        demandId,
        userId: identity.userId,
        action: 'vinculo_incluido',
        details: { modulo: input.module, protocolo: target.protocol },
      })
      return created.rows[0].id
    })
  }

  async removeLink(identity: AuthenticatedIdentity, demandId: string, linkId: string) {
    await transact(this.poolProvider(), async (client) => {
      await lockDemand(client, demandId)
      const removed = await client.query<{ modulo: string; protocolo: string }>(
        `UPDATE public.demand_links SET removido_em = now(), removido_por = $3
          WHERE id = $1 AND demand_id = $2 AND removido_em IS NULL
          RETURNING modulo, protocolo`,
        [linkId, demandId, identity.userId],
      )
      if (!removed.rows[0]) throw notFound()
      await bump(client, demandId, false)
      await recordDemandHistory(client, {
        demandId,
        userId: identity.userId,
        action: 'vinculo_removido',
        details: { modulo: removed.rows[0].modulo, protocolo: removed.rows[0].protocolo },
      })
    })
  }

  /** O nome do arquivo pode trazer dado pessoal: o histórico guarda só o tipo. */
  async addAttachment(
    identity: AuthenticatedIdentity,
    storage: AttachmentStorage,
    demandId: string,
    input: {
      content: Buffer
      name: string
      kind: string
      category: string
      subtaskId: string | null
    },
  ) {
    const id = randomUUID()
    const storageKey = randomUUID()
    const sha256 = createHash('sha256').update(input.content).digest('hex')
    await storage.save(storageKey, input.content)
    try {
      await transact(this.poolProvider(), async (client) => {
        await lockDemand(client, demandId)
        if (input.subtaskId) {
          const subtask = await client.query(
            `SELECT 1 FROM public.demand_subtasks WHERE id = $1 AND demand_id = $2`,
            [input.subtaskId, demandId],
          )
          if (!subtask.rowCount) throw notFound()
        }
        await client.query(
          `INSERT INTO public.demand_attachments
             (id, demand_id, subtask_id, categoria, nome_original, tipo, tamanho_bytes, sha256, storage_key, enviado_por)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, demandId, input.subtaskId, input.category, input.name, input.kind, input.content.length, sha256, storageKey, identity.userId],
        )
        await bump(client, demandId, false)
        await recordDemandHistory(client, {
          demandId,
          userId: identity.userId,
          action: 'anexo_incluido',
          details: { anexoId: id, tipo: input.kind, categoria: input.category },
        })
        await insertAuthAuditEvent(client, {
          actorUserId: identity.userId,
          actorKind: 'user',
          subjectUserId: null,
          sessionId: demandId,
          eventType: 'attachment_uploaded',
          details: { attachmentId: id, kind: input.kind, module: 'demands' },
        })
      })
    } catch (error) {
      await storage.remove(storageKey).catch(() => undefined)
      throw error
    }
    return id
  }

  async findAttachment(id: string) {
    const { rows } = await this.poolProvider().query<Row>(
      `SELECT id::text AS id, demand_id::text AS demand_id, nome_original, tipo, tamanho_bytes::text AS tamanho_bytes,
              sha256, storage_key, enviado_por::text AS enviado_por, removido_em
         FROM public.demand_attachments WHERE id = $1`,
      [id],
    )
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id as string,
      demandId: row.demand_id as string,
      name: row.nome_original as string,
      kind: row.tipo as string,
      sizeBytes: Number(row.tamanho_bytes),
      sha256: row.sha256 as string,
      storageKey: row.storage_key as string,
      uploadedById: row.enviado_por as string,
      removedAt: row.removido_em as Date | null,
    }
  }

  /** Leitura que só existe por ser administrador do sistema: sempre fica registrada. */
  async recordAdministrativeAccess(identity: AuthenticatedIdentity, demandId: string, what: string) {
    await insertAuthAuditEvent(this.poolProvider(), {
      actorUserId: identity.userId,
      actorKind: 'user',
      subjectUserId: null,
      sessionId: demandId,
      eventType: 'demand_admin_access',
      details: { operation: what },
    })
  }

  async recordAttachmentDownload(identity: AuthenticatedIdentity, id: string, demandId: string) {
    await insertAuthAuditEvent(this.poolProvider(), {
      actorUserId: identity.userId,
      actorKind: 'user',
      subjectUserId: null,
      sessionId: demandId,
      eventType: 'attachment_downloaded',
      details: { attachmentId: id, module: 'demands' },
    })
  }

  /** Remoção lógica: o arquivo e o registro continuam, para a rastreabilidade. */
  async removeAttachment(identity: AuthenticatedIdentity, id: string, demandId: string, reason: string) {
    await transact(this.poolProvider(), async (client) => {
      const removed = await client.query(
        `UPDATE public.demand_attachments
            SET removido_em = now(), removido_por = $2, motivo_remocao = $3
          WHERE id = $1 AND removido_em IS NULL`,
        [id, identity.userId, redactOptional(reason)],
      )
      if (!removed.rowCount) throw conflict('Este anexo já foi removido.')
      await bump(client, demandId, false)
      await recordDemandHistory(client, {
        demandId,
        userId: identity.userId,
        action: 'anexo_removido',
        comment: reason,
        details: { anexoId: id },
      })
      await insertAuthAuditEvent(client, {
        actorUserId: identity.userId,
        actorKind: 'user',
        subjectUserId: null,
        sessionId: demandId,
        eventType: 'attachment_removed',
        details: { attachmentId: id, module: 'demands' },
      })
    })
  }
}

function storedRecurrence(input: ReturnType<typeof readRecurrenceInput>) {
  return { ...input.rule, leadDays: input.leadDays, startOffsetDays: input.startOffsetDays }
}

async function lockDemand(client: Client, demandId: string) {
  const found = await client.query<Row>(
    `SELECT d.id::text AS id, d.numero, d.titulo, d.descricao, d.categoria_id::text AS categoria_id,
            d.setor_origem_id::text AS setor_origem_id, d.setor_responsavel_id::text AS setor_responsavel_id,
            d.solicitante_id::text AS solicitante_id, d.responsavel_id::text AS responsavel_id,
            d.gestor_acompanhamento_id::text AS gestor_id,
            (SELECT u.full_name FROM public.auth_users u WHERE u.id = d.responsavel_id) AS responsavel_nome,
            d.inicio_previsto::text AS inicio_previsto, d.prazo::text AS prazo, d.prioridade, d.status,
            d.rascunho, d.restrita, d.observacoes, d.referencias, d.lembrete_dias, d.versao,
            d.series_id::text AS series_id, d.data_ocorrencia::text AS data_ocorrencia, d.recorrencia_rascunho,
            d.conclusao_realizado, d.conclusao_resultado, d.conclusao_observacoes, d.concluida_em,
            (SELECT u.full_name FROM public.auth_users u WHERE u.id = d.concluida_por) AS concluida_por_nome
       FROM public.demands d
      WHERE d.id = $1 AND d.excluida_em IS NULL
      FOR UPDATE OF d`,
    [demandId],
  )
  if (!found.rows[0]) throw notFound()
  return found.rows[0]
}

function assertVersion(row: Row, expected: number | null) {
  if (expected !== null && row.versao !== expected) {
    throw conflict('Esta demanda foi alterada por outra pessoa. Atualize a página e tente de novo.')
  }
}

async function bump(client: Client, demandId: string, customOccurrence: boolean) {
  await client.query(
    `UPDATE public.demands
        SET versao = versao + 1, ultima_atividade_em = now(),
            ocorrencia_personalizada = ocorrencia_personalizada OR $2
      WHERE id = $1`,
    [demandId, customOccurrence],
  )
}

async function applyFields(client: Client, demandId: string, patch: DemandPatch) {
  const columns: Record<keyof DemandPatch, string> = {
    title: 'titulo',
    description: 'descricao',
    categoryId: 'categoria_id',
    originSectorId: 'setor_origem_id',
    responsibleSectorId: 'setor_responsavel_id',
    startDate: 'inicio_previsto',
    dueDate: 'prazo',
    priority: 'prioridade',
    restricted: 'restrita',
    notes: 'observacoes',
    references: 'referencias',
    reminderDays: 'lembrete_dias',
    followUpManagerId: 'gestor_acompanhamento_id',
  }
  const free = new Set(['title', 'description', 'notes', 'references'])
  const sets: string[] = []
  const values: unknown[] = [demandId]
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    values.push(free.has(key) ? redactOptional(value as string | null) : value)
    sets.push(`${columns[key as keyof DemandPatch]} = $${values.length}`)
  }
  if (sets.length > 0) await client.query(`UPDATE public.demands SET ${sets.join(', ')} WHERE id = $1`, values)
}

async function recordPatchHistory(
  client: Client,
  userId: string,
  demandId: string,
  row: Row,
  patch: DemandPatch,
  scope: 'this' | 'future',
) {
  const alcance = row.series_id ? { alcance: scope === 'future' ? 'esta_e_futuras' : 'somente_esta' } : {}
  // Um registro por campo que mudou de fato, com o valor anterior e o novo.
  for (const change of await nameReferences(client, demandFieldChanges(row, patch))) {
    await recordDemandHistory(client, { demandId, userId, action: actionForField(change.campo), details: { ...change, ...alcance } })
  }
}

const referenceNameSql: Record<'category' | 'sector' | 'person', string> = {
  category: `SELECT id::text AS id, nome AS name FROM public.demand_categories WHERE id = ANY($1::uuid[])`,
  sector: `SELECT id::text AS id, nome AS name FROM public.demand_sectors WHERE id = ANY($1::uuid[])`,
  person: `SELECT id::text AS id, full_name AS name FROM public.auth_users WHERE id = ANY($1::uuid[])`,
}

async function namesOf(client: Client, kind: 'category' | 'sector' | 'person', ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (wanted.length === 0) return new Map<string, string>()
  const { rows } = await client.query<{ id: string; name: string }>(referenceNameSql[kind], [wanted])
  return new Map(rows.map((item) => [item.id, item.name]))
}

/** O nome vigente no momento da alteração fica no registro, junto do identificador. */
async function nameReferences(client: Client, changes: ReturnType<typeof demandFieldChanges>): Promise<FieldChange[]> {
  const result: FieldChange[] = []
  for (const { reference, ...change } of changes) {
    if (!reference) {
      result.push(change)
      continue
    }
    const names = await namesOf(client, reference, [change.deId, change.paraId])
    result.push({ ...change, de: change.deId ? (names.get(change.deId) ?? null) : null, para: change.paraId ? (names.get(change.paraId) ?? null) : null })
  }
  return result
}

async function readCollaborationState(client: Client, demandId: string): Promise<CollaborationState> {
  const people = await client.query<{ user_id: string; tipo: string; atividade: string | null; prazo: string | null }>(
    `SELECT user_id::text AS user_id, tipo, atividade, prazo::text AS prazo FROM public.demand_participants
      WHERE demand_id = $1 AND tipo IN ('colaborador', 'autorizado')`,
    [demandId],
  )
  const sectors = await client.query<{ sector_id: string }>(
    `SELECT sector_id::text AS sector_id FROM public.demand_sector_links WHERE demand_id = $1`,
    [demandId],
  )
  return {
    collaborators: people.rows
      .filter((item) => item.tipo === 'colaborador')
      .map((item) => ({ userId: item.user_id, activity: item.atividade, dueDate: item.prazo })),
    collaboratorSectorIds: sectors.rows.map((item) => item.sector_id),
    authorizedUserIds: people.rows.filter((item) => item.tipo === 'autorizado').map((item) => item.user_id),
  }
}

/** Cada pessoa ou setor incluído ou retirado vira um registro próprio, com o nome. */
async function recordCollaborationChanges(
  client: Client,
  demandId: string,
  userId: string,
  before: CollaborationState,
  after: CollaborationState,
  extra: Record<string, unknown> = {},
) {
  const events = collaborationChanges(before, after)
  if (events.length === 0) return
  const people = await namesOf(client, 'person', events.map((item) => ('userId' in item ? item.userId : null)))
  const sectors = await namesOf(client, 'sector', events.map((item) => ('sectorId' in item ? item.sectorId : null)))
  for (const event of events) {
    const { action, ...rest } = event
    const details =
      'sectorId' in rest
        ? { setorId: rest.sectorId, setor: sectors.get(rest.sectorId) ?? null }
        : {
            pessoaId: rest.userId,
            pessoa: people.get(rest.userId) ?? null,
            ...('atividade' in rest ? { atividade: rest.atividade, prazo: rest.prazo } : {}),
            ...('alteracoes' in rest ? { alteracoes: rest.alteracoes, campos: rest.alteracoes.map((item) => item.campo) } : {}),
          }
    await recordDemandHistory(client, { demandId, userId, action, details: { ...details, ...extra } })
  }
}

async function mergeTemplate(client: Client, seriesId: string, values: Record<string, unknown>) {
  await client.query(`UPDATE public.demand_series SET modelo = modelo || $2::jsonb WHERE id = $1`, [
    seriesId,
    JSON.stringify(values),
  ])
}

async function buildTemplate(client: Client, demandId: string): Promise<SeriesTemplate> {
  const found = await client.query<Row>(
    `SELECT d.titulo, d.descricao, d.categoria_id::text AS categoria_id, d.setor_origem_id::text AS setor_origem_id,
            d.setor_responsavel_id::text AS setor_responsavel_id, d.solicitante_id::text AS solicitante_id,
            d.responsavel_id::text AS responsavel_id, d.gestor_acompanhamento_id::text AS gestor_id,
            d.prioridade, d.restrita, d.observacoes, d.referencias, d.lembrete_dias,
            ARRAY(SELECT l.sector_id::text FROM public.demand_sector_links l WHERE l.demand_id = d.id) AS setores
       FROM public.demands d WHERE d.id = $1`,
    [demandId],
  )
  const row = found.rows[0]
  const people = await client.query<{ user_id: string; tipo: string; atividade: string | null }>(
    `SELECT user_id::text AS user_id, tipo, atividade FROM public.demand_participants
      WHERE demand_id = $1 AND tipo IN ('colaborador', 'autorizado')`,
    [demandId],
  )
  return {
    title: row.titulo,
    description: row.descricao,
    categoryId: row.categoria_id,
    originSectorId: row.setor_origem_id,
    responsibleSectorId: row.setor_responsavel_id,
    requesterId: row.solicitante_id,
    responsibleId: row.responsavel_id,
    followUpManagerId: row.gestor_id,
    priority: row.prioridade,
    restricted: row.restrita,
    notes: row.observacoes,
    references: row.referencias,
    reminderDays: row.lembrete_dias,
    collaborators: people.rows
      .filter((item) => item.tipo === 'colaborador')
      .map((item) => ({ userId: item.user_id, activity: item.atividade })),
    collaboratorSectorIds: row.setores,
    authorizedUserIds: people.rows.filter((item) => item.tipo === 'autorizado').map((item) => item.user_id),
  }
}

/** Mesmas regras de leitura de cada módulo: quem não abre o registro também não o vincula. */
async function findLinkTarget(client: Client, identity: AuthenticatedIdentity, module: LinkModule, protocol: string) {
  const clean = protocol.trim()
  if (module === 'warehouse') {
    const { rows } = await client.query<{ id: string; protocolo: string; solicitante_id: string }>(
      `SELECT r.id::text AS id, ${protocolSql('r')} AS protocolo, r.solicitante_id::text AS solicitante_id
         FROM public.material_requests r
        WHERE upper(${protocolSql('r')}) = upper($1) LIMIT 1`,
      [clean],
    )
    const row = rows[0]
    if (!row) return null
    const allowed =
      identity.permissions.includes('warehouse:read') &&
      (holdsPermission(identity, 'warehouse:manage') ||
        identity.permissions.includes('requests:read_all') ||
        row.solicitante_id === identity.userId)
    return allowed ? { id: row.id, protocol: row.protocolo } : null
  }
  const { rows } = await client.query<{ id: string; protocolo: string; solicitante_id: string }>(
    `SELECT r.id::text AS id, ${protocolSql('r')} AS protocolo, r.solicitante_id::text AS solicitante_id
       FROM public.service_requests r
      WHERE r.tipo = $1 AND upper(${protocolSql('r')}) = upper($2) LIMIT 1`,
    [moduleByType[module], clean],
  )
  const row = rows[0]
  if (!row) return null
  return canReadRequest(identity, { module, requesterId: row.solicitante_id })
    ? { id: row.id, protocol: row.protocolo }
    : null
}

