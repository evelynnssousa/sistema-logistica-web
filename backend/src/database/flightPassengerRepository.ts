import type { Pool } from 'pg'
import { maskCpf } from '../auth/requestPolicy.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'

export type PassengerRequestScope = {
  requestId: string
  requesterId: string
}

export class FlightPassengerRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async findRequestScope(requestId: string): Promise<PassengerRequestScope | null> {
    const result = await this.poolProvider().query<{
      id: string
      solicitante_id: string
    }>(
      `SELECT id::text AS id, solicitante_id::text AS solicitante_id
         FROM public.service_requests
        WHERE id = $1
          AND tipo = 'passagem'`,
      [requestId],
    )
    const row = result.rows[0]
    return row ? { requestId: row.id, requesterId: row.solicitante_id } : null
  }

  async findPassengerScope(passengerId: string): Promise<PassengerRequestScope | null> {
    const result = await this.poolProvider().query<{
      request_id: string
      solicitante_id: string
    }>(
      `SELECT p.request_id::text AS request_id,
              r.solicitante_id::text AS solicitante_id
         FROM public.flight_request_passengers p
         JOIN public.service_requests r ON r.id = p.request_id
        WHERE p.id = $1`,
      [passengerId],
    )
    const row = result.rows[0]
    return row
      ? { requestId: row.request_id, requesterId: row.solicitante_id }
      : null
  }

  /** O CPF é mascarado aqui, para que o valor completo não chegue à rota. */
  async listMasked(requestId: string) {
    const result = await this.poolProvider().query<{
      id: string
      full_name: string
      cpf: string
    }>(
      `SELECT id::text AS id, full_name, cpf
         FROM public.flight_request_passengers
        WHERE request_id = $1
        ORDER BY created_at, id`,
      [requestId],
    )

    return result.rows.map((row) => ({
      id: row.id,
      name: row.full_name,
      cpfMasked: maskCpf(row.cpf),
    }))
  }

  /**
   * Leitura e auditoria estão na mesma transação: se o registro não puder ser
   * gravado, o CPF não é devolvido. A auditoria nunca recebe o número.
   */
  async readFullCpf(
    actorUserId: string,
    passengerId: string,
    scope: PassengerRequestScope,
  ): Promise<string | null> {
    return withTransaction(this.poolProvider(), async (client) => {
      const result = await client.query<{ cpf: string }>(
        `SELECT cpf FROM public.flight_request_passengers WHERE id = $1`,
        [passengerId],
      )
      const cpf = result.rows[0]?.cpf
      if (!cpf) return null

      await insertAuthAuditEvent(client, {
        actorUserId,
        actorKind: 'user',
        subjectUserId: scope.requesterId,
        sessionId: passengerId,
        eventType: 'cpf_read',
        details: {
          operation: 'flights.passenger.cpf.read',
          requestId: scope.requestId,
        },
      })

      return cpf
    })
  }
}
