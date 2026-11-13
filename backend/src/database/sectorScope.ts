import type { Pool } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'

/**
 * Solicitações do próprio setor (13/11/2026). Quem tem requests:read_sector vê, só para consulta,
 * as solicitações de Manutenção, Frota e Almoxarifado abertas para o mesmo setor de lotação
 * (auth_users.setor_id). Passagens fica de fora: tem dados pessoais dos passageiros.
 */
export const sectorReadModules = ['maintenance', 'fleet', 'warehouse'] as const

export function readsSector(identity: Pick<AuthenticatedIdentity, 'permissions'>, module: string) {
  return (
    identity.permissions.includes('requests:read_sector') &&
    (sectorReadModules as readonly string[]).includes(module)
  )
}

/**
 * Condição SQL: o registro é do setor de lotação da pessoa. O setor da pessoa é o do cadastro
 * (setor_id) ou, sem ele, o da lista de setores com o mesmo nome da lotação, como na criação da
 * solicitação. Sem setor dos dois lados, nunca.
 */
export const sameSectorSql = (alias: string, userParameter: string) => `(
  ${alias}.setor_id IS NOT NULL
  AND ${alias}.setor_id = (
    SELECT COALESCE(u.setor_id, (SELECT s.id FROM public.setores s WHERE lower(trim(s.nome)) = lower(trim(u.sector)) LIMIT 1))
      FROM public.auth_users u
     WHERE u.id = ${userParameter} AND u.status = 'approved'
  )
)`

export async function sharesSector(
  pool: Pick<Pool, 'query'>,
  table: 'service_requests' | 'material_requests',
  id: string,
  userId: string,
) {
  const { rows } = await pool.query(
    `SELECT 1 FROM public.${table} r WHERE r.id = $1 AND ${sameSectorSql('r', '$2')}`,
    [id, userId],
  )
  return rows.length > 0
}
