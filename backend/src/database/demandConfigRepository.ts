import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import type { DemandContextData, DemandMembership } from '../demands/demandPolicy.js'
import { accessSql, isAccessSchemaMigrated, resolveAccess } from './accessSchema.js'
import type { AccessRow } from './accessSchema.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { conflict, notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'
import { sortByName } from './naturalOrder.js'

type Client = Pick<PoolClient, 'query'>

/** Setores, integrantes, categorias e preferências. Nomes e pessoas nunca ficam no código. */

export async function loadMemberships(client: Client, userId: string): Promise<DemandMembership[]> {
  const { rows } = await client.query<{
    sector_id: string
    nome: string
    papel: 'colaborador' | 'responsavel'
    ativo: boolean
  }>(
    `SELECT m.sector_id::text AS sector_id, s.nome, m.papel, s.ativo
       FROM public.demand_sector_members m
       JOIN public.demand_sectors s ON s.id = m.sector_id
      WHERE m.user_id = $1 AND m.ativo
      ORDER BY s.ordem, s.nome`,
    [userId],
  )
  return rows.map((row) => ({
    sectorId: row.sector_id,
    sectorName: row.nome,
    role: row.papel,
    sectorActive: row.ativo,
  }))
}

/** Tudo que o banco sabe sobre os vínculos da pessoa, lido a cada requisição. */
export async function loadDemandContextData(client: Client, userId: string): Promise<DemandContextData> {
  const [memberships, link] = await Promise.all([
    loadMemberships(client, userId),
    client.query<{ papel_demandas: string }>(
      `SELECT papel_demandas FROM public.user_directorate_links WHERE user_id = $1 AND ativo`,
      [userId],
    ),
  ])
  return { memberships, directorateRole: link.rows[0]?.papel_demandas ?? null }
}

/** Quem tem a permissão de gestor. A regra é a mesma da sessão: perfil, concessões e retiradas. */
export async function loadDirectorateUserIds(client: Client) {
  const sql = accessSql(await isAccessSchemaMigrated(client))
  const { rows } = await client.query<AccessRow & { id: string }>(
    `SELECT u.id::text AS id, ${sql.columns}
       FROM public.auth_users u
       ${sql.join}
      WHERE u.status = 'approved'`,
  )
  return rows
    .filter((row) => resolveAccess(row)?.permissions.includes('demands:directorate'))
    .map((row) => row.id)
}

/** Pessoas que podem receber uma demanda: integrantes de setores e diretores. */
export async function loadDemandPeople(client: Client) {
  const directorate = await loadDirectorateUserIds(client)
  const { rows } = await client.query<{ id: string; full_name: string; sector_ids: string[]; gestor: boolean }>(
    `SELECT u.id::text AS id, u.full_name,
            ARRAY(
              SELECT m.sector_id::text FROM public.demand_sector_members m
                JOIN public.demand_sectors s ON s.id = m.sector_id
               WHERE m.user_id = u.id AND m.ativo AND s.ativo
            ) AS sector_ids,
            u.id = ANY($1::uuid[]) OR coalesce(l.ativo AND l.papel_demandas = 'diretor', false) AS gestor
       FROM public.auth_users u
       LEFT JOIN public.user_directorate_links l ON l.user_id = u.id
      WHERE u.status = 'approved'
        AND (u.id = ANY($1::uuid[])
             OR coalesce(l.ativo AND l.papel_demandas = 'diretor', false)
             OR EXISTS (SELECT 1 FROM public.demand_sector_members m
                          JOIN public.demand_sectors s ON s.id = m.sector_id
                         WHERE m.user_id = u.id AND m.ativo AND s.ativo))
      ORDER BY u.full_name`,
    [directorate],
  )
  return rows.map((row) => ({ id: row.id, name: row.full_name, sectorIds: row.sector_ids, isManager: row.gestor }))
}

const sectorSelect = `
  SELECT s.id::text AS id, s.nome, s.sigla, s.descricao, s.ativo, s.ordem, s.e_slm
    FROM public.demand_sectors s`

function presentSector(row: { id: string; nome: string; sigla: string | null; descricao: string | null; ativo: boolean; ordem: number; e_slm: boolean }) {
  return { id: row.id, name: row.nome, acronym: row.sigla, description: row.descricao, active: row.ativo, order: row.ordem, isSlm: row.e_slm }
}

export type SectorInput = { name: string; acronym: string | null; description: string | null; order: number; isSlm: boolean }
export type MemberInput = { role: 'colaborador' | 'responsavel'; canCreate: boolean; seesSector: boolean; chefia: boolean; function: string | null }
export type CategoryInput = { name: string; description: string | null; order: number }

export class DemandConfigRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  private audit(client: Client, actor: AuthenticatedIdentity, details: Record<string, string>, resourceId: string | null, subject: string | null = null) {
    return insertAuthAuditEvent(client, {
      actorUserId: actor.userId,
      actorKind: 'user',
      subjectUserId: subject,
      sessionId: resourceId,
      eventType: 'demand_config_changed',
      details,
    })
  }

  async listActiveOptions() {
    const pool = this.poolProvider()
    const [sectors, categories, people] = await Promise.all([
      pool.query(`${sectorSelect} WHERE s.ativo ORDER BY s.ordem, s.nome`),
      pool.query(
        `SELECT id::text AS id, nome, descricao FROM public.demand_categories
          WHERE ativo ORDER BY ordem, nome`,
      ),
      loadDemandPeople(pool),
    ])
    return {
      // Setores em ordem alfabética (não há ordem manual para eles na tela); categorias seguem a
      // ordem definida em Configurações.
      sectors: sortByName(sectors.rows, (row) => String(row.nome)).map(presentSector),
      categories: categories.rows.map((row) => ({ id: row.id, name: row.nome, description: row.descricao })),
      people,
    }
  }

  async listSectors() {
    const pool = this.poolProvider()
    const [sectors, members] = await Promise.all([
      pool.query(`${sectorSelect} ORDER BY s.ordem, s.nome`),
      pool.query<{
        sector_id: string
        user_id: string
        full_name: string
        email: string
        papel: string
        pode_cadastrar: boolean
        ver_setor: boolean
        chefia: boolean
        funcao: string | null
        status: string
      }>(
        `SELECT m.sector_id::text AS sector_id, m.user_id::text AS user_id, u.full_name, u.email,
                m.papel, m.pode_cadastrar, m.ver_setor, m.chefia, m.funcao, u.status
           FROM public.demand_sector_members m
           JOIN public.auth_users u ON u.id = m.user_id
          WHERE m.ativo
          ORDER BY u.full_name`,
      ),
    ])
    return sortByName(sectors.rows, (row) => String(row.nome)).map((row) => ({
      ...presentSector(row),
      members: members.rows
        .filter((member) => member.sector_id === row.id)
        .map((member) => ({
          userId: member.user_id,
          name: member.full_name,
          email: member.email,
          role: member.papel,
          canCreate: member.pode_cadastrar,
          seesSector: member.ver_setor,
          chefia: member.chefia,
          function: member.funcao,
          accountActive: member.status === 'approved',
        })),
    }))
  }

  async createSector(actor: AuthenticatedIdentity, input: SectorInput) {
    return withTransaction(this.poolProvider(), async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO public.demand_sectors (nome, sigla, descricao, ordem, e_slm)
         VALUES ($1, $2, $3, $4, $5) RETURNING id::text AS id`,
        [input.name, input.acronym, input.description, input.order, input.isSlm],
      )
      await this.audit(client, actor, { item: 'setor', action: 'criado', name: input.name }, created.rows[0].id)
      return created.rows[0].id
    })
  }

  async updateSector(actor: AuthenticatedIdentity, id: string, input: SectorInput & { active: boolean }) {
    await withTransaction(this.poolProvider(), async (client) => {
      const updated = await client.query(
        `UPDATE public.demand_sectors SET nome = $2, sigla = $3, descricao = $4, ordem = $5, ativo = $6, e_slm = $7 WHERE id = $1`,
        [id, input.name, input.acronym, input.description, input.order, input.active, input.isSlm],
      )
      if (!updated.rowCount) throw notFound()
      await this.audit(client, actor, { item: 'setor', action: input.active ? 'alterado' : 'desativado', name: input.name }, id)
    })
  }

  /** Busca contas aprovadas para incluir em um setor. Só o nome e o e-mail. */
  async searchUsers(term: string) {
    const { rows } = await this.poolProvider().query<{ id: string; full_name: string; email: string; sector: string | null }>(
      `SELECT id::text AS id, full_name, email, sector
         FROM public.auth_users
        WHERE status = 'approved'
          AND ($1 = '' OR full_name ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%')
        ORDER BY full_name LIMIT 30`,
      [term.replace(/[\\%_]/g, '\\$&')],
    )
    return rows.map((row) => ({ id: row.id, name: row.full_name, email: row.email, sector: row.sector }))
  }

  async setMember(actor: AuthenticatedIdentity, sectorId: string, userId: string, input: MemberInput) {
    await withTransaction(this.poolProvider(), async (client) => {
      const sector = await client.query(`SELECT 1 FROM public.demand_sectors WHERE id = $1`, [sectorId])
      const user = await client.query(`SELECT 1 FROM public.auth_users WHERE id = $1 AND status = 'approved'`, [userId])
      if (!sector.rowCount || !user.rowCount) throw notFound()
      // Chefia sempre responde pelo setor: o acesso continua vindo de um só lugar.
      const role = input.chefia ? 'responsavel' : input.role
      await client.query(
        `INSERT INTO public.demand_sector_members (sector_id, user_id, papel, pode_cadastrar, ver_setor, chefia, funcao, ativo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)
         ON CONFLICT (sector_id, user_id) DO UPDATE
           SET papel = EXCLUDED.papel, pode_cadastrar = EXCLUDED.pode_cadastrar,
               ver_setor = EXCLUDED.ver_setor, chefia = EXCLUDED.chefia, funcao = EXCLUDED.funcao, ativo = true`,
        [sectorId, userId, role, input.canCreate, input.seesSector, input.chefia, input.function],
      )
      await this.audit(client, actor, { item: 'integrante', action: input.chefia ? 'chefia definida' : 'definido', linkRole: role }, sectorId, userId)
    })
  }

  async removeMember(actor: AuthenticatedIdentity, sectorId: string, userId: string) {
    await withTransaction(this.poolProvider(), async (client) => {
      const removed = await client.query(
        `UPDATE public.demand_sector_members SET ativo = false
          WHERE sector_id = $1 AND user_id = $2 AND ativo`,
        [sectorId, userId],
      )
      if (!removed.rowCount) throw notFound()
      await this.audit(client, actor, { item: 'integrante', action: 'removido' }, sectorId, userId)
    })
  }

  async listCategories() {
    const { rows } = await this.poolProvider().query(
      `SELECT c.id::text AS id, c.nome, c.descricao, c.ativo, c.ordem,
              (SELECT count(*)::int FROM public.demands d WHERE d.categoria_id = c.id AND d.excluida_em IS NULL) AS uso
         FROM public.demand_categories c
        ORDER BY c.ordem, c.nome`,
    )
    return rows.map((row) => ({
      id: row.id,
      name: row.nome,
      description: row.descricao,
      active: row.ativo,
      order: row.ordem,
      usage: row.uso,
    }))
  }

  async createCategory(actor: AuthenticatedIdentity, input: CategoryInput) {
    return withTransaction(this.poolProvider(), async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO public.demand_categories (nome, descricao, ordem) VALUES ($1, $2, $3) RETURNING id::text AS id`,
        [input.name, input.description, input.order],
      )
      await this.audit(client, actor, { item: 'categoria', action: 'criada', name: input.name }, created.rows[0].id)
      return created.rows[0].id
    })
  }

  /** Desativar só tira a categoria dos novos formulários: as demandas continuam apontando para ela. */
  async updateCategory(actor: AuthenticatedIdentity, id: string, input: CategoryInput & { active: boolean }) {
    await withTransaction(this.poolProvider(), async (client) => {
      const updated = await client.query(
        `UPDATE public.demand_categories SET nome = $2, descricao = $3, ordem = $4, ativo = $5 WHERE id = $1`,
        [id, input.name, input.description, input.order, input.active],
      )
      if (!updated.rowCount) throw notFound()
      await this.audit(client, actor, { item: 'categoria', action: input.active ? 'alterada' : 'desativada', name: input.name }, id)
    })
  }

  async readPreferences(userId: string) {
    const { rows } = await this.poolProvider().query<{ lembrete_dias: number; silenciados: string[]; email: boolean }>(
      `SELECT lembrete_dias, silenciados, email FROM public.demand_notification_preferences WHERE user_id = $1`,
      [userId],
    )
    const row = rows[0]
    return { reminderDays: row?.lembrete_dias ?? 3, muted: row?.silenciados ?? [], email: row?.email ?? false }
  }

  async savePreferences(userId: string, input: { reminderDays: number; muted: string[]; email: boolean }) {
    await this.poolProvider().query(
      `INSERT INTO public.demand_notification_preferences (user_id, lembrete_dias, silenciados, email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET lembrete_dias = EXCLUDED.lembrete_dias, silenciados = EXCLUDED.silenciados, email = EXCLUDED.email`,
      [userId, input.reminderDays, input.muted, input.email],
    )
  }
}

/** Nome duplicado vira mensagem clara, em vez da mensagem genérica de registro repetido. */
export function duplicatedName(error: unknown, label: string) {
  const code = (error as { code?: unknown; cause?: { code?: unknown } })?.cause?.code
  return code === '23505' ? conflict(`Já existe ${label} com esse nome.`) : error
}
