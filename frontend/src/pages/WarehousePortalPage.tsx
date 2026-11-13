import { useManagedForm } from '../app/useManagedForm'
import { ExtraFields } from '../components/ExtraFields'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createInternalWarehouseRequest,
  errorMessage,
  listMaterials,
} from '../api/modulesApi'
import type { Material } from '../api/modulesApi'
import { privacyNotices } from '../app/privacyNotices'
import FormNotices from '../components/FormNotices'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, FilterSelect, SearchField } from '../components/ui/Filters'
import Icon from '../components/ui/Icon'
import { uploadPendingFiles, warnFailedUploads } from '../app/formFiles'

/** Nova solicitação interna, a partir do catálogo real de materiais ativos. */
function WarehousePortalPage() {
  const navigate = useNavigate()
  const [materials, setMaterials] = useState<Material[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const form = useManagedForm('warehouseRequest')
  const [extra, setExtra] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let active = true
    listMaterials()
      .then((data) => {
        if (active) setMaterials(data.materials)
      })
      .catch((err: unknown) => {
        if (active) setLoadError(errorMessage(err, 'Não foi possível carregar os materiais.'))
      })
    return () => {
      active = false
    }
  }, [])

  const categories = useMemo(
    () => [...new Set((materials ?? []).flatMap((item) => (item.category ? [item.category] : [])))],
    [materials],
  )

  const filteredMaterials = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('pt-BR')
    return (materials ?? []).filter(
      (item) =>
        (item.name.toLocaleLowerCase('pt-BR').includes(term) ||
          (item.category ?? '').toLocaleLowerCase('pt-BR').includes(term)) &&
        (!category || item.category === category),
    )
  }, [materials, search, category])

  const chosen = (materials ?? []).filter((item) => Number(quantities[item.id]) > 0)

  async function submit() {
    setSubmitError('')
    setSubmitting(true)
    try {
      const created = await createInternalWarehouseRequest({
        note,
        customFields: extra,
        avisoPrivacidade: privacyNotices.warehouse.version,
        items: chosen.map((item) => ({ materialId: item.id, requested: quantities[item.id] })),
      })
      warnFailedUploads(await uploadPendingFiles('material_request', created.id, extra, Object.fromEntries(form.extraFields.map((field) => [field.id, field.label]))))
      navigate(`/almoxarifado/pedidos/${created.id}`)
    } catch (err) {
      setSubmitError(errorMessage(err, 'Não foi possível enviar a solicitação.'))
      setSubmitting(false)
    }
  }

  if (loadError) return <Alert tone="error">{loadError}</Alert>
  if (!materials) return <Loading label="Carregando materiais..." />
  if (materials.length === 0) {
    return (
      <section className="ui-card">
        <EmptyState icon="warehouse" title="Catálogo sem materiais ativos">
          As solicitações ficam disponíveis assim que os responsáveis cadastrarem materiais.
        </EmptyState>
      </section>
    )
  }

  return (
    <>
      <FilterBar
        label="Filtros do catálogo"
        canClear={Boolean(search || category)}
        onClear={() => {
          setSearch('')
          setCategory('')
        }}
      >
        <SearchField label="Pesquisar material" value={search} onChange={setSearch} />
        {categories.length > 0 && (
          <FilterSelect
            label="Categoria"
            value={category}
            onChange={setCategory}
            allLabel="Todas as categorias"
            options={categories.map((value) => ({ value, label: value }))}
          />
        )}
      </FilterBar>

      {filteredMaterials.length === 0 ? (
        <section className="ui-card">
          <EmptyState icon="search" title="Nenhum material encontrado">
            Tente alterar os termos da pesquisa ou os filtros selecionados.
          </EmptyState>
        </section>
      ) : (
        <div className="warehouse-material-grid">
          {filteredMaterials.map((material) => (
            <article
              className={`warehouse-material-card${Number(quantities[material.id]) > 0 ? ' is-chosen' : ''}`}
              key={material.id}
            >
              <span className="warehouse-material-icon">
                <Icon name="warehouse" size={24} weight="duotone" />
              </span>
              <h3>{material.name}</h3>
              <p>
                {material.category ? `${material.category} · ` : ''}
                {material.unit}
              </p>
              <label className="maintenance-form-field">
                <span>Quantidade</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  aria-label={`Quantidade de ${material.name}`}
                  value={quantities[material.id] ?? ''}
                  onChange={(event) =>
                    setQuantities((current) => ({ ...current, [material.id]: event.target.value }))
                  }
                />
              </label>
            </article>
          ))}
        </div>
      )}

      <div className="warehouse-privacy">
        <FormNotices module="warehouse" />
      </div>

      {submitError && <Alert tone="error" className="ui-stacked">{submitError}</Alert>}

      {form.extraFields.length > 0 && (
        <div className="ui-card ui-stacked">
          <ExtraFields fields={form.extraFields} values={extra} onChange={setExtra} staff={false} />
        </div>
      )}

      <div className="warehouse-request-summary">
        <label>
          <span>{form.label('note', 'Observação')}</span>
          <input value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} />
        </label>
        <button
          type="button"
          className="maintenance-primary-button"
          disabled={chosen.length === 0 || submitting}
          onClick={() => void submit()}
        >
          {submitting
            ? 'Enviando...'
            : `Enviar solicitação (${chosen.length} ${chosen.length === 1 ? 'item' : 'itens'})`}
        </button>
      </div>
    </>
  )
}

export default WarehousePortalPage
