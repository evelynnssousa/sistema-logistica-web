import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { classifyRead, normalizeAssetNumber, situationLabels } from '../requests/patrimonyRules.js'
import type { AssetInput, AssetSituation, CheckReadResult, ImportLine } from '../requests/patrimonyRules.js'
import { likePattern } from '../requests/validation.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import type { AuthAuditEventType } from './authAuditRepository.js'
import { conflict, ModuleError, notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'

/**
 * Patrimônio (023). Só quem tem patrimony:manage chega aqui (conferido nas rotas). Cada mudança de
 * bem gera uma linha permanente em patrimony_movements; cada leitura de conferência, uma linha
 * permanente em patrimony_check_reads.
 */

type Client = Pick<PoolClient, 'query'>
type Actor = AuthenticatedIdentity

const pageSize = 50
const normalizedSql = (column: string) => `upper(regexp_replace(${column}, '[^A-Za-z0-9]', '', 'g'))`

async function audit(client: Client, actor: Actor, eventType: AuthAuditEventType, resourceId: string, details: Record<string, string>) {
  await insertAuthAuditEvent(client, {
    actorUserId: actor.userId,
    actorKind: 'user',
    subjectUserId: null,
    sessionId: resourceId,
    eventType,
    details,
  })
}

type AssetRow = {
  id: string
  numero: string
  descricao: string
  setor_id: string | null
  setor_nome: string | null
  sala: string | null
  situacao: AssetSituation
  marca: string | null
  modelo: string | null
  numero_serie: string | null
  data_tombamento: string | null
  valor_aquisicao: string | null
  nota_fiscal: string | null
  fornecedor: string | null
  observacao: string | null
  ultima_conferencia_em: Date | null
  ultima_conferencia_por_nome: string | null
  criado_por_nome: string | null
  created_at: Date
  updated_at: Date
}

const assetSelect = `
  SELECT a.id::text AS id, a.numero, a.descricao, a.setor_id::text AS setor_id, s.nome AS setor_nome, a.sala,
         a.situacao, a.marca, a.modelo, a.numero_serie, to_char(a.data_tombamento, 'YYYY-MM-DD') AS data_tombamento,
         a.valor_aquisicao, a.nota_fiscal, a.fornecedor, a.observacao, a.ultima_conferencia_em,
         uc.full_name AS ultima_conferencia_por_nome, cu.full_name AS criado_por_nome, a.created_at, a.updated_at
    FROM public.patrimony_assets a
    LEFT JOIN public.setores s ON s.id = a.setor_id
    LEFT JOIN public.auth_users uc ON uc.id = a.ultima_conferencia_por
    LEFT JOIN public.auth_users cu ON cu.id = a.criado_por`

function presentAsset(row: AssetRow) {
  return {
    id: row.id,
    number: row.numero,
    description: row.descricao,
    sectorId: row.setor_id,
    sector: row.setor_nome,
    room: row.sala,
    situation: row.situacao,
    situationLabel: situationLabels[row.situacao],
    brand: row.marca,
    model: row.modelo,
    serialNumber: row.numero_serie,
    registeredOn: row.data_tombamento,
    acquisitionValue: row.valor_aquisicao === null ? null : Number(row.valor_aquisicao),
    invoice: row.nota_fiscal,
    supplier: row.fornecedor,
    note: row.observacao,
    lastCheckAt: row.ultima_conferencia_em,
    lastCheckBy: row.ultima_conferencia_por_nome,
    createdBy: row.criado_por_nome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export type PatrimonyAsset = ReturnType<typeof presentAsset>

/** Nome dos campos no histórico. O valor de aquisição aparece só como "alterado". */
const fieldLabels: Record<string, string> = {
  number: 'Número do patrimônio',
  description: 'Descrição',
  brand: 'Marca',
  model: 'Modelo',
  serialNumber: 'Número de série',
  registeredOn: 'Data em que foi patrimoniado',
  acquisitionValue: 'Valor de aquisição',
  invoice: 'Nota fiscal',
  supplier: 'Fornecedor',
  note: 'Observação',
}

export class PatrimonyRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async schemaReady() {
    const { rows } = await this.poolProvider().query<{ ok: boolean }>(
      `SELECT to_regclass('public.patrimony_assets') IS NOT NULL AS ok`,
    )
    return rows[0].ok
  }

  async requireSchema() {
    if (!(await this.schemaReady())) {
      throw new ModuleError('O Patrimônio depende da migração 023, ainda não aplicada neste banco.', 409, 'MIGRATION_PENDING')
    }
  }

  async sectors() {
    const { rows } = await this.poolProvider().query<{ id: string; nome: string; sigla: string | null }>(
      `SELECT id::text AS id, nome, sigla FROM public.setores WHERE ativo ORDER BY lower(nome)`,
    )
    return rows.map((row) => ({ id: row.id, name: row.nome, acronym: row.sigla }))
  }

  /** Salas já usadas, para a tela sugerir e evitar "Sala 1" e "sala 01" para o mesmo lugar. */
  async rooms() {
    const { rows } = await this.poolProvider().query<{ setor_id: string | null; sala: string }>(
      `SELECT DISTINCT ON (setor_id, lower(sala)) setor_id::text AS setor_id, sala
         FROM public.patrimony_assets WHERE sala IS NOT NULL
        ORDER BY setor_id, lower(sala), sala LIMIT 2000`,
    )
    return rows.map((row) => ({ sectorId: row.setor_id, room: row.sala }))
  }

  async list(filters: { search: string; sectorId: string | null; room: string | null; situation: string | null; page: number }) {
    const parameters: unknown[] = []
    const conditions: string[] = []
    if (filters.search) {
      parameters.push(likePattern(filters.search), normalizeAssetNumber(filters.search) || '-')
      conditions.push(`(a.descricao ILIKE $1 OR a.numero ILIKE $1 OR a.numero_serie ILIKE $1 OR a.marca ILIKE $1
                        OR a.modelo ILIKE $1 OR ${normalizedSql('a.numero')} = $2)`)
    }
    if (filters.sectorId) {
      parameters.push(filters.sectorId)
      conditions.push(`a.setor_id = $${parameters.length}`)
    }
    if (filters.room) {
      parameters.push(filters.room.trim().toLowerCase())
      conditions.push(`lower(trim(a.sala)) = $${parameters.length}`)
    }
    if (filters.situation) {
      parameters.push(filters.situation)
      conditions.push(`a.situacao = $${parameters.length}`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const pool = this.poolProvider()
    const [rows, total] = await Promise.all([
      pool.query<AssetRow>(
        `${assetSelect} ${where}
          ORDER BY s.nome NULLS LAST, lower(a.sala) NULLS LAST, ${normalizedSql('a.numero')}
          LIMIT ${pageSize} OFFSET ${(filters.page - 1) * pageSize}`,
        parameters,
      ),
      pool.query<{ total: number; valor: string | null }>(
        `SELECT count(*)::int AS total, sum(a.valor_aquisicao) AS valor FROM public.patrimony_assets a ${where}`,
        parameters,
      ),
    ])
    return {
      assets: rows.rows.map(presentAsset),
      total: total.rows[0].total,
      totalValue: total.rows[0].valor === null ? null : Number(total.rows[0].valor),
      page: filters.page,
      pageSize,
    }
  }

  async find(id: string, client: Client = this.poolProvider()) {
    const { rows } = await client.query<AssetRow>(`${assetSelect} WHERE a.id = $1`, [id])
    return rows[0] ? presentAsset(rows[0]) : null
  }

  async findByNumber(number: string, client: Client = this.poolProvider()) {
    const normalized = normalizeAssetNumber(number)
    if (!normalized) return null
    const { rows } = await client.query<AssetRow>(`${assetSelect} WHERE ${normalizedSql('a.numero')} = $1`, [normalized])
    return rows[0] ? presentAsset(rows[0]) : null
  }

  async history(id: string) {
    const { rows } = await this.poolProvider().query<{
      tipo: string; setor_anterior: string | null; setor_novo: string | null; sala_anterior: string | null; sala_nova: string | null
      situacao_anterior: AssetSituation | null; situacao_nova: AssetSituation | null; detalhes: { campos?: string[] } | null
      observacao: string | null; usuario: string | null; created_at: Date
    }>(
      `SELECT m.tipo, sa.nome AS setor_anterior, sn.nome AS setor_novo, m.sala_anterior, m.sala_nova,
              m.situacao_anterior, m.situacao_nova, m.detalhes, m.observacao, u.full_name AS usuario, m.created_at
         FROM public.patrimony_movements m
         LEFT JOIN public.setores sa ON sa.id = m.setor_anterior_id
         LEFT JOIN public.setores sn ON sn.id = m.setor_novo_id
         LEFT JOIN public.auth_users u ON u.id = m.usuario_id
        WHERE m.asset_id = $1
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 200`,
      [id],
    )
    return rows.map((row) => ({
      type: row.tipo,
      previousSector: row.setor_anterior,
      newSector: row.setor_novo,
      previousRoom: row.sala_anterior,
      newRoom: row.sala_nova,
      previousSituation: row.situacao_anterior ? situationLabels[row.situacao_anterior] : null,
      newSituation: row.situacao_nova ? situationLabels[row.situacao_nova] : null,
      fields: row.detalhes?.campos ?? [],
      note: row.observacao,
      by: row.usuario,
      at: row.created_at,
    }))
  }

  private async assertNumberFree(client: Client, number: string, exceptId: string | null) {
    const { rows } = await client.query<{ id: string; numero: string }>(
      `SELECT id::text AS id, numero FROM public.patrimony_assets WHERE ${normalizedSql('numero')} = $1`,
      [normalizeAssetNumber(number)],
    )
    if (rows[0] && rows[0].id !== exceptId) throw conflict(`Já existe um bem com o número de patrimônio ${rows[0].numero}.`)
  }

  private async assertSector(client: Client, sectorId: string | null) {
    if (!sectorId) return
    const { rowCount } = await client.query(`SELECT 1 FROM public.setores WHERE id = $1 AND ativo`, [sectorId])
    if (!rowCount) throw new ModuleError('Setor indisponível. Selecione outra opção.', 400)
  }

  private async insertAsset(client: Client, actor: Actor, input: AssetInput, type: 'cadastro' | 'importacao') {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO public.patrimony_assets
        (numero, descricao, setor_id, sala, situacao, marca, modelo, numero_serie, data_tombamento,
         valor_aquisicao, nota_fiscal, fornecedor, observacao, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id::text AS id`,
      [
        input.number.trim(), input.description, input.sectorId, input.room, input.situation, input.brand, input.model,
        input.serialNumber, input.registeredOn, input.acquisitionValue, input.invoice, input.supplier, input.note, actor.userId,
      ],
    )
    const id = rows[0].id
    await client.query(
      `INSERT INTO public.patrimony_movements (asset_id, tipo, setor_novo_id, sala_nova, situacao_nova, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, type, input.sectorId, input.room, input.situation, actor.userId],
    )
    return id
  }

  async create(actor: Actor, input: AssetInput) {
    await this.requireSchema()
    return withTransaction(this.poolProvider(), async (client) => {
      // Duas leituras simultâneas do mesmo número não criam dois bens.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`patrimony:${normalizeAssetNumber(input.number)}`])
      await this.assertNumberFree(client, input.number, null)
      await this.assertSector(client, input.sectorId)
      const id = await this.insertAsset(client, actor, input, 'cadastro')
      await audit(client, actor, 'patrimony_asset_changed', id, { operation: 'created' })
      return id
    })
  }

  /** Alteração do cadastro. Setor, sala e situação ficam no histórico com o antes e o depois. */
  async update(actor: Actor, id: string, input: AssetInput, note: string | null) {
    await this.requireSchema()
    return withTransaction(this.poolProvider(), async (client) => {
      const locked = await client.query(`SELECT 1 FROM public.patrimony_assets WHERE id = $1 FOR UPDATE`, [id])
      if (!locked.rowCount) throw notFound()
      const current = (await this.find(id, client))!
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`patrimony:${normalizeAssetNumber(input.number)}`])
      await this.assertNumberFree(client, input.number, id)
      if (input.sectorId !== current.sectorId) await this.assertSector(client, input.sectorId)

      const changedFields = (Object.keys(fieldLabels) as (keyof typeof fieldLabels)[])
        .filter((key) => {
          const before = (current as Record<string, unknown>)[key] ?? null
          const after = (input as Record<string, unknown>)[key] ?? null
          return before !== after
        })
        .map((key) => fieldLabels[key])
      const moved = input.sectorId !== current.sectorId || (input.room ?? '') !== (current.room ?? '')
      const situationChanged = input.situation !== current.situation
      if (!moved && !situationChanged && changedFields.length === 0) return

      await client.query(
        `UPDATE public.patrimony_assets
            SET numero = $2, descricao = $3, setor_id = $4, sala = $5, situacao = $6, marca = $7, modelo = $8,
                numero_serie = $9, data_tombamento = $10, valor_aquisicao = $11, nota_fiscal = $12, fornecedor = $13,
                observacao = $14, updated_at = now()
          WHERE id = $1`,
        [
          id, input.number.trim(), input.description, input.sectorId, input.room, input.situation, input.brand, input.model,
          input.serialNumber, input.registeredOn, input.acquisitionValue, input.invoice, input.supplier, input.note,
        ],
      )
      await client.query(
        `INSERT INTO public.patrimony_movements
          (asset_id, tipo, setor_anterior_id, setor_novo_id, sala_anterior, sala_nova, situacao_anterior, situacao_nova,
           detalhes, observacao, usuario_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id, moved ? 'mudanca_local' : situationChanged ? 'situacao' : 'alteracao',
          current.sectorId, input.sectorId, current.room, input.room, current.situation, input.situation,
          changedFields.length ? JSON.stringify({ campos: changedFields }) : null, note, actor.userId,
        ],
      )
      await audit(client, actor, 'patrimony_asset_changed', id, { operation: moved ? 'moved' : 'updated' })
    })
  }

  /** Mudança só de local, como na conferência: "o bem está aqui, registrar este local". */
  async move(actor: Actor, id: string, target: { sectorId: string | null; room: string | null }, note: string | null) {
    await this.requireSchema()
    const current = await this.find(id)
    if (!current) throw notFound()
    await this.update(
      actor,
      id,
      {
        number: current.number,
        description: current.description,
        sectorId: target.sectorId,
        room: target.room,
        situation: current.situation,
        brand: current.brand,
        model: current.model,
        serialNumber: current.serialNumber,
        registeredOn: current.registeredOn,
        acquisitionValue: current.acquisitionValue,
        invoice: current.invoice,
        supplier: current.supplier,
        note: current.note,
      },
      note,
    )
  }

  /** Números da planilha que já existem, com o local registrado, para a prévia da importação. */
  async existingByNumbers(numbers: readonly string[]) {
    const normalized = [...new Set(numbers.map(normalizeAssetNumber).filter(Boolean))]
    if (normalized.length === 0) return new Map<string, PatrimonyAsset>()
    const { rows } = await this.poolProvider().query<AssetRow>(
      `${assetSelect} WHERE ${normalizedSql('a.numero')} = ANY($1::text[])`,
      [normalized],
    )
    return new Map(rows.map((row) => [normalizeAssetNumber(row.numero), presentAsset(row)]))
  }

  /** Cadastra as linhas novas. As já existentes não mudam: a mudança de local é feita bem a bem. */
  async importLines(actor: Actor, lines: readonly ImportLine[], fileName: string) {
    await this.requireSchema()
    return withTransaction(this.poolProvider(), async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['patrimony:import'])
      const sectorIds = [...new Set(lines.map((line) => line.sectorId).filter((id): id is string => Boolean(id)))]
      const active = new Set(
        (await client.query<{ id: string }>(`SELECT id::text AS id FROM public.setores WHERE ativo AND id = ANY($1::uuid[])`, [sectorIds])).rows.map((row) => row.id),
      )
      let created = 0
      let existing = 0
      for (const line of lines) {
        if (line.problems.length) continue
        const found = await client.query(`SELECT 1 FROM public.patrimony_assets WHERE ${normalizedSql('numero')} = $1`, [normalizeAssetNumber(line.number)])
        if (found.rowCount) {
          existing += 1
          continue
        }
        await this.insertAsset(client, actor, {
          number: line.number,
          description: line.description,
          sectorId: line.sectorId && active.has(line.sectorId) ? line.sectorId : null,
          room: line.room,
          situation: line.situation,
          brand: line.brand,
          model: line.model,
          serialNumber: line.serialNumber,
          registeredOn: line.registeredOn,
          acquisitionValue: line.acquisitionValue,
          invoice: line.invoice,
          supplier: line.supplier,
          note: null,
        }, 'importacao')
        created += 1
      }
      await audit(client, actor, 'patrimony_imported', actor.userId, { created: String(created), existing: String(existing), file: fileName.slice(0, 120) })
      return { created, existing, rejected: lines.filter((line) => line.problems.length).length }
    })
  }

  // -------------------------------------------------------------------------
  // Conferências
  // -------------------------------------------------------------------------
  async listChecks(page: number) {
    const pool = this.poolProvider()
    const { rows } = await pool.query<{
      id: string; titulo: string; setor: string | null; sala: string | null; status: string; criado_por: string | null
      created_at: Date; encerrada_em: Date | null; lidos: number; no_local: number; problemas: number
    }>(
      `SELECT c.id::text AS id, c.titulo, s.nome AS setor, c.sala, c.status, u.full_name AS criado_por, c.created_at, c.encerrada_em,
              (SELECT count(*)::int FROM public.patrimony_check_reads r WHERE r.check_id = c.id) AS lidos,
              (SELECT count(*)::int FROM public.patrimony_check_reads r WHERE r.check_id = c.id AND r.resultado = 'no_local') AS no_local,
              (SELECT count(*)::int FROM public.patrimony_check_reads r WHERE r.check_id = c.id AND r.resultado <> 'no_local') AS problemas
         FROM public.patrimony_checks c
         LEFT JOIN public.setores s ON s.id = c.setor_id
         LEFT JOIN public.auth_users u ON u.id = c.criado_por
        ORDER BY c.created_at DESC
        LIMIT 25 OFFSET ${(page - 1) * 25}`,
    )
    return rows.map((row) => ({
      id: row.id,
      title: row.titulo,
      sector: row.setor,
      room: row.sala,
      status: row.status,
      createdBy: row.criado_por,
      createdAt: row.created_at,
      closedAt: row.encerrada_em,
      read: row.lidos,
      inPlace: row.no_local,
      issues: row.problemas,
    }))
  }

  async createCheck(actor: Actor, input: { title: string; sectorId: string | null; room: string | null }) {
    await this.requireSchema()
    if (input.room && !input.sectorId) throw new ModuleError('Para conferir uma sala, escolha também o setor.', 400)
    return withTransaction(this.poolProvider(), async (client) => {
      await this.assertSector(client, input.sectorId)
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO public.patrimony_checks (titulo, setor_id, sala, criado_por) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
        [input.title, input.sectorId, input.room, actor.userId],
      )
      await audit(client, actor, 'patrimony_check_changed', rows[0].id, { operation: 'created' })
      return rows[0].id
    })
  }

  private async checkRow(client: Client, id: string, lock = false) {
    const { rows } = await client.query<{ id: string; titulo: string; setor_id: string | null; setor: string | null; sala: string | null; status: string; comentario: string | null; created_at: Date; encerrada_em: Date | null }>(
      `SELECT c.id::text AS id, c.titulo, c.setor_id::text AS setor_id, s.nome AS setor, c.sala, c.status, c.comentario, c.created_at, c.encerrada_em
         FROM public.patrimony_checks c LEFT JOIN public.setores s ON s.id = c.setor_id
        WHERE c.id = $1 ${lock ? 'FOR UPDATE OF c' : ''}`,
      [id],
    )
    return rows[0] ?? null
  }

  /**
   * Conferência com as leituras e os bens esperados que ainda não foram lidos (do setor ou da sala,
   * fora os baixados). A conferência geral, sem setor, não tem lista de esperados.
   */
  async findCheck(id: string) {
    const pool = this.poolProvider()
    const check = await this.checkRow(pool, id)
    if (!check) return null
    const reads = await pool.query<{
      numero_lido: string; resultado: CheckReadResult; asset_id: string | null; descricao: string | null
      setor_registrado: string | null; sala_registrada: string | null; lido_por: string | null; lido_em: Date
    }>(
      `SELECT r.numero_lido, r.resultado, r.asset_id::text AS asset_id, a.descricao, s.nome AS setor_registrado,
              r.sala_registrada, u.full_name AS lido_por, r.lido_em
         FROM public.patrimony_check_reads r
         LEFT JOIN public.patrimony_assets a ON a.id = r.asset_id
         LEFT JOIN public.setores s ON s.id = r.setor_registrado_id
         LEFT JOIN public.auth_users u ON u.id = r.lido_por
        WHERE r.check_id = $1
        ORDER BY r.lido_em DESC`,
      [id],
    )
    let missing: PatrimonyAsset[] = []
    if (check.setor_id) {
      const parameters: unknown[] = [id, check.setor_id]
      let roomCondition = ''
      if (check.sala) {
        parameters.push(check.sala.trim().toLowerCase())
        roomCondition = 'AND lower(trim(a.sala)) = $3'
      }
      const expected = await pool.query<AssetRow>(
        `${assetSelect}
          WHERE a.setor_id = $2 ${roomCondition} AND a.situacao <> 'baixado'
            AND NOT EXISTS (SELECT 1 FROM public.patrimony_check_reads r WHERE r.check_id = $1 AND r.asset_id = a.id)
          ORDER BY lower(a.sala) NULLS LAST, ${normalizedSql('a.numero')}
          LIMIT 2000`,
        parameters,
      )
      missing = expected.rows.map(presentAsset)
    }
    return {
      id: check.id,
      title: check.titulo,
      sectorId: check.setor_id,
      sector: check.setor,
      room: check.sala,
      status: check.status,
      comment: check.comentario,
      createdAt: check.created_at,
      closedAt: check.encerrada_em,
      reads: reads.rows.map((row) => ({
        number: row.numero_lido,
        result: row.resultado,
        assetId: row.asset_id,
        description: row.descricao,
        registeredSector: row.setor_registrado,
        registeredRoom: row.sala_registrada,
        by: row.lido_por,
        at: row.lido_em,
      })),
      missing,
    }
  }

  /**
   * Uma leitura do código de barras. Responde se o bem existe, onde o sistema diz que ele está e quando
   * foi patrimoniado. Ler de novo o mesmo número na mesma conferência não duplica nada.
   */
  async read(actor: Actor, checkId: string, number: string) {
    await this.requireSchema()
    return withTransaction(this.poolProvider(), async (client) => {
      const check = await this.checkRow(client, checkId, true)
      if (!check) throw notFound()
      if (check.status !== 'em_andamento') throw conflict('Esta conferência já foi encerrada.')
      const asset = await this.findByNumber(number, client)
      const previous = await client.query<{ resultado: CheckReadResult; lido_em: Date }>(
        `SELECT resultado, lido_em FROM public.patrimony_check_reads
          WHERE check_id = $1 AND ${normalizedSql('numero_lido')} = $2`,
        [checkId, normalizeAssetNumber(number)],
      )
      if (previous.rows[0]) {
        return { result: previous.rows[0].resultado, repeated: true, asset, previousCheckAt: asset?.lastCheckAt ?? null }
      }
      const result = classifyRead(asset, { sectorId: check.setor_id, room: check.sala })
      await client.query(
        `INSERT INTO public.patrimony_check_reads
          (check_id, numero_lido, asset_id, resultado, setor_registrado_id, sala_registrada, lido_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [checkId, number.trim(), asset?.id ?? null, result, asset?.sectorId ?? null, asset?.room ?? null, actor.userId],
      )
      if (asset) {
        await client.query(
          `UPDATE public.patrimony_assets SET ultima_conferencia_em = now(), ultima_conferencia_por = $2 WHERE id = $1`,
          [asset.id, actor.userId],
        )
        await client.query(
          `INSERT INTO public.patrimony_movements
            (asset_id, tipo, setor_anterior_id, setor_novo_id, sala_anterior, sala_nova, situacao_anterior, situacao_nova, observacao, usuario_id)
           VALUES ($1, 'conferencia', $2, $2, $3, $3, $4, $4, $5, $6)`,
          [asset.id, asset.sectorId, asset.room, asset.situation, `Conferência "${check.titulo}": ${result === 'no_local' ? 'no local certo' : result === 'baixado' ? 'bem baixado' : 'encontrado em outro local'}`.slice(0, 2000), actor.userId],
        )
      }
      // Antes desta leitura: a resposta mostra a conferência anterior, não a de agora.
      return { result, repeated: false, asset, previousCheckAt: asset?.lastCheckAt ?? null }
    })
  }

  async closeCheck(actor: Actor, id: string, outcome: 'concluida' | 'cancelada', comment: string | null) {
    await this.requireSchema()
    await withTransaction(this.poolProvider(), async (client) => {
      const check = await this.checkRow(client, id, true)
      if (!check) throw notFound()
      if (check.status !== 'em_andamento') throw conflict('Esta conferência já foi encerrada.')
      await client.query(
        `UPDATE public.patrimony_checks SET status = $2, comentario = $3, encerrada_por = $4, encerrada_em = now() WHERE id = $1`,
        [id, outcome, comment, actor.userId],
      )
      await audit(client, actor, 'patrimony_check_changed', id, { operation: outcome })
    })
  }
}
