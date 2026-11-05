import { useEffect, useSyncExternalStore } from 'react'
import {
  getFormDefinitionsSnapshot,
  loadFormDefinitions,
  subscribeFormDefinitions,
} from './formDefinitions'
import type { FormKey } from './formDefinitions'

export function useConfiguredForm(formKey: FormKey) {
  const snapshot = useSyncExternalStore(
    subscribeFormDefinitions,
    getFormDefinitionsSnapshot,
    getFormDefinitionsSnapshot,
  )
  useEffect(() => {
    void loadFormDefinitions()
  }, [])
  return {
    fields: snapshot.definitions[formKey],
    error: snapshot.error,
  }
}
