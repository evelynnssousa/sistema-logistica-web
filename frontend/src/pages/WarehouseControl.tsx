import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { createControlRecord, getControlForm, listControlRecords } from '../api/configApi'
import type { ControlRecord, FormContent } from '../api/configApi'
import { errorMessage, formatDateTime, listMaterials } from '../api/modulesApi'
import type { Material } from '../api/modulesApi'
import { useCatalog } from '../app/useCatalog'
import { isManagedFieldVisible } from '../app/requestForm'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import Pagination from '../components/ui/Pagination'

const standardIds = ['reference', 'sector', 'material', 'description', 'referenceQuantity', 'countedQuantity', 'providedQuantity', 'notes', 'divergenceJustification']

/**
 * Controle interno da SLM, com os campos do Gerenciador de formulários. Não recebe pedidos de
 * outros setores, que continuam no procedimento governamental, e não movimenta saldo.
 */
export function ControlTab() {
  const { catalog } = useCatalog()
  const [form, setForm] = useState<FormContent | null>(null)
  const [materials, setMaterials] = useState<Material[]>([])
  const [values, setValues] = useState<Record<string, string>>({})
  const [records, setRecords] = useState<{ list: ControlRecord[]; page: number; hasMore: boolean } | null>(null)
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async (target: number) => {
    const data = await listControlRecords(target)
    setRecords({ list: data.records, page: data.page, hasMore: data.hasMore })
  }, [])

  useEffect(() => {
    let active = true
    Promise.all([getControlForm(), listMaterials(), listControlRecords(page)])
      .then(([control, catalogue, list]) => {
        if (!active) return
        setForm(control.content)
        setMaterials(catalogue.materials)
        setRecords({ list: list.records, page: list.page, hasMore: list.hasMore })
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar o controle interno.'))
      })
    return () => {
      active = false
    }
  }, [page])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setFormError('')
    setNotice('')
    try {
      const body: Record<string, unknown> = {}
      const customFields: Record<string, string> = {}
      for (const [key, value] of Object.entries(values)) {
        if (standardIds.includes(key)) body[key] = value
        else customFields[key] = value
      }
      await createControlRecord({ ...body, customFields })
      setValues({})
      setNotice('Registro incluído.')
      await load(1)
      setPage(1)
    } catch (err) {
      setFormError(errorMessage(err, 'Não foi possível registrar.'))
    }
  }

  if (error) return <Alert tone="error">{error}</Alert>
  if (!form) return <Loading label="Carregando controle interno..." />

  const set = (id: string, value: string) => setValues((current) => ({ ...current, [id]: value }))
  const visible = form.fields.filter((field) => isManagedFieldVisible(field, values, true))

  return (
    <>
      <p className="module-notice">
        Controle interno de conferência da SLM. Não é um pedido de materiais e não substitui o sistema governamental,
        que continua recebendo as solicitações dos setores.
      </p>
      {notice && <Alert tone="success">{notice}</Alert>}

      <section className="ui-card ui-stacked" aria-labelledby="control-new">
        <h2 id="control-new">Novo registro</h2>
        <form className="form-grid" onSubmit={(event) => void submit(event)}>
          {visible.map((field) => {
            const label = (
              <span>
                {field.label}
                {field.required && <span aria-hidden="true"> *</span>}
              </span>
            )
            const value = values[field.id] ?? ''
            const options =
              field.catalog === 'materials'
                ? materials.map((item) => ({ value: item.id, label: `${item.name} (${item.unit})` }))
                : field.catalog === 'sectors'
                  ? catalog.sectors.map((item) => ({ value: item.id, label: item.label }))
                  : field.options.map((option) => ({ value: option, label: option }))
            const control =
              field.type === 'singleSelect' ? (
                <select required={field.required} value={value} onChange={(event) => set(field.id, event.target.value)}>
                  <option value="">Selecione</option>
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : field.type === 'longText' ? (
                <textarea required={field.required} rows={2} maxLength={field.maxLength ?? undefined} value={value} onChange={(event) => set(field.id, event.target.value)} />
              ) : field.type === 'checkbox' ? (
                <input type="checkbox" checked={value === 'true'} onChange={(event) => set(field.id, event.target.checked ? 'true' : '')} />
              ) : (
                <input
                  required={field.required}
                  type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'phone' ? 'tel' : field.type === 'email' ? 'email' : 'text'}
                  step={field.type === 'number' ? '0.01' : undefined}
                  min={field.min ?? undefined}
                  max={field.max ?? undefined}
                  maxLength={field.maxLength ?? undefined}
                  value={value}
                  onChange={(event) => set(field.id, event.target.value)}
                />
              )
            return (
              <label key={field.id} className={`maintenance-form-field${field.type === 'longText' ? ' form-grid-wide' : ''}`}>
                {label}
                {control}
                {(field.description || field.help) && <small>{field.help || field.description}</small>}
              </label>
            )
          })}
          {formError && <Alert tone="error" className="form-grid-wide">{formError}</Alert>}
          <button type="submit" className="maintenance-primary-button">
            Registrar
          </button>
        </form>
      </section>

      {records && (
        <section className="ui-card ui-stacked" aria-labelledby="control-history">
          <h2 id="control-history">Registros</h2>
          {records.list.length === 0 ? (
            <EmptyState icon="inventory" title="Nenhum registro de controle" />
          ) : (
            <div className="data-table-wrapper">
              <table className="data-table">
                <caption className="visually-hidden">Registros de controle interno de materiais</caption>
                <thead>
                  <tr>
                    <th scope="col">Data</th>
                    <th scope="col">Material</th>
                    <th scope="col">Referência</th>
                    <th scope="col">Setor</th>
                    <th scope="col">Referência (qtd.)</th>
                    <th scope="col">Conferida</th>
                    <th scope="col">Disponibilizada</th>
                    <th scope="col">Justificativa</th>
                    <th scope="col">Registro</th>
                  </tr>
                </thead>
                <tbody>
                  {records.list.map((record) => (
                    <tr key={record.id}>
                      <td>{formatDateTime(record.at)}</td>
                      <td>{record.material}</td>
                      <td>{record.reference ?? '—'}</td>
                      <td>{record.sector ?? '—'}</td>
                      <td>{record.referenceQuantity ?? '—'}</td>
                      <td>{record.countedQuantity ?? '—'}</td>
                      <td>{record.providedQuantity ?? '—'}</td>
                      <td>{record.justification ?? '—'}</td>
                      <td>{record.user ?? 'Sistema'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination page={records.page} summary="" hasNext={records.hasMore} onChange={setPage} />
        </section>
      )}
    </>
  )
}
