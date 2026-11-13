import type { Pool } from 'pg'
import { brasiliaWeek, instrumentHints, restockSuggestions } from '../requests/robotRules.js'
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
