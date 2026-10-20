import { useSyncExternalStore } from 'react'
import {
  getFormDefinitionsSnapshot,
  subscribeFormDefinitions,
} from './formDefinitions'
import type { FormKey } from './formDefinitions'

export function useConfiguredForm(formKey: FormKey) {
  const snapshot = useSyncExternalStore(
    subscribeFormDefinitions,
    getFormDefinitionsSnapshot,
    getFormDefinitionsSnapshot,
  )
  return {
    fields: snapshot.definitions[formKey],
    error: snapshot.error,
  }
}
