import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  closeRequestReturn,
  errorMessage,
  formatDateTime,
  fromLocalInput,
  openRequestReturn,
  respondRequestReturn,
  toLocalInput,
} from '../api/modulesApi'
import type { RequestDetail, RequestModule } from '../api/modulesApi'
import { useCatalog } from '../app/useCatalog'
import { Alert } from './ui/Feedback'

const situationLabels: Record<string, string> = {
  aberta: 'Aguardando o solicitante',
  atendida: 'Respondida',
  encerrada: 'Encerrada pela equipe',
}

function FormBox({
  title,
  submitLabel,
  onSubmit,
  children,
}: {
  title: string
  submitLabel: string
  onSubmit: () => Promise<void>
  children: ReactNode
}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onSubmit()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível concluir a ação.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="detail-action" onSubmit={(event) => void submit(event)}>
      <h3>{title}</h3>
      {children}
      {error && <Alert tone="error">{error}</Alert>}
      <button type="submit" className="maintenance-primary-button" disabled={busy}>
        {submitLabel}
      </button>
    </form>
  )
}

type Segment = { origem: string; destino: string; data: string; horario: string }
const emptySegment: Segment = { origem: '', destino: '', data: '', horario: '' }

/** Correção pelo solicitante: só os campos indicados, com o valor atual já preenchido. */
function CorrectionForm({ module, detail, onDone }: { module: RequestModule; detail: RequestDetail; onDone: () => Promise<void> }) {
  const { catalog } = useCatalog()
  const { request, fieldNames, passengers } = detail
  const open = detail.returns.find((item) => item.status === 'aberta')!
  const [response, setResponse] = useState('')
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      open.fields
        .filter((field) => !['ida', 'volta', 'passageiros'].includes(field) || module === 'fleet')
        .map((field) => {
          if (field === 'descricao') return [field, request.description ?? '']
          if (field === 'passageiros') {
            const list = (request.details.passageiros as { nome: string }[] | undefined) ?? []
            return [field, list.map((item) => item.nome).join('\n')]
          }
          if (['dataHora', 'dataHoraRetorno', 'dataPreferencial'].includes(field)) {
            return [field, toLocalInput(request.details[field] as string | null)]
          }
          if (field === 'andarId') return [field, request.floorId ?? '']
          if (field === 'tipoServicoId') return [field, request.serviceTypeId ?? '']
          return [field, (request.details[field] as string | null) ?? '']
        }),
    ),
  )
  const [segments, setSegments] = useState<Record<string, Segment>>({
    ida: (request.details.ida as Segment | null) ?? emptySegment,
    volta: (request.details.volta as Segment | null) ?? emptySegment,
  })
  const [rows, setRows] = useState(passengers.map((item) => ({ id: item.id, nome: item.name, cpf: '' })))
  const set = (field: string, value: string) => setValues((current) => ({ ...current, [field]: value }))

  function fieldControl(field: string) {
    const label = fieldNames[field]
    if (field === 'andarId' || field === 'tipoServicoId') {
      const options = field === 'andarId' ? catalog.floors : catalog.serviceTypes
      return (
        <label className="maintenance-form-field" key={field}>
          <span>{label}</span>
          <select value={values[field]} onChange={(event) => set(field, event.target.value)}>
            <option value="">Selecione</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )
    }
    if (['ida', 'volta'].includes(field) && module === 'flights') {
      const segment = segments[field]
      const change = (key: keyof Segment, value: string) =>
        setSegments((current) => ({ ...current, [field]: { ...current[field], [key]: value } }))
      return (
        <fieldset className="check-list" key={field}>
          <legend>{label}</legend>
          <label className="maintenance-form-field"><span>Origem</span><input value={segment.origem} onChange={(event) => change('origem', event.target.value)} /></label>
          <label className="maintenance-form-field"><span>Destino</span><input value={segment.destino} onChange={(event) => change('destino', event.target.value)} /></label>
          <label className="maintenance-form-field"><span>Data</span><input type="date" value={segment.data} onChange={(event) => change('data', event.target.value)} /></label>
          <label className="maintenance-form-field"><span>Horário</span><input type="time" value={segment.horario} onChange={(event) => change('horario', event.target.value)} /></label>
        </fieldset>
      )
    }
    if (field === 'passageiros' && module === 'flights') {
      return (
        <fieldset className="check-list" key={field}>
          <legend>{label}</legend>
          {rows.map((row, index) => {
            const update = (key: 'nome' | 'cpf', value: string) =>
              setRows((current) => current.map((item, position) => (position === index ? { ...item, [key]: value } : item)))
            return (
              <div className="detail-passenger-row" key={row.id}>
                <label className="maintenance-form-field"><span>Nome</span><input value={row.nome} onChange={(event) => update('nome', event.target.value)} /></label>
                <label className="maintenance-form-field">
                  <span>CPF (em branco: mantém o atual)</span>
                  <input autoComplete="off" inputMode="numeric" maxLength={14} value={row.cpf} onChange={(event) => update('cpf', event.target.value)} />
                </label>
              </div>
            )
          })}
        </fieldset>
      )
    }
    if (['dataHora', 'dataHoraRetorno', 'dataPreferencial'].includes(field)) {
      return (
        <label className="maintenance-form-field" key={field}>
          <span>{label}</span>
          <input type="datetime-local" value={values[field]} onChange={(event) => set(field, event.target.value)} />
        </label>
      )
    }
    const long = ['descricao', 'observacoes', 'finalidade', 'passageiros'].includes(field)
    return (
      <label className="maintenance-form-field" key={field}>
        <span>{label}{field === 'passageiros' ? ' (um nome por linha)' : ''}</span>
        {long ? (
          <textarea rows={3} value={values[field]} onChange={(event) => set(field, event.target.value)} />
        ) : (
          <input value={values[field]} onChange={(event) => set(field, event.target.value)} />
        )}
      </label>
    )
  }

  return (
    <FormBox
      title={open.type === 'correcao' ? 'Corrigir a solicitação' : 'Responder à solicitação de informações'}
      submitLabel="Enviar para a equipe"
      onSubmit={async () => {
        const dados: Record<string, unknown> = {}
        for (const field of open.fields) {
          if (module === 'flights' && (field === 'ida' || field === 'volta')) dados[field] = segments[field]
          else if (module === 'flights' && field === 'passageiros') dados.passageiros = rows
          else if (field === 'passageiros') {
            dados.passageiros = values[field].split('\n').map((name) => name.trim()).filter(Boolean).map((nome) => ({ nome }))
          } else if (['dataHora', 'dataHoraRetorno', 'dataPreferencial'].includes(field)) {
            dados[field] = fromLocalInput(values[field]) ?? null
          } else dados[field] = values[field]
        }
        await respondRequestReturn(module, request.id, { resposta: response, dados })
        await onDone()
      }}
    >
      {open.fields.map(fieldControl)}
      <label className="maintenance-form-field">
        <span>{open.type === 'correcao' ? 'Comentário' : 'Resposta'}{open.fields.length === 0 ? ' *' : ''}</span>
        <textarea rows={3} required={open.fields.length === 0} maxLength={2000} value={response} onChange={(event) => setResponse(event.target.value)} />
      </label>
    </FormBox>
  )
}

function ReturnForm({ module, detail, onDone }: { module: RequestModule; detail: RequestDetail; onDone: () => Promise<void> }) {
  const [type, setType] = useState('correcao')
  const [reason, setReason] = useState('')
  const [fields, setFields] = useState<string[]>([])

  return (
    <FormBox
      title="Devolver ao solicitante"
      submitLabel="Devolver"
      onSubmit={async () => {
        await openRequestReturn(module, detail.request.id, { tipo: type, motivo: reason, campos: fields })
        await onDone()
      }}
    >
      <label className="maintenance-form-field">
        <span>Tipo</span>
        <select value={type} onChange={(event) => setType(event.target.value)}>
          <option value="correcao">Correção de dados</option>
          <option value="complementacao">Informações complementares</option>
        </select>
      </label>
      <label className="maintenance-form-field">
        <span>Motivo *</span>
        <textarea required rows={3} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <fieldset className="check-list">
        <legend>Campos a corrigir{type === 'correcao' ? ' *' : ''}</legend>
        {Object.entries(detail.fieldNames).map(([field, label]) => (
          <label key={field}>
            <input
              type="checkbox"
              checked={fields.includes(field)}
              onChange={(event) =>
                setFields((current) => (event.target.checked ? [...current, field] : current.filter((item) => item !== field)))
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
    </FormBox>
  )
}

function CloseForm({ module, id, onDone }: { module: RequestModule; id: string; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('')
  return (
    <FormBox
      title="Encerrar a devolução"
      submitLabel="Encerrar devolução"
      onSubmit={async () => {
        await closeRequestReturn(module, id, reason)
        await onDone()
      }}
    >
      <label className="maintenance-form-field">
        <span>Motivo *</span>
        <textarea required rows={2} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
    </FormBox>
  )
}

/** Devolução para correção: a solicitação continua a mesma, com o mesmo protocolo. */
function ReturnPanel({ module, detail, onDone }: { module: RequestModule; detail: RequestDetail; onDone: () => Promise<void> }) {
  const { returns, actions, fieldNames } = detail
  const open = returns.find((item) => item.status === 'aberta')

  if (returns.length === 0 && !actions.returnForCorrection) return null

  return (
    <section className="admin-data-card detail-card" aria-labelledby="return-title">
      <h2 id="return-title">Devolução para correção</h2>
      {open && (
        <div className="return-panel" data-testid="open-return">
          <Alert tone="warning">
            <strong>{actions.respondReturn ? 'Esta solicitação precisa da sua atenção.' : 'Aguardando o solicitante.'}</strong>{' '}
            {open.reason}
          </Alert>
          {open.fields.length > 0 && (
            <p>
              <strong>O que corrigir:</strong> {open.fields.map((field) => fieldNames[field] ?? field).join(', ')}
            </p>
          )}
          <small>O prazo interno não corre enquanto aguarda a resposta.</small>
        </div>
      )}
      {actions.respondReturn && <CorrectionForm key={open?.id} module={module} detail={detail} onDone={onDone} />}
      {actions.returnForCorrection && <ReturnForm module={module} detail={detail} onDone={onDone} />}
      {actions.closeReturn && <CloseForm module={module} id={detail.request.id} onDone={onDone} />}
      {returns.length > 0 && (
        <ul className="detail-history">
          {returns.map((item) => (
            <li key={item.id}>
              <strong>{item.type === 'correcao' ? 'Correção' : 'Informações complementares'}: {situationLabels[item.status] ?? item.status}</strong>
              <span>{item.reason}</span>
              {item.response && <span>Resposta: {item.response}</span>}
              <small>
                Devolvida em {formatDateTime(item.returnedAt)}
                {item.finishedAt ? ` · Finalizada em ${formatDateTime(item.finishedAt)}` : ''}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default ReturnPanel
