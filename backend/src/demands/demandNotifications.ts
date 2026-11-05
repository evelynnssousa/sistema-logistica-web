import type { PoolClient } from 'pg'
import { loadDirectorateUserIds } from '../database/demandConfigRepository.js'
import { describeError, logSecurityEvent } from '../security/logger.js'
import type { NotificationKind } from './demandValidation.js'

type Client = Pick<PoolClient, 'query'>

/**
 * Notificações internas do módulo, na mesma tabela das demais: aparecem no sino e na página de
 * Notificações. Rodam em SAVEPOINT, e uma falha aqui nunca desfaz a alteração da demanda.
 *
 * A chave do acontecimento evita repetição: a mesma chave não gera um segundo aviso à mesma pessoa.
 * Em demanda restrita, o texto não traz o título: leva só o número, e o resto exige abrir o registro.
 *
 * Por enquanto só avisos internos. A preferência de e-mail fica gravada, e o envio depende de
 * entrar no catálogo de modelos e da liberação de NOTIFICATION_EMAILS_ENABLED.
 */

const categories: Record<NotificationKind, string> = {
  atribuicao: 'atribuicao',
  responsavel: 'atribuicao',
  mencao: 'demandas',
  comentario: 'demandas',
  prazo_alterado: 'demandas',
  prazo_proximo: 'demandas',
  atraso: 'pendencia',
  status: 'demandas',
  recorrencia: 'demandas',
  providencia: 'pendencia',
}

const messages: Record<NotificationKind, string> = {
  atribuicao: 'Uma demanda foi atribuída a você.',
  responsavel: 'O responsável pela demanda foi alterado.',
  mencao: 'Você foi mencionado em um comentário.',
  comentario: 'Há um novo registro em uma demanda que você acompanha.',
  prazo_alterado: 'O prazo da demanda foi alterado.',
  prazo_proximo: 'O prazo da demanda está próximo.',
  atraso: 'A demanda está com o prazo vencido.',
  status: 'A situação da demanda mudou.',
  recorrencia: 'Uma nova ocorrência recorrente foi gerada.',
  providencia: 'A demanda aguarda uma providência.',
}

export type DemandNotice = {
  kind: NotificationKind
  /** Identifica o fato. Repetir a chave não repete o aviso. */
  key: string
  demand: { id: string; number: string; title: string; restricted: boolean }
  recipients: Iterable<string | null | undefined>
  actorId: string | null
}

/** Só recebe o aviso quem consegue abrir a demanda: integrantes dos setores dela e diretores. */
export async function keepThoseWithAccess(client: Client, demandId: string, candidates: readonly string[]) {
  const [directors, reachable] = await Promise.all([
    loadDirectorateUserIds(client),
    client.query<{ user_id: string }>(
      `SELECT m.user_id::text AS user_id FROM public.demand_sector_members m
        JOIN public.demands d ON d.id = $1
       WHERE m.ativo AND m.user_id = ANY($2::uuid[])
         AND (m.sector_id = d.setor_responsavel_id OR m.sector_id = d.setor_origem_id
              OR EXISTS (SELECT 1 FROM public.demand_sector_links l WHERE l.demand_id = d.id AND l.sector_id = m.sector_id))
       UNION
       SELECT l.user_id::text FROM public.user_directorate_links l
        WHERE l.ativo AND l.papel_demandas = 'diretor' AND l.user_id = ANY($2::uuid[])`,
      [demandId, candidates],
    ),
  ])
  const allowed = new Set([...directors, ...reachable.rows.map((row) => row.user_id)])
  return candidates.filter((id) => allowed.has(id))
}

export async function notifyDemand(client: Client, notice: DemandNotice) {
  const candidates = [...new Set(notice.recipients)].filter(
    (id): id is string => Boolean(id) && id !== notice.actorId,
  )
  if (candidates.length === 0) return

  await client.query('SAVEPOINT demand_notification')
  try {
    const recipients = await keepThoseWithAccess(client, notice.demand.id, candidates)
    // DO UPDATE só para devolver o id: outras pessoas podem ter de receber o mesmo acontecimento.
    const event = await client.query<{ id: string }>(
      `INSERT INTO public.integration_events (event_key, event_type, module, resource_id, protocol)
       VALUES ($1, $2, 'demands', $3, $4)
       ON CONFLICT (event_key) DO UPDATE SET event_key = EXCLUDED.event_key
       RETURNING id::text AS id`,
      [`demand:${notice.key}`.slice(0, 200), `demand_${notice.kind}`, notice.demand.id, notice.demand.number],
    )
    const base = messages[notice.kind]
    const message = notice.demand.restricted ? base : `${base} ${notice.demand.title}`
    await client.query(
      `INSERT INTO public.user_notifications
        (event_id, user_id, category, title, message, link)
       SELECT $1::uuid, recipient, $2::text, $3::text, $4::text, $5::text
         FROM unnest($6::uuid[]) AS recipient
        WHERE NOT EXISTS (
          SELECT 1 FROM public.demand_notification_preferences p
           WHERE p.user_id = recipient AND $7::text = ANY (p.silenciados)
        )
       ON CONFLICT (event_id, user_id) DO NOTHING`,
      [
        event.rows[0].id,
        categories[notice.kind],
        `Controle de Demandas · ${notice.demand.number}`,
        message.slice(0, 300),
        `/demandas/${notice.demand.id}`,
        recipients,
        notice.kind,
      ],
    )
    await client.query('RELEASE SAVEPOINT demand_notification')
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT demand_notification')
    await client.query('RELEASE SAVEPOINT demand_notification')
    logSecurityEvent('demand_notification_failed', { kind: notice.kind, ...describeError(error) })
  }
}
