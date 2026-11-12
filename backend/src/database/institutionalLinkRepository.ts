import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import type { DirectorateRole } from '../demands/demandPolicy.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { ModuleError, notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'
import { sortByName } from './naturalOrder.js'

type Client = Pick<PoolClient, 'query'>

/**
 * Vínculos institucionais de uma pessoa: DA e setores de atuação. São independentes da lotação e da
 * equipe SLM, e somam. Retirar um vínculo é lógico: ações e históricos antigos não mudam.
 */

export type SectorLinkInput = {
  sectorId: string
  role: 'colaborador' | 'responsavel'
  chefia: boolean
  function: string | null
  canCreate: boolean
  seesSector: boolean
}

export type InstitutionalInput = {
  directorate: { role: DirectorateRole; function: string | null } | null
  sectors: SectorLinkInput[]
}

// Os dois primeiros só explicam registros antigos: esses papéis não dão acesso nem podem ser definidos.
const directorateRoleLabels: Record<string, string> = {
  integrante: 'Integrante',
  consulta: 'Somente consulta',
  diretor: 'Diretor',
}

const memberRoleLabels = { colaborador: 'Colaborador', responsavel: 'Responsável pelo setor' }

function describeMember(input: { role: 'colaborador' | 'responsavel'; chefia: boolean; function: string | null }) {
  return [input.chefia ? 'Chefia' : memberRoleLabels[input.role], input.function].filter(Boolean).join(' · ')
}

function audit(client: Client, actorId: string, userId: string, details: Record<string, string>) {
  return insertAuthAuditEvent(client, {
    actorUserId: actorId,
    actorKind: 'user',
    subjectUserId: userId,
    sessionId: null,
    eventType: 'institutional_link_changed',
    details,
  })
}

/** Só o que mudou gera registro. */
async function applyDirectorateLink(client: Client, actorId: string, userId: string, directorate: InstitutionalInput['directorate']) {
  const previousLink = await client.query<{ ativo: boolean; papel_demandas: DirectorateRole; funcao: string | null }>(
    `SELECT ativo, papel_demandas, funcao FROM public.user_directorate_links WHERE user_id = $1 FOR UPDATE`,
    [userId],
  )
  const link = previousLink.rows[0]?.ativo ? previousLink.rows[0] : null

  if (directorate) {
    const { role, function: fn } = directorate
    if (!link || link.papel_demandas !== role || link.funcao !== fn) {
      await client.query(
        `INSERT INTO public.user_directorate_links (user_id, ativo, papel_demandas, funcao, atualizado_por)
         VALUES ($1, true, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE
           SET ativo = true, papel_demandas = EXCLUDED.papel_demandas, funcao = EXCLUDED.funcao,
               atualizado_por = EXCLUDED.atualizado_por`,
        [userId, role, fn, actorId],
      )
      await audit(client, actorId, userId, {
        operation: link ? 'Alteração' : 'Inclusão',
        link: 'Diretoria Administrativa',
        ...(link ? { from: directorateRoleLabels[link.papel_demandas] } : {}),
        to: [directorateRoleLabels[role], fn].filter(Boolean).join(' · '),
      })
    }
  } else if (link) {
    await client.query(
      `UPDATE public.user_directorate_links SET ativo = false, atualizado_por = $2 WHERE user_id = $1`,
      [userId, actorId],
    )
    await audit(client, actorId, userId, {
      operation: 'Retirada',
      link: 'Diretoria Administrativa',
      from: directorateRoleLabels[link.papel_demandas],
    })
  }
}

/** Roda na transação de quem chama, inclusive na da aprovação. */
export async function applyInstitutionalLinks(client: Client, actorId: string, userId: string, input: InstitutionalInput) {
  await applyDirectorateLink(client, actorId, userId, input.directorate)

  const current = await client.query<{
    sector_id: string
    nome: string
    papel: 'colaborador' | 'responsavel'
    chefia: boolean
    funcao: string | null
    pode_cadastrar: boolean
    ver_setor: boolean
  }>(
    `SELECT m.sector_id::text AS sector_id, s.nome, m.papel, m.chefia, m.funcao, m.pode_cadastrar, m.ver_setor
       FROM public.demand_sector_members m
       JOIN public.demand_sectors s ON s.id = m.sector_id
      WHERE m.user_id = $1 AND m.ativo
      FOR UPDATE OF m`,
    [userId],
  )
  const wanted = new Set(input.sectors.map((item) => item.sectorId))

  for (const row of current.rows.filter((item) => !wanted.has(item.sector_id))) {
    await client.query(
      `UPDATE public.demand_sector_members SET ativo = false WHERE sector_id = $1 AND user_id = $2`,
      [row.sector_id, userId],
    )
    await audit(client, actorId, userId, { operation: 'Retirada', link: `Setor ${row.nome}` })
  }

  for (const item of input.sectors) {
    const before = current.rows.find((row) => row.sector_id === item.sectorId)
    const sector = await client.query<{ nome: string; ativo: boolean }>(
      `SELECT nome, ativo FROM public.demand_sectors WHERE id = $1`,
      [item.sectorId],
    )
    if (!sector.rows[0]) throw new ModuleError('Setor de atuação inválido.', 400)
    if (!before && !sector.rows[0].ativo) throw new ModuleError('Setor de atuação desativado.', 400)

    // Chefia sempre responde pelo setor: o acesso continua vindo de um só lugar.
    const role = item.chefia ? 'responsavel' : item.role
    const next = { ...item, role }
    const changed =
      !before ||
      before.papel !== role ||
      before.chefia !== item.chefia ||
      before.funcao !== item.function ||
      before.pode_cadastrar !== item.canCreate ||
      before.ver_setor !== item.seesSector
    if (!changed) continue

    await client.query(
      `INSERT INTO public.demand_sector_members
         (sector_id, user_id, papel, chefia, funcao, pode_cadastrar, ver_setor, ativo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       ON CONFLICT (sector_id, user_id) DO UPDATE
         SET papel = EXCLUDED.papel, chefia = EXCLUDED.chefia, funcao = EXCLUDED.funcao,
             pode_cadastrar = EXCLUDED.pode_cadastrar, ver_setor = EXCLUDED.ver_setor, ativo = true`,
      [item.sectorId, userId, role, item.chefia, item.function, item.canCreate, item.seesSector],
    )
    await audit(client, actorId, userId, {
      operation: before ? 'Alteração' : 'Inclusão',
      link: `Setor ${sector.rows[0].nome}`,
      ...(before ? { from: describeMember({ role: before.papel, chefia: before.chefia, function: before.funcao }) } : {}),
      to: describeMember(next),
    })
  }
}

/** Banco sem a migração 015 ou 014: as telas seguem funcionando, sem esses campos. */
function isMissingSchema(error: unknown) {
  const code = (error as { code?: unknown }).code
  return code === '42P01' || code === '42703'
}

export class InstitutionalLinkRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async options() {
    const pool = this.poolProvider()
    const lotations = await pool.query<{ nome: string }>(`SELECT nome FROM public.setores WHERE ativo ORDER BY nome`)
    try {
      const sectors = await pool.query<{ id: string; nome: string; e_slm: boolean }>(
        `SELECT id::text AS id, nome, e_slm FROM public.demand_sectors WHERE ativo ORDER BY ordem, nome`,
      )
      await pool.query(`SELECT 1 FROM public.user_directorate_links LIMIT 0`)
      return {
        available: true,
        lotations: sortByName(lotations.rows, (row) => row.nome).map((row) => row.nome),
        sectors: sortByName(sectors.rows, (row) => row.nome).map((row) => ({ id: row.id, name: row.nome, isSlm: row.e_slm })),
      }
    } catch (error) {
      if (!isMissingSchema(error)) throw error
      return { available: false, lotations: lotations.rows.map((row) => row.nome), sectors: [] }
    }
  }

  async read(userId: string) {
    const pool = this.poolProvider()
    const [link, sectors] = await Promise.all([
      pool.query<{ papel_demandas: DirectorateRole; funcao: string | null }>(
        `SELECT papel_demandas, funcao FROM public.user_directorate_links WHERE user_id = $1 AND ativo`,
        [userId],
      ),
      pool.query<{
        sector_id: string
        nome: string
        papel: 'colaborador' | 'responsavel'
        chefia: boolean
        funcao: string | null
        pode_cadastrar: boolean
        ver_setor: boolean
      }>(
        `SELECT m.sector_id::text AS sector_id, s.nome, m.papel, m.chefia, m.funcao, m.pode_cadastrar, m.ver_setor
           FROM public.demand_sector_members m
           JOIN public.demand_sectors s ON s.id = m.sector_id
          WHERE m.user_id = $1 AND m.ativo
          ORDER BY s.ordem, s.nome`,
        [userId],
      ),
    ])
    return {
      directorate: link.rows[0] ? { role: link.rows[0].papel_demandas, function: link.rows[0].funcao } : null,
      sectors: sectors.rows.map((row) => ({
        sectorId: row.sector_id,
        sectorName: row.nome,
        role: row.papel,
        chefia: row.chefia,
        function: row.funcao,
        canCreate: row.pode_cadastrar,
        seesSector: row.ver_setor,
      })),
    }
  }

  async overview(userId: string) {
    const options = await this.options()
    return { options, links: options.available ? await this.read(userId) : { directorate: null, sectors: [] } }
  }

  /** Só o administrador altera, e nunca os próprios vínculos, como no perfil e nas permissões. */
  async update(actor: AuthenticatedIdentity, userId: string, input: InstitutionalInput) {
    if (actor.role !== 'administrator') throw new ModuleError('Somente um administrador altera vínculos.', 403)
    if (actor.userId === userId) throw new ModuleError('Você não pode alterar os próprios vínculos.', 403)
    await withTransaction(this.poolProvider(), async (client) => {
      const target = await client.query<{ status: string }>(`SELECT status FROM public.auth_users WHERE id = $1 FOR UPDATE`, [userId])
      if (!target.rows[0]) throw notFound()
      if (target.rows[0].status !== 'approved') throw new ModuleError('Só contas ativas recebem vínculos.', 409)
      await applyInstitutionalLinks(client, actor.userId, userId, input)
    })
  }

  /** Integrantes e gestores da DA, para a tela de Configurações. */
  async listDirectorate() {
    const { rows } = await this.poolProvider().query<{
      user_id: string
      full_name: string
      email: string
      papel_demandas: DirectorateRole
      funcao: string | null
      status: string
    }>(
      `SELECT l.user_id::text AS user_id, u.full_name, u.email, l.papel_demandas, l.funcao, u.status
         FROM public.user_directorate_links l
         JOIN public.auth_users u ON u.id = l.user_id
        WHERE l.ativo
        ORDER BY u.full_name`,
    )
    return rows.map((row) => ({
      userId: row.user_id,
      name: row.full_name,
      email: row.email,
      role: row.papel_demandas,
      function: row.funcao,
      accountActive: row.status === 'approved',
    }))
  }

  /**
   * Configurar o módulo define integrantes. O diretor vê e edita todos os setores:
   * conceder esse papel é só do administrador, e ninguém altera o próprio vínculo.
   */
  async setDirectorateLink(
    actor: AuthenticatedIdentity,
    userId: string,
    input: { role: DirectorateRole; function: string | null } | null,
  ) {
    if (actor.userId === userId) throw new ModuleError('Você não pode alterar o próprio vínculo.', 403)
    if (input?.role === 'diretor' && actor.role !== 'administrator') {
      throw new ModuleError('Somente um administrador define diretores.', 403)
    }
    await withTransaction(this.poolProvider(), async (client) => {
      const target = await client.query<{ status: string }>(`SELECT status FROM public.auth_users WHERE id = $1 FOR UPDATE`, [userId])
      if (!target.rows[0]) throw notFound()
      if (input && target.rows[0].status !== 'approved') throw new ModuleError('Só contas ativas recebem vínculos.', 409)
      const existing = await client.query<{ ativo: boolean; papel_demandas: DirectorateRole; funcao: string | null }>(
        `SELECT ativo, papel_demandas, funcao FROM public.user_directorate_links WHERE user_id = $1`,
        [userId],
      )
      const before = existing.rows[0]?.ativo ? existing.rows[0] : null
      if (!input && !before) throw notFound()
      if (before?.papel_demandas === 'diretor' && actor.role !== 'administrator') {
        throw new ModuleError('Somente um administrador altera diretores.', 403)
      }
      await applyDirectorateLink(client, actor.userId, userId, input)
    })
  }
}
