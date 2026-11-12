import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  getIntegrationStatus,
  listEmailDeliveries,
  listEmailTemplates,
  retryEmail,
} from '../api/integrationsApi'
import type {
  ChannelMode,
  EmailTemplate,
  IntegrationStatus,
} from '../api/integrationsApi'
import { protocolLabel, errorMessage, formatDateTime, modulePaths } from '../api/modulesApi'
import { useHasPermission } from '../auth/UserContext'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, FilterSelect, SearchField } from '../components/ui/Filters'
import PageHeader from '../components/ui/PageHeader'
import Pagination from '../components/ui/Pagination'
import { useConfirm } from '../components/ui/useConfirm'

const tabs = [
  { key: 'status', label: 'Situação' },
  { key: 'emails', label: 'E-mails' },
  { key: 'templates', label: 'Modelos' },
] as const

type Tab = (typeof tabs)[number]['key']

// O sistema só sabe se os valores existem. Isso não comprova que a integração funciona.
const modeLabels: Record<ChannelMode, { label: string; detail: string }> = {
  none: {
    label: 'Não configurado',
    detail: 'Nada é enviado. Cada comunicação fica registrada e só sai por reprocessamento autorizado.',
  },
  simulated: {
    label: 'Simulado',
    detail: 'Ambiente de teste. Nada sai da máquina, e os registros aparecem como simulados.',
  },
  provider: {
    label: 'Configurado',
    detail: 'Os valores estão presentes. Isso não comprova o funcionamento: a validação é feita com a TI.',
  },
}

/** Motivos que não são falha do serviço, e os da cota diária. */
const emailErrorLabels: Record<string, string> = {
  EXPIRED: 'expirado: passou da validade do aviso',
  NOTICE_OBSOLETE: 'não enviado: a situação mudou depois do aviso',
  RECIPIENT_ACCESS_REVOKED: 'não enviado: o destinatário perdeu o acesso',
  RECIPIENT_ADDRESS_CHANGED: 'não enviado: o e-mail da conta mudou',
  RECIPIENT_PREFERENCE_DISABLED: 'não enviado: a pessoa desligou o aviso por e-mail',
  RECIPIENT_OUTSIDE_TEST_LIST: 'bloqueado: destinatário fora da lista de testes',
  BLOCKED_BEFORE_ACTIVATION: 'bloqueado: gerado antes da ativação controlada',
  DAILY_LIMIT_REACHED: 'aguardando: limite diário atingido',
  QUOTA_NOT_CONFIGURED: 'aguardando: limite diário não configurado',
  QUOTA_UNAVAILABLE: 'aguardando: limite diário não pôde ser conferido',
}

const emailStatusLabels: Record<string, string> = {
  pending: 'Na fila',
  sending: 'Enviando',
  sent: 'Enviado',
  failed: 'Com falha',
  not_configured: 'Não enviado: serviço não configurado',
}

const yesNo = (value: boolean) => (value ? 'Sim' : 'Não')

const requestLink = (module: string, id: string | null) => {
  if (!id || module === 'system') return null
  if (module === 'warehouse') return `/almoxarifado/pedidos/${id}`
  // A própria tela da demanda confere, de novo, quem pode abri-la.
  if (module === 'demands') return `/demandas/${id}`
  return modulePaths[module] ? `${modulePaths[module]}/${id}` : null
}

function StatusTab() {
  const [status, setStatus] = useState<IntegrationStatus | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    getIntegrationStatus()
      .then((data) => {
        if (active) setStatus(data.status)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar a situação.'))
      })
    return () => {
      active = false
    }
  }, [])

  if (error) return <Alert tone="error">{error}</Alert>
  if (!status) return <Loading label="Carregando situação..." />

  return (
    <div className="ui-grid-2">
      <section className="ui-card integration-status-card" aria-labelledby="status-email">
        <h2 id="status-email">E-mail ({status.email.provider})</h2>
        <p className="integration-mode">{modeLabels[status.email.mode].label}</p>
        <p>{modeLabels[status.email.mode].detail}</p>
        <dl className="detail-grid">
          <div className="detail-info"><dt>Envio autorizado na configuração</dt><dd>{yesNo(status.email.flagEnabled)}</dd></div>
          <div className="detail-info"><dt>Credenciais presentes</dt><dd>{yesNo(status.email.credentialsPresent)}</dd></div>
          <div className="detail-info"><dt>Endereço público para os links</dt><dd>{yesNo(status.email.publicUrlPresent)}</dd></div>
          {status.email.restriction && (
            <div className="detail-info">
              <dt>Destinatários</dt>
              <dd>
                {status.email.restriction.mode === 'test'
                  ? `Envio restrito a contas de teste: ${status.email.restriction.allowedRecipients} autorizado(s)`
                  : 'Sem restrição de destinatários'}
                {status.email.restriction.rejectedEntries > 0 &&
                  ` · ${status.email.restriction.rejectedEntries} entrada(s) recusada(s)`}
              </dd>
            </div>
          )}
          <div className="detail-info">
            <dt>Destinatários internos configurados</dt>
            <dd>{Object.values(status.email.internalRecipients).reduce((sum, total) => sum + total, 0)}</dd>
          </div>
        </dl>
      </section>
      <section className="ui-card integration-status-card" aria-labelledby="status-worker">
        <h2 id="status-worker">Processamento das filas</h2>
        <dl className="detail-grid">
          <div className="detail-info"><dt>Ligado nesta instância</dt><dd>{yesNo(status.worker.enabled)}</dd></div>
          <div className="detail-info">
            <dt>Lembrete de pendências</dt>
            <dd>{status.pendingReminderDays ? `Após ${status.pendingReminderDays} dias` : 'Sem prazo definido'}</dd>
          </div>
        </dl>
      </section>
      {status.queue && (
        <section className="ui-card integration-status-card" aria-labelledby="status-queue">
          <h2 id="status-queue">Fila de e-mails e cota diária</h2>
          <p>
            Mensagens guardadas sem serviço ativo não saem sozinhas. As que passam da validade do aviso ficam
            como expiradas, no histórico, e não podem ser reprocessadas.
          </p>
          <dl className="detail-grid">
            <div className="detail-info"><dt>Não enviadas: serviço não configurado</dt><dd>{status.queue.notConfigured}</dd></div>
            <div className="detail-info"><dt>Na fila</dt><dd>{status.queue.pending}</dd></div>
            <div className="detail-info"><dt>Expiradas</dt><dd>{status.queue.expired}</dd></div>
            <div className="detail-info"><dt>Bloqueadas: fora da lista de testes</dt><dd>{status.queue.blockedByTestList ?? 0}</dd></div>
            <div className="detail-info"><dt>Bloqueadas: anteriores à ativação</dt><dd>{status.queue.blockedBeforeActivation ?? 0}</dd></div>
            <div className="detail-info">
              <dt>Mais antiga aguardando</dt>
              <dd>{status.queue.oldestWaitingAt ? formatDateTime(status.queue.oldestWaitingAt) : 'Nenhuma'}</dd>
            </div>
            {status.queue.quota ? (
              <>
                <div className="detail-info">
                  <dt>Limite diário (UTC)</dt>
                  <dd>{status.queue.quota.dailyLimit ?? 'Não configurado'}</dd>
                </div>
                <div className="detail-info"><dt>Reserva da recuperação de senha</dt><dd>{status.queue.quota.recoveryReserve}</dd></div>
                <div className="detail-info"><dt>Usado hoje pelas notificações</dt><dd>{status.queue.quota.notificationsUsed}</dd></div>
                <div className="detail-info"><dt>Usado hoje pela recuperação</dt><dd>{status.queue.quota.recoveryUsed}</dd></div>
              </>
            ) : (
              <div className="detail-info"><dt>Controle da cota</dt><dd>Depende da migração 019</dd></div>
            )}
          </dl>
        </section>
      )}
    </div>
  )
}

function useRetry(reload: () => Promise<void>) {
  const { confirm, confirmDialog } = useConfirm()
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  async function retry(action: () => Promise<unknown>, question: string) {
    if (!(await confirm(question, { confirmLabel: 'Reprocessar' }))) return
    try {
      await action()
      setMessage({ tone: 'success', text: 'Item devolvido à fila.' })
      await reload()
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Não foi possível reprocessar.') })
    }
  }

  return { retry, confirmDialog, message }
}

function EmailsTab() {
  const canManage = useHasPermission('integrations:manage')
  const [status, setStatus] = useState('')
  const [module, setModule] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [listing, setListing] = useState<Awaited<ReturnType<typeof listEmailDeliveries>> | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setListing(await listEmailDeliveries({ status, module, search, page }))
      setError('')
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível carregar os envios.'))
    }
  }, [status, module, search, page])

  useEffect(() => {
    let active = true
    listEmailDeliveries({ status, module, search, page })
      .then((data) => {
        if (active) {
          setListing(data)
          setError('')
        }
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os envios.'))
      })
    return () => {
      active = false
    }
  }, [status, module, search, page])

  const { retry, confirmDialog, message } = useRetry(load)

  return (
    <>
      <FilterBar
        label="Filtros de envios"
        canClear={Boolean(status || module || search)}
        onClear={() => {
          setStatus('')
          setModule('')
          setSearch('')
          setPage(1)
        }}
      >
        <SearchField
          label="Protocolo"
          placeholder="Número do protocolo"
          value={search}
          onChange={(value) => {
            setSearch(value)
            setPage(1)
          }}
        />
        <FilterSelect
          label="Situação"
          value={status}
          onChange={(value) => {
            setStatus(value)
            setPage(1)
          }}
          allLabel="Todas"
          options={Object.entries(emailStatusLabels).map(([value, label]) => ({ value, label }))}
        />
        <FilterSelect
          label="Módulo"
          value={module}
          onChange={(value) => {
            setModule(value)
            setPage(1)
          }}
          allLabel="Todos"
          options={[
            { value: 'maintenance', label: 'Manutenção' },
            { value: 'fleet', label: 'Frota' },
            { value: 'flights', label: 'Passagens aéreas' },
            { value: 'warehouse', label: 'Almoxarifado' },
            { value: 'demands', label: 'Controle de Demandas' },
            { value: 'system', label: 'Sistema' },
          ]}
        />
      </FilterBar>

      {error && <Alert tone="error">{error}</Alert>}
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      {!listing && !error && <Loading label="Carregando envios..." />}

      {listing && (
        <section className="ui-card ui-stacked" aria-label="Histórico de envios">
          {listing.emails.length === 0 ? (
            <EmptyState icon="mail" title="Nenhum envio encontrado" />
          ) : (
            <div className="data-table-wrapper">
              <table className="data-table integration-table">
                <thead>
                  <tr>
                    <th>Registrado em</th>
                    <th>Solicitação</th>
                    <th>Modelo</th>
                    <th>Destinatário</th>
                    <th>Situação</th>
                    <th>Tentativas</th>
                    {canManage && <th>Ação</th>}
                  </tr>
                </thead>
                <tbody>
                  {listing.emails.map((email) => {
                    const link = requestLink(email.module, email.resourceId)
                    return (
                      <tr key={email.id}>
                        <td>{formatDateTime(email.createdAt)}</td>
                        <td>
                          {email.moduleLabel}
                          {email.protocol && (
                            <>
                              {' '}
                              {link ? <Link to={link}>{protocolLabel(email.protocol)}</Link> : `${protocolLabel(email.protocol)}`}
                            </>
                          )}
                        </td>
                        <td>{email.template}</td>
                        <td>
                          {email.recipient}
                          {email.ccTotal > 0 && ` + ${email.ccTotal} em cópia`}
                        </td>
                        <td>
                          {emailStatusLabels[email.status] ?? email.status}
                          {email.simulated && email.status === 'sent' && ' (simulado)'}
                          {email.deliveryStatus && <small> · Provedor: {email.deliveryStatus}</small>}
                          {email.errorCode && email.status !== 'not_configured' && (
                            <small> · {emailErrorLabels[email.errorCode] ?? email.errorCode}</small>
                          )}
                        </td>
                        <td>{email.attempts}</td>
                        {canManage && (
                          <td>
                            {(email.status === 'failed' || email.status === 'not_configured') && (
                              <button
                                type="button"
                                onClick={() =>
                                  void retry(
                                    () => retryEmail(email.id),
                                    'A mensagem volta à fila e será enviada ao destinatário. Deseja continuar?',
                                  )
                                }
                              >
                                Reprocessar
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pagination
            page={listing.page}
            summary={`${listing.total} no total`}
            hasNext={listing.page * listing.pageSize < listing.total}
            onChange={setPage}
          />
        </section>
      )}
      {confirmDialog}
    </>
  )
}

function audienceText(template: EmailTemplate) {
  const parts = [
    template.audience.requester && 'Solicitante',
    template.audience.team && 'Equipe',
    template.audience.responsible && 'Responsável (na plataforma)',
  ].filter(Boolean)
  return parts.join(', ')
}

function TemplatesTab() {
  const [templates, setTemplates] = useState<EmailTemplate[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    listEmailTemplates()
      .then((data) => {
        if (active) setTemplates(data.templates)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os modelos.'))
      })
    return () => {
      active = false
    }
  }, [])

  if (error) return <Alert tone="error">{error}</Alert>
  if (!templates) return <Loading label="Carregando modelos..." />

  return (
    <div className="integration-templates">
      {templates.map((template) => (
        <details key={template.key} className="ui-card">
          <summary>
            <strong>{template.label}</strong>
            <span>{template.modules.join(', ')}</span>
          </summary>
          <p><strong>Público:</strong> {audienceText(template)}</p>
          <p><strong>Assunto:</strong> {template.subject}</p>
          <pre>{template.body}</pre>
        </details>
      ))}
    </div>
  )
}

function IntegrationsPage() {
  const [tab, setTab] = useState<Tab>('status')

  return (
    <div className="admin-module-page integrations-page">
      <PageHeader
        title="Integrações"
        description="Situação das comunicações automáticas por e-mail. A agenda é interna: Manutenção, Frota e Passagens aparecem em Calendário."
      />
      <nav className="module-tabs" aria-label="Áreas das integrações">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            className={tab === item.key ? 'active' : ''}
            aria-pressed={tab === item.key}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {tab === 'status' && <StatusTab />}
      {tab === 'emails' && <EmailsTab />}
      {tab === 'templates' && <TemplatesTab />}
    </div>
  )
}

export default IntegrationsPage
