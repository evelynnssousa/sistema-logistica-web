import { apiRequest } from '../auth/apiClient'

type Envelope = { success: boolean; message?: string }

function send<Response extends Envelope>(path: string, method: string, body?: unknown) {
  return apiRequest<Response>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
}

function queryString(values: Record<string, string | number | undefined | null>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  }
  const text = query.toString()
  return text ? `?${text}` : ''
}

export const situationOptions = [
  { value: 'em_uso', label: 'Em uso' },
  { value: 'ocioso', label: 'Ocioso' },
  { value: 'em_manutencao', label: 'Em manutenção' },
  { value: 'inservivel', label: 'Inservível' },
  { value: 'baixado', label: 'Baixado' },
] as const

export type Asset = {
  id: string
  number: string
  description: string
  sectorId: string | null
  sector: string | null
  room: string | null
  situation: string
  situationLabel: string
  brand: string | null
  model: string | null
  serialNumber: string | null
  registeredOn: string | null
  acquisitionValue: number | null
  invoice: string | null
  supplier: string | null
  note: string | null
  lastCheckAt: string | null
  lastCheckBy: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export type AssetPayload = {
  number: string
  description: string
  sectorId: string
  room: string
  situation: string
  brand: string
  model: string
  serialNumber: string
  registeredOn: string
  acquisitionValue: string
  invoice: string
  supplier: string
  note: string
  justification?: string
}

export type AssetHistoryEntry = {
  type: string
  previousSector: string | null
  newSector: string | null
  previousRoom: string | null
  newRoom: string | null
  previousSituation: string | null
  newSituation: string | null
  fields: string[]
  note: string | null
  by: string | null
  at: string
}

export type PatrimonyOptions = {
  ready: boolean
  sectors: { id: string; name: string; acronym: string | null }[]
  rooms: { sectorId: string | null; room: string }[]
}

export const getPatrimonyOptions = () => apiRequest<Envelope & PatrimonyOptions>('/patrimony/options')

export const listAssets = (filters: { search?: string; sectorId?: string; room?: string; situation?: string; page: number }) =>
  apiRequest<Envelope & { assets: Asset[]; total: number; totalValue: number | null; page: number; pageSize: number }>(
    `/patrimony/assets${queryString(filters)}`,
  )

export const lookupAsset = (number: string) =>
  apiRequest<Envelope & { number: string; asset: Asset | null }>(`/patrimony/lookup${queryString({ number })}`)

export const getAsset = (id: string) => apiRequest<Envelope & { asset: Asset; history: AssetHistoryEntry[] }>(`/patrimony/assets/${id}`)

export const createAsset = (body: AssetPayload) => send<Envelope & { id: string }>('/patrimony/assets', 'POST', body)

export const updateAsset = (id: string, body: AssetPayload) => send<Envelope>(`/patrimony/assets/${id}`, 'PUT', body)

export const moveAsset = (id: string, body: { sectorId: string | null; room: string | null; note?: string }) =>
  send<Envelope>(`/patrimony/assets/${id}/location`, 'PUT', body)

export const assetColumnLabels = {
  number: 'Número do patrimônio',
  description: 'Descrição',
  sector: 'Setor',
  room: 'Sala',
  registeredOn: 'Data em que foi patrimoniado',
  situation: 'Situação',
  brand: 'Marca',
  model: 'Modelo',
  serialNumber: 'Número de série',
  acquisitionValue: 'Valor de aquisição',
  invoice: 'Nota fiscal',
  supplier: 'Fornecedor',
} as const

export type AssetColumnKey = keyof typeof assetColumnLabels
export type AssetColumns = { headerRow: number } & Record<AssetColumnKey, number | null>

export type ImportPreviewLine = {
  line: number
  number: string
  description: string
  sectorText: string
  sectorId: string | null
  room: string | null
  registeredOn: string | null
  situation: string
  problems: string[]
  warnings: string[]
  existing: { id: string; description: string; sector: string | null; room: string | null; registeredOn: string | null; situation: string } | null
  locationDiffers: boolean
}

export type ImportPreview = {
  fileName: string
  rowCount: number
  preview: string[][]
  columns: AssetColumns
  lines: ImportPreviewLine[]
}

function importQuery(columns?: AssetColumns, confirm = false) {
  const values: Record<string, string | number | undefined> = { confirm: confirm ? '1' : undefined }
  if (columns) {
    values.header = columns.headerRow
    for (const key of Object.keys(assetColumnLabels) as AssetColumnKey[]) {
      values[key] = columns[key] === null ? 'none' : columns[key]
    }
  }
  return queryString(values)
}

const sheetHeaders = (file: File) => ({ 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) })

export const previewAssetImport = (file: File, columns?: AssetColumns) =>
  apiRequest<Envelope & ImportPreview>(`/patrimony/import${importQuery(columns)}`, { method: 'POST', body: file, headers: sheetHeaders(file) })

export const confirmAssetImport = (file: File, columns: AssetColumns) =>
  apiRequest<Envelope & { created: number; existing: number; rejected: number }>(`/patrimony/import${importQuery(columns, true)}`, {
    method: 'POST',
    body: file,
    headers: sheetHeaders(file),
  })

export type PatrimonyCheckSummary = {
  id: string
  title: string
  sector: string | null
  room: string | null
  status: string
  createdBy: string | null
  createdAt: string
  closedAt: string | null
  read: number
  inPlace: number
  issues: number
}

export type CheckRead = {
  number: string
  result: 'no_local' | 'outro_local' | 'nao_cadastrado' | 'baixado'
  assetId: string | null
  description: string | null
  registeredSector: string | null
  registeredRoom: string | null
  by: string | null
  at: string
}

export type PatrimonyCheck = {
  id: string
  title: string
  sectorId: string | null
  sector: string | null
  room: string | null
  status: string
  comment: string | null
  createdAt: string
  closedAt: string | null
  reads: CheckRead[]
  missing: Asset[]
}

export const listPatrimonyChecks = (page: number) =>
  apiRequest<Envelope & { checks: PatrimonyCheckSummary[] }>(`/patrimony/checks${queryString({ page })}`)

export const createPatrimonyCheck = (body: { title: string; sectorId: string; room: string }) =>
  send<Envelope & { id: string }>('/patrimony/checks', 'POST', body)

export const getPatrimonyCheck = (id: string) => apiRequest<Envelope & { check: PatrimonyCheck }>(`/patrimony/checks/${id}`)

export const readPatrimonyCode = (checkId: string, number: string) =>
  send<Envelope & { number: string; result: CheckRead['result']; label: string; repeated: boolean; asset: Asset | null; previousCheckAt: string | null }>(
    `/patrimony/checks/${checkId}/reads`,
    'POST',
    { number },
  )

export const closePatrimonyCheck = (checkId: string, body: { outcome: 'concluida' | 'cancelada'; comment: string }) =>
  send<Envelope>(`/patrimony/checks/${checkId}/close`, 'POST', body)

export const readResultLabels: Record<CheckRead['result'], string> = {
  no_local: 'No local certo',
  outro_local: 'Registrado em outro local',
  nao_cadastrado: 'Não cadastrado',
  baixado: 'Bem baixado',
}
