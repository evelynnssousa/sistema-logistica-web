import type { CatalogCategory } from '../api/modulesApi'
import { useCatalog } from '../app/useCatalog'

type MaintenanceOptionSelectProps = {
  category: CatalogCategory
  label: string
  name: string
  required?: boolean
  value?: string
  onChange?: (value: string) => void
  emptyLabel?: string
}

/** Seletor padronizado: só oferece as opções ativas cadastradas em Configurações. */
function MaintenanceOptionSelect({
  category,
  label,
  name,
  required = false,
  value,
  onChange,
  emptyLabel,
}: MaintenanceOptionSelectProps) {
  const { catalog, error, loaded } = useCatalog()
  const options = catalog[category]
  const errorId = `${name}-catalog-error`
  const placeholder = !loaded
    ? 'Carregando...'
    : options.length > 0
      ? (emptyLabel ?? 'Selecione uma opção')
      : error
        ? 'Opções indisponíveis'
        : 'Nenhuma opção cadastrada. Consulte Configurações.'

  return (
    <div className="maintenance-option-select">
      <label className="maintenance-form-field">
        <span>
          {label}
          {required && (
            <>
              {' '}
              <span className="required-marker">*</span>
            </>
          )}
        </span>
        <select
          name={name}
          required={required}
          disabled={options.length === 0}
          {...(onChange
            ? { value: value ?? '', onChange: (event) => onChange(event.target.value) }
            : { defaultValue: '' })}
          aria-describedby={error ? errorId : undefined}
        >
          <option value="" disabled={!emptyLabel}>
            {placeholder}
          </option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <span id={errorId} className="maintenance-option-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

export default MaintenanceOptionSelect
