import type { ChangeEvent } from 'react'
import type { FormFieldDefinition } from '../app/formDefinitions'
import { setPendingFile } from '../app/formFiles'
import MaintenanceOptionSelect from './MaintenanceOptionSelect'

type ConfiguredFieldProps = {
  field: FormFieldDefinition
  value?: string
  onValueChange?: (value: string) => void
}

function FieldHints({ field }: { field: FormFieldDefinition }) {
  return (
    <>
      {field.description && <small>{field.description}</small>}
      {field.help && <small>{field.help}</small>}
    </>
  )
}

function ConfiguredField({
  field,
  value,
  onValueChange,
}: ConfiguredFieldProps) {
  const isControlled = value !== undefined && onValueChange !== undefined
  const selectBinding = isControlled ? { value, onChange: onValueChange } : {}
  const className =
    field.type === 'longText' || field.type === 'multiSelect'
      ? 'maintenance-form-field maintenance-form-field-wide'
      : 'maintenance-form-field'

  if (
    field.id === 'sector' ||
    field.id === 'setor' ||
    field.id === 'requesterSector'
  ) {
    return (
      <div>
        <MaintenanceOptionSelect
          category="sectors"
          label={field.label}
          name={field.id}
          required={field.required}
          {...selectBinding}
        />
        <FieldHints field={field} />
      </div>
    )
  }
  if (
    field.id === 'floor' ||
    field.id === 'andar' ||
    field.id === 'requesterFloor'
  ) {
    return (
      <div>
        <MaintenanceOptionSelect
          category="floors"
          label={field.label}
          name={field.id}
          required={field.required}
          {...selectBinding}
        />
        <FieldHints field={field} />
      </div>
    )
  }
  if (field.id === 'tipoSolicitacao') {
    return (
      <div>
        <MaintenanceOptionSelect
          category="serviceTypes"
          label={field.label}
          name={field.id}
          required={field.required}
          {...selectBinding}
        />
        <FieldHints field={field} />
      </div>
    )
  }
  if (field.id === 'tripType') {
    return (
      <div className="air-travel-trip-type">
        <span>
          {field.label}
          {field.required && (
            <>
              {' '}
              <span className="required-marker" aria-hidden="true">*</span>
            </>
          )}
        </span>
        {field.options.map((option) => (
          <label key={option}>
            <input
              type="radio"
              name={field.id}
              value={option}
              required={field.required}
            />
            {option}
          </label>
        ))}
        <FieldHints field={field} />
      </div>
    )
  }

  const label = (
    <span>
      {field.label}
      {field.required && (
        <>
          {' '}
          <span className="required-marker" aria-hidden="true">*</span>
        </>
      )}
    </span>
  )
  const sharedProps = {
    name: field.id,
    required: field.required,
    value: isControlled ? value : undefined,
    onChange: isControlled
      ? (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
          onValueChange(event.target.value)
      : undefined,
  }

  return (
    <label className={className}>
      {label}
      {field.type === 'longText' ? (
        <>
          <textarea {...sharedProps} rows={4} minLength={field.minLength ?? undefined} maxLength={field.maxLength ?? undefined} />
          <FieldHints field={field} />
        </>
      ) : field.type === 'singleSelect' ? (
        <>
          <select
            name={field.id}
            required={field.required}
            value={isControlled ? value : undefined}
            defaultValue={isControlled ? undefined : ''}
            onChange={sharedProps.onChange}
          >
            <option value="" disabled>
              Selecione uma opção
            </option>
            {field.options.map((option, index) => (
              <option key={`${field.id}-${index}`} value={option}>
                {option}
              </option>
            ))}
          </select>
          <FieldHints field={field} />
        </>
      ) : field.type === 'multiSelect' ? (
        <>
          <select
            name={field.id}
            multiple
            required={field.required}
            defaultValue={[]}
            onChange={
              isControlled
                ? (event) =>
                    onValueChange(
                      Array.from(event.target.selectedOptions)
                        .map((option) => option.value)
                        .join('|'),
                    )
                : undefined
            }
          >
            {field.options.map((option, index) => (
              <option key={`${field.id}-${index}`} value={option}>
                {option}
              </option>
            ))}
          </select>
          <FieldHints field={field} />
        </>
      ) : field.type === 'attachment' ? (
        <>
          <input
            type="file"
            name={field.id}
            required={field.required}
            accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.txt"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null
              setPendingFile(field.id, file)
              onValueChange?.(file?.name ?? '')
            }}
          />
          <FieldHints field={field} />
          <small>O arquivo é enviado junto com a solicitação e fica em "Documentos e anexos".</small>
        </>
      ) : field.type === 'checkbox' ? (
        <>
          <input
            type="checkbox"
            name={field.id}
            required={field.required}
            checked={isControlled ? value === 'true' : undefined}
            onChange={isControlled ? (event) => onValueChange(event.target.checked ? 'true' : '') : undefined}
          />
          <FieldHints field={field} />
        </>
      ) : field.type === 'boolean' ? (
        <>
          <select
            name={field.id}
            required={field.required}
            value={isControlled ? value : undefined}
            defaultValue={isControlled ? undefined : ''}
            onChange={sharedProps.onChange}
          >
            <option value="" disabled>
              Selecione
            </option>
            <option value="true">Sim</option>
            <option value="false">Não</option>
          </select>
          <FieldHints field={field} />
        </>
      ) : (
        <>
          <input
            {...sharedProps}
            minLength={field.minLength ?? undefined}
            maxLength={field.maxLength ?? undefined}
            min={field.min ?? undefined}
            max={field.max ?? undefined}
            type={
              field.type === 'shortText'
                ? 'text'
                : field.type === 'phone'
                  ? 'tel'
                  : field.type === 'number'
                  ? 'number'
                  : field.type === 'dateTime'
                    ? 'datetime-local'
                    : field.type
            }
          />
          <FieldHints field={field} />
        </>
      )}
    </label>
  )
}

export default ConfiguredField
