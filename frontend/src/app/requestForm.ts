import { useEffect, useState } from 'react'
import { errorMessage, getCapabilities } from '../api/modulesApi'
import type { FormFieldDefinition } from './formDefinitions'

/** Indica se a tela oferece o seletor de setor. A API confere de novo ao gravar. */
export function useCanActOnBehalf() {
  const [canActOnBehalf, setCanActOnBehalf] = useState(false)

  useEffect(() => {
    let active = true
    getCapabilities()
      .then((data) => {
        if (active) setCanActOnBehalf(data.canActOnBehalf)
      })
      .catch((error: unknown) => {
        // Sem a resposta, vale o caminho comum: abrir pelo próprio setor.
        console.warn(errorMessage(error, 'Falha ao consultar permissões.'))
      })
    return () => {
      active = false
    }
  }, [])

  return canActOnBehalf
}

type VisibilityRule = {
  active: boolean
  visibleTo?: 'all' | 'staff'
  visibleWhen?: { field: string; equals: string } | null
}

/** A mesma regra do servidor. Esconder aqui não protege nada: a API confere de novo ao gravar. */
export function isManagedFieldVisible(field: VisibilityRule, values: Record<string, string>, staff: boolean) {
  if (!field.active || (field.visibleTo === 'staff' && !staff)) return false
  if (!field.visibleWhen) return true
  return (values[field.visibleWhen.field] ?? '') === field.visibleWhen.equals
}

/** Campos criados na personalização, que não têm coluna própria. */
export function customFieldsOf(
  fields: readonly FormFieldDefinition[],
  values: Record<string, string>,
  knownIds: readonly string[],
) {
  return Object.fromEntries(
    fields
      .filter((field) => field.active && !knownIds.includes(field.id) && values[field.id])
      .map((field) => [field.id, values[field.id]]),
  )
}
