import { useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import {
  addCatalogOption,
  getMaintenanceCatalogSnapshot,
  renameCatalogOption,
  setCatalogOptionActive,
  subscribeMaintenanceCatalog,
} from '../app/maintenanceCatalog'
import type {
  CatalogCategory,
  CatalogOption,
} from '../app/maintenanceCatalog'
import { useHasPermission } from '../auth/UserContext'
import FormCustomizationSection from '../components/FormCustomizationSection'

const settingsSections: {
  category: CatalogCategory
  title: string
  description: string
}[] = [
  {
    category: 'sectors',
    title: 'Setores',
    description: 'Opções de setor utilizadas nos formulários do sistema.',
  },
  {
    category: 'floors',
    title: 'Andares',
    description: 'Opções de andar para identificar o local dos serviços.',
  },
  {
    category: 'serviceTypes',
    title: 'Tipos de serviços de manutenção',
    description: 'Tipos padronizados para novas solicitações de manutenção.',
  },
  {
    category: 'inventoryCategories',
    title: 'Categorias do Almoxarifado',
    description: 'Categorias para organizar os materiais em estoque.',
  },
  {
    category: 'measurementUnits',
    title: 'Unidades de medida',
    description: 'Unidades utilizadas para quantificar materiais.',
  },
]

type CatalogSectionProps = {
  category: CatalogCategory
  title: string
  description: string
  options: readonly CatalogOption[]
  disabled: boolean
}

function CatalogSection({
  category,
  title,
  description,
  options,
  disabled,
}: CatalogSectionProps) {
  const [isAdding, setIsAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  function startAdding() {
    setEditingId(null)
    setDraft('')
    setFeedback(null)
    setIsAdding(true)
  }

  function startEditing(option: CatalogOption) {
    setIsAdding(false)
    setDraft(option.label)
    setFeedback(null)
    setEditingId(option.id)
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      if (editingId) {
        renameCatalogOption(category, editingId, draft)
        setFeedback({ type: 'success', message: 'Cadastro atualizado.' })
        setEditingId(null)
      } else {
        addCatalogOption(category, draft)
        setFeedback({ type: 'success', message: 'Cadastro adicionado.' })
        setIsAdding(false)
      }
      setDraft('')
    } catch (error) {
      setFeedback({
        type: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Não foi possível salvar o cadastro.',
      })
    }
  }

  function toggleActive(option: CatalogOption) {
    try {
      setCatalogOptionActive(category, option.id, !option.active)
      setFeedback({
        type: 'success',
        message: option.active
          ? 'Cadastro desativado. Ele não aparecerá em novos formulários.'
          : 'Cadastro ativado.',
      })
    } catch (error) {
      setFeedback({
        type: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Não foi possível alterar o status do cadastro.',
      })
    }
  }

  return (
    <article className="settings-card">
      <div className="settings-card-icon" aria-hidden="true">
        ▤
      </div>
      <div className="settings-card-content">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>

      <div className="settings-catalog-content">
        {options.length === 0 ? (
          <p className="settings-empty">Nenhuma opção cadastrada.</p>
        ) : (
          <ul className="settings-option-list">
            {options.map((option) => (
              <li className="settings-option" key={option.id}>
                {editingId === option.id ? (
                  <form className="settings-option-form" onSubmit={save}>
                    <label>
                      <span className="visually-hidden">
                        Editar nome em {title}
                      </span>
                      <input
                        autoFocus
                        required
                        maxLength={120}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                    </label>
                    <button type="submit" disabled={disabled}>
                      Salvar
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                    >
                      Cancelar
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="settings-option-label">
                      {option.label}
                    </span>
                    <span
                      className={`settings-option-state${option.active ? ' active' : ''}`}
                    >
                      {option.active ? 'Ativa' : 'Inativa'}
                    </span>
                    <div className="settings-option-actions">
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => startEditing(option)}
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => toggleActive(option)}
                      >
                        {option.active ? 'Desativar' : 'Ativar'}
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {isAdding && (
          <form className="settings-option-form settings-add-form" onSubmit={save}>
            <label>
              <span className="visually-hidden">Nome do novo item em {title}</span>
              <input
                autoFocus
                required
                maxLength={120}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={`Nome para ${title.toLocaleLowerCase('pt-BR')}`}
              />
            </label>
            <button type="submit" disabled={disabled}>
              Salvar
            </button>
            <button type="button" onClick={() => setIsAdding(false)}>
              Cancelar
            </button>
          </form>
        )}

        {feedback && (
          <p
            className={`settings-feedback ${feedback.type}`}
            role={feedback.type === 'error' ? 'alert' : 'status'}
          >
            {feedback.message}
          </p>
        )}
      </div>

      <div className="settings-card-actions">
        <button type="button" disabled={disabled || isAdding} onClick={startAdding}>
          Cadastrar opção
        </button>
      </div>
    </article>
  )
}

function SettingsPage() {
  const snapshot = useSyncExternalStore(
    subscribeMaintenanceCatalog,
    getMaintenanceCatalogSnapshot,
    getMaintenanceCatalogSnapshot,
  )
  const catalogUnavailable = snapshot.error !== null
  const canManage = useHasPermission('settings:manage')

  return (
    <div className="admin-module-page settings-page">
      <section className="admin-page-heading">
        <div>
          <div className="eyebrow">JUCESP · GESTÃO OPERACIONAL</div>
          <h1>Configurações</h1>
          <p>
            Gerencie as listas padronizadas utilizadas pelos módulos do sistema.
          </p>
        </div>
      </section>

      <div className="settings-guidance" role="note">
        <span aria-hidden="true">i</span>
        <p>
          Cadastros são armazenados somente neste navegador e não são
          compartilhados com outros usuários. Ao desativar uma opção, ela deixa
          de aparecer em novos formulários; solicitações antigas devem manter
          seus valores históricos.
        </p>
      </div>

      {snapshot.error && (
        <div className="settings-storage-error" role="alert">
          {snapshot.error}
        </div>
      )}

      {canManage ? (
        <FormCustomizationSection />
      ) : (
        <div className="settings-guidance" role="note">
          <span aria-hidden="true">i</span>
          <p>Seu acesso a esta página é somente de consulta.</p>
        </div>
      )}

      <section className="settings-grid" aria-label="Listas padronizadas">
        {settingsSections.map((section) => (
          <CatalogSection
            key={section.category}
            {...section}
            options={snapshot.options[section.category]}
            disabled={catalogUnavailable || !canManage}
          />
        ))}
      </section>

      <section className="settings-future-section">
        <div>
          <h2>Opções futuras de Frota e Passagens Aéreas</h2>
          <p>
            A estrutura aceita novas listas quando os campos desses formulários
            forem definidos. Nenhum cadastro foi presumido para esses módulos.
          </p>
        </div>
        <span>Campos a definir</span>
      </section>

      <p className="settings-persistence-note">
        Esta é uma persistência provisória local. Uma etapa futura deverá migrar
        estes cadastros para a API do sistema antes do uso compartilhado.
      </p>
    </div>
  )
}

export default SettingsPage
