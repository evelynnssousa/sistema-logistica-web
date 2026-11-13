import type { PoolClient } from 'pg'
import { loadDirectorateUserIds } from '../database/demandConfigRepository.js'
import { isEventType, renderSubject } from '../integrations/catalog.js'
import { enqueueEmail } from '../integrations/publisher.js'
import { describeError, logSecurityEvent } from '../security/logger.js'
import { visibleDemandSql } from './demandPolicy.js'
import type { NotificationKind } from './demandValidation.js'

type Client = Pick<PoolClient, 'query'>

/**
 * Notificações internas do módulo, na mesma tabela das demais: aparecem no sino e na página de
 * Notificações. Rodam em SAVEPOINT, e uma falha aqui nunca desfaz a alteração da demanda.
 *
 * A chave do acontecimento evita repetição: a mesma chave não gera um segundo aviso à mesma pessoa.
 * Em demanda restrita, o texto não traz o título: leva só o número, e o resto exige abrir o registro.
 *
 * O e-mail usa a fila central (email_deliveries) e o modelo demand_<tipo> do catálogo. Só recebe quem
 * marcou a preferência de e-mail, não silenciou o tipo e enxerga a demanda pela mesma regra das listas
 * (visibleDemandSql), o que cobre as restritas. A saída real depende de NOTIFICATION_EMAILS_ENABLED;
 * sem ela, a mensagem fica registrada como "não configurada".
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

/**
 * Quem enxerga a demanda e pode receber e-mail, sem olhar a preferência: keepThoseWithAccess (setor ou
 * diretoria), conta aprovada com endereço e a regra completa de visibilidade, em que a demanda restrita
 * só alcança chefe do setor, diretor e quem está envolvido. O administrador que só consulta não recebe
 * por ser administrador.
 */
export async function demandVisibleRecipients(
  client: Client,
  demandId: string,
  candidates: readonly string[],
): Promise<{ id: string; email: string }[]> {
  if (candidates.length === 0) return []
  const withAccess = await keepThoseWithAccess(client, demandId, candidates)
  if (withAccess.length === 0) return []
  const [directorate, linked] = await Promise.all([
    loadDirectorateUserIds(client),
    client.query<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM public.user_directorate_links
        WHERE ativo AND papel_demandas = 'diretor' AND user_id = ANY($1::uuid[])`,
      [withAccess],
    ),
  ])
  const directors = new Set([...directorate, ...linked.rows.map((row) => row.user_id)])
  const levels = withAccess.map((id) => (directors.has(id) ? 1 : 0))
  const { rows } = await client.query<{ id: string; email: string }>(
    `SELECT c.uid::text AS id, lower(trim(u.email)) AS email
       FROM unnest($2::uuid[], $3::int[]) AS c(uid, lvl)
       JOIN public.auth_users u ON u.id = c.uid AND u.status = 'approved'
       JOIN public.demands d ON d.id = $1
      WHERE coalesce(trim(u.email), '') <> ''
        AND ${visibleDemandSql('d', 'c.uid', 'c.lvl')}`,
    [demandId, withAccess, levels],
  )
  return rows
}

/** Dos que enxergam a demanda, quem pediu e-mail e não silenciou o tipo. */
export async function withEmailPreference(
  client: Client,
  people: readonly { id: string; email: string }[],
  kind: string,
) {
  if (people.length === 0) return []
  const { rows } = await client.query<{ user_id: string }>(
    `SELECT p.user_id::text AS user_id FROM public.demand_notification_preferences p
      WHERE p.user_id = ANY($1::uuid[]) AND p.email AND NOT ($2::text = ANY (p.silenciados))`,
    [people.map((person) => person.id), kind],
  )
  const wanted = new Set(rows.map((row) => row.user_id))
  return people.filter((person) => wanted.has(person.id))
}

/**
 * Quem recebe o aviso também por e-mail: enxerga a demanda (demandVisibleRecipients), marcou a
 * preferência de e-mail e não silenciou o tipo.
 */
export async function demandEmailRecipients(
  client: Client,
  demandId: string,
  candidates: readonly string[],
  kind: string,
): Promise<{ id: string; email: string }[]> {
  return withEmailPreference(client, await demandVisibleRecipients(client, demandId, candidates), kind)
}

export async function notifyDemand(client: Client, notice: DemandNotice) {
  const candidates = [...new Set(notice.recipients)].filter(
    (id): id is string => Boolean(id) && id !== notice.actorId,
  )
  if (candidates.length === 0) return

  // 1. Acontecimento e aviso no sino, em um SAVEPOINT próprio. Se falhar, nada do aviso fica, e a
  //    alteração da demanda segue normalmente.
  let delivered: { eventId: string; recipients: string[] } | null = null
  await client.query('SAVEPOINT demand_notification')
  try {
    const recipients = await keepThoseWithAccess(client, notice.demand.id, candidates)
    // O acontecimento é permanente (o gatilho recusa qualquer UPDATE, inclusive o de um upsert):
    // se já existe, por exemplo no lembrete de prazo repetido a cada hora, reaproveita o id, e
    // outras pessoas ainda podem receber o mesmo acontecimento.
    // O conteúdo que vai para a fila: em demanda restrita, nem o título.
    const payload = notice.demand.restricted
      ? { restricted: true }
      : { restricted: false, title: notice.demand.title }
    const eventKey = `demand:${notice.key}`.slice(0, 200)
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.integration_events (event_key, event_type, module, resource_id, protocol, payload)
       VALUES ($1, $2, 'demands', $3, $4, $5::jsonb)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id::text AS id`,
      [eventKey, `demand_${notice.kind}`, notice.demand.id, notice.demand.number, JSON.stringify(payload)],
    )
    const event = inserted.rows[0]
      ? inserted
      : await client.query<{ id: string }>(`SELECT id::text AS id FROM public.integration_events WHERE event_key = $1`, [eventKey])
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
    delivered = { eventId: event.rows[0].id, recipients }
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT demand_notification')
    await client.query('RELEASE SAVEPOINT demand_notification')
    logSecurityEvent('demand_notification_failed', { kind: notice.kind, ...describeError(error) })
    return
  }

  // 2. E-mail, em outro SAVEPOINT: uma falha aqui desfaz só a fila deste aviso, e o sino permanece.
  //    O log leva só o tipo e o código do erro, nunca o título ou o conteúdo da demanda.
  await publishDemandEmails(client, notice, delivered.eventId, delivered.recipients)
}

/** Separada para que a falha do e-mail nunca alcance o aviso no sino. A chave única evita duplicidade. */
export async function publishDemandEmails(client: Client, notice: DemandNotice, eventId: string, recipients: readonly string[]) {
  const templateKey = `demand_${notice.kind}`
  if (!isEventType(templateKey) || recipients.length === 0) return
  await client.query('SAVEPOINT demand_notification_email')
  try {
    const subject = renderSubject(templateKey, {
      module: 'demands',
      protocol: notice.demand.number,
      restricted: notice.demand.restricted,
    })
    for (const recipient of await demandEmailRecipients(client, notice.demand.id, recipients, notice.kind)) {
      await enqueueEmail(client, {
        eventId,
        templateKey,
        audience: 'internal',
        recipient: recipient.email,
        subject,
      })
    }
    await client.query('RELEASE SAVEPOINT demand_notification_email')
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT demand_notification_email')
    await client.query('RELEASE SAVEPOINT demand_notification_email')
    const code = (error as { code?: unknown })?.code
    logSecurityEvent('demand_notification_email_failed', {
      kind: notice.kind,
      code: typeof code === 'string' ? code : 'UNEXPECTED',
    })
  }
}
