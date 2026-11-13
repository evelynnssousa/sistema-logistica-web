import { useSystemInfo } from '../../app/useSystemInfo'
import { useCallback, useEffect, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { demandStatusLabels } from '../../api/demandsApi'
import {
  addInstrumentAmendment,
  addInstrumentUsage,
  amendmentTypeLabels,
  fetchInstrument,
  formatBRL,
  formatDay,
  instrumentAttachmentUrl,
  instrumentCategoryLabels,
  instrumentTypeLabels,
  removeInstrumentAttachment,
  saveInstrumentItem,
  uploadInstrumentAttachment,
} from '../../api/instrumentsApi'
import type { InstrumentDetail as Detail, InstrumentItem } from '../../api/instrumentsApi'
import { errorMessage } from '../../api/modulesApi'
import StatCard from '../../components/StatCard'
import { Alert, EmptyState, Loading } from '../../components/ui/Feedback'
import Icon from '../../components/ui/Icon'
import Modal from '../../components/ui/Modal'
import { SituationFlag } from './InstrumentList'

type Loaded = Awaited<ReturnType<typeof fetchInstrument>>

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
const quantity = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })

const emptyItem = { itemNumber: '', description: '', unit: '', registered: '', unitPrice: '', active: true }
const emptyAmendment = { type: 'prorrogacao', number: '', signedAt: '', newEnd: '', newValue: '', description: '' }

/** Ata ou contrato: dados, itens e saldo, utilizações, aditivos, anexos e demandas vinculadas. */
export function InstrumentDetail() {
  const { instrumentId = '' } = useParams()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [itemForm, setItemForm] = useState<{ id: string | null; values: typeof emptyItem } | null>(null)
  const [usageForm, setUsageForm] = useState<{ itemId: string; quantity: string; date: string; document: string; note: string } | null>(null)
  const [amendmentForm, setAmendmentForm] = useState<typeof emptyAmendment | null>(null)
  const [amendmentFile, setAmendmentFile] = useState<File | null>(null)
  const [dialogError, setDialogError] = useState('')
  const [uploading, setUploading] = useState(false)
  const { contracts } = useSystemInfo()

  const load = useCallback(async () => {
    setLoaded(await fetchInstrument(instrumentId))
  }, [instrumentId])

  useEffect(() => {
    let active = true
    fetchInstrument(instrumentId)
      .then((result) => {
        if (active) setLoaded(result)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar a ata ou o contrato.'))
      })
    return () => {
      active = false
    }
  }, [instrumentId])

  if (error && !loaded) return <Alert tone="error">{error}</Alert>
  if (!loaded) return <Loading label="Carregando..." />

  const instrument: Detail = loaded.instrument
  const canEdit = loaded.access.edit
  const activeItems = instrument.items.filter((item) => item.active && item.balance > 0)

  async function run(action: () => Promise<unknown>, success: string, close: () => void) {
    setDialogError('')
    try {
      await action()
      close()
      setNotice(success)
      await load()
    } catch (err) {
      setDialogError(errorMessage(err, 'Não foi possível salvar.'))
    }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setUploading(true)
    setError('')
    try {
      await uploadInstrumentAttachment(instrumentId, file)
      setNotice('Anexo enviado.')
      await load()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível enviar o anexo.'))
    } finally {
      setUploading(false)
    }
  }

  async function removeAttachment(attachmentId: string) {
    const reason = window.prompt('Motivo da remoção do anexo (o registro continua no histórico):')
    if (!reason) return
    try {
      await removeInstrumentAttachment(instrumentId, attachmentId, reason)
      setNotice('Anexo removido.')
      await load()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível remover o anexo.'))
    }
  }

  function editItem(item: InstrumentItem | null) {
    setDialogError('')
    setItemForm(
      item
        ? {
            id: item.id,
            values: {
              itemNumber: item.itemNumber ?? '',
              description: item.description,
              unit: item.unit,
              registered: String(item.registered),
              unitPrice: String(item.unitPrice),
              active: item.active,
            },
          }
        : { id: null, values: { ...emptyItem } },
    )
  }

  const itemsValue = instrument.items.reduce((sum, item) => sum + item.registeredValue, 0)

  return (
    <>
      <p>
        <Link to="/demandas/atas">
          <Icon name="back" size={16} /> Atas e contratos
        </Link>
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {instrument.situation === 'vencendo' && (
        <Alert tone="warning">
          Vence em {formatDay(instrument.validUntil)}.{' '}
          {instrument.renewalDemand ? (
            <>
              Demanda de renovação: <Link to={`/demandas/${instrument.renewalDemand.id}`}>{instrument.renewalDemand.number}</Link>.
            </>
          ) : (
            'A demanda de renovação será aberta automaticamente.'
          )}
        </Alert>
      )}
      {instrument.situation === 'vencido' && (
        <Alert tone="error">
          Vigência encerrada em {formatDay(instrument.validUntil)}. Registre a prorrogação como aditivo ou marque como encerrado.
        </Alert>
      )}

      <section className="ui-card ui-stacked" aria-labelledby="instrument-title">
        <div className="ui-card-heading">
          <h2 id="instrument-title">
            {instrumentTypeLabels[instrument.type]} {instrument.number}
          </h2>
          {canEdit && (
            <Link className="maintenance-secondary-button" to={`/demandas/atas/${instrument.id}/editar`}>
              Editar
            </Link>
          )}
        </div>
        <p>{instrument.subject}</p>
        <dl className="demand-facts">
          <div><dt>Situação</dt><dd><SituationFlag item={instrument} /></dd></div>
          <div><dt>Categoria</dt><dd>{instrumentCategoryLabels[instrument.category]}</dd></div>
          <div><dt>Vigência</dt><dd>{formatDay(instrument.validFrom)} a {formatDay(instrument.validUntil)}</dd></div>
          <div><dt>Fornecedor</dt><dd>{instrument.supplier ?? '—'}</dd></div>
          <div><dt>Processo</dt><dd>{instrument.process ?? '—'}</dd></div>
          <div><dt>Setor responsável</dt><dd>{instrument.responsibleSector.name}</dd></div>
          <div>
            <dt>Compartilhado com</dt>
            <dd>{instrument.sharedSectors.length ? instrument.sharedSectors.map((sector) => sector.name).join(', ') : '—'}</dd>
          </div>
          <div><dt>Gestor ou fiscal</dt><dd>{instrument.manager?.name ?? '—'}</dd></div>
          <div><dt>Aviso de vencimento</dt><dd>{instrument.noticeDays} dias antes</dd></div>
        </dl>
        {instrument.notes && <p className="demand-muted">{instrument.notes}</p>}
      </section>

      <section className="ui-metrics" aria-label="Valores">
        <StatCard icon="money" tone="white" label="Valor total" value={formatBRL(instrument.total)} description={instrument.amendments.length ? 'Com os aditivos' : 'Valor original'} />
        <StatCard icon="stock" tone="white" label="Utilizado" value={formatBRL(instrument.spent)} description={instrument.usedPercent === null ? '—' : `${instrument.usedPercent.toLocaleString('pt-BR')}% do total`} />
        <StatCard icon="scales" tone="white" label="Saldo" value={formatBRL(instrument.balance)} description="Valor total menos o utilizado" />
      </section>

      <section className="ui-card ui-stacked" aria-labelledby="instrument-items">
        <div className="ui-card-heading">
          <h2 id="instrument-items">Itens</h2>
          {canEdit && (
            <div className="ui-card-actions">
              {activeItems.length > 0 && (
                <button
                  type="button"
                  className="maintenance-secondary-button"
                  onClick={() => {
                    setDialogError('')
                    setUsageForm({ itemId: activeItems[0].id, quantity: '', date: today(), document: '', note: '' })
                  }}
                >
                  Registrar utilização
                </button>
              )}
              <button type="button" className="maintenance-secondary-button" onClick={() => editItem(null)}>
                <Icon name="add" size={18} />
                Novo item
              </button>
            </div>
          )}
        </div>
        {instrument.items.length === 0 ? (
          <EmptyState icon="lists" title="Nenhum item cadastrado">
            Cadastre os itens com a quantidade registrada e o valor unitário para acompanhar o saldo de cada um.
          </EmptyState>
        ) : (
          <>
            {Math.abs(itemsValue - instrument.total) > 0.01 && (
              <p className="demand-muted">
                A soma dos itens ({formatBRL(itemsValue)}) é diferente do valor total ({formatBRL(instrument.total)}).
              </p>
            )}
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Valor unitário</th>
                    <th>Registrado</th>
                    <th>Utilizado</th>
                    <th>Saldo</th>
                    <th>Valor do saldo</th>
                    {canEdit && <th><span className="visually-hidden">Ações</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {instrument.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {item.itemNumber && <strong>{item.itemNumber}. </strong>}
                        {item.description}
                        {!item.active && <span className="central-flag">Inativo</span>}
                      </td>
                      <td>{formatBRL(item.unitPrice)} / {item.unit}</td>
                      <td>{quantity(item.registered)} {item.unit}</td>
                      <td>{quantity(item.used)} {item.unit}</td>
                      <td>
                        {quantity(item.balance)} {item.unit}
                        {item.registered > 0 && item.balance / item.registered <= contracts.lowBalancePercent / 100 && (
                          <span className="central-flag central-flag-late">Saldo baixo</span>
                        )}
                      </td>
                      <td>{formatBRL(item.registeredValue - item.usedValue)}</td>
                      {canEdit && (
                        <td>
                          <button type="button" className="central-link-button" onClick={() => editItem(item)}>
                            Editar
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="ui-card ui-stacked" aria-labelledby="instrument-usages">
        <h2 id="instrument-usages">Utilizações</h2>
        {instrument.usages.length === 0 ? (
          <EmptyState icon="lists" title="Nenhuma utilização registrada">
            Registre cada empenho, pedido ou ordem de serviço para o saldo ficar atualizado.
          </EmptyState>
        ) : (
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Item</th>
                  <th>Quantidade</th>
                  <th>Valor</th>
                  <th>Documento</th>
                  <th>Registro</th>
                </tr>
              </thead>
              <tbody>
                {instrument.usages.map((usage) => (
                  <tr key={usage.id}>
                    <td>{formatDay(usage.date)}</td>
                    <td>
                      {usage.item}
                      {usage.note && <small className="central-subtext">{usage.note}</small>}
                    </td>
                    <td>{quantity(usage.quantity)} {usage.unit}</td>
                    <td>{formatBRL(usage.value)}</td>
                    <td>{usage.document ?? '—'}</td>
                    <td>{usage.registeredBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ui-card ui-stacked" aria-labelledby="instrument-amendments">
        <div className="ui-card-heading">
          <h2 id="instrument-amendments">Aditivos e prorrogações</h2>
          {canEdit && (
            <button
              type="button"
              className="maintenance-secondary-button"
              onClick={() => {
                setDialogError('')
                setAmendmentFile(null)
                setAmendmentForm({ ...emptyAmendment })
              }}
            >
              <Icon name="add" size={18} />
              Registrar aditivo
            </button>
          )}
        </div>
        {instrument.amendments.length === 0 ? (
          <EmptyState icon="lists" title="Nenhum aditivo registrado" />
        ) : (
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Assinatura</th>
                  <th>Vigência</th>
                  <th>Valor</th>
                  <th>Descrição</th>
                  <th>Registro</th>
                </tr>
              </thead>
              <tbody>
                {instrument.amendments.map((amendment) => (
                  <tr key={amendment.id}>
                    <td>
                      {amendmentTypeLabels[amendment.type]}
                      {amendment.number && <small className="central-subtext">Nº {amendment.number}</small>}
                    </td>
                    <td>{formatDay(amendment.signedAt)}</td>
                    <td>
                      {amendment.previousEnd !== amendment.newEnd ? `${formatDay(amendment.previousEnd)} → ${formatDay(amendment.newEnd)}` : 'Sem mudança'}
                    </td>
                    <td>
                      {amendment.previousValue !== amendment.newValue
                        ? `${formatBRL(amendment.previousValue)} → ${formatBRL(amendment.newValue)}`
                        : 'Sem mudança'}
                    </td>
                    <td>{amendment.description}</td>
                    <td>{amendment.registeredBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ui-card ui-stacked" aria-labelledby="instrument-files">
        <div className="ui-card-heading">
          <h2 id="instrument-files">Documentos</h2>
          {canEdit && loaded.storageConfigured && (
            <label className="maintenance-secondary-button">
              <Icon name="attachment" size={18} />
              {uploading ? 'Enviando...' : 'Anexar PDF ou documento'}
              <input type="file" className="visually-hidden" disabled={uploading} onChange={(event) => void upload(event)} />
            </label>
          )}
        </div>
        {!loaded.storageConfigured && <p className="demand-muted">O armazenamento de anexos ainda não foi configurado neste ambiente.</p>}
        {instrument.attachments.length === 0 ? (
          <EmptyState icon="attachment" title="Nenhum documento anexado">
            Anexe o PDF da ata, do contrato e dos aditivos (até {loaded.attachmentLimits.maxFileMb} MB por arquivo).
          </EmptyState>
        ) : (
          <ul className="ui-stacked">
            {instrument.attachments.map((file) => (
              <li key={file.id}>
                <a href={instrumentAttachmentUrl(instrument.id, file.id, file.kind === 'pdf')} target="_blank" rel="noreferrer">
                  {file.name}
                </a>{' '}
                <small className="demand-muted">
                  {(file.sizeBytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB, enviado por {file.uploadedBy}
                  {file.amendmentId ? ' (aditivo)' : ''}
                </small>{' '}
                {canEdit && (
                  <button type="button" className="central-link-button" onClick={() => void removeAttachment(file.id)}>
                    Remover
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ui-card ui-stacked" aria-labelledby="instrument-demands">
        <h2 id="instrument-demands">Demandas vinculadas</h2>
        {instrument.demands.length === 0 ? (
          <EmptyState icon="demands" title="Nenhuma demanda vinculada">
            Ao criar ou editar uma demanda, escolha esta ata ou contrato no campo "Ata ou contrato".
          </EmptyState>
        ) : (
          <ul className="ui-stacked">
            {instrument.demands.map((demand) => (
              <li key={demand.id}>
                <Link to={`/demandas/${demand.id}`}>{demand.number}</Link> {demand.title}{' '}
                <small className="demand-muted">
                  {demandStatusLabels[demand.status as keyof typeof demandStatusLabels] ?? demand.status}
                  {demand.dueDate ? `, prazo ${formatDay(demand.dueDate)}` : ''}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>

      {itemForm && (
        <Modal title={itemForm.id ? 'Editar item' : 'Novo item'} onClose={() => setItemForm(null)}>
          <form
            className="ui-stacked"
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              void run(() => saveInstrumentItem(instrument.id, itemForm.id, itemForm.values), 'Item salvo.', () => setItemForm(null))
            }}
          >
            {(
              [
                ['itemNumber', 'Número do item', 'text'],
                ['description', 'Descrição *', 'text'],
                ['unit', 'Unidade (ex.: resma, hora, vaga) *', 'text'],
                ['registered', 'Quantidade registrada *', 'number'],
                ['unitPrice', 'Valor unitário (R$) *', 'number'],
              ] as const
            ).map(([field, label, kind]) => (
              <label key={field} className="maintenance-form-field">
                <span>{label}</span>
                <input
                  type={kind}
                  min={kind === 'number' ? '0' : undefined}
                  step={kind === 'number' ? 'any' : undefined}
                  required={label.endsWith('*')}
                  value={itemForm.values[field]}
                  onChange={(event) => setItemForm({ ...itemForm, values: { ...itemForm.values, [field]: event.target.value } })}
                />
              </label>
            ))}
            {itemForm.id && (
              <label className="parameter-check">
                <input
                  type="checkbox"
                  checked={itemForm.values.active}
                  onChange={(event) => setItemForm({ ...itemForm, values: { ...itemForm.values, active: event.target.checked } })}
                />
                <span>Item ativo</span>
              </label>
            )}
            {dialogError && <Alert tone="error">{dialogError}</Alert>}
            <button type="submit" className="maintenance-primary-button">Salvar</button>
          </form>
        </Modal>
      )}

      {usageForm && (
        <Modal title="Registrar utilização" onClose={() => setUsageForm(null)}>
          <form
            className="ui-stacked"
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              void run(() => addInstrumentUsage(instrument.id, usageForm), 'Utilização registrada.', () => setUsageForm(null))
            }}
          >
            <label className="maintenance-form-field">
              <span>Item *</span>
              <select value={usageForm.itemId} onChange={(event) => setUsageForm({ ...usageForm, itemId: event.target.value })}>
                {activeItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.description} (saldo {quantity(item.balance)} {item.unit})
                  </option>
                ))}
              </select>
            </label>
            <label className="maintenance-form-field">
              <span>Quantidade *</span>
              <input type="number" min="0" step="any" required value={usageForm.quantity} onChange={(event) => setUsageForm({ ...usageForm, quantity: event.target.value })} />
            </label>
            <label className="maintenance-form-field">
              <span>Data *</span>
              <input type="date" required value={usageForm.date} onChange={(event) => setUsageForm({ ...usageForm, date: event.target.value })} />
            </label>
            <label className="maintenance-form-field">
              <span>Documento (empenho, pedido, ordem de serviço)</span>
              <input maxLength={120} value={usageForm.document} onChange={(event) => setUsageForm({ ...usageForm, document: event.target.value })} />
            </label>
            <label className="maintenance-form-field">
              <span>Observação</span>
              <textarea rows={2} maxLength={2000} value={usageForm.note} onChange={(event) => setUsageForm({ ...usageForm, note: event.target.value })} />
            </label>
            <p className="demand-muted">O valor é calculado pela quantidade vezes o valor unitário do item. A utilização não pode ser apagada.</p>
            {dialogError && <Alert tone="error">{dialogError}</Alert>}
            <button type="submit" className="maintenance-primary-button">Registrar</button>
          </form>
        </Modal>
      )}

      {amendmentForm && (
        <Modal title="Registrar aditivo" onClose={() => setAmendmentForm(null)}>
          <form
            className="ui-stacked"
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              void run(
                async () => {
                  const created = await addInstrumentAmendment(instrument.id, amendmentForm)
                  if (amendmentFile) await uploadInstrumentAttachment(instrument.id, amendmentFile, created.id)
                },
                'Aditivo registrado.',
                () => setAmendmentForm(null),
              )
            }}
          >
            <label className="maintenance-form-field">
              <span>Tipo *</span>
              <select value={amendmentForm.type} onChange={(event) => setAmendmentForm({ ...amendmentForm, type: event.target.value })}>
                {Object.entries(amendmentTypeLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="maintenance-form-field">
              <span>Número do aditivo</span>
              <input maxLength={60} value={amendmentForm.number} onChange={(event) => setAmendmentForm({ ...amendmentForm, number: event.target.value })} />
            </label>
            <label className="maintenance-form-field">
              <span>Data de assinatura</span>
              <input type="date" value={amendmentForm.signedAt} onChange={(event) => setAmendmentForm({ ...amendmentForm, signedAt: event.target.value })} />
            </label>
            <label className="maintenance-form-field">
              <span>Nova data de fim da vigência{amendmentForm.type === 'prorrogacao' ? ' *' : ''}</span>
              <input
                type="date"
                required={amendmentForm.type === 'prorrogacao'}
                value={amendmentForm.newEnd}
                onChange={(event) => setAmendmentForm({ ...amendmentForm, newEnd: event.target.value })}
              />
            </label>
            <label className="maintenance-form-field">
              <span>Novo valor total (R$){['acrescimo', 'supressao', 'reajuste'].includes(amendmentForm.type) ? ' *' : ''}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                required={['acrescimo', 'supressao', 'reajuste'].includes(amendmentForm.type)}
                value={amendmentForm.newValue}
                onChange={(event) => setAmendmentForm({ ...amendmentForm, newValue: event.target.value })}
              />
              <small className="central-subtext">Atual: {formatBRL(instrument.total)}, vigência até {formatDay(instrument.validUntil)}.</small>
            </label>
            <label className="maintenance-form-field">
              <span>Descrição *</span>
              <textarea required rows={2} minLength={3} maxLength={2000} value={amendmentForm.description} onChange={(event) => setAmendmentForm({ ...amendmentForm, description: event.target.value })} />
            </label>
            {loaded.storageConfigured && (
              <label className="maintenance-form-field">
                <span>PDF do aditivo</span>
                <input type="file" onChange={(event) => setAmendmentFile(event.target.files?.[0] ?? null)} />
              </label>
            )}
            {dialogError && <Alert tone="error">{dialogError}</Alert>}
            <button type="submit" className="maintenance-primary-button">Registrar</button>
          </form>
        </Modal>
      )}
    </>
  )
}
