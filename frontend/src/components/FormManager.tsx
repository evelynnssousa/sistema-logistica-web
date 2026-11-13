import { forgetManagedForm } from '../app/useManagedForm'
import { useEffect, useState } from 'react'
import {
  getFormLibrary,
  getManagedForm,
  publishForm,
  restoreForm,
  saveFormDraft,
  validateForm,
} from '../api/configApi'
import type { ConfigVersion, FormContent, ManagedField } from '../api/configApi'
import { errorMessage, formatDateTime } from '../api/modulesApi'
import { isManagedFieldVisible } from '../app/requestForm'
import { useHasPermission } from '../auth/UserContext'
import { Alert, Loading } from './ui/Feedback'
import Icon from './ui/Icon'

const typeLabels: Record<string, string> = {
  shortText: 'Texto curto',
  longText: 'Texto longo',
  number: 'Número',
  email: 'E-mail',
  phone: 'Telefone',
  date: 'Data',
  time: 'Horário',
  dateTime: 'Data e horário',
  singleSelect: 'Seleção única',
  multiSelect: 'Seleção múltipla',
  boolean: 'Sim ou não',
  checkbox: 'Caixa de seleção',
}

const validationLabels: Record<string, string> = {
  none: 'Sem regra adicional',
  digits: 'Somente números',
  letters: 'Somente letras',
  phone: 'Telefone',
  email: 'E-mail',
}

const catalogLabels: Record<string, string> = {
  sectors: 'Setores',
  floors: 'Andares',
  serviceTypes: 'Tipos de serviço',
  warehouseCategories: 'Categorias do Almoxarifado',
  measurementUnits: 'Unidades de medida',
  materials: 'Materiais',
}

function newField(section: string): ManagedField {
  return {
    id: `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    label: '',
    description: '',
    help: '',
    type: 'shortText',
    required: false,
    active: true,
    protected: false,
    options: [],
    catalog: null,
    section,
    minLength: null,
    maxLength: null,
    min: null,
    max: null,
    validation: 'none',
    visibleTo: 'all',
    visibleWhen: null,
  }
}

const numberOrNull = (value: string) => (value === '' ? null : Number(value))

function FieldEditor({
  field,
  earlier,
  content,
  onChange,
  onRemove,
  onMove,
  disabled,
}: {
  field: ManagedField
  earlier: ManagedField[]
  content: FormContent
  onChange: (field: ManagedField) => void
  onRemove: () => void
  onMove: (step: number) => void
  disabled: boolean
}) {
  const set = <Key extends keyof ManagedField>(key: Key, value: ManagedField[Key]) => onChange({ ...field, [key]: value })
  const isSelect = ['singleSelect', 'multiSelect'].includes(field.type)

  return (
    <details className="settings-customize" data-field={field.id}>
      <summary>
        {field.label || 'Novo campo'} · {typeLabels[field.type] ?? field.type}
        {field.required ? ' · obrigatório' : ''}
        {field.active ? '' : ' · desativado'}
        {field.protected ? ' · protegido' : ''}
        {field.visibleWhen ? ' · condicional' : ''}
      </summary>
      <fieldset disabled={disabled} className="parameter-fields">
        <div className="form-grid">
          <label className="maintenance-form-field">
            <span>Nome *</span>
            <input required maxLength={120} value={field.label} onChange={(event) => set('label', event.target.value)} />
          </label>
          <label className="maintenance-form-field">
            <span>Tipo</span>
            <select value={field.type} disabled={field.protected || !field.id.startsWith('custom-')} onChange={(event) => set('type', event.target.value)}>
              {Object.entries(typeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="maintenance-form-field">
            <span>Seção</span>
            <select value={field.section} onChange={(event) => set('section', event.target.value)}>
              {content.sections.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.title}
                </option>
              ))}
            </select>
          </label>
          <label className="maintenance-form-field">
            <span>Visível para</span>
            <select value={field.visibleTo} disabled={field.protected} onChange={(event) => set('visibleTo', event.target.value as ManagedField['visibleTo'])}>
              <option value="all">Todos</option>
              <option value="staff">Somente a equipe</option>
            </select>
          </label>
          <label className="maintenance-form-field form-grid-wide">
            <span>Descrição</span>
            <input maxLength={500} value={field.description} onChange={(event) => set('description', event.target.value)} />
          </label>
          <label className="maintenance-form-field form-grid-wide">
            <span>Texto de orientação</span>
            <input maxLength={500} value={field.help} onChange={(event) => set('help', event.target.value)} />
          </label>
          {isSelect && !field.protected && field.id.startsWith('custom-') && (
            <label className="maintenance-form-field">
              <span>Origem das opções</span>
              <select
                value={field.catalog ?? ''}
                onChange={(event) => onChange({ ...field, catalog: event.target.value || null, options: event.target.value ? [] : field.options })}
              >
                <option value="">Lista própria</option>
                {Object.entries(catalogLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    Cadastro: {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {isSelect && !field.catalog && !(field.protected && field.options.length > 0) && (
            <label className="maintenance-form-field form-grid-wide">
              <span>Opções (uma por linha) *</span>
              <textarea rows={3} value={field.options.join('\n')} onChange={(event) => set('options', event.target.value.split('\n'))} />
            </label>
          )}
          {field.catalog && <p className="form-grid-wide">Opções vindas do cadastro: {catalogLabels[field.catalog]}. Administre em Configurações.</p>}
          {['shortText', 'longText', 'phone', 'email'].includes(field.type) && (
            <>
              <label className="maintenance-form-field">
                <span>Tamanho mínimo</span>
                <input type="number" min="0" value={field.minLength ?? ''} onChange={(event) => set('minLength', numberOrNull(event.target.value))} />
              </label>
              <label className="maintenance-form-field">
                <span>Tamanho máximo</span>
                <input type="number" min="1" value={field.maxLength ?? ''} onChange={(event) => set('maxLength', numberOrNull(event.target.value))} />
              </label>
            </>
          )}
          {field.type === 'number' && (
            <>
              <label className="maintenance-form-field">
                <span>Valor mínimo</span>
                <input type="number" value={field.min ?? ''} onChange={(event) => set('min', numberOrNull(event.target.value))} />
              </label>
              <label className="maintenance-form-field">
                <span>Valor máximo</span>
                <input type="number" value={field.max ?? ''} onChange={(event) => set('max', numberOrNull(event.target.value))} />
              </label>
            </>
          )}
          {field.type === 'shortText' && (
            <label className="maintenance-form-field">
              <span>Regra de validação</span>
              <select value={field.validation} onChange={(event) => set('validation', event.target.value)}>
                {Object.entries(validationLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!field.protected && (
            <>
              <label className="maintenance-form-field">
                <span>Exibir somente se o campo</span>
                <select
                  value={field.visibleWhen?.field ?? ''}
                  onChange={(event) =>
                    set('visibleWhen', event.target.value ? { field: event.target.value, equals: field.visibleWhen?.equals ?? '' } : null)
                  }
                >
                  <option value="">Sempre exibir</option>
                  {earlier.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              {field.visibleWhen && (
                <label className="maintenance-form-field">
                  <span>for igual a *</span>
                  <input value={field.visibleWhen.equals} onChange={(event) => set('visibleWhen', { field: field.visibleWhen!.field, equals: event.target.value })} />
                </label>
              )}
            </>
          )}
        </div>
        <div className="action-row">
          <label>
            <input type="checkbox" disabled={field.protected} checked={field.required} onChange={(event) => set('required', event.target.checked)} /> Obrigatório
          </label>
          <label>
            <input type="checkbox" disabled={field.protected} checked={field.active} onChange={(event) => set('active', event.target.checked)} /> Ativo
          </label>
          <button type="button" onClick={() => onMove(-1)}>Mover para cima</button>
          <button type="button" onClick={() => onMove(1)}>Mover para baixo</button>
          {!field.protected && field.id.startsWith('custom-') && (
            <button type="button" onClick={onRemove}>Retirar do formulário</button>
          )}
        </div>
        {field.protected && <small>Campo protegido: sustenta o funcionamento do módulo. O nome e os textos podem mudar; o tipo e a obrigatoriedade, não.</small>}
      </fieldset>
    </details>
  )
}

/** Prévia real: mostra os campos, as seções e as regras, e testa o preenchimento sem gravar nada. */
function FormPreview({ content }: { content: FormContent }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState('')
  const set = (id: string, value: string) => setValues((current) => ({ ...current, [id]: value }))

  return (
    <form
      className="ui-card ui-stacked"
      aria-label="Pré-visualização do formulário"
      data-testid="form-preview"
      onSubmit={(event) => {
        event.preventDefault()
        setResult('Preenchimento válido. Esta é só uma prévia: nada foi gravado.')
      }}
    >
      <Alert tone="info">Prévia para conferir aparência e preenchimento. Nada é gravado.</Alert>
      {content.sections.map((section) => {
        const fields = content.fields.filter((field) => field.section === section.id && isManagedFieldVisible(field, values, true))
        if (fields.length === 0) return null
        return (
          <fieldset className="check-list" key={section.id}>
            <legend>{section.title}</legend>
            {fields.map((field) => {
              const value = values[field.id] ?? ''
              const options = field.catalog ? [`(opções do cadastro: ${catalogLabels[field.catalog]})`] : field.options
              return (
                <label className="maintenance-form-field" key={field.id}>
                  <span>
                    {field.label}
                    {field.required && <span aria-hidden="true"> *</span>}
                  </span>
                  {field.type === 'longText' ? (
                    <textarea required={field.required} maxLength={field.maxLength ?? undefined} rows={2} value={value} onChange={(event) => set(field.id, event.target.value)} />
                  ) : field.type === 'singleSelect' || field.type === 'boolean' ? (
                    <select required={field.required} value={value} onChange={(event) => set(field.id, event.target.value)}>
                      <option value="">Selecione</option>
                      {(field.type === 'boolean' ? ['Sim', 'Não'] : options).map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : field.type === 'multiSelect' ? (
                    <select multiple required={field.required} onChange={(event) => set(field.id, Array.from(event.target.selectedOptions).map((option) => option.value).join('|'))}>
                      {options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : field.type === 'checkbox' ? (
                    <input type="checkbox" required={field.required} checked={value === 'true'} onChange={(event) => set(field.id, event.target.checked ? 'true' : '')} />
                  ) : (
                    <input
                      required={field.required}
                      minLength={field.minLength ?? undefined}
                      maxLength={field.maxLength ?? undefined}
                      min={field.min ?? undefined}
                      max={field.max ?? undefined}
                      type={{ number: 'number', email: 'email', phone: 'tel', date: 'date', time: 'time', dateTime: 'datetime-local' }[field.type] ?? 'text'}
                      value={value}
                      onChange={(event) => set(field.id, event.target.value)}
                    />
                  )}
                  {(field.description || field.help) && <small>{field.help || field.description}</small>}
                </label>
              )
            })}
          </fieldset>
        )
      })}
      {result && <Alert tone="success">{result}</Alert>}
      <button type="submit" className="maintenance-secondary-button">Testar preenchimento</button>
    </form>
  )
}

function FormEditor({ formKey, onChanged }: { formKey: string; onChanged: () => void }) {
  const canEdit = useHasPermission('forms:edit')
  const canPublish = useHasPermission('forms:publish')
  const canRestore = useHasPermission('config_versions:restore')
  const [content, setContent] = useState<FormContent | null>(null)
  const [defaults, setDefaults] = useState<FormContent | null>(null)
  const [history, setHistory] = useState<ConfigVersion<FormContent>[]>([])
  const [note, setNote] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    getManagedForm(formKey)
      .then((data) => {
        if (!active) return
        setDefaults(data.default)
        setHistory(data.history)
        setContent(data.latest?.content ?? data.default)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar o formulário.'))
      })
    return () => {
      active = false
    }
  }, [formKey])

  async function run(action: () => Promise<unknown>, success: string) {
    setError('')
    setNotice('')
    try {
      await action()
      setNotice(success)
      setNote('')
      const data = await getManagedForm(formKey)
      setHistory(data.history)
      setContent(data.latest?.content ?? data.default)
      onChanged()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível concluir a ação.'))
    }
  }

  if (error && !content) return <Alert tone="error">{error}</Alert>
  if (!content) return <Loading label="Carregando formulário..." />

  const updateField = (id: string, field: ManagedField) =>
    setContent({ ...content, fields: content.fields.map((item) => (item.id === id ? field : item)) })
  const move = (index: number, step: number) => {
    const fields = [...content.fields]
    const next = index + step
    if (next < 0 || next >= fields.length) return
    ;[fields[index], fields[next]] = [fields[next], fields[index]]
    setContent({ ...content, fields })
  }

  return (
    <div className="ui-stacked" data-testid="form-editor">
      <fieldset disabled={!canEdit} className="parameter-fields">
        <legend>Seções</legend>
        {content.sections.map((section, index) => (
          <label className="maintenance-form-field" key={section.id}>
            <span>Título da seção {index + 1}</span>
            <input
              required
              maxLength={120}
              value={section.title}
              onChange={(event) =>
                setContent({
                  ...content,
                  sections: content.sections.map((item) => (item.id === section.id ? { ...item, title: event.target.value } : item)),
                })
              }
            />
          </label>
        ))}
        <button
          type="button"
          className="maintenance-secondary-button"
          onClick={() =>
            setContent({
              ...content,
              sections: [...content.sections, { id: `secao-${Date.now().toString(36)}`, title: 'Nova seção' }],
            })
          }
        >
          Adicionar seção
        </button>
      </fieldset>

      <div className="ui-stacked">
        {content.fields.map((field, index) => (
          <FieldEditor
            key={field.id}
            field={field}
            earlier={content.fields.slice(0, index).filter((item) => item.active)}
            content={content}
            disabled={!canEdit}
            onChange={(next) => updateField(field.id, next)}
            onMove={(step) => move(index, step)}
            onRemove={() => setContent({ ...content, fields: content.fields.filter((item) => item.id !== field.id) })}
          />
        ))}
      </div>

      {canEdit && (
        <button
          type="button"
          className="maintenance-secondary-button"
          onClick={() => setContent({ ...content, fields: [...content.fields, newField(content.sections[0].id)] })}
        >
          <Icon name="add" size={18} /> Adicionar campo
        </button>
      )}

      <label className="maintenance-form-field">
        <span>Observação da versão</span>
        <input maxLength={500} disabled={!canEdit} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>

      <p className="management-hint">
        Campo retirado ou desativado sai só dos próximos cadastros: os valores já registrados continuam guardados, com o
        nome que o campo tinha. Os avisos institucionais e de privacidade não fazem parte desta edição.
      </p>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="action-row">
        <button type="button" className="maintenance-secondary-button" onClick={() => setShowPreview((current) => !current)}>
          {showPreview ? 'Fechar prévia' : 'Pré-visualizar'}
        </button>
        <button
          type="button"
          className="maintenance-secondary-button"
          onClick={() => {
            setError('')
            setNotice('')
            validateForm(formKey, content)
              .then(() => setNotice('Nenhum erro de configuração encontrado.'))
              .catch((err: unknown) => setError(errorMessage(err, 'Há erros de configuração.')))
          }}
        >
          Verificar configuração
        </button>
        {canEdit && (
          <>
            <button type="button" className="maintenance-secondary-button" onClick={() => void run(() => saveFormDraft(formKey, content, note), 'Rascunho salvo. O formulário em uso não mudou.')}>
              Salvar rascunho
            </button>
            {defaults && (
              <button type="button" className="maintenance-secondary-button" onClick={() => setContent(defaults)}>
                Carregar campos padrão
              </button>
            )}
          </>
        )}
        {canPublish && (
          <button type="button" className="maintenance-primary-button" onClick={() => void run(() => publishForm(formKey, content, note), 'Formulário publicado. Os próximos cadastros usarão esta versão.')}>
            Publicar
          </button>
        )}
      </div>

      {showPreview && <FormPreview key={JSON.stringify(content)} content={content} />}

      <details>
        <summary>Histórico de versões ({history.length})</summary>
        {history.length === 0 ? (
          <p>Sem versões salvas. Valem os campos padrão.</p>
        ) : (
          <ul className="detail-history">
            {history.map((item) => (
              <li key={item.id}>
                <strong>Versão {item.version}: {item.status === 'publicada' ? 'publicada' : 'rascunho'}</strong>
                <span>{item.content.fields.length} campos</span>
                {item.note && <span>{item.note}</span>}
                <small>{item.user ?? 'Sistema'} · {formatDateTime(item.at)}</small>
                <div className="action-row">
                  <button type="button" onClick={() => setContent(item.content)}>Carregar no editor</button>
                  {canRestore && (
                    <button type="button" onClick={() => void run(() => restoreForm(formKey, item.version), `Versão ${item.version} publicada novamente.`)}>
                      Restaurar esta versão
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  )
}

function FormManager() {
  const [forms, setForms] = useState<{ key: string; label: string; published: number | null; hasDraft: boolean; fixedLayout?: boolean }[] | null>(null)
  const [selected, setSelected] = useState('maintenance')
  const [error, setError] = useState('')

  const load = () =>
    getFormLibrary()
      .then((data) => setForms(data.forms))
      .catch((err: unknown) => setError(errorMessage(err, 'Não foi possível carregar os formulários.')))

  useEffect(() => {
    void load()
  }, [])

  return (
    <section className="settings-group" aria-labelledby="settings-forms">
      <header>
        <span>
          <Icon name="customize" size={22} weight="duotone" />
        </span>
        <div>
          <h2 id="settings-forms">Gerenciador de formulários</h2>
          <p>Campos, seções e regras. Alterações só valem depois de publicadas, e os registros antigos não mudam.</p>
        </div>
      </header>
      {error && <Alert tone="error">{error}</Alert>}
      {forms && (
        <details className="settings-customize">
          <summary>Abrir gerenciador de formulários</summary>
          <div className="settings-customize-body ui-stacked">
            <label className="maintenance-form-field">
              <span>Formulário</span>
              <select value={selected} onChange={(event) => setSelected(event.target.value)}>
                {forms.map((form) => (
                  <option key={form.key} value={form.key}>
                    {form.label}
                    {form.published ? ` (publicado: v${form.published})` : ' (campos padrão)'}
                    {form.hasDraft ? ' · rascunho' : ''}
                  </option>
                ))}
              </select>
            </label>
            {forms.find((form) => form.key === selected)?.fixedLayout && (
              <Alert tone="info">
                Neste formulário, os campos que já existem podem ser renomeados, mas a ordem e o tipo deles seguem a tela. Os
                campos novos que você criar aparecem no fim, em "Informações adicionais", e ficam gravados junto do registro.
              </Alert>
            )}
            <FormEditor
              key={selected}
              formKey={selected}
              onChanged={() => {
                forgetManagedForm(selected)
                void load()
              }}
            />
          </div>
        </details>
      )}
    </section>
  )
}

export default FormManager
