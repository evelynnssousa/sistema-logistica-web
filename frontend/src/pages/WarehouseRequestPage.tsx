import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  protocolLabel,
  changeWarehouseStatus,
  communicationLabels,
  deliverWarehouseRequest,
  deliveryHistoryLabels,
  deliveryStatusLabels,
  errorMessage,
  formatCalendarDate,
  formatDate,
  formatDateTime,
  getWarehouseRequest,
  historyActionLabels,
  getCapabilities,
  listMaterials,
  originLabels,
  replaceWarehouseItems,
  setDeliveryForecast,
  todayCalendarDate,
  updateWarehouseRequest,
  warehouseStatusLabels,
} from '../api/modulesApi'
import type { ItemPayload, Material, ReasonOption } from '../api/modulesApi'
import { useHasPermission } from '../auth/UserContext'
import { Alert, Loading } from '../components/ui/Feedback'
import Icon from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'
import StatusBadge from '../components/ui/StatusBadge'
import AttachmentsPanel from '../components/AttachmentsPanel'
import ReportExport from '../components/ReportExport'
import CommunicationsPanel from '../components/CommunicationsPanel'
import { attachmentCategoriesFor } from '../api/operationsApi'
import { ItemRows } from './InventoryPage'

type Detail = Awaited<ReturnType<typeof getWarehouseRequest>>

const nextStatuses: Record<string, string[]> = {
  pendente: ['em_analise', 'atendido_parcial', 'atendido', 'rejeitado', 'cancelado'],
  em_analise: ['atendido_parcial', 'atendido', 'rejeitado', 'cancelado'],
  atendido_parcial: ['atendido', 'cancelado'],
  atendido: [],
  entregue: [],
  rejeitado: [],
  cancelado: [],
}

function WarehouseRequestPage() {
  const { requestId = '' } = useParams()
  const canManage = useHasPermission('warehouse:manage')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [materials, setMaterials] = useState<Material[]>([])
  const [items, setItems] = useState<ItemPayload[]>([])
  const [note, setNote] = useState('')
  const [reference, setReference] = useState('')
  const [requester, setRequester] = useState('')
  const [status, setStatus] = useState('')
  const [comment, setComment] = useState('')
  const [receivedBy, setReceivedBy] = useState('')
  const [deliveredDate, setDeliveredDate] = useState(todayCalendarDate)
  const [deliveryNote, setDeliveryNote] = useState('')
  const [forecastDate, setForecastDate] = useState('')
  const [justification, setJustification] = useState('')
  const [requesterEmail, setRequesterEmail] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [reasons, setReasons] = useState<ReasonOption[]>([])

  useEffect(() => {
    let active = true
    getCapabilities()
      .then((data) => {
        if (active) setReasons(data.reasons?.warehouse ?? [])
      })
      .catch(() => {
        // Sem a lista, a API segue conferindo o motivo ao salvar.
      })
    return () => {
      active = false
    }
  }, [])

  const apply = useCallback((data: Detail) => {
    setDetail(data)
    setItems(
      data.items.map((item) => ({
        materialId: item.materialId,
        requested: item.requested,
        fulfilled: item.fulfilled,
        reasonCode: item.reasonCode ?? '',
        note: item.note ?? '',
      })),
    )
    setNote(data.request.note ?? '')
    setReference(data.request.externalReference ?? '')
    setRequester(data.request.externalRequester ?? '')
    setRequesterEmail(data.request.externalRequesterEmail ?? '')
    setForecastDate(data.request.deliveryForecast ?? '')
    setJustification('')
    setStatus('')
    setComment('')
  }, [])

  useEffect(() => {
    let active = true
    getWarehouseRequest(requestId)
      .then((data) => {
        if (active) apply(data)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar o pedido.'))
      })
    if (canManage) {
      listMaterials()
        .then((data) => {
          if (active) setMaterials(data.materials)
        })
        .catch(() => {
          // Sem o catálogo, a edição mostra apenas os itens já incluídos.
        })
    }
    return () => {
      active = false
    }
  }, [requestId, canManage, apply])

  async function run<T>(action: () => Promise<T>, success: string | ((result: T) => string)) {
    setError('')
    setNotice('')
    try {
      const result = await action()
      apply(await getWarehouseRequest(requestId))
      setNotice(typeof success === 'string' ? success : success(result))
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível concluir a ação.'))
    }
  }

  const submit = (handler: () => Promise<void>) => (event: FormEvent) => {
    event.preventDefault()
    void handler()
  }

  if (!detail) {
    return error ? (
      <div className="admin-module-page">
        <Alert tone="error">{error}</Alert>
        <Link className="maintenance-secondary-button" to="/almoxarifado/solicitacoes">
          Voltar
        </Link>
      </div>
    ) : (
      <Loading label="Carregando pedido..." />
    )
  }

  const { request, history } = detail
  const open = ['pendente', 'em_analise', 'atendido_parcial', 'atendido'].includes(request.status)
  const external = request.origin === 'governamental'
  const canDeliver = ['atendido', 'atendido_parcial'].includes(request.status)
  const limited = request.limitedView
  const currentForecast = request.deliveryForecast
  const changingForecast = Boolean(currentForecast) && forecastDate !== currentForecast
  // O catálogo só traz ativos; um item antigo continua selecionável na edição.
  const materialOptions = [
    ...materials,
    ...detail.items
      .filter((item) => !materials.some((material) => material.id === item.materialId))
      .map((item) => ({
        id: item.materialId,
        code: null,
        name: item.material,
        description: null,
        unit: item.unit,
        categoryId: null,
        category: null,
        active: false,
      })),
  ]

  return (
    <div className="admin-module-page warehouse-request-page">
      <PageHeader
        eyebrow={`Origem: ${originLabels[request.origin]}`}
        title={`Pedido ${protocolLabel(request.protocol)}`}
        description={`${request.externalRequester ?? request.requester} · ${request.sector ?? 'Setor não informado'}`}
        actions={
          <>
            <StatusBadge
              className="detail-status"
              status={request.status}
              label={warehouseStatusLabels[request.status]}
            />
            <Link className="maintenance-secondary-button" to="/almoxarifado/solicitacoes">
              <Icon name="back" size={18} weight="bold" />
              Voltar
            </Link>
          </>
        }
      />

      {external && (
        <p className="module-notice">
          Este registro é uma cópia digitada no JUCESP. O sistema não está integrado ao sistema
          governamental: editar aqui não altera o pedido original.
        </p>
      )}

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {!limited && <ReportExport path={`/warehouse/requests/${request.id}/report`} />}

      {!limited && (
        <AttachmentsPanel
          resourceType="material_request"
          resourceId={request.id}
          canUpload={!['entregue', 'rejeitado', 'cancelado'].includes(request.status) || canManage}
          canRemove={canManage}
          canRestrict={canManage}
          categories={attachmentCategoriesFor('warehouse')}
        />
      )}

      <section className="ui-card ui-stacked" aria-label="Entrega dos materiais">
        <h2>Entrega</h2>
        <dl className="detail-grid">
          <div className="detail-info">
            <dt>Data prevista de entrega</dt>
            <dd>{formatCalendarDate(currentForecast)}</dd>
          </div>
          <div className="detail-info">
            <dt>Situação da entrega</dt>
            <dd>
              {request.deliveryStatus ? (
                <StatusBadge
                  status={request.deliveryStatus}
                  label={deliveryStatusLabels[request.deliveryStatus]}
                />
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div className="detail-info">
            <dt>Data efetiva de entrega</dt>
            <dd>{formatDate(request.deliveredAt)}</dd>
          </div>
        </dl>
      </section>

      {!limited && (
        <section className="ui-card ui-stacked">
          <h2>Dados do pedido</h2>
          <dl className="detail-grid">
            <div className="detail-info">
              <dt>Referência externa</dt>
              <dd>{request.externalReference ?? '—'}</dd>
            </div>
            <div className="detail-info">
              <dt>Registrado por</dt>
              <dd>{request.registeredBy ?? '—'}</dd>
            </div>
            <div className="detail-info">
              <dt>Registrado em</dt>
              <dd>{formatDateTime(request.createdAt)}</dd>
            </div>
            <div className="detail-info">
              <dt>Atendido por</dt>
              <dd>{request.attendedBy ?? '—'}</dd>
            </div>
            <div className="detail-info">
              <dt>Entregue em</dt>
              <dd>{formatDateTime(request.deliveredAt)}</dd>
            </div>
            <div className="detail-info">
              <dt>Entregue por</dt>
              <dd>{request.deliveredBy ?? '—'}</dd>
            </div>
            <div className="detail-info">
              <dt>Recebido por</dt>
              <dd>{request.receivedBy ?? '—'}</dd>
            </div>
            <div className="detail-info">
              <dt>Observação</dt>
              <dd>{request.note ?? '—'}</dd>
            </div>
          </dl>
        </section>
      )}

      <section className="ui-card ui-stacked">
        <h2>Itens</h2>
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Material</th>
                <th>Unidade</th>
                <th>Solicitada</th>
                <th>Disponibilizada</th>
                <th>Não disponibilizada</th>
                <th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {detail.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.material}</td>
                  <td>{item.unit}</td>
                  <td>{item.requested}</td>
                  <td>{item.fulfilled}</td>
                  <td>{item.notProvided}</td>
                  <td>
                    {item.reason ?? '—'}
                    {item.note && <small className="central-subtext">Interna: {item.note}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {canManage && (
        <section className="detail-actions" aria-label="Ações do pedido">
          {open && (
            <form
              className="detail-action"
              onSubmit={submit(() =>
                run(
                  () => setDeliveryForecast(request.id, { date: forecastDate, justification }),
                  (result) =>
                    !result.changed
                      ? 'A data informada já é a previsão atual. Nenhuma comunicação foi gerada.'
                      : result.requesterNotified
                        ? 'Previsão registrada. O solicitante será avisado.'
                        : 'Previsão registrada, mas não há solicitante identificado para avisar.',
                ),
              )}
            >
              <h3>{currentForecast ? 'Alterar previsão de entrega' : 'Informar previsão de entrega'}</h3>
              {external && !request.externalRequesterEmail && (
                <p className="module-notice">
                  Este pedido não tem o e-mail do solicitante. Informe-o em &quot;Editar registro local&quot;
                  para que a pessoa seja avisada.
                </p>
              )}
              <label className="maintenance-form-field">
                <span>Data prevista de entrega *</span>
                <input
                  required
                  type="date"
                  min={todayCalendarDate()}
                  value={forecastDate}
                  onChange={(event) => setForecastDate(event.target.value)}
                />
              </label>
              {changingForecast && (
                <label className="maintenance-form-field">
                  <span>Justificativa da alteração *</span>
                  <textarea
                    required
                    rows={2}
                    minLength={3}
                    maxLength={1000}
                    value={justification}
                    onChange={(event) => setJustification(event.target.value)}
                  />
                </label>
              )}
              <button className="maintenance-primary-button" type="submit">
                Salvar previsão
              </button>
            </form>
          )}

          {open && (
            <form
              className="detail-action"
              onSubmit={submit(() =>
                run(() => replaceWarehouseItems(request.id, items), 'Itens atualizados.'),
              )}
            >
              <h3>Itens e quantidades</h3>
              <ItemRows materials={materialOptions} items={items} onChange={setItems} withFulfilled />
              <p className="management-hint">
                Ter saldo em estoque não obriga a disponibilizar. Ao fornecer menos que o solicitado, informe o motivo.
              </p>
              {items.map((item, index) => {
                if (Number(item.fulfilled ?? 0) >= Number(item.requested)) return null
                const name = materialOptions.find((material) => material.id === item.materialId)?.name ?? 'Material'
                const update = (change: Partial<ItemPayload>) =>
                  setItems((current) => current.map((entry, position) => (position === index ? { ...entry, ...change } : entry)))
                return (
                  <div className="item-decision" key={item.materialId || index}>
                    <label className="maintenance-form-field">
                      <span>Motivo: {name}</span>
                      <select value={item.reasonCode ?? ''} onChange={(event) => update({ reasonCode: event.target.value })}>
                        <option value="">Ainda não decidido</option>
                        {reasons.map((reason) => (
                          <option key={reason.key} value={reason.key}>
                            {reason.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="maintenance-form-field">
                      <span>Observação interna{item.reasonCode === 'outro' ? ' *' : ''}</span>
                      <input
                        maxLength={2000}
                        required={item.reasonCode === 'outro'}
                        value={item.note ?? ''}
                        onChange={(event) => update({ note: event.target.value })}
                      />
                    </label>
                  </div>
                )
              })}
              <button className="maintenance-primary-button" type="submit">
                Salvar itens
              </button>
            </form>
          )}

          {nextStatuses[request.status].length > 0 && (
            <form
              className="detail-action"
              onSubmit={submit(() =>
                run(() => changeWarehouseStatus(request.id, status, comment), 'Situação alterada.'),
              )}
            >
              <h3>Alterar situação</h3>
              <label className="maintenance-form-field">
                <span>Nova situação *</span>
                <select required value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="" disabled>
                    Selecione
                  </option>
                  {nextStatuses[request.status].map((option) => (
                    <option key={option} value={option}>
                      {warehouseStatusLabels[option]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="maintenance-form-field">
                <span>{['rejeitado', 'cancelado'].includes(status) ? 'Motivo *' : 'Comentário'}</span>
                <textarea
                  rows={2}
                  required={['rejeitado', 'cancelado'].includes(status)}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              </label>
              <button className="maintenance-primary-button" type="submit">
                Confirmar
              </button>
            </form>
          )}

          {canDeliver && (
            <form
              className="detail-action"
              onSubmit={submit(() =>
                run(
                  () =>
                    deliverWarehouseRequest(request.id, {
                      receivedBy,
                      comment: '',
                      deliveredDate,
                      deliveryNote,
                    }),
                  'Entrega registrada.',
                ),
              )}
            >
              <h3>Registrar entrega</h3>
              <label className="maintenance-form-field">
                <span>Recebido por *</span>
                <input
                  required
                  name="recebidoPor"
                  maxLength={120}
                  value={receivedBy}
                  onChange={(event) => setReceivedBy(event.target.value)}
                />
              </label>
              <label className="maintenance-form-field">
                <span>Data efetiva de entrega *</span>
                <input
                  required
                  type="date"
                  max={todayCalendarDate()}
                  value={deliveredDate}
                  onChange={(event) => setDeliveredDate(event.target.value)}
                />
              </label>
              <label className="maintenance-form-field">
                <span>Observações sobre a entrega</span>
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={deliveryNote}
                  onChange={(event) => setDeliveryNote(event.target.value)}
                />
              </label>
              <button className="maintenance-primary-button" type="submit">
                Registrar entrega
              </button>
            </form>
          )}

          {open && (
            <form
              className="detail-action"
              onSubmit={submit(() =>
                run(
                  () =>
                    updateWarehouseRequest(request.id, {
                      note,
                      externalReference: external ? reference : null,
                      externalRequester: external ? requester : null,
                      ...(external ? { externalRequesterEmail: requesterEmail } : {}),
                    }),
                  'Registro atualizado.',
                ),
              )}
            >
              <h3>Editar registro local</h3>
              {external && (
                <>
                  <label className="maintenance-form-field">
                    <span>Número de referência</span>
                    <input maxLength={120} value={reference} onChange={(event) => setReference(event.target.value)} />
                  </label>
                  <label className="maintenance-form-field">
                    <span>Solicitante informado no pedido</span>
                    <input maxLength={120} value={requester} onChange={(event) => setRequester(event.target.value)} />
                  </label>
                  <label className="maintenance-form-field">
                    <span>E-mail institucional do solicitante</span>
                    <input
                      type="email"
                      maxLength={254}
                      value={requesterEmail}
                      onChange={(event) => setRequesterEmail(event.target.value)}
                    />
                  </label>
                </>
              )}
              <label className="maintenance-form-field">
                <span>Observação</span>
                <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
              </label>
              <button className="maintenance-primary-button" type="submit">
                Salvar
              </button>
            </form>
          )}
        </section>
      )}

      {canManage && (
        <CommunicationsPanel type="material_request" id={request.id} categories={attachmentCategoriesFor('warehouse')} />
      )}

      {detail.itemChanges.length > 0 && (
        <section className="ui-card ui-stacked">
          <h2>Histórico de quantidades disponibilizadas</h2>
          <ul className="detail-history">
            {detail.itemChanges.map((change) => (
              <li key={change.id}>
                <strong>{change.material}</strong>
                <span>
                  {change.previous ?? 0} → {change.fulfilled} {change.unit}, de {change.requested} solicitados
                </span>
                {change.reason && <span>Motivo: {change.reason}</span>}
                {change.note && <span>Observação: {change.note}</span>}
                <small>
                  {change.user ?? 'Sistema'} · {formatDateTime(change.at)}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.deliveryHistory.length > 0 && (
        <section className="ui-card ui-stacked">
          <h2>Histórico de previsões e entrega</h2>
          <ul className="detail-history">
            {detail.deliveryHistory.map((entry) => (
              <li key={entry.id}>
                <strong>{deliveryHistoryLabels[entry.action] ?? entry.action}</strong>
                {entry.newForecast && (
                  <span>
                    {entry.previousForecast ? `${formatCalendarDate(entry.previousForecast)} → ` : ''}
                    {formatCalendarDate(entry.newForecast)}
                  </span>
                )}
                {entry.action === 'entrega_registrada' && (
                  <span>
                    Data efetiva: {formatCalendarDate(entry.effectiveDate)}
                    {entry.previousForecast
                      ? ` · Previsão: ${formatCalendarDate(entry.previousForecast)}`
                      : ''}
                  </span>
                )}
                {entry.comment && (
                  <span>
                    {entry.action === 'previsao_alterada' ? 'Justificativa' : 'Observação'}: {entry.comment}
                  </span>
                )}
                <small>
                  {entry.user ?? 'Sistema'} · {formatDateTime(entry.at)}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.communications.length > 0 && (
        <section className="ui-card ui-stacked" aria-label="Comunicações do pedido">
          <h2>Comunicações</h2>
          <ul className="detail-history">
            {detail.communications.map((item) => (
              <li key={item.id}>
                <strong>{item.label ?? 'E-mail'}</strong>
                <span>
                  {communicationLabels[item.status] ?? item.status}
                  {item.simulated ? ' (simulado)' : ''}
                </span>
                <small>{formatDateTime(item.at)}</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!limited && (
        <section className="ui-card ui-stacked">
          <h2>Histórico</h2>
          <ul className="detail-history">
            {history.map((entry) => (
              <li key={entry.id}>
                <strong>{historyActionLabels[entry.action] ?? entry.action}</strong>
                {entry.from !== entry.to && entry.to && (
                  <span>
                    {entry.from ? `${warehouseStatusLabels[entry.from] ?? entry.from} → ` : ''}
                    {warehouseStatusLabels[entry.to] ?? entry.to}
                  </span>
                )}
                {entry.comment && <span>{entry.comment}</span>}
                <small>
                  {entry.user ?? 'Sistema'} · {formatDateTime(entry.at)}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

export default WarehouseRequestPage
