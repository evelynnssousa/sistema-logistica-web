import type { Pool } from 'pg'
import { holdsPermission } from '../auth/permissions.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { getDatabasePool } from '../database/pool.js'
import { readSystemSettings } from '../database/settingsRepository.js'
import { journeyOf } from '../requests/driverPortalRules.js'
import { expectedDailyMinutes, workloadByDay, workloadSummary } from './driverWorkload.js'
import type { WorkloadSummary } from './driverWorkload.js'
import { loadFleetTrips, tableExists } from './operationalSpreadsheets.js'
import type { SpreadsheetPeriod } from './operationalSpreadsheets.js'

/**
 * Resumo do mês da Frota (14/11/2026): quantos km cada carro rodou e quantas horas cada motorista
 * fez a mais e a menos. Os km somam duas fontes, mostradas separadas: o hodômetro informado pelo
 * motorista no portal (fim menos início de cada viagem) e o diário de bordo do veículo (utilização).
 * As horas são a mesma estimativa da planilha da Frota (driverWorkload.ts).
 */

export type RegisteredVehicle = { id: string; placa: string; modelo: string | null; logKm: number; logUses: number }

export type VehicleKilometers = {
  /** Placa do cadastro ou, sem cadastro, o texto informado na viagem. */
  vehicle: string
  model: string | null
  registered: boolean
  trips: number
  /** Viagens sem os dois hodômetros: não entram nos km do portal. */
  tripsWithoutOdometer: number
  tripKm: number
  logUses: number
  logKm: number
  totalKm: number
}

/** "abc-1d23" → "ABC1D23": a placa sem espaço, hífen ou ponto. */
export const plateKey = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** O veículo cadastrado cuja placa aparece no texto da viagem ("Gol ABC-1D23", "abc1d23"). */
export function matchVehicle(text: string, vehicles: readonly RegisteredVehicle[]) {
  const key = plateKey(text)
  if (!key) return null
  return vehicles.find((vehicle) => plateKey(vehicle.placa).length >= 5 && key.includes(plateKey(vehicle.placa))) ?? null
}

export function kilometersByVehicle(
  trips: readonly { vehicle: string | null; kilometers: number | null }[],
  vehicles: readonly RegisteredVehicle[],
): VehicleKilometers[] {
  const rows = new Map<string, VehicleKilometers>()
  for (const vehicle of vehicles) {
    rows.set(`id:${vehicle.id}`, {
      vehicle: vehicle.placa, model: vehicle.modelo, registered: true, trips: 0, tripsWithoutOdometer: 0,
      tripKm: 0, logUses: vehicle.logUses, logKm: vehicle.logKm, totalKm: 0,
    })
  }
  for (const trip of trips) {
    const text = trip.vehicle?.trim() || 'Veículo não informado'
    const match = trip.vehicle ? matchVehicle(trip.vehicle, vehicles) : null
    const key = match ? `id:${match.id}` : `texto:${plateKey(text) || text.toLowerCase()}`
    const row = rows.get(key) ?? {
      vehicle: text, model: null, registered: false, trips: 0, tripsWithoutOdometer: 0, tripKm: 0, logUses: 0, logKm: 0, totalKm: 0,
    }
    row.trips += 1
    if (trip.kilometers === null) row.tripsWithoutOdometer += 1
    else row.tripKm += trip.kilometers
    rows.set(key, row)
  }
  return [...rows.values()]
    .map((row) => ({ ...row, totalKm: row.tripKm + row.logKm }))
    .filter((row) => row.trips > 0 || row.logUses > 0)
    .sort((a, b) => b.totalKm - a.totalKm || a.vehicle.localeCompare(b.vehicle, 'pt-BR'))
}

/** "2026-11" → de 01/11 a 01/12 (exclusivo), no horário de Brasília. */
export function monthPeriod(month: string): SpreadsheetPeriod | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month)
  if (!match) return null
  const year = Number(match[1])
  const index = Number(match[2]) - 1
  // Meia-noite em São Paulo (UTC−3, sem horário de verão desde 2019).
  return { from: new Date(Date.UTC(year, index, 1, 3)), to: new Date(Date.UTC(year, index + 1, 1, 3)) }
}

export type FleetMonthlySummary = {
  month: string
  vehicles: VehicleKilometers[]
  /** Só para quem administra a Frota (fleet:manage): horas são dado de pessoal. */
  drivers: WorkloadSummary[] | null
  journey: { weekdays: number[]; start: string; end: string; breakMinutes: number; dailyMinutes: number } | null
}

export async function fleetMonthlySummary(
  identity: AuthenticatedIdentity,
  month: string,
  period: SpreadsheetPeriod,
  poolProvider: () => Pool = getDatabasePool,
): Promise<FleetMonthlySummary> {
  const pool = poolProvider()
  const { hasDrivers, tripRows } = await loadFleetTrips(identity, period, pool)

  const registered: RegisteredVehicle[] = (await tableExists(pool, 'vehicles'))
    ? (await pool.query<{ id: string; placa: string; modelo: string | null; usos: number; km: string | null }>(
        `SELECT v.id::text AS id, v.placa, to_jsonb(v)->>'modelo' AS modelo,
                count(l.id)::int AS usos, COALESCE(sum(l.km_final - l.km_inicial), 0) AS km
           FROM public.vehicles v
           LEFT JOIN public.vehicle_logs l
             ON l.vehicle_id = v.id AND l.tipo = 'utilizacao' AND l.data_registro >= $1 AND l.data_registro < $2
          GROUP BY v.id`,
        [period.from, period.to],
      )).rows.map((row) => ({ id: row.id, placa: row.placa, modelo: row.modelo, logUses: row.usos, logKm: Number(row.km ?? 0) }))
    : []

  // Só viagens que de fato começaram: as apenas agendadas ainda não rodaram.
  const started = tripRows.filter(({ row }) => row.execucao_inicio)
  const vehicles = kilometersByVehicle(
    started.map(({ row, kilometers }) => ({ vehicle: row.registro?.inicio?.veiculo ?? row.veiculo, kilometers })),
    registered,
  )

  if (!hasDrivers || !holdsPermission(identity, 'fleet:manage')) return { month, vehicles, drivers: null, journey: null }
  const settings = await readSystemSettings(pool)
  const journey = journeyOf(settings)
  const days = workloadByDay(
    started
      .filter(({ row }) => row.motorista_id && row.motorista)
      .map(({ row }) => ({ driverId: row.motorista_id!, driverName: row.motorista!, startedAt: row.execucao_inicio, finishedAt: row.execucao_fim })),
    journey,
    settings.holidays.list.map((item) => item.date),
  )
  return {
    month,
    vehicles,
    drivers: workloadSummary(days),
    journey: { weekdays: journey.weekdays, start: journey.start, end: journey.end, breakMinutes: journey.breakMinutes, dailyMinutes: expectedDailyMinutes(journey) },
  }
}
