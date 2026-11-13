import type { Pool } from 'pg'
import { brasiliaWeek, instrumentHints, normalizeCode, normalizeText, restockSuggestions } from '../requests/robotRules.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import type { InstrumentItemForRestock } from '../requests/robotRules.js'
import { publishIntegrationEvent } from '../integrations/publisher.js'
import { ModuleExtensionsRepository } from './moduleExtensionsRepository.js'
import { getDatabasePool } from './pool.js'
import { readSystemSettings } from './settingsRepository.js'
import { WarehouseFinanceRepository } from './warehouseFinanceRepository.js'
import { withTransaction } from './withTransaction.js'

/**
 * Robô do Almoxarifado, sem inteligência artificial. Só lê: a conferência de inventário é criada
 * pela rota de sempre, depois que a pessoa confere a comparação na tela.
 */
export class RobotRepository {
  private readonly extensions: ModuleExtensionsRepository
  private readonly finance: WarehouseFinanceRepository

  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {
    this.extensions = new ModuleExtensionsRepository(poolProvider)
    this.finance = new WarehouseFinanceRepository(poolProvider)
  }

  /** Materiais ativos, com o saldo do estoque interno, para comparar com a planilha. */
  async catalog() {
    const { rows } = await this.poolProvider().query<{
      id: string; codigo: string | null; nome: string; unidade: string; localizacao: string | null; estoque_atual: string
    }>(
      `SELECT id::text AS id, codigo, nome, unidade, to_jsonb(m)->>'localizacao' AS localizacao, estoque_atual
         FROM public.materials m
        WHERE ativo
        ORDER BY lower(nome)
        LIMIT 3000`,
    )
    return rows.map((row) => ({
      id: row.id,
      code: row.codigo,
      name: row.nome,
      unit: row.unidade,
      location: row.localizacao,
      current: Number(row.estoque_atual),
    }))
  }

  /** Unidades de medida ativas, para reconhecer a unidade escrita na planilha. */
  async units() {
    const { rows } = await this.poolProvider().query<{ id: string; nome: string }>(
      `SELECT id::text AS id, nome FROM public.catalog_options WHERE categoria = 'measurement_unit' AND ativo ORDER BY lower(nome)`,
    )
    return rows.map((row) => ({ id: row.id, name: row.nome }))
  }

  /**
   * Cadastra os materiais da planilha que a pessoa confirmou. Pula, sem erro, o que já existir com o
   * mesmo código (sem pontuação nem zeros à esquerda) ou o mesmo nome: o robô nunca duplica material.
   */
  async createMaterials(actor: AuthenticatedIdentity, items: readonly { code: string | null; name: string; unitId: string }[]) {
    return withTransaction(this.poolProvider(), async (client) => {
      // Duas importações ao mesmo tempo não cadastram o mesmo material duas vezes.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('slm:robot-materials'))`)
      const { rows: units } = await client.query<{ id: string; nome: string }>(
        `SELECT id::text AS id, nome FROM public.catalog_options WHERE categoria = 'measurement_unit' AND ativo AND id = ANY($1::uuid[])`,
        [[...new Set(items.map((item) => item.unitId))]],
      )
      const unitName = new Map(units.map((unit) => [unit.id, unit.nome]))
      const { rows: existing } = await client.query<{ codigo: string | null; nome: string }>(`SELECT codigo, nome FROM public.materials`)
      const codes = new Set(existing.map((row) => (row.codigo ? normalizeCode(row.codigo) : '')).filter(Boolean))
      const names = new Set(existing.map((row) => normalizeText(row.nome)))
      const created: { id: string; name: string }[] = []
      const skipped: { name: string; reason: string }[] = []
      for (const item of items) {
        const code = item.code ? normalizeCode(item.code) : ''
        const name = normalizeText(item.name)
        if (!unitName.has(item.unitId)) skipped.push({ name: item.name, reason: 'Unidade de medida indisponível' })
        else if (code && codes.has(code)) skipped.push({ name: item.name, reason: 'Já existe material com este código' })
        else if (names.has(name)) skipped.push({ name: item.name, reason: 'Já existe material com este nome' })
        else {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO public.materials (codigo, nome, unidade, ativo) VALUES ($1, $2, $3, true) RETURNING id::text AS id`,
            [item.code, item.name, unitName.get(item.unitId)],
          )
          await insertAuthAuditEvent(client, {
            actorUserId: actor.userId,
            actorKind: 'user',
            subjectUserId: null,
            sessionId: rows[0].id,
            eventType: 'material_created',
            details: { name: item.name, origin: 'robo_planilha' },
          })
          if (code) codes.add(code)
          names.add(name)
          created.push({ id: rows[0].id, name: item.name })
        }
      }
      return { created, skipped }
    })
  }

  /** Sugestão de compra para o período; com withValues, indica atas e contratos com saldo. */
  async restock(months: number, withValues: boolean) {
    const stock = await this.extensions.stock({ search: '', belowMinimum: false })
    const suggestions = restockSuggestions(stock, months)
    if (!withValues) return suggestions.map((item) => ({ ...item, instruments: [] }))
    const instruments = await this.finance.materialInstruments()
    const items: InstrumentItemForRestock[] = instruments.flatMap((instrument) =>
      instrument.items.map((item) => ({
        instrumentId: instrument.id,
        number: instrument.number,
        type: instrument.type,
        validUntil: instrument.validUntil,
        expired: instrument.expired,
        itemId: item.id,
        description: item.description,
        unit: item.unit,
        balance: item.balance,
      })),
    )
    return suggestions.map((item) => ({ ...item, instruments: instrumentHints(item.name, items) }))
  }

  /** Números do resumo semanal: os mesmos da tela e do e-mail. */
  async weeklySummary() {
    const pool = this.poolProvider()
    const [stock, counts] = await Promise.all([
      this.extensions.stock({ search: '', belowMinimum: false }),
      pool.query<{ pendentes: number; conferencias: number }>(
        `SELECT (SELECT count(*)::int FROM public.material_requests WHERE status IN ('pendente', 'em_analise')) AS pendentes,
                (SELECT count(*)::int FROM public.inventory_checks WHERE status = 'em_andamento') AS conferencias`,
      ),
    ])
    return {
      belowMinimum: stock.filter((item) => item.belowMinimum).length,
      restockCount: restockSuggestions(stock, 3).length,
      pendingCount: counts.rows[0].pendentes,
      openChecks: counts.rows[0].conferencias,
    }
  }

  /**
   * Publica o resumo da semana, se ligado em Configurações. Sai na segunda-feira a partir das 7h
   * (Brasília), uma vez por semana: a chave do evento é a semana, e repetir não gera novo aviso.
   */
  async publishWeeklySummary(now: Date = new Date()) {
    const settings = await readSystemSettings(this.poolProvider())
    if (!settings.notifications.warehouseWeeklySummary) return false
    const week = brasiliaWeek(now)
    if (week.weekday !== 1 || week.hour < 7) return false
    const summary = await this.weeklySummary()
    await withTransaction(this.poolProvider(), (client) =>
      publishIntegrationEvent(client, {
        type: 'warehouse_weekly_summary',
        key: `warehouse-weekly:${week.key}`,
        module: 'warehouse',
        resourceId: null,
        protocol: '',
        actorId: null,
        context: summary,
      }),
    )
    return true
  }
}
