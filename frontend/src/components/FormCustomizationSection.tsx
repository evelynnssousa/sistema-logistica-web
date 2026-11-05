import { useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import {
  fieldTypes,
  formKeys,
  getFormDefinitionsSnapshot,
  saveFormDefinitions,
  subscribeFormDefinitions,
} from '../app/formDefinitions'
import type {
  FormFieldDefinition,
  FormFieldType,
  FormKey,
} from '../app/formDefinitions'
import ConfiguredField from './ConfiguredField'

const formTitles: Record<FormKey, string> = {
  maintenance: 'Formulário de Manutenção',
  fleet: 'Formulário de Frota',
  airTravel: 'Formulário de Passagens Aéreas',
}

const typeLabels: Record<FormFieldType, string> = {
  shortText: 'Texto curto',
  longText: 'Texto longo',
  number: 'Número',
  email: 'E-mail',
  date: 'Data',
  time: 'Horário',
  dateTime: 'Data e horário',
  singleSelect: 'Lista de opções',
  multiSelect: 'Múltiplas opções',
  boolean: 'Sim/não',
  phone: 'Telefone',
  checkbox: 'Caixa de seleção',
}

function copyDefinitions(fields: FormFieldDefinition[]) {
  return fields.map((field) => ({ ...field, options: [...field.options] }))
}

function createFieldId() {
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function FormCustomizationSection() {
  const snapshot = useSyncExternalStore(
    subscribeFormDefinitions,
    getFormDefinitionsSnapshot,
    getFormDefinitionsSnapshot,
  )
  const [formKey, setFormKey] = useState<FormKey>('maintenance')
  const [draft, setDraft] = useState(() =>
    copyDefinitions(snapshot.definitions.maintenance),
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftField, setDraftField] = useState<FormFieldDefinition | null>(null)
  const [newOption, setNewOption] = useState('')
  const [feedback, setFeedback] = useState('')
  const [previewVisible, setPreviewVisible] = useState(false)
  const [newFieldId, setNewFieldId] = useState<string | null>(null)

  function selectForm(nextForm: FormKey) {
    const currentSaved = snapshot.definitions[formKey]
    if (
      (JSON.stringify(draft) !== JSON.stringify(currentSaved) ||
        editingId !== null) &&
      !window.confirm(
        'Há alterações não salvas neste formulário. Deseja descartá-las?',
      )
    ) {
      return
    }
    setFormKey(nextForm)
    setDraft(copyDefinitions(snapshot.definitions[nextForm]))
    setEditingId(null)
    setDraftField(null)
    setFeedback('')
  }

  function moveField(index: number, offset: -1 | 1) {
    const nextIndex = index + offset
    if (nextIndex < 0 || nextIndex >= draft.length) return
    setDraft((current) => {
      const next = [...current]
      ;[next[index], next[nextIndex]] = [next[nextIndex], next[index]]
      return next
    })
  }

  function startEdit(field: FormFieldDefinition) {
    setNewFieldId(null)
    setEditingId(field.id)
    setDraftField({ ...field, options: [...field.options] })
    setNewOption('')
    setFeedback('')
  }

  function updateDraftField<K extends keyof FormFieldDefinition>(
    key: K,
    value: FormFieldDefinition[K],
  ) {
    setDraftField((current) =>
      current ? { ...current, [key]: value } : current,
    )
  }

  function applyFieldEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draftField) return
    if (!draftField.label.trim()) {
      setFeedback('Informe o nome do campo.')
      return
    }
    if (
      draft.some(
        (field) =>
          field.id !== draftField.id &&
          field.label.trim().toLocaleLowerCase('pt-BR') ===
            draftField.label.trim().toLocaleLowerCase('pt-BR'),
      )
    ) {
      setFeedback('Já existe outro campo com esse nome neste formulário.')
      return
    }
    if (
      !draftField.protected &&
      (draftField.type === 'singleSelect' ||
        draftField.type === 'multiSelect')
    ) {
      const normalizedOptions = draftField.options.map((option) =>
        option.trim().toLocaleLowerCase('pt-BR'),
      )
      if (
        normalizedOptions.length === 0 ||
        normalizedOptions.some((option) => !option) ||
        new Set(normalizedOptions).size !== normalizedOptions.length
      ) {
        setFeedback(
          'Adicione pelo menos uma opção e verifique se não há opções vazias ou duplicadas.',
        )
        return
      }
    }
    setDraft((current) =>
      current.map((field) =>
        field.id === draftField.id
          ? {
              ...draftField,
              label: draftField.label.trim(),
              options: draftField.options.map((option) => option.trim()),
            }
          : field,
      ),
    )
    setEditingId(null)
    setDraftField(null)
    setNewFieldId(null)
    setFeedback('Edição aplicada à prévia. Salve para atualizar o formulário.')
  }

  function addField() {
    const newField: FormFieldDefinition = {
      id: createFieldId(),
      label: 'Novo campo',
      description: '',
      type: 'shortText',
      required: false,
      active: true,
      protected: false,
      options: [],
    }
    setDraft((current) => [...current, newField])
    setNewFieldId(newField.id)
    startEdit(newField)
    setNewFieldId(newField.id)
  }

  function toggleField(field: FormFieldDefinition) {
    if (field.protected) return
    setDraft((current) =>
      current.map((item) =>
        item.id === field.id ? { ...item, active: !item.active } : item,
      ),
    )
  }

  function removeField(field: FormFieldDefinition) {
    if (field.protected) return
    setDraft((current) => current.filter((item) => item.id !== field.id))
    if (editingId === field.id) {
      setEditingId(null)
      setDraftField(null)
    }
    setFeedback('Campo removido da prévia. Salve para aplicar a alteração.')
  }

  function saveChanges() {
    try {
      const nextDefinitions = {
        ...snapshot.definitions,
        [formKey]: draft,
      }
      saveFormDefinitions(nextDefinitions)
      setFeedback('Personalização salva e aplicada ao formulário.')
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : 'Não foi possível salvar a personalização.',
      )
    }
  }

  function cancelChanges() {
    setDraft(copyDefinitions(snapshot.definitions[formKey]))
    setEditingId(null)
    setDraftField(null)
    setNewFieldId(null)
    setFeedback('Alterações não salvas foram canceladas.')
  }

  function cancelFieldEdit() {
    if (newFieldId) {
      setDraft((current) => current.filter((field) => field.id !== newFieldId))
    }
    setEditingId(null)
    setDraftField(null)
    setNewFieldId(null)
    setFeedback('')
  }

  return (
    <section className="form-customization" aria-labelledby="form-customization-title">
      <div className="settings-section-heading">
        <div>
          <h2 id="form-customization-title">Personalização de formulários</h2>
          <p>
            Ajuste os campos que serão apresentados nos formulários de
            solicitações.
          </p>
        </div>
        <label className="form-customization-selector">
          <span>Formulário</span>
          <select
            value={formKey}
            onChange={(event) => selectForm(event.target.value as FormKey)}
          >
            {formKeys.map((key) => (
              <option key={key} value={key}>
                {formTitles[key]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="form-customization-warning" role="note">
        As personalizações são salvas somente neste navegador. Setor e Andar
        continuam ligados aos catálogos centrais. Campos protegidos mantêm
        validações e comportamentos necessários ao formulário.
      </div>
      {snapshot.error && (
        <div className="settings-storage-error" role="alert">
          {snapshot.error}
        </div>
      )}

      <div className="form-field-list">
        {draft.map((field, index) => (
          <article className="form-field-config" key={field.id}>
            <div className="form-field-config-main">
              <div className="form-field-config-order" aria-label={`Posição ${index + 1}`}>
                {index + 1}
              </div>
              <div className="form-field-config-info">
                <strong>{field.label}</strong>
                <span>
                  {typeLabels[field.type]} ·{' '}
                  {field.required ? 'Obrigatório' : 'Opcional'} ·{' '}
                  {field.active ? 'Ativo' : 'Inativo'}
                </span>
              </div>
              {field.protected && (
                <span className="form-field-protected">Protegido</span>
              )}
              <div className="form-field-config-actions">
                <button
                  type="button"
                  onClick={() => moveField(index, -1)}
                  disabled={index === 0 || editingId !== null}
                  aria-label={`Mover ${field.label} para cima`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveField(index, 1)}
                  disabled={index === draft.length - 1 || editingId !== null}
                  aria-label={`Mover ${field.label} para baixo`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(field)}
                  disabled={editingId !== null && editingId !== field.id}
                >
                  Editar
                </button>
                <button
                  type="button"
                  onClick={() => toggleField(field)}
                  disabled={field.protected || editingId !== null}
                  title={
                    field.protected
                      ? 'Campo protegido: não pode ser desativado.'
                      : undefined
                  }
                >
                  {field.active ? 'Desativar' : 'Ativar'}
                </button>
                {!field.protected && (
                  <button
                    type="button"
                    onClick={() => removeField(field)}
                    disabled={editingId !== null}
                    title="Remover este campo da configuração."
                  >
                    Remover
                  </button>
                )}
              </div>
            </div>
            {field.protected && (
              <small className="form-field-protection-note">
                Este campo é necessário para preservar validações ou fluxos
                especiais e não pode ser desativado, removido ou ter seu tipo
                alterado.
              </small>
            )}
            {editingId === field.id && draftField && (
              <form className="form-field-editor" onSubmit={applyFieldEdit}>
                <label>
                  <span>Nome / etiqueta</span>
                  <input
                    required
                    maxLength={120}
                    value={draftField.label}
                    onChange={(event) =>
                      updateDraftField('label', event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>Descrição ou instrução</span>
                  <input
                    maxLength={240}
                    value={draftField.description}
                    onChange={(event) =>
                      updateDraftField('description', event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>Tipo do campo</span>
                  <select
                    value={draftField.type}
                    disabled={draftField.protected}
                    onChange={(event) =>
                      updateDraftField(
                        'type',
                        event.target.value as FormFieldType,
                      )
                    }
                  >
                    {fieldTypes.map((type) => (
                      <option key={type} value={type}>
                        {typeLabels[type]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="form-field-check">
                  <input
                    type="checkbox"
                    checked={draftField.required}
                    disabled={draftField.protected}
                    onChange={(event) =>
                      updateDraftField('required', event.target.checked)
                    }
                  />
                  Obrigatório
                </label>
                <label className="form-field-check">
                  <input
                    type="checkbox"
                    checked={draftField.active}
                    disabled={draftField.protected}
                    onChange={(event) =>
                      updateDraftField('active', event.target.checked)
                    }
                  />
                  Exibir no formulário
                </label>
                {(draftField.type === 'singleSelect' ||
                  draftField.type === 'multiSelect') &&
                  !draftField.protected &&
                  ![
                    'sector',
                    'floor',
                    'setor',
                    'andar',
                    'tipoSolicitacao',
                    'requesterSector',
                    'requesterFloor',
                  ].includes(
                    draftField.id,
                  ) && (
                    <div className="form-options-editor">
                      <strong>Opções da lista</strong>
                      {draftField.options.map((option, optionIndex) => (
                        <div className="form-option-row" key={`${draftField.id}-${optionIndex}`}>
                          <input
                            required
                            maxLength={120}
                            value={option}
                            aria-label={`Opção ${optionIndex + 1}`}
                            onChange={(event) =>
                              updateDraftField(
                                'options',
                                draftField.options.map((current, index) =>
                                  index === optionIndex
                                    ? event.target.value
                                    : current,
                                ),
                              )
                            }
                          />
                          <button
                            type="button"
                            disabled={optionIndex === 0}
                            aria-label={`Mover opção ${optionIndex + 1} para cima`}
                            onClick={() =>
                              updateDraftField(
                                'options',
                                draftField.options.map((current, index) =>
                                  index === optionIndex - 1
                                    ? option
                                    : index === optionIndex
                                      ? draftField.options[optionIndex - 1]
                                      : current,
                                ),
                              )
                            }
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            disabled={optionIndex === draftField.options.length - 1}
                            aria-label={`Mover opção ${optionIndex + 1} para baixo`}
                            onClick={() =>
                              updateDraftField(
                                'options',
                                draftField.options.map((current, index) =>
                                  index === optionIndex + 1
                                    ? option
                                    : index === optionIndex
                                      ? draftField.options[optionIndex + 1]
                                      : current,
                                ),
                              )
                            }
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              updateDraftField(
                                'options',
                                draftField.options.filter(
                                  (_, index) => index !== optionIndex,
                                ),
                              )
                            }
                          >
                            Remover
                          </button>
                        </div>
                      ))}
                      <div className="form-option-add">
                        <input
                          value={newOption}
                          maxLength={120}
                          onChange={(event) => setNewOption(event.target.value)}
                          placeholder="Nova opção"
                          aria-label="Nova opção da lista"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const normalized = newOption.trim().toLocaleLowerCase('pt-BR')
                            if (
                              !normalized ||
                              draftField.options.some(
                                (option) =>
                                  option.trim().toLocaleLowerCase('pt-BR') ===
                                  normalized,
                              )
                            ) {
                              setFeedback('Informe uma opção válida e não duplicada.')
                              return
                            }
                            updateDraftField('options', [
                              ...draftField.options,
                              newOption.trim(),
                            ])
                            setNewOption('')
                          }}
                        >
                          Adicionar opção
                        </button>
                      </div>
                    </div>
                  )}
                <div className="form-field-live-preview">
                  <strong>Prévia do campo</strong>
                  {draftField.active ? (
                    <ConfiguredField field={draftField} />
                  ) : (
                    <p>Este campo está desativado e não aparecerá no formulário.</p>
                  )}
                </div>
                <div className="form-field-editor-actions">
                  <button type="submit">Salvar edição</button>
                  <button
                    type="button"
                    onClick={cancelFieldEdit}
                  >
                    Cancelar
                  </button>
                </div>
              </form>
            )}
          </article>
        ))}
      </div>

      <div className="form-customization-actions">
        <button
          type="button"
          onClick={addField}
          disabled={editingId !== null}
        >
          Adicionar campo
        </button>
        <button
          type="button"
          aria-expanded={previewVisible}
          onClick={() => setPreviewVisible((visible) => !visible)}
        >
          {previewVisible ? 'Ocultar prévia' : 'Visualizar prévia'}
        </button>
        <button type="button" onClick={cancelChanges}>
          Cancelar alterações
        </button>
        <button
          type="button"
          onClick={saveChanges}
          disabled={snapshot.error !== null || editingId !== null}
          title={
            editingId !== null
              ? 'Aplique ou feche a edição do campo antes de salvar.'
              : undefined
          }
        >
          Salvar alterações
        </button>
      </div>
      {previewVisible && (
        <div className="form-customization-preview">
          <div>
            <h3>Prévia</h3>
            <p>
              Campos ativos na ordem configurada. O formulário final mantém
              comportamentos especiais, como passageiros e trechos condicionais.
            </p>
          </div>
          <div className="maintenance-request-fields">
            {draft
              .filter((field) => field.active)
              .map((field) => (
                <ConfiguredField key={field.id} field={field} />
              ))}
          </div>
        </div>
      )}
      {feedback && (
        <p className="settings-feedback" role="status">
          {feedback}
        </p>
      )}
    </section>
  )
}

export default FormCustomizationSection
