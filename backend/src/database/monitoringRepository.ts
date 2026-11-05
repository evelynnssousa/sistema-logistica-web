import type { Pool } from 'pg'
import { resolveAccess } from './accessSchema.js'
import type { AccessRow } from './accessSchema.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { isRestrictedPermission } from '../auth/permissions.js'
import { redactOptional } from '../integrations/redaction.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { withTransaction } from './withTransaction.js'

const pageSize = 50

// Critérios da revisão de acessos.
export const reviewIntervalDays = 180
export const inactivityDays = 90

export class MonitoringRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  /** Disponibilidade medida nos últimos dias, só com o que foi de fato verificado ou perdido. */
  async availability(days: number) {
    const result = await this.poolProvider().query<{
      service: string
      status: string
      segundos: string
      inicio: Date
    }>(
      `SELECT service, status,
              sum(extract(epoch FROM last_seen_at - greatest(started_at, now() - make_interval(days => $1)))) AS segundos,
              min(started_at) AS inicio
         FROM public.availability_periods
        WHERE last_seen_at >= now() - make_interval(days => $1)
        GROUP BY service, status`,
      [days],
    )

    const byService = new Map<string, { up: number; down: number; unknown: number; since: Date }>()
    for (const row of result.rows) {
      const current = byService.get(row.service) ?? { up: 0, down: 0, unknown: 0, since: row.inicio }
      current[row.status as 'up' | 'down' | 'unknown'] += Number(row.segundos)
      if (row.inicio < current.since) current.since = row.inicio
      byService.set(row.service, current)
    }

    return [...byService.entries()].map(([service, totals]) => {
      const measured = totals.up + totals.down + totals.unknown
      return {
        service,
        since: totals.since,
        // Sem medição suficiente, o indicador fica vazio em vez de mostrar 100%.
        availabilityPercent: measured < 60 ? null : Math.round((totals.up / measured) * 10000) / 100,
        downMinutes: Math.round(totals.down / 60),
        unknownMinutes: Math.round(totals.unknown / 60),
      }
    })
  }

  async incidents(limit: number) {
    const result = await this.poolProvider().query<{
      service: string
      status: string
      started_at: Date
      last_seen_at: Date
      detail: string | null
    }>(
      `SELECT service, status, started_at, last_seen_at, detail
         FROM public.availability_periods
        WHERE status <> 'up'
        ORDER BY started_at DESC
        LIMIT $1`,
      [limit],
    )
    return result.rows.map((row) => ({
      service: row.service,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.last_seen_at,
      detail: row.detail,
    }))
  }

  async events(filters: { service?: string; page: number }) {
    const parameters: unknown[] = []
    const where = filters.service ? 'WHERE service = $1' : ''
    if (filters.service) parameters.push(filters.service)
    const pool = this.poolProvider()
    const [rows, total, last24h] = await Promise.all([
      pool.query<{
        id: string
        service: string
        event: string
        error_name: string | null
        error_code: string | null
        created_at: Date
      }>(
        `SELECT id::text AS id, service, event, error_name, error_code, created_at
           FROM public.technical_events ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ${pageSize} OFFSET ${(filters.page - 1) * pageSize}`,
        parameters,
      ),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM public.technical_events ${where}`, parameters),
      pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM public.technical_events WHERE created_at > now() - interval '24 hours'`,
      ),
    ])
    return {
      events: rows.rows.map((row) => ({
        id: row.id,
        service: row.service,
        event: row.event,
        errorName: row.error_name,
        errorCode: row.error_code,
        at: row.created_at,
      })),
      total: total.rows[0].total,
      last24h: last24h.rows[0].total,
      page: filters.page,
      pageSize,
    }
  }

  // -------------------------------------------------------------------------
  // Revisão de acessos
  // -------------------------------------------------------------------------
  async accessReview() {
    const result = await this.poolProvider().query<
      AccessRow & {
        id: string
        full_name: string
        email: string
        sector: string
        status: string
        ultimo_acesso: Date | null
        ultima_revisao: Date | null
        revisado_por: string | null
        resultado: string | null
      }
    >(
      `SELECT u.id::text AS id, u.full_name, u.email, u.sector, u.status, u.role, u.permissions,
              a.profile AS access_profile, a.slm_member AS access_slm_member,
              a.granted_permissions AS access_granted, a.denied_permissions AS access_denied,
              acesso.ultimo AS ultimo_acesso,
              revisao.created_at AS ultima_revisao, revisao.resultado,
              revisor.full_name AS revisado_por
         FROM public.auth_users u
         LEFT JOIN public.auth_user_access a ON a.user_id = u.id
         LEFT JOIN LATERAL (
           SELECT max(e.occurred_at) AS ultimo FROM public.auth_audit_events e
            WHERE e.action = 'auth.login' AND e.result = 'success'
              AND (e.actor_user_id = u.id OR e.target_user_id = u.id)
         ) acesso ON true
         LEFT JOIN LATERAL (
           SELECT r.created_at, r.resultado, r.revisado_por FROM public.access_reviews r
            WHERE r.user_id = u.id ORDER BY r.created_at DESC LIMIT 1
         ) revisao ON true
         LEFT JOIN public.auth_users revisor ON revisor.id = revisao.revisado_por
        WHERE u.status IN ('approved', 'blocked', 'inactive')
        ORDER BY lower(u.full_name)`,
    )

    const now = Date.now()
    const olderThan = (date: Date | null, days: number) =>
      !date || now - date.getTime() > days * 86_400_000

    return result.rows.map((row) => {
      const access = resolveAccess(row)
      const permissions = access?.permissions ?? []
      const active = row.status === 'approved'
      const administrator = access?.role === 'administrator'
      const restricted = permissions.filter(isRestrictedPermission)
      const sensitive = administrator || restricted.length > 0
      const reasons = [
        active && sensitive && olderThan(row.ultima_revisao, reviewIntervalDays) && 'Acesso sensível sem revisão recente',
        active && sensitive && olderThan(row.ultimo_acesso, inactivityDays) && 'Acesso sensível sem uso recente',
        active && !sensitive && olderThan(row.ultimo_acesso, inactivityDays * 2) && 'Conta sem uso recente',
        !active && permissions.length > 0 && restricted.length > 0 && 'Conta desativada com permissão especial',
      ].filter((reason): reason is string => Boolean(reason))

      return {
        id: row.id,
        name: row.full_name,
        email: row.email,
        sector: row.sector,
        status: row.status,
        role: access?.role ?? null,
        slmMember: access?.slmMember ?? false,
        administrator,
        restrictedPermissions: restricted,
        lastAccess: row.ultimo_acesso,
        lastReview: row.ultima_revisao,
        lastReviewBy: row.revisado_por,
        lastReviewResult: row.resultado,
        reasons,
      }
    })
  }

  async addAccessReview(
    actor: AuthenticatedIdentity,
    userId: string,
    input: { result: 'mantido' | 'ajustado'; note: string | null },
  ) {
    await withTransaction(this.poolProvider(), async (client) => {
      const found = await client.query(`SELECT 1 FROM public.auth_users WHERE id = $1`, [userId])
      if (found.rows.length === 0) throw notFound()
      await client.query(
        `INSERT INTO public.access_reviews (user_id, revisado_por, resultado, observacao)
         VALUES ($1, $2, $3, $4)`,
        [userId, actor.userId, input.result, redactOptional(input.note)],
      )
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: userId,
        sessionId: null,
        eventType: 'access_reviewed',
        details: { result: input.result },
      })
    })
  }
}
