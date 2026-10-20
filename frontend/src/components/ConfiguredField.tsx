import type { ChangeEvent } from 'react'
import type { FormFieldDefinition } from '../app/formDefinitions'
import MaintenanceOptionSelect from './MaintenanceOptionSelect'

type ConfiguredFieldProps = {
  field: FormFieldDefinition
  value?: string
  onValueChange?: (value: string) => void
}

function ConfiguredField({
  field,
  value,
  onValueChange,
}: ConfiguredFieldProps) {
  const isControlled = value !== undefined && onValueChange !== undefined
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
        />
        {field.description && <small>{field.description}</small>}
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
        />
        {field.description && <small>{field.description}</small>}
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
        />
        {field.description && <small>{field.description}</small>}
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
              <span className="required-marker">*</span>
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
        {field.description && <small>{field.description}</small>}
      </div>
    )
  }

  const label = (
    <span>
      {field.label}
      {field.required && (
        <>
          {' '}
          <span className="required-marker">*</span>
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
          <textarea {...sharedProps} rows={4} />
          {field.description && <small>{field.description}</small>}
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
          {field.description && <small>{field.description}</small>}
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
          {field.description && <small>{field.description}</small>}
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
          {field.description && <small>{field.description}</small>}
        </>
      ) : (
        <>
          <input
            {...sharedProps}
            type={
              field.type === 'shortText'
                ? 'text'
                : field.type === 'number'
                  ? 'number'
                  : field.type === 'dateTime'
                    ? 'datetime-local'
                    : field.type
            }
          />
          {field.description && <small>{field.description}</small>}
        </>
      )}
    </label>
  )
}

export default ConfiguredField
