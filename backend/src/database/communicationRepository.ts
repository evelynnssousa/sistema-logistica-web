import type { Pool, PoolClient } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import type { RequestModule } from '../auth/requestPolicy.js'
import { emailMode } from '../integrations/config.js'
import { moduleTypes } from '../requests/workflow.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { ModuleError, notFound } from './moduleErrors.js'
import { getDatabasePool } from './pool.js'
import { optionalColumnSql, protocolSql } from './protocolSql.js'
import { recordHistory } from './serviceRequestRepository.js'
import { withTransaction } from './withTransaction.js'

/**
 * Mensagens escritas pelos operadores. Ficam em uma fila própria, ao lado da fila dos e-mails
 * automáticos, que não muda. Nada aqui fala com o provedor: quem envia é o worker. Sem serviço ativo,
 * a mensagem fica registrada como não enviada, e nunca aparece como enviada.
 */

export type ResourceType = 'service_request' | 'material_request'
export type CommunicationModule = RequestModule | 'warehouse'

const maxAttempts = 5
const leaseSeconds = 120
const moduleByType = Object.fromEntries(
  Object.entries(moduleTypes).map(([module, type]) => [type, module]),
) as Record<string, RequestModule>

export type CommunicationResource = {
  type: ResourceType
  id: string
  module: CommunicationModule
  protocol: string
  status: string
  title: string
  requesterName: string | null
  requesterEmail: string | null
  sector: string | null
  details: Record<string, unknown>
}

export type ClaimedManualEmail = {
  id: string
  recipients: string[]
  cc: string[]
  subject: string
  text: string
  html: string
  attempts: number
  attachments: { name: string; sha256: string; storageKey: string; removed: boolean }[]
}

type Row = {
  id: string
  tipo: string
  modelo: string | null
  passageiro_id: string | null
  destinatarios: string[]
  copias: string[]
  assunto: string
  corpo_texto: string
  corpo_html: string
  reenvio_de: string | null
  status: string
  tentativas: number
  codigo_erro: string | null
  provedor: string | null
  simulado: boolean
  id_mensagem_provedor: string | null
  enviado_em: Date | null
  created_at: Date
  operador: string | null
  anexos: { nome: string; tipo: string; categoria: string; tamanho: string }[] | null
}

function toEmail(row: Row) {
  return {
    id: row.id,
    kind: row.tipo,
    template: row.modelo,
    passengerId: row.passageiro_id,
    recipients: row.destinatarios,
    cc: row.copias,
    subject: row.assunto,
    text: row.corpo_texto,
    html: row.corpo_html,
    resentFrom: row.reenvio_de,
    status: row.status,
    attempts: row.tentativas,
    errorCode: row.codigo_erro,
    provider: row.provedor,
    simulated: row.simulado,
    providerMessageId: row.id_mensagem_provedor,
    sentAt: row.enviado_em,
    createdAt: row.created_at,
    operator: row.operador,
    attachments: (row.anexos ?? []).map((item) => ({
      name: item.nome,
      kind: item.tipo,
      category: item.categoria,
      sizeBytes: Number(item.tamanho),
    })),
  }
}

const select = `
  SELECT m.id::text AS id, m.tipo, m.modelo, m.passageiro_id::text AS passageiro_id, m.destinatarios,
         m.copias, m.assunto, m.corpo_texto, m.corpo_html, m.reenvio_de::text AS reenvio_de, m.status,
         m.tentativas, m.codigo_erro, m.provedor, m.simulado, m.id_mensagem_provedor, m.enviado_em,
         m.created_at, u.full_name AS operador,
         (SELECT json_agg(json_build_object('nome', a.nome, 'tipo', a.tipo, 'categoria', a.categoria,
                                            'tamanho', a.tamanho_bytes) ORDER BY a.nome)
            FROM public.manual_email_attachments a WHERE a.email_id = m.id) AS anexos
    FROM public.manual_emails m
    LEFT JOIN public.auth_users u ON u.id = m.enviado_por`

export type TicketStatus = 'nao_enviado' | 'enviado' | 'falha' | 'pendente'

/** Vem só do histórico: o indicador nunca afirma o que o serviço não confirmou. */
export function ticketStatusOf(status: string | null | undefined): TicketStatus {
  if (status === 'sent') return 'enviado'
  if (status === 'failed') return 'falha'
  if (status === 'pending' || status === 'sending') return 'pendente'
  // Sem serviço ativo, nada saiu: continua "não enviado".
  return 'nao_enviado'
}

export class CommunicationRepository {
  constructor(private readonly poolProvider: () => Pool = getDatabasePool) {}

  async findResource(type: ResourceType, id: string): Promise<CommunicationResource | null> {
    const pool = this.poolProvider()
    if (type === 'service_request') {
      const result = await pool.query<{
        tipo: string; protocolo: string; status: string; titulo: string; nome: string; email: string
        setor: string | null; dados: Record<string, unknown>
      }>(
        `SELECT r.tipo, ${protocolSql('r')} AS protocolo, r.status, r.titulo, u.full_name AS nome,
                u.email, r.setor_nome AS setor, r.dados
           FROM public.service_requests r JOIN public.auth_users u ON u.id = r.solicitante_id
          WHERE r.id = $1`,
        [id],
      )
      const row = result.rows[0]
      if (!row) return null
      return {
        type, id, module: moduleByType[row.tipo], protocol: row.protocolo, status: row.status, title: row.titulo,
        requesterName: row.nome, requesterEmail: row.email, sector: row.setor, details: row.dados,
      }
    }
    const result = await pool.query<{
      protocolo: string; status: string; origem: string; externo: string | null; externo_email: string | null
      nome: string; email: string; setor: string | null
    }>(
      `SELECT ${protocolSql('r')} AS protocolo, r.status, r.origem, r.solicitante_externo AS externo,
              ${optionalColumnSql('r', 'solicitante_email')} AS externo_email,
              u.full_name AS nome, u.email, r.setor_nome AS setor
         FROM public.material_requests r JOIN public.auth_users u ON u.id = r.solicitante_id
        WHERE r.id = $1`,
      [id],
    )
    const row = result.rows[0]
    if (!row) return null
    const external = row.origem === 'governamental'
    return {
      type, id, module: 'warehouse', protocol: row.protocolo, status: row.status, title: 'Pedido de materiais',
      // No pedido digitado, a conta é de quem registrou: o solicitante é o informado no pedido.
      requesterName: external ? row.externo : row.nome,
      requesterEmail: external ? row.externo_email : row.email,
      sector: row.setor, details: {},
    }
  }

  /** Cotação escolhida, para preencher o encaminhamento da passagem. */
  async selectedQuote(requestId: string) {
    const pool = this.poolProvider()
    const present = await pool.query<{ present: boolean }>(`SELECT to_regclass('public.flight_quotes') IS NOT NULL AS present`)
    if (!present.rows[0].present) return null
    const result = await pool.query<{ companhia: string; voos: string }>(
      `SELECT companhia, voos FROM public.flight_quotes WHERE request_id = $1 AND selecionada LIMIT 1`,
      [requestId],
    )
    return result.rows[0] ?? null
  }

  /** Última mensagem enviada a este passageiro: evita pedir o mesmo endereço de novo. */
  async lastPassengerAddress(requestId: string, passengerId: string) {
    const result = await this.poolProvider().query<{ destinatarios: string[] }>(
      `SELECT destinatarios FROM public.manual_emails
        WHERE request_id = $1 AND passageiro_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [requestId, passengerId],
    )
    return result.rows[0]?.destinatarios[0] ?? null
  }

  async list(resource: { type: ResourceType; id: string }) {
    const column = resource.type === 'service_request' ? 'request_id' : 'material_request_id'
    const pool = this.poolProvider()
    const present = await pool.query<{ present: boolean }>(`SELECT to_regclass('public.manual_emails') IS NOT NULL AS present`)
    if (!present.rows[0].present) return []
    const result = await pool.query<Row>(`${select} WHERE m.${column} = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT 200`, [resource.id])
    return result.rows.map(toEmail)
  }

  /** Situação do bilhete de cada solicitação, pelo último encaminhamento registrado. */
  async ticketStatuses(ids: readonly string[]) {
    const statuses = new Map<string, { status: TicketStatus; at: Date | null }>()
    if (ids.length === 0) return statuses
    const pool = this.poolProvider()
    const present = await pool.query<{ present: boolean }>(`SELECT to_regclass('public.manual_emails') IS NOT NULL AS present`)
    if (!present.rows[0].present) return statuses
    const result = await pool.query<{ request_id: string; status: string; momento: Date }>(
      `SELECT DISTINCT ON (request_id) request_id::text AS request_id, status,
              COALESCE(enviado_em, created_at) AS momento
         FROM public.manual_emails
        WHERE request_id = ANY($1::uuid[]) AND tipo = 'passagem'
        ORDER BY request_id, created_at DESC`,
      [ids],
    )
    for (const row of result.rows) statuses.set(row.request_id, { status: ticketStatusOf(row.status), at: row.momento })
    return statuses
  }

  /** Grava a mensagem para envio. A chave torna o clique duplo inofensivo. */
  async queue(
    actor: AuthenticatedIdentity,
    resource: CommunicationResource,
    input: {
      kind: 'geral' | 'passagem'
      template: string | null
      passengerId: string | null
      recipients: readonly string[]
      cc: readonly string[]
      subject: string
      text: string
      html: string
      idempotencyKey: string
      attachmentIds: readonly string[]
      maxBytes: number
      resentFrom?: string | null
    },
  ) {
    return withTransaction(this.poolProvider(), async (client) => {
      const repeated = await client.query<{ id: string; status: string }>(
        `SELECT id::text AS id, status FROM public.manual_emails WHERE chave_idempotencia = $1`,
        [input.idempotencyKey],
      )
      if (repeated.rows[0]) return { ...repeated.rows[0], repeated: true }

      const attachments = await this.lockAttachments(client, resource, input.attachmentIds)
      const total = attachments.reduce((sum, item) => sum + Number(item.tamanho_bytes), 0)
      if (total > input.maxBytes) {
        throw new ModuleError(`Os anexos somam mais do que o limite de ${Math.floor(input.maxBytes / 1048576)} MB por mensagem.`, 400)
      }

      const status = emailMode() === 'none' ? 'not_configured' : 'pending'
      const created = await client.query<{ id: string }>(
        `INSERT INTO public.manual_emails
          (request_id, material_request_id, modulo, protocolo, tipo, modelo, passageiro_id, destinatarios,
           copias, assunto, corpo_texto, corpo_html, chave_idempotencia, reenvio_de, enviado_por, status, codigo_erro)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING id::text AS id`,
        [
          resource.type === 'service_request' ? resource.id : null,
          resource.type === 'material_request' ? resource.id : null,
          resource.module,
          resource.protocol,
          input.kind,
          input.template,
          input.passengerId,
          input.recipients,
          input.cc,
          input.subject,
          input.text,
          input.html,
          input.idempotencyKey,
          input.resentFrom ?? null,
          actor.userId,
          status,
          status === 'not_configured' ? 'EMAIL_NOT_CONFIGURED' : null,
        ],
      )
      const { id } = created.rows[0]
      for (const item of attachments) {
        await client.query(
          `INSERT INTO public.manual_email_attachments (email_id, attachment_id, nome, tipo, categoria, tamanho_bytes, sha256)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, item.id, item.nome_original, item.tipo, item.categoria, item.tamanho_bytes, item.sha256],
        )
      }
      // A linha do tempo registra o fato; destinatários e conteúdo ficam com quem pode consultá-los.
      if (resource.type === 'service_request') {
        await recordHistory(client, {
          requestId: resource.id,
          userId: actor.userId,
          action: input.kind === 'passagem' ? 'passagem_encaminhada' : 'email_registrado',
          from: null,
          to: null,
          details: { anexos: attachments.length, ...(input.resentFrom ? { reenvio: true } : {}) },
        })
      }
      await insertAuthAuditEvent(client, {
        actorUserId: actor.userId,
        actorKind: 'user',
        subjectUserId: null,
        sessionId: resource.id,
        eventType: input.resentFrom ? 'manual_email_resent' : 'manual_email_queued',
        details: {
          module: resource.module,
          protocol: resource.protocol,
          kind: input.kind,
          recipients: String(input.recipients.length + input.cc.length),
          attachments: String(attachments.length),
        },
      })
      return { id, status, repeated: false }
    })
  }

  /** Só anexos desta solicitação e ainda válidos. Bloqueados, para não saírem removidos. */
  private async lockAttachments(client: PoolClient, resource: { type: ResourceType; id: string }, ids: readonly string[]) {
    if (ids.length === 0) return []
    const column = resource.type === 'service_request' ? 'request_id' : 'material_request_id'
    const result = await client.query<{
      id: string; nome_original: string; tipo: string; categoria: string; tamanho_bytes: string; sha256: string
    }>(
      `SELECT id::text AS id, nome_original, tipo, categoria, tamanho_bytes::text AS tamanho_bytes, sha256
         FROM public.request_attachments
        WHERE id = ANY($1::uuid[]) AND ${column} = $2 AND removido_em IS NULL
        FOR SHARE`,
      [ids, resource.id],
    )
    if (result.rows.length !== new Set(ids).size) {
      throw new ModuleError('Há um anexo inexistente, removido ou de outra solicitação.', 400)
    }
    return result.rows
  }

  /** Reenvio: uma nova mensagem, igual à original, que continua registrada como está. */
  async original(id: string) {
    const pool = this.poolProvider()
    const result = await pool.query<{
      request_id: string | null; material_request_id: string | null; tipo: string; modelo: string | null
      passageiro_id: string | null; destinatarios: string[]; copias: string[]; assunto: string
      corpo_texto: string; corpo_html: string; anexos: string[] | null
    }>(
      `SELECT m.request_id::text AS request_id, m.material_request_id::text AS material_request_id, m.tipo,
              m.modelo, m.passageiro_id::text AS passageiro_id, m.destinatarios, m.copias, m.assunto,
              m.corpo_texto, m.corpo_html,
              (SELECT array_agg(a.attachment_id::text) FROM public.manual_email_attachments a WHERE a.email_id = m.id) AS anexos
         FROM public.manual_emails m WHERE m.id = $1`,
      [id],
    )
    const row = result.rows[0]
    if (!row) throw notFound()
    return row
  }

  async claim(limit: number): Promise<ClaimedManualEmail[]> {
    const pool = this.poolProvider()
    const present = await pool.query<{ present: boolean }>(`SELECT to_regclass('public.manual_emails') IS NOT NULL AS present`)
    if (!present.rows[0].present) return []
    return withTransaction(pool, async (client) => {
      const result = await client.query<{
        id: string; destinatarios: string[]; copias: string[]; assunto: string; corpo_texto: string
        corpo_html: string; tentativas: number
      }>(
        `UPDATE public.manual_emails
            SET status = 'sending', travado_ate = now() + make_interval(secs => $2)
          WHERE id IN (
            SELECT id FROM public.manual_emails
             WHERE proxima_tentativa <= now()
               AND (status = 'pending' OR (status = 'sending' AND travado_ate < now()))
             ORDER BY proxima_tentativa
             LIMIT $1
             FOR UPDATE SKIP LOCKED
          )
        RETURNING id::text AS id, destinatarios, copias, assunto, corpo_texto, corpo_html, tentativas`,
        [limit, leaseSeconds],
      )
      const files = await client.query<{
        email_id: string; nome: string; sha256: string; storage_key: string; removido: boolean
      }>(
        `SELECT e.email_id::text AS email_id, e.nome, e.sha256, a.storage_key, a.removido_em IS NOT NULL AS removido
           FROM public.manual_email_attachments e
           JOIN public.request_attachments a ON a.id = e.attachment_id
          WHERE e.email_id = ANY($1::uuid[])`,
        [result.rows.map((row) => row.id)],
      )
      return result.rows.map((row) => ({
        id: row.id,
        recipients: row.destinatarios,
        cc: row.copias,
        subject: row.assunto,
        text: row.corpo_texto,
        html: row.corpo_html,
        attempts: row.tentativas,
        attachments: files.rows
          .filter((file) => file.email_id === row.id)
          .map((file) => ({ name: file.nome, sha256: file.sha256, storageKey: file.storage_key, removed: file.removido })),
      }))
    })
  }

  async markSent(id: string, outcome: { provider: string; simulated: boolean; messageId: string | null }) {
    await this.poolProvider().query(
      `UPDATE public.manual_emails
          SET status = 'sent', enviado_em = now(), travado_ate = NULL, tentativas = tentativas + 1,
              codigo_erro = NULL, provedor = $2, simulado = $3, id_mensagem_provedor = $4
        WHERE id = $1`,
      [id, outcome.provider, outcome.simulated, outcome.messageId],
    )
  }

  /** Devolve true quando as tentativas acabaram. Falha temporária espera mais a cada vez. */
  /** Volta à fila sem contar tentativa: a cota do dia acabou ou não pôde ser conferida. */
  async defer(id: string, until: Date, code: string) {
    await this.poolProvider().query(
      `UPDATE public.manual_emails
          SET status = 'pending', travado_ate = NULL, proxima_tentativa = $2, codigo_erro = $3
        WHERE id = $1 AND status = 'sending'`,
      [id, until, code],
    )
  }

  async markFailed(item: { id: string; attempts: number }, outcome: { code: string; retryable: boolean }) {
    const attempts = item.attempts + 1
    const final = !outcome.retryable || attempts >= maxAttempts
    await this.poolProvider().query(
      `UPDATE public.manual_emails
          SET status = $2, tentativas = $3, codigo_erro = $4, travado_ate = NULL,
              proxima_tentativa = now() + make_interval(mins => $5)
        WHERE id = $1`,
      [item.id, final ? 'failed' : 'pending', attempts, outcome.code, 2 ** attempts],
    )
    return final
  }
}
