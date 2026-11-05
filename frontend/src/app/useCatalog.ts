import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { errorMessage, fetchActiveCatalog } from '../api/modulesApi'
import type { Catalog } from '../api/modulesApi'

/**
 * Opções ativas dos formulários, vindas do servidor e compartilhadas entre as telas abertas.
 * É um atalho de leitura: a validade de cada opção é conferida de novo na gravação.
 */

type CatalogState = { catalog: Catalog; error: string | null; loaded: boolean }

const emptyCatalog: Catalog = {
  sectors: [],
  floors: [],
  serviceTypes: [],
  warehouseCategories: [],
  measurementUnits: [],
}

let state: CatalogState = { catalog: emptyCatalog, error: null, loaded: false }
let pending: Promise<void> | null = null
const listeners = new Set<() => void>()

function publish(next: CatalogState) {
  state = next
  listeners.forEach((listener) => listener())
}

function load() {
  pending ??= fetchActiveCatalog()
    .then((data) => publish({ catalog: data.catalog, error: null, loaded: true }))
    .catch((error: unknown) =>
      publish({
        ...state,
        error: errorMessage(error, 'Não foi possível carregar as opções.'),
        loaded: true,
      }),
    )
    .finally(() => {
      pending = null
    })
  return pending
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getState = () => state

/** Depois de alterar as listas em Configurações, os formulários abertos recebem o novo valor. */
export function refreshCatalog() {
  return load()
}

export function useCatalog() {
  const current = useSyncExternalStore(subscribe, getState, getState)
  const refresh = useCallback(() => load(), [])

  // Sempre relê ao abrir um formulário: outra pessoa pode ter alterado as listas.
  useEffect(() => {
    void load()
  }, [])

  return { ...current, refresh }
}
