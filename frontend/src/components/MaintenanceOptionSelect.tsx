import { useSyncExternalStore } from 'react'
import type { MaintenanceOptionCategory } from '../app/maintenanceCatalog'
import {
  getMaintenanceCatalogSnapshot,
  subscribeMaintenanceCatalog,
} from '../app/maintenanceCatalog'

type MaintenanceOptionSelectProps = {
  category: MaintenanceOptionCategory
  label: string
  name: string
  required?: boolean
}

function MaintenanceOptionSelect({
  category,
  label,
  name,
  required = false,
}: MaintenanceOptionSelectProps) {
  const snapshot = useSyncExternalStore(
    subscribeMaintenanceCatalog,
    getMaintenanceCatalogSnapshot,
    getMaintenanceCatalogSnapshot,
  )
  const options = snapshot.options[category].filter((option) => option.active)
  const errorId = `${name}-catalog-error`

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
          disabled={options.length === 0 || snapshot.error !== null}
          defaultValue=""
          aria-describedby={snapshot.error ? errorId : undefined}
        >
          <option value="" disabled>
            {options.length > 0
              ? 'Selecione uma opção'
              : snapshot.error
                ? 'Opções indisponíveis'
                : 'Nenhuma opção cadastrada. Consulte Configurações.'}
          </option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {snapshot.error && (
        <span id={errorId} className="maintenance-option-error" role="alert">
          {snapshot.error}
        </span>
      )}
    </div>
  )
}

export default MaintenanceOptionSelect
