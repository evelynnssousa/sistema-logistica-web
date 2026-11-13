import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import {
  createOption,
  errorMessage,
  fetchFullCatalog,
  setOptionActive,
  updateOption,
} from '../api/modulesApi'
import type { Catalog, CatalogCategory, CatalogOption } from '../api/modulesApi'
import {
  getMaintenanceCatalogSnapshot,
  subscribeMaintenanceCatalog,
} from '../app/maintenanceCatalog'
import type { CatalogCategory as LocalCategory } from '../app/maintenanceCatalog'
import { refreshCatalog } from '../app/useCatalog'
import { useHasPermission } from '../auth/UserContext'
import { useDemandContext } from '../app/useDemandContext'
import AccessDeniedPage from './AccessDeniedPage'
import AdminSettingsSection from '../components/AdminSettingsSection'
import DemandSettingsSection from '../components/DemandSettingsSection'
import DriverPortalSettingsSection from '../components/DriverPortalSettingsSection'
import EmailTemplatesManager from '../components/EmailTemplatesManager'
import FormManager from '../components/FormManager'
import ParametersSection from '../components/ParametersSection'
import { Alert, Loading } from '../components/ui/Feedback'
import Icon from '../components/ui/Icon'
import type { IconName } from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'

const settingsSections: {
  category: CatalogCategory
  local: LocalCategory
  title: string
  description: string
}[] = [
  {
    category: 'sectors',
    local: 'sectors',
    title: 'Setores',
    description: 'Opções de setor utilizadas nos formulários do sistema.',
  },
  {
    category: 'floors',
    local: 'floors',
    title: 'Andares',
    description: 'Opções de andar para identificar o local dos serviços.',
  },
  {
    category: 'serviceTypes',
    local: 'serviceTypes',
    title: 'Tipos de serviços de manutenção',
    description: 'Tipos padronizados para novas solicitações de manutenção.',
  },
  {
    category: 'warehouseCategories',
    local: 'inventoryCategories',
    title: 'Categorias do Almoxarifado',
    description: 'Categorias para organizar os materiais.',
  },
  {
    category: 'measurementUnits',
    local: 'measurementUnits',
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
  onChanged: () => Promise<void>
}

function CatalogSection({
  category,
  title,
  description,
  options,
  disabled,
  onChanged,
}: CatalogSectionProps) {
  const [isAdding, setIsAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [acronym, setAcronym] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)
  const hasAcronym = category === 'sectors'

  function startAdding() {
    setEditingId(null)
    setDraft('')
    setAcronym('')
    setFeedback(null)
    setIsAdding(true)
  }

  function startEditing(option: CatalogOption) {
    setIsAdding(false)
    setDraft(option.label)
    setAcronym(option.acronym ?? '')
    setFeedback(null)
    setEditingId(option.id)
  }

  async function perform(action: () => Promise<unknown>, success: string) {
    setBusy(true)
    try {
      await action()
      setFeedback({ type: 'success', message: success })
      await onChanged()
      return true
    } catch (error) {
      setFeedback({
        type: 'error',
        message: errorMessage(error, 'Não foi possível salvar o cadastro.'),
      })
      return false
    } finally {
      setBusy(false)
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const saved = editingId
      ? await perform(
          () => updateOption(category, editingId, draft, hasAcronym ? acronym : undefined),
          'Cadastro atualizado.',
        )
      : await perform(
          () => createOption(category, draft, hasAcronym ? acronym : undefined),
          'Cadastro adicionado.',
        )

    if (saved) {
      setEditingId(null)
      setIsAdding(false)
      setDraft('')
      setAcronym('')
    }
  }

  function toggleActive(option: CatalogOption) {
    void perform(
      () => setOptionActive(category, option.id, !option.active),
      option.active
        ? 'Cadastro desativado. Ele não aparecerá em novos formulários.'
        : 'Cadastro ativado.',
    )
  }

  const nameInput = (label: string, placeholder?: string) => (
    <>
      <label>
        <span className="visually-hidden">{label}</span>
        <input
          autoFocus
          required
          maxLength={120}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
        />
      </label>
      {hasAcronym && (
        <label>
          <span className="visually-hidden">Sigla</span>
          <input
            maxLength={20}
            value={acronym}
            onChange={(event) => setAcronym(event.target.value)}
            placeholder="Sigla"
          />
        </label>
      )}
    </>
  )

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
                  <form className="settings-option-form" onSubmit={(event) => void save(event)}>
                    {nameInput(`Editar nome em ${title}`)}
                    <button type="submit" disabled={disabled || busy}>
                      Salvar
                    </button>
                    <button type="button" onClick={() => setEditingId(null)}>
                      Cancelar
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="settings-option-label">
                      {option.label}
                      {option.acronym ? ` (${option.acronym})` : ''}
                    </span>
                    <span className={`settings-option-state${option.active ? ' active' : ''}`}>
                      {option.active ? 'Ativa' : 'Inativa'}
                    </span>
                    <div className="settings-option-actions">
                      <button type="button" disabled={disabled || busy} onClick={() => startEditing(option)}>
                        Editar
                      </button>
                      <button type="button" disabled={disabled || busy} onClick={() => toggleActive(option)}>
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
          <form className="settings-option-form settings-add-form" onSubmit={(event) => void save(event)}>
            {nameInput(`Nome do novo item em ${title}`, `Nome para ${title.toLocaleLowerCase('pt-BR')}`)}
            <button type="submit" disabled={disabled || busy}>
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

/**
 * Cadastros que ficaram no navegador antes de existir a API. A cópia só acontece a pedido, e
 * o que já existe no servidor é mantido. Os dados locais não são apagados.
 */
function LocalCatalogImport({ onChanged }: { onChanged: () => Promise<void> }) {
  const local = useSyncExternalStore(
    subscribeMaintenanceCatalog,
    getMaintenanceCatalogSnapshot,
    getMaintenanceCatalogSnapshot,
  )
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)
  const total = settingsSections.reduce(
    (sum, section) => sum + local.options[section.local].filter((option) => option.active).length,
    0,
  )

  if (total === 0) return null

  async function importOptions() {
    setBusy(true)
    let created = 0
    let skipped = 0
    for (const section of settingsSections) {
      for (const option of local.options[section.local].filter((item) => item.active)) {
        try {
          await createOption(section.category, option.label)
          created += 1
        } catch {
          skipped += 1
        }
      }
    }
    setResult(`${created} copiados para o servidor. ${skipped} não copiados, por já existirem ou serem inválidos.`)
    setBusy(false)
    await onChanged()
  }

  return (
    <Alert tone="warning">
      <p className="ui-alert-text">
        Este navegador guarda {total} cadastros feitos antes da integração.{' '}
        {result || 'Eles não são usados pelos formulários até serem copiados para o servidor.'}
      </p>
      <button type="button" disabled={busy} onClick={() => void importOptions()}>
        Copiar para o servidor
      </button>
    </Alert>
  )
}

function FullSettingsPage() {
  const canManage = useHasPermission('settings:manage')
  const { context: demandContext } = useDemandContext()
  const canConfigureDemands = useHasPermission('demands:configure') || demandContext?.canConfigure === true
  const canReadTemplates = useHasPermission('email_templates:read')
  const canReadForms = useHasPermission('forms:read')
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    try {
      const data = await fetchFullCatalog()
      setCatalog(data.catalog)
      setError('')
      void refreshCatalog()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível carregar as configurações.'))
    }
  }, [])

  useEffect(() => {
    let active = true
    fetchFullCatalog()
      .then((data) => {
        if (active) setCatalog(data.catalog)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar as configurações.'))
      })
    return () => {
      active = false
    }
  }, [])

  const groups: { key: string; title: string; description: string; icon: IconName; sections: typeof settingsSections }[] = [
    {
      key: 'organization',
      title: 'Organização e serviços',
      description: 'Listas usadas nos formulários de Manutenção, Frota e Passagens.',
      icon: 'lists',
      sections: settingsSections.filter((section) =>
        ['sectors', 'floors', 'serviceTypes'].includes(section.category),
      ),
    },
    {
      key: 'warehouse',
      title: 'Almoxarifado',
      description: 'Listas usadas no catálogo de materiais.',
      icon: 'warehouse',
      sections: settingsSections.filter((section) =>
        ['warehouseCategories', 'measurementUnits'].includes(section.category),
      ),
    },
  ]

  return (
    <div className="admin-module-page settings-page">
      <PageHeader
        title="Configurações"
        description="Listas padronizadas e personalização dos formulários do sistema."
      />

      <Alert tone="info">
        As listas ficam no servidor e valem para todos os usuários. Ao desativar uma opção, ela deixa
        de aparecer em novos formulários, e os registros antigos mantêm o valor usado.
      </Alert>

      {error && <Alert tone="error">{error}</Alert>}
      {!canManage && <Alert tone="warning">Seu acesso a esta página é somente de consulta.</Alert>}
      {canManage && <LocalCatalogImport onChanged={reload} />}

      {groups.map((group) => (
        <section className="settings-group" key={group.key} aria-labelledby={`settings-${group.key}`}>
          <header>
            <span>
              <Icon name={group.icon} size={22} weight="duotone" />
            </span>
            <div>
              <h2 id={`settings-${group.key}`}>{group.title}</h2>
              <p>{group.description}</p>
            </div>
          </header>
          <div className="settings-grid">
            {group.sections.map((section) => (
              <CatalogSection
                key={section.category}
                category={section.category}
                title={section.title}
                description={section.description}
                options={catalog?.[section.category] ?? []}
                disabled={!canManage || !catalog}
                onChanged={reload}
              />
            ))}
          </div>
        </section>
      ))}

      <AdminSettingsSection canManage={canManage} />

      <ParametersSection canManage={canManage} />

      <DriverPortalSettingsSection canManage={canManage} />

      {canConfigureDemands && <DemandSettingsSection />}

      {canReadTemplates && <EmailTemplatesManager />}
      {canReadForms && <FormManager />}
    </div>
  )
}

/** Quem só configura o Controle de Demandas vê só essa parte: o resto exigiria outras permissões. */
function SettingsPage() {
  const canReadSettings = useHasPermission('settings:read', 'settings:manage')
  const hasConfigurePermission = useHasPermission('demands:configure')
  const { context, failed } = useDemandContext()
  if (canReadSettings) return <FullSettingsPage />
  if (!hasConfigurePermission && !context && !failed) return <Loading label="Carregando..." />
  if (!hasConfigurePermission && !context?.canConfigure) return <AccessDeniedPage />
  return (
    <div className="admin-module-page settings-page">
      <PageHeader title="Configurações" description="Setores, integrantes e categorias do Controle de Demandas." />
      <DemandSettingsSection />
    </div>
  )
}

export default SettingsPage
