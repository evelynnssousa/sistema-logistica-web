import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  createInstrument,
  fetchInstrument,
  instrumentCategoryLabels,
  instrumentTypeLabels,
  updateInstrument,
} from '../../api/instrumentsApi'
import type { InstrumentInput } from '../../api/instrumentsApi'
import { errorMessage } from '../../api/modulesApi'
import { Alert, Loading } from '../../components/ui/Feedback'
import { useDemands } from './useDemands'

const empty: InstrumentInput = {
  type: 'ata',
  number: '',
  subject: '',
  category: 'material',
  supplier: '',
  process: '',
  total: '',
  validFrom: '',
  validUntil: '',
  responsibleSectorId: '',
  sharedSectorIds: [],
  managerId: '',
  noticeDays: '90',
  closed: false,
  notes: '',
}

/** Cadastro e alteração de ata ou contrato. O servidor confere o setor de cada pessoa. */
export function InstrumentForm() {
  const { instrumentId } = useParams()
  const navigate = useNavigate()
  const { context, options } = useDemands()
  // Para cadastrar: os setores em que a pessoa pode cadastrar demandas (todos, para o Diretor).
  const ownSectors = new Set(context.memberships.map((item) => item.sectorId))
  const responsibleOptions = options.sectors.filter((sector) => context.directorate || ownSectors.has(sector.id))
  const [form, setForm] = useState<InstrumentInput | null>(() =>
    instrumentId ? null : { ...empty, responsibleSectorId: responsibleOptions.length === 1 ? responsibleOptions[0].id : '' },
  )
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!instrumentId) return
    let active = true
    fetchInstrument(instrumentId)
      .then(({ instrument }) => {
        if (!active) return
        setForm({
          type: instrument.type,
          number: instrument.number,
          subject: instrument.subject,
          category: instrument.category,
          supplier: instrument.supplier ?? '',
          process: instrument.process ?? '',
          total: String(instrument.total),
          validFrom: instrument.validFrom ?? '',
          validUntil: instrument.validUntil ?? '',
          responsibleSectorId: instrument.responsibleSector.id,
          sharedSectorIds: instrument.sharedSectors.map((sector) => sector.id),
          managerId: instrument.manager?.id ?? '',
          noticeDays: String(instrument.noticeDays),
          closed: instrument.closed,
          notes: instrument.notes ?? '',
        })
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar a ata ou o contrato.'))
      })
    return () => {
      active = false
    }
  }, [instrumentId])

  if (error && !form) return <Alert tone="error">{error}</Alert>
  if (!form) return <Loading label="Carregando..." />

  const set = <K extends keyof InstrumentInput>(field: K, value: InstrumentInput[K]) => setForm({ ...form, [field]: value })
  const currentSector = options.sectors.find((sector) => sector.id === form.responsibleSectorId)
  const sectorChoices =
    currentSector && !responsibleOptions.some((sector) => sector.id === currentSector.id)
      ? [currentSector, ...responsibleOptions]
      : responsibleOptions
  const managers = options.people.filter((person) => !form.responsibleSectorId || person.sectorIds.includes(form.responsibleSectorId))

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!form) return
    setError('')
    setSaving(true)
    try {
      if (instrumentId) {
        await updateInstrument(instrumentId, form)
        navigate(`/demandas/atas/${instrumentId}`)
      } else {
        const created = await createInstrument(form)
        navigate(`/demandas/atas/${created.id}`)
      }
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível salvar.'))
      setSaving(false)
    }
  }

  return (
    <section className="ui-card ui-stacked" aria-labelledby="instrument-form-title">
      <h2 id="instrument-form-title">{instrumentId ? 'Editar ata ou contrato' : 'Nova ata ou contrato'}</h2>
      <form className="form-grid" onSubmit={(event) => void submit(event)}>
        <label className="maintenance-form-field">
          <span>Tipo *</span>
          <select value={form.type} onChange={(event) => set('type', event.target.value)}>
            {Object.entries(instrumentTypeLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="maintenance-form-field">
          <span>Número *</span>
          <input required maxLength={60} value={form.number} onChange={(event) => set('number', event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Categoria *</span>
          <select value={form.category} onChange={(event) => set('category', event.target.value)}>
            {Object.entries(instrumentCategoryLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="maintenance-form-field">
          <span>Processo</span>
          <input maxLength={60} value={form.process} onChange={(event) => set('process', event.target.value)} />
        </label>
        <label className="maintenance-form-field form-grid-wide">
          <span>Objeto *</span>
          <textarea required rows={2} minLength={3} maxLength={1000} value={form.subject} onChange={(event) => set('subject', event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Fornecedor</span>
          <input maxLength={200} value={form.supplier} onChange={(event) => set('supplier', event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Valor total (R$) *</span>
          <input type="number" min="0" step="0.01" inputMode="decimal" required value={form.total} onChange={(event) => set('total', event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Início da vigência</span>
          <input type="date" value={form.validFrom} onChange={(event) => set('validFrom', event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Fim da vigência</span>
          <input type="date" value={form.validUntil} onChange={(event) => set('validUntil', event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Setor responsável *</span>
          <select required value={form.responsibleSectorId} onChange={(event) => set('responsibleSectorId', event.target.value)}>
            <option value="">Selecione</option>
            {sectorChoices.map((sector) => (
              <option key={sector.id} value={sector.id}>{sector.name}</option>
            ))}
          </select>
        </label>
        <label className="maintenance-form-field">
          <span>Gestor ou fiscal</span>
          <select value={form.managerId} onChange={(event) => set('managerId', event.target.value)}>
            <option value="">Sem gestor definido</option>
            {managers.map((person) => (
              <option key={person.id} value={person.id}>{person.name}</option>
            ))}
          </select>
        </label>
        <label className="maintenance-form-field">
          <span>Avisar quantos dias antes do fim *</span>
          <input type="number" min="0" max="365" required value={form.noticeDays} onChange={(event) => set('noticeDays', event.target.value)} />
        </label>
        <fieldset className="demand-checks form-grid-wide">
          <legend>Compartilhar com os setores</legend>
          {options.sectors
            .filter((sector) => sector.id !== form.responsibleSectorId)
            .map((sector) => (
              <label key={sector.id}>
                <input
                  type="checkbox"
                  checked={form.sharedSectorIds.includes(sector.id)}
                  onChange={(event) =>
                    set(
                      'sharedSectorIds',
                      event.target.checked
                        ? [...form.sharedSectorIds, sector.id]
                        : form.sharedSectorIds.filter((id) => id !== sector.id),
                    )
                  }
                />
                {sector.name}
              </label>
            ))}
        </fieldset>
        <label className="maintenance-form-field form-grid-wide">
          <span>Observações</span>
          <textarea rows={2} maxLength={4000} value={form.notes} onChange={(event) => set('notes', event.target.value)} />
        </label>
        {instrumentId && (
          <label className="parameter-check form-grid-wide">
            <input type="checkbox" checked={form.closed} onChange={(event) => set('closed', event.target.checked)} />
            <span>Encerrado (não abre mais demanda de renovação e não aparece para vincular)</span>
          </label>
        )}
        <p className="demand-muted form-grid-wide">
          Ao entrar no prazo de aviso, o sistema abre uma demanda de renovação no setor responsável, para o gestor (se houver) e
          os chefes do setor. Prorrogações e mudanças de valor ficam registradas como aditivos, na página da ata ou do contrato.
        </p>
        {error && <Alert tone="error" className="form-grid-wide">{error}</Alert>}
        <div className="ui-card-actions form-grid-wide">
          <Link className="maintenance-secondary-button" to={instrumentId ? `/demandas/atas/${instrumentId}` : '/demandas/atas'}>
            Cancelar
          </Link>
          <button type="submit" className="maintenance-primary-button" disabled={saving}>
            Salvar
          </button>
        </div>
      </form>
    </section>
  )
}
