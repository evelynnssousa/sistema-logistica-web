import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  createDemandCategory,
  createDemandSector,
  listDemandCategories,
  listDemandSectors,
  listDirectorateLinks,
  removeDemandMember,
  removeDirectorateLink,
  searchDemandUsers,
  setDemandMember,
  setDirectorateLink,
  updateDemandCategory,
  updateDemandSector,
} from '../api/demandsApi'
import type { DemandCategory, DemandSector, DirectorateLink } from '../api/demandsApi'
import { useAuthenticatedUser, useHasPermission } from '../auth/UserContext'
import { errorMessage } from '../api/modulesApi'
import { demandContextChangedEvent } from '../app/useDemandContext'
import { Alert } from './ui/Feedback'
import Icon from './ui/Icon'

const memberValues = (member: DemandSector['members'][number]) => ({
  role: member.role,
  canCreate: member.canCreate,
  seesSector: member.seesSector,
  chefia: member.chefia,
  function: member.function,
})

function DirectoratePanel({ setFeedback }: { setFeedback: (text: string, tone: 'success' | 'error') => void }) {
  const currentUser = useAuthenticatedUser()
  const isAdministrator = currentUser?.role === 'administrator'
  const [links, setLinks] = useState<DirectorateLink[]>([])
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<{ id: string; name: string; email: string }[]>([])

  const load = useCallback(async () => {
    setLinks((await listDirectorateLinks()).links)
  }, [])

  useEffect(() => {
    let active = true
    listDirectorateLinks()
      .then((data) => {
        if (active) setLinks(data.links)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  async function perform(action: () => Promise<unknown>, success: string) {
    try {
      await action()
      setFeedback(success, 'success')
      await load()
      window.dispatchEvent(new Event(demandContextChangedEvent))
      return true
    } catch (err) {
      setFeedback(errorMessage(err, 'Não foi possível salvar.'), 'error')
      return false
    }
  }

  return (
    <div className="demand-settings-card">
      <header>
        <h3>Diretores da Diretoria Administrativa</h3>
      </header>
      <p className="demand-muted">
        O Diretor vê, cadastra e edita as demandas de todos os setores, mesmo sem integrar um deles. Somente um administrador define diretores.
      </p>
      {links.length === 0 ? (
        <p className="demand-muted">Nenhum diretor definido.</p>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Pessoa</th>
                <th>Função</th>
                <th>Ação</th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.userId}>
                  <td>
                    {link.name}
                    <br />
                    <small className="demand-muted">
                      {link.email}
                      {!link.accountActive && ' · conta inativa'}
                    </small>
                  </td>
                  <td>
                    <label>
                      <span className="visually-hidden">Função de {link.name} na DA</span>
                      <input
                        key={link.function ?? ''}
                        maxLength={120}
                        defaultValue={link.function ?? ''}
                        onBlur={(event) => {
                          const next = event.target.value.trim() || null
                          if (next === link.function) return
                          void perform(() => setDirectorateLink(link.userId, { role: link.role, function: next }), 'Vínculo atualizado.')
                        }}
                      />
                    </label>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="maintenance-secondary-button"
                      onClick={() => void perform(() => removeDirectorateLink(link.userId), 'Perfil de Diretor retirado. O histórico da pessoa é mantido.')}
                    >
                      Retirar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {isAdministrator && <form
        className="demand-settings-inline"
        onSubmit={(event) => {
          event.preventDefault()
          searchDemandUsers(search)
            .then((data) => setResults(data.users))
            .catch((err: unknown) => setFeedback(errorMessage(err, 'Não foi possível pesquisar.'), 'error'))
        }}
      >
        <label>
          <span className="visually-hidden">Pesquisar pessoa para definir como Diretor</span>
          <input placeholder="Pesquisar conta para definir como Diretor" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <button type="submit" className="maintenance-secondary-button">Pesquisar</button>
      </form>}
      {results.length > 0 && (
        <ul className="demand-mini-list">
          {results
            .filter((user) => !links.some((link) => link.userId === user.id))
            .map((user) => (
              <li key={user.id}>
                <div>
                  <strong>{user.name}</strong>
                  <span>{user.email}</span>
                </div>
                <button
                  type="button"
                  className="maintenance-secondary-button"
                  onClick={() =>
                    void perform(() => setDirectorateLink(user.id, { role: 'diretor' }), 'Diretor definido.').then(
                      (saved) => saved && setResults([]),
                    )
                  }
                >
                  Definir como Diretor
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}

function SectorCard({ sector, onChanged, setFeedback }: { sector: DemandSector; onChanged: () => Promise<void>; setFeedback: (text: string, tone: 'success' | 'error') => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(sector.name)
  const [acronym, setAcronym] = useState(sector.acronym ?? '')
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<{ id: string; name: string; email: string; sector: string | null }[]>([])

  async function perform(action: () => Promise<unknown>, success: string) {
    try {
      await action()
      setFeedback(success, 'success')
      await onChanged()
      window.dispatchEvent(new Event(demandContextChangedEvent))
      return true
    } catch (err) {
      setFeedback(errorMessage(err, 'Não foi possível salvar.'), 'error')
      return false
    }
  }

  async function find(event: FormEvent) {
    event.preventDefault()
    try {
      setResults((await searchDemandUsers(search)).users)
    } catch (err) {
      setFeedback(errorMessage(err, 'Não foi possível pesquisar.'), 'error')
    }
  }

  return (
    <article className="demand-settings-card">
      <header>
        {editing ? (
          <form
            className="demand-settings-inline"
            onSubmit={(event) => {
              event.preventDefault()
              void perform(
                () => updateDemandSector(sector.id, { name, acronym: acronym || null, order: sector.order, active: sector.active, isSlm: sector.isSlm }),
                'Setor atualizado.',
              ).then((saved) => saved && setEditing(false))
            }}
          >
            <label>
              <span className="visually-hidden">Nome do setor</span>
              <input required minLength={2} maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              <span className="visually-hidden">Sigla</span>
              <input maxLength={20} placeholder="Sigla" value={acronym} onChange={(event) => setAcronym(event.target.value)} />
            </label>
            <button type="submit" className="maintenance-primary-button">Salvar</button>
            <button type="button" className="maintenance-secondary-button" onClick={() => setEditing(false)}>Voltar</button>
          </form>
        ) : (
          <>
            <h3>
              {sector.name}
              {sector.acronym && ` (${sector.acronym})`}
              {!sector.active && <span className="demand-flag">Desativado</span>}
            </h3>
            <span className="demand-actions">
              <button type="button" className="maintenance-secondary-button" onClick={() => setEditing(true)}>Editar</button>
              <button
                type="button"
                className="maintenance-secondary-button"
                onClick={() =>
                  void perform(
                    () => updateDemandSector(sector.id, { name: sector.name, acronym: sector.acronym, order: sector.order, active: !sector.active, isSlm: sector.isSlm }),
                    sector.active ? 'Setor desativado. As demandas antigas não mudam.' : 'Setor ativado.',
                  )
                }
              >
                {sector.active ? 'Desativar' : 'Ativar'}
              </button>
            </span>
          </>
        )}
      </header>

      {sector.members.length === 0 ? (
        <p className="demand-muted">Nenhum integrante.</p>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Pessoa</th>
                <th>Função</th>
                <th>Ação</th>
              </tr>
            </thead>
            <tbody>
              {sector.members.map((member) => (
                <tr key={member.userId}>
                  <td>
                    {member.name}
                    <br />
                    <small className="demand-muted">
                      {member.email}
                      {!member.accountActive && ' · conta inativa'}
                    </small>
                  </td>
                  <td>
                    <label>
                      <span className="visually-hidden">Papel de {member.name}</span>
                      <select
                        value={member.role === 'responsavel' ? 'chefia' : 'colaborador'}
                        onChange={(event) =>
                          void perform(
                            () =>
                              setDemandMember(sector.id, member.userId, {
                                ...memberValues(member),
                                role: event.target.value === 'colaborador' ? 'colaborador' : 'responsavel',
                                chefia: event.target.value === 'chefia',
                              }),
                            'Integrante atualizado.',
                          )
                        }
                      >
                        <option value="colaborador">Servidor do setor</option>
                        <option value="chefia">Chefe do setor</option>
                      </select>
                    </label>
                  </td>
                  <td>
                    <label>
                      <span className="visually-hidden">Função de {member.name}</span>
                      <input
                        key={member.function ?? ''}
                        maxLength={120}
                        defaultValue={member.function ?? ''}
                        onBlur={(event) => {
                          const next = event.target.value.trim() || null
                          if (next === member.function) return
                          void perform(
                            () => setDemandMember(sector.id, member.userId, { ...memberValues(member), function: next }),
                            'Integrante atualizado.',
                          )
                        }}
                      />
                    </label>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="maintenance-secondary-button"
                      onClick={() => void perform(() => removeDemandMember(sector.id, member.userId), 'Integrante removido do setor.')}
                    >
                      Remover
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="demand-settings-inline" onSubmit={(event) => void find(event)}>
        <label>
          <span className="visually-hidden">Pesquisar pessoa para incluir em {sector.name}</span>
          <input placeholder="Pesquisar conta por nome ou e-mail" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <button type="submit" className="maintenance-secondary-button">Pesquisar</button>
      </form>
      {results.length > 0 && (
        <ul className="demand-mini-list">
          {results
            .filter((user) => !sector.members.some((member) => member.userId === user.id))
            .map((user) => (
              <li key={user.id}>
                <div>
                  <strong>{user.name}</strong>
                  <span>{user.email}</span>
                </div>
                <button
                  type="button"
                  className="maintenance-secondary-button"
                  onClick={() =>
                    void perform(
                      () => setDemandMember(sector.id, user.id, { role: 'colaborador', canCreate: true, seesSector: true }),
                      'Integrante incluído.',
                    ).then((saved) => saved && setResults([]))
                  }
                >
                  Incluir
                </button>
              </li>
            ))}
        </ul>
      )}
    </article>
  )
}

function CategoryRow({ category, onSave }: { category: DemandCategory; onSave: (values: { name: string; order: number; active: boolean }) => Promise<boolean> }) {
  const [name, setName] = useState(category.name)
  const [order, setOrder] = useState(String(category.order))

  return (
    <tr>
      <td>
        <label>
          <span className="visually-hidden">Nome da categoria {category.name}</span>
          <input maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
      </td>
      <td>
        <label>
          <span className="visually-hidden">Ordem de {category.name}</span>
          <input type="number" min="0" className="demand-order-input" value={order} onChange={(event) => setOrder(event.target.value)} />
        </label>
      </td>
      <td>{category.usage}</td>
      <td>{category.active ? 'Ativa' : 'Desativada'}</td>
      <td className="demand-actions">
        <button
          type="button"
          className="maintenance-secondary-button"
          disabled={name === category.name && Number(order) === category.order}
          onClick={() => void onSave({ name, order: Number(order), active: category.active })}
        >
          Salvar
        </button>
        <button
          type="button"
          className="maintenance-secondary-button"
          onClick={() => void onSave({ name: category.name, order: category.order, active: !category.active })}
        >
          {category.active ? 'Desativar' : 'Ativar'}
        </button>
      </td>
    </tr>
  )
}

/** Configurações do Controle de Demandas. O servidor confere cada operação. */
function DemandSettingsSection() {
  // O Diretor configura setores e categorias, mas definir diretores exige a permissão.
  const canManageDirectorate = useHasPermission('demands:configure')
  const [sectors, setSectors] = useState<DemandSector[] | null>(null)
  const [categories, setCategories] = useState<DemandCategory[]>([])
  const [feedback, setFeedback] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  const [unavailable, setUnavailable] = useState('')
  const [sectorName, setSectorName] = useState('')
  const [categoryName, setCategoryName] = useState('')

  const load = useCallback(async () => {
    try {
      const [sectorList, categoryList] = await Promise.all([listDemandSectors(), listDemandCategories()])
      setSectors(sectorList.sectors)
      setCategories(categoryList.categories)
      setUnavailable('')
    } catch (err) {
      setUnavailable(errorMessage(err, 'Não foi possível carregar as configurações do módulo.'))
    }
  }, [])

  useEffect(() => {
    let active = true
    Promise.all([listDemandSectors(), listDemandCategories()])
      .then(([sectorList, categoryList]) => {
        if (!active) return
        setSectors(sectorList.sectors)
        setCategories(categoryList.categories)
      })
      .catch((err: unknown) => {
        if (active) setUnavailable(errorMessage(err, 'Não foi possível carregar as configurações do módulo.'))
      })
    return () => {
      active = false
    }
  }, [])

  const show = (text: string, tone: 'success' | 'error') => setFeedback({ text, tone })

  async function addSector(event: FormEvent) {
    event.preventDefault()
    try {
      await createDemandSector({ name: sectorName, order: (sectors?.length ?? 0) * 10 })
      setSectorName('')
      show('Setor cadastrado.', 'success')
      await load()
    } catch (err) {
      show(errorMessage(err, 'Não foi possível cadastrar o setor.'), 'error')
    }
  }

  async function addCategory(event: FormEvent) {
    event.preventDefault()
    try {
      const last = categories.reduce((maximum, item) => Math.max(maximum, item.order), 0)
      await createDemandCategory({ name: categoryName, order: last + 10 })
      setCategoryName('')
      show('Categoria cadastrada.', 'success')
      await load()
    } catch (err) {
      show(errorMessage(err, 'Não foi possível cadastrar a categoria.'), 'error')
    }
  }

  async function saveCategory(category: DemandCategory, values: { name: string; order: number; active: boolean }) {
    try {
      await updateDemandCategory(category.id, { ...values, description: category.description })
      show(values.active === category.active ? 'Categoria atualizada.' : values.active ? 'Categoria ativada.' : 'Categoria desativada. As demandas antigas não mudam.', 'success')
      await load()
      return true
    } catch (err) {
      show(errorMessage(err, 'Não foi possível salvar a categoria.'), 'error')
      return false
    }
  }

  return (
    <section className="settings-group" aria-labelledby="settings-demands">
      <header>
        <span>
          <Icon name="demands" size={22} weight="duotone" />
        </span>
        <div>
          <h2 id="settings-demands">Controle de Demandas</h2>
          <p>Setores da Diretoria Administrativa, seus integrantes e as categorias do módulo.</p>
        </div>
      </header>

      {unavailable && <Alert tone="warning">{unavailable}</Alert>}
      {feedback && <Alert tone={feedback.tone}>{feedback.text}</Alert>}

      {sectors && (
        <div className="demand-stack">
          <Alert tone="info">
            Os vínculos somam e não mudam a lotação da pessoa. Quem participa da DA ou integra um setor acessa o módulo.
            Retirar alguém não apaga as ações anteriores nem o histórico das demandas.
          </Alert>

          {canManageDirectorate && <DirectoratePanel setFeedback={show} />}

          <h3>Setores e integrantes</h3>
          {sectors.length === 0 && <p className="demand-muted">Nenhum setor cadastrado. Cadastre os setores da Diretoria Administrativa.</p>}
          {sectors.map((sector) => (
            <SectorCard key={sector.id} sector={sector} onChanged={load} setFeedback={show} />
          ))}
          <form className="demand-settings-inline" onSubmit={(event) => void addSector(event)}>
            <label>
              <span className="visually-hidden">Nome do novo setor</span>
              <input required minLength={2} maxLength={120} placeholder="Nome do novo setor" value={sectorName} onChange={(event) => setSectorName(event.target.value)} />
            </label>
            <button type="submit" className="maintenance-secondary-button">Cadastrar setor</button>
          </form>

          <h3>Categorias de demandas</h3>
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Ordem</th>
                  <th>Demandas</th>
                  <th>Situação</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((category) => (
                  <CategoryRow key={`${category.id}-${category.name}-${category.order}`} category={category} onSave={(values) => saveCategory(category, values)} />
                ))}
              </tbody>
            </table>
          </div>
          <form className="demand-settings-inline" onSubmit={(event) => void addCategory(event)}>
            <label>
              <span className="visually-hidden">Nome da nova categoria</span>
              <input required minLength={2} maxLength={120} placeholder="Nome da nova categoria" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} />
            </label>
            <button type="submit" className="maintenance-secondary-button">Cadastrar categoria</button>
          </form>
        </div>
      )}
    </section>
  )
}

export default DemandSettingsSection
