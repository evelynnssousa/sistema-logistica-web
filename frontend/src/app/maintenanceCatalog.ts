export type CatalogCategory =
  | 'sectors'
  | 'floors'
  | 'serviceTypes'
  | 'inventoryCategories'
  | 'measurementUnits'

export type MaintenanceOptionCategory = Extract<
  CatalogCategory,
  'sectors' | 'floors' | 'serviceTypes'
>

export type CatalogOption = {
  id: string
  label: string
  active: boolean
}

export type MaintenanceCatalog = Record<
  CatalogCategory,
  readonly CatalogOption[]
>

export type MaintenanceCatalogSnapshot = {
  options: MaintenanceCatalog
  error: string | null
}

const storageKey = 'jucesp.maintenance-catalog.v1'

function emptyCatalog(): MaintenanceCatalog {
  return {
    sectors: [],
    floors: [],
    serviceTypes: [],
    inventoryCategories: [],
    measurementUnits: [],
  }
}

function isCatalogOption(value: unknown): value is CatalogOption {
  if (typeof value !== 'object' || value === null) return false

  const option = value as Record<string, unknown>
  return (
    typeof option.id === 'string' &&
    typeof option.label === 'string' &&
    typeof option.active === 'boolean'
  )
}

function parseStoredCatalog(value: string): MaintenanceCatalog | null {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null) return null

  const candidate = parsed as Record<string, unknown>
  const categories = Object.keys(emptyCatalog()) as CatalogCategory[]
  const options = {} as MaintenanceCatalog

  for (const category of categories) {
    const entries = candidate[category]
    if (!Array.isArray(entries) || !entries.every(isCatalogOption)) {
      return null
    }
    options[category] = entries
  }

  return options
}

function readInitialSnapshot(): MaintenanceCatalogSnapshot {
  if (typeof window === 'undefined') {
    return { options: emptyCatalog(), error: null }
  }

  try {
    const stored = window.localStorage.getItem(storageKey)
    if (stored === null) {
      return { options: emptyCatalog(), error: null }
    }

    const options = parseStoredCatalog(stored)
    if (options === null) {
      return {
        options: emptyCatalog(),
        error:
          'Os cadastros locais estão em formato inválido. Não foi possível carregá-los.',
      }
    }

    return { options, error: null }
  } catch {
    return {
      options: emptyCatalog(),
      error:
        'Não foi possível acessar os cadastros locais neste navegador.',
    }
  }
}

let snapshot = readInitialSnapshot()
const listeners = new Set<() => void>()

function notifyListeners() {
  listeners.forEach((listener) => listener())
}

function handleStorageChange(event: StorageEvent) {
  if (event.key !== storageKey && event.key !== null) return

  if (event.newValue === null) {
    snapshot = { options: emptyCatalog(), error: null }
    notifyListeners()
    return
  }

  try {
    const options = parseStoredCatalog(event.newValue)
    snapshot =
      options === null
        ? {
            options: snapshot.options,
            error:
              'Os cadastros locais foram alterados para um formato inválido.',
          }
        : { options, error: null }
  } catch {
    snapshot = {
      options: snapshot.options,
      error: 'Não foi possível ler os cadastros alterados em outra aba.',
    }
  }

  notifyListeners()
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', handleStorageChange)
}

export function subscribeMaintenanceCatalog(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getMaintenanceCatalogSnapshot() {
  return snapshot
}

function saveCatalog(options: MaintenanceCatalog) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(options))
    snapshot = { options, error: null }
    notifyListeners()
  } catch {
    snapshot = {
      ...snapshot,
      error:
        'Não foi possível salvar os cadastros neste navegador. Verifique o armazenamento disponível e tente novamente.',
    }
    notifyListeners()
    throw new Error(
      snapshot.error ?? 'Não foi possível salvar os cadastros locais.',
    )
  }
}

function normalizeLabel(label: string) {
  return label.trim().toLocaleLowerCase('pt-BR')
}

function ensureUniqueLabel(
  category: CatalogCategory,
  label: string,
  excludedId?: string,
) {
  const normalized = normalizeLabel(label)
  if (!normalized) {
    throw new Error('Informe um nome para o cadastro.')
  }

  const duplicate = snapshot.options[category].some(
    (option) =>
      option.id !== excludedId && normalizeLabel(option.label) === normalized,
  )
  if (duplicate) {
    throw new Error('Já existe um cadastro com esse nome nesta lista.')
  }
}

function createOptionId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function addCatalogOption(category: CatalogCategory, label: string) {
  if (snapshot.error) {
    throw new Error(
      'Corrija o problema de armazenamento antes de alterar os cadastros.',
    )
  }
  ensureUniqueLabel(category, label)

  const option: CatalogOption = {
    id: createOptionId(),
    label: label.trim(),
    active: true,
  }
  saveCatalog({
    ...snapshot.options,
    [category]: [...snapshot.options[category], option],
  })
}

export function renameCatalogOption(
  category: CatalogCategory,
  id: string,
  label: string,
) {
  if (snapshot.error) {
    throw new Error(
      'Corrija o problema de armazenamento antes de alterar os cadastros.',
    )
  }
  ensureUniqueLabel(category, label, id)

  const existing = snapshot.options[category].find(
    (option) => option.id === id,
  )
  if (!existing) {
    throw new Error('O cadastro não foi encontrado. Atualize a página.')
  }

  saveCatalog({
    ...snapshot.options,
    [category]: snapshot.options[category].map((option) =>
      option.id === id ? { ...option, label: label.trim() } : option,
    ),
  })
}

export function setCatalogOptionActive(
  category: CatalogCategory,
  id: string,
  active: boolean,
) {
  if (snapshot.error) {
    throw new Error(
      'Corrija o problema de armazenamento antes de alterar os cadastros.',
    )
  }

  const existing = snapshot.options[category].some(
    (option) => option.id === id,
  )
  if (!existing) {
    throw new Error('O cadastro não foi encontrado. Atualize a página.')
  }

  saveCatalog({
    ...snapshot.options,
    [category]: snapshot.options[category].map((option) =>
      option.id === id ? { ...option, active } : option,
    ),
  })
}

export function getActiveMaintenanceOptions(
  category: MaintenanceOptionCategory,
): CatalogOption[] {
  return snapshot.options[category].filter((option) => option.active)
}
