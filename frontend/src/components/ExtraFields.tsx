import type { ManagedField } from '../api/configApi'
import type { FormFieldDefinition } from '../app/formDefinitions'
import { isManagedFieldVisible } from '../app/requestForm'
import { useCatalog } from '../app/useCatalog'
import ConfiguredField from './ConfiguredField'

/**
 * Campos criados no Gerenciador de formulários, no fim de um formulário de leiaute fixo. Listas de
 * cadastros centrais mostram as opções ativas; o valor gravado é o nome, para o histórico.
 */
export function ExtraFields({
  fields,
  values,
  onChange,
  staff = true,
  title = 'Informações adicionais',
}: {
  fields: readonly ManagedField[]
  values: Record<string, string>
  onChange: (values: Record<string, string>) => void
  staff?: boolean
  title?: string
}) {
  const { catalog } = useCatalog()
  const visible = fields.filter((field) => isManagedFieldVisible(field, values, staff))
  if (visible.length === 0) return null
  const catalogOptions = (field: ManagedField) => {
    const list = field.catalog ? (catalog as Record<string, { label: string }[] | undefined>)[field.catalog] : undefined
    return list ? list.map((item) => item.label) : field.options
  }
  return (
    <fieldset className="extra-fields form-grid-wide">
      <legend>{title}</legend>
      <div className="form-grid">
        {visible.map((field) => (
          <ConfiguredField
            key={field.id}
            field={{ ...(field as unknown as FormFieldDefinition), options: catalogOptions(field) }}
            value={values[field.id] ?? ''}
            onValueChange={(value) => onChange({ ...values, [field.id]: value })}
          />
        ))}
      </div>
    </fieldset>
  )
}

/** Valores gravados dos campos novos, com o nome que o campo tinha quando foi preenchido. */
export function ExtraFieldsView({
  items,
  className = 'demand-fact-wide',
}: {
  items?: readonly { id: string; label: string; value: string }[] | null
  className?: string
}) {
  if (!items || items.length === 0) return null
  const show = (value: string) => (value === 'true' ? 'Sim' : value.replace(/\|/g, ', '))
  return (
    <>
      {items.map((item) => (
        <div key={item.id} className={className}>
          <dt>{item.label}</dt>
          <dd>{show(item.value)}</dd>
        </div>
      ))}
    </>
  )
}
