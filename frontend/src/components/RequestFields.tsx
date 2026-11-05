import type { FormFieldDefinition } from '../app/formDefinitions'
import { useAuthenticatedUser } from '../auth/UserContext'
import ConfiguredField from './ConfiguredField'
import MaintenanceOptionSelect from './MaintenanceOptionSelect'

/** A identidade e o setor vêm da sessão. Na tela só são mostrados; a API os ignora. */
function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <label className="maintenance-form-field">
      <span>{label}</span>
      <input value={value} readOnly aria-readonly="true" />
    </label>
  )
}

type RequestFieldProps = {
  field: FormFieldDefinition
  values: Record<string, string>
  onChange: (id: string, value: string) => void
  canActOnBehalf: boolean
  // Campos preenchidos com dados da sessão: id do campo → dado.
  identityFields: Record<string, 'name' | 'email' | 'sector'>
  sectorField: string
  /** Título da seção que começa neste campo. */
  heading?: string
}

export function RequestField({
  field,
  values,
  onChange,
  canActOnBehalf,
  identityFields,
  sectorField,
  heading,
}: RequestFieldProps) {
  const user = useAuthenticatedUser()
  const title = heading ? <h3 className="form-section-title">{heading}</h3> : null

  if (field.id === sectorField) {
    return canActOnBehalf ? (
      <>
      {title}
      <MaintenanceOptionSelect
        category="sectors"
        label={`${field.label} (em branco: seu setor, ${user?.sector ?? 'não informado'})`}
        name={field.id}
        value={values[field.id] ?? ''}
        onChange={(value) => onChange(field.id, value)}
        emptyLabel="Meu próprio setor"
      />
      </>
    ) : (
      <>
        {title}
        <ReadOnlyField label={field.label} value={user?.sector ?? ''} />
      </>
    )
  }

  const identity = identityFields[field.id]
  if (identity) {
    return (
      <>
        {title}
        <ReadOnlyField label={field.label} value={user?.[identity] ?? ''} />
      </>
    )
  }

  return (
    <>
      {title}
      <ConfiguredField
        field={field}
        value={values[field.id] ?? ''}
        onValueChange={(value) => onChange(field.id, value)}
      />
    </>
  )
}
