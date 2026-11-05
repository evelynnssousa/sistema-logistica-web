import { useEffect, useRef, useState } from 'react'
import {
  getTemplate,
  getTemplateLibrary,
  previewTemplate,
  publishTemplate,
  restoreTemplate,
  saveTemplateDraft,
  sendTemplateTest,
} from '../api/configApi'
import type { ConfigVersion, TemplateContent, TemplateEvent, TemplateLibrary } from '../api/configApi'
import { errorMessage, formatDateTime } from '../api/modulesApi'
import { useHasPermission } from '../auth/UserContext'
import { Alert, Loading } from './ui/Feedback'
import Icon from './ui/Icon'

type Target = 'subject' | 'greeting' | 'body' | 'closing'

/** Editor em texto simples: o servidor converte **negrito** e listas, e escapa todo o resto. */
function TemplateEditor({
  event,
  library,
  onChanged,
}: {
  event: TemplateEvent
  library: TemplateLibrary
  onChanged: () => void
}) {
  const canEdit = useHasPermission('email_templates:edit')
  const canPublish = useHasPermission('email_templates:publish')
  const canRestore = useHasPermission('config_versions:restore')
  const [content, setContent] = useState<TemplateContent | null>(null)
  const [fallback, setFallback] = useState<TemplateContent | null>(null)
  const [history, setHistory] = useState<ConfigVersion<TemplateContent>[]>([])
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState<{ subject: string; text: string; html: string } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [target, setTarget] = useState<Target>('body')
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let active = true
    getTemplate(event.key)
      .then((data) => {
        if (!active) return
        setFallback(data.default)
        setHistory(data.history)
        setContent(data.latest?.content ?? data.default)
        setPreview(null)
        setError('')
        setNotice('')
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar o modelo.'))
      })
    return () => {
      active = false
    }
  }, [event.key])

  async function refresh() {
    const data = await getTemplate(event.key)
    setHistory(data.history)
    setContent(data.latest?.content ?? data.default)
    onChanged()
  }

  async function run(action: () => Promise<unknown>, success: string) {
    setError('')
    setNotice('')
    try {
      await action()
      setNotice(success)
      setNote('')
      await refresh()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível concluir a ação.'))
    }
  }

  if (error && !content) return <Alert tone="error">{error}</Alert>
  if (!content) return <Loading label="Carregando modelo..." />

  const change = (field: keyof TemplateContent, value: unknown) =>
    setContent((current) => (current ? { ...current, [field]: value } : current))

  function insert(text: string) {
    const element = target === 'body' ? bodyRef.current : null
    const value = content?.[target] ?? ''
    if (element) {
      const start = element.selectionStart
      const end = element.selectionEnd
      change(target, `${value.slice(0, start)}${text}${value.slice(end)}`)
    } else {
      change(target, `${value}${value ? ' ' : ''}${text}`)
    }
  }

  function makeBold() {
    const element = bodyRef.current
    if (!element || !content) return
    const { selectionStart: start, selectionEnd: end } = element
    const selected = content.body.slice(start, end) || 'texto em negrito'
    change('body', `${content.body.slice(0, start)}**${selected}**${content.body.slice(end)}`)
  }

  const allowed = library.variables.filter((item) => event.variables.includes(item.key))
  const moveFact = (index: number, step: number) => {
    const facts = [...content.facts]
    const next = index + step
    if (next < 0 || next >= facts.length) return
    ;[facts[index], facts[next]] = [facts[next], facts[index]]
    change('facts', facts)
  }

  return (
    <div className="ui-stacked" data-testid="template-editor">
      <fieldset disabled={!canEdit} className="parameter-fields">
        <div className="form-grid">
          <label className="maintenance-form-field">
            <span>Nome do modelo *</span>
            <input required maxLength={120} value={content.name} onChange={(item) => change('name', item.target.value)} />
          </label>
          <div className="maintenance-form-field">
            <span>Evento que dispara</span>
            <p>{event.label} ({event.modules.join(', ')}). O disparo é definido pelo sistema.</p>
          </div>
          <label className="maintenance-form-field form-grid-wide">
            <span>Assunto *</span>
            <input required maxLength={150} value={content.subject} onFocus={() => setTarget('subject')} onChange={(item) => change('subject', item.target.value)} />
          </label>
          <label className="maintenance-form-field form-grid-wide">
            <span>Saudação</span>
            <input maxLength={300} value={content.greeting} onFocus={() => setTarget('greeting')} onChange={(item) => change('greeting', item.target.value)} />
          </label>
          <label className="maintenance-form-field form-grid-wide">
            <span>Texto principal *</span>
            <textarea ref={bodyRef} required rows={6} maxLength={4000} value={content.body} onFocus={() => setTarget('body')} onChange={(item) => change('body', item.target.value)} />
            <small>Cada linha é um parágrafo. Linhas iniciadas por "- " viram lista. Linha com informação ausente não é enviada.</small>
          </label>
          <label className="maintenance-form-field form-grid-wide">
            <span>Encerramento</span>
            <input maxLength={500} value={content.closing} onFocus={() => setTarget('closing')} onChange={(item) => change('closing', item.target.value)} />
          </label>
          <label className="maintenance-form-field form-grid-wide">
            <span>Assinatura institucional *</span>
            <textarea required rows={3} maxLength={500} value={content.signature} onChange={(item) => change('signature', item.target.value)} />
          </label>
        </div>

        <div className="action-row" role="group" aria-label="Formatação e informações dinâmicas">
          <button type="button" className="maintenance-secondary-button" onClick={makeBold}>
            <strong>Negrito</strong>
          </button>
          <label className="maintenance-form-field">
            <span>Inserir informação dinâmica</span>
            <select
              value=""
              onChange={(item) => {
                if (item.target.value) insert(`{{${item.target.value}}}`)
              }}
            >
              <option value="">Selecione</option>
              {allowed.map((variable) => (
                <option key={variable.key} value={variable.key}>
                  {variable.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="check-list">
          <legend>Informações do atendimento, em ordem</legend>
          {content.facts.map((key, index) => (
            <div className="action-row" key={key}>
              <label>
                <input type="checkbox" checked onChange={() => change('facts', content.facts.filter((item) => item !== key))} />
                {library.facts.find((fact) => fact.key === key)?.label ?? key}
              </label>
              <button type="button" aria-label={`Mover ${key} para cima`} onClick={() => moveFact(index, -1)}>↑</button>
              <button type="button" aria-label={`Mover ${key} para baixo`} onClick={() => moveFact(index, 1)}>↓</button>
            </div>
          ))}
          {library.facts
            .filter((fact) => !content.facts.includes(fact.key))
            .map((fact) => (
              <label key={fact.key}>
                <input type="checkbox" checked={false} onChange={() => change('facts', [...content.facts, fact.key])} />
                {fact.label}
              </label>
            ))}
          <small>Motivo, datas, alterações e campos a corrigir são incluídos sempre que existirem, para a mensagem não ficar genérica.</small>
        </fieldset>

        <label className="maintenance-form-field">
          <span>Observação da versão</span>
          <input maxLength={500} value={note} onChange={(item) => setNote(item.target.value)} />
        </label>
      </fieldset>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="action-row">
        <button
          type="button"
          className="maintenance-secondary-button"
          onClick={() => {
            setError('')
            previewTemplate(event.key, content)
              .then((data) => setPreview(data))
              .catch((err: unknown) => setError(errorMessage(err, 'O modelo tem erros.')))
          }}
        >
          Visualizar e validar
        </button>
        {canEdit && (
          <>
            <button type="button" className="maintenance-secondary-button" onClick={() => void run(() => saveTemplateDraft(event.key, content, note), 'Rascunho salvo. Ele ainda não vale para os envios.')}>
              Salvar rascunho
            </button>
            <button
              type="button"
              className="maintenance-secondary-button"
              onClick={() => {
                setError('')
                setNotice('')
                sendTemplateTest(event.key, content)
                  .then((data) =>
                    setNotice(data.simulated ? 'Teste processado em modo simulado: nenhum e-mail saiu.' : 'E-mail de teste enviado para o endereço da sua conta.'),
                  )
                  .catch((err: unknown) => setError(errorMessage(err, 'Não foi possível enviar o teste.')))
              }}
            >
              Enviar teste para meu e-mail
            </button>
            {fallback && (
              <button type="button" className="maintenance-secondary-button" onClick={() => setContent(fallback)}>
                Restaurar o texto padrão
              </button>
            )}
          </>
        )}
        {canPublish && (
          <button type="button" className="maintenance-primary-button" onClick={() => void run(() => publishTemplate(event.key, content, note), 'Modelo publicado. Os próximos e-mails usarão esta versão.')}>
            Publicar
          </button>
        )}
      </div>

      {preview && (
        <section className="ui-card ui-stacked" aria-label="Visualização prévia" data-testid="template-preview">
          <Alert tone="info">Simulação com dados de exemplo. Nenhuma pessoa ou solicitação real aparece aqui.</Alert>
          <p><strong>Assunto:</strong> {preview.subject}</p>
          <iframe title="Visualização do e-mail" sandbox="" srcDoc={preview.html} style={{ width: '100%', minHeight: 360, border: '1px solid #dedfda' }} />
        </section>
      )}

      <details>
        <summary>Histórico de versões ({history.length})</summary>
        {history.length === 0 ? (
          <p>Sem versões salvas. Vale o texto padrão.</p>
        ) : (
          <ul className="detail-history">
            {history.map((item) => (
              <li key={item.id}>
                <strong>Versão {item.version}: {item.status === 'publicada' ? 'publicada' : 'rascunho'}</strong>
                <span>Assunto: {item.content.subject}</span>
                {item.note && <span>{item.note}</span>}
                <small>{item.user ?? 'Sistema'} · {formatDateTime(item.at)}</small>
                <div className="action-row">
                  <button type="button" onClick={() => setContent(item.content)}>Carregar no editor</button>
                  {canRestore && (
                    <button type="button" onClick={() => void run(() => restoreTemplate(event.key, item.version), `Versão ${item.version} publicada novamente.`)}>
                      Restaurar esta versão
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  )
}

/** Disparo, destinatários e credenciais não aparecem aqui: ficam protegidos no servidor. */
function EmailTemplatesManager() {
  const [library, setLibrary] = useState<TemplateLibrary | null>(null)
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [newName, setNewName] = useState('')
  const [newEvent, setNewEvent] = useState('manual_message')
  const [createError, setCreateError] = useState('')
  const canEdit = useHasPermission('email_templates:edit')

  const load = () =>
    getTemplateLibrary()
      .then((data) => {
        setLibrary(data)
        setSelected((current) => current || data.events[0]?.key || '')
      })
      .catch((err: unknown) => setError(errorMessage(err, 'Não foi possível carregar os modelos.')))

  useEffect(() => {
    void load()
  }, [])

  const custom = library?.custom.find((item) => item.key === selected)
  const parent = library?.events.find((item) => item.key === (custom?.event ?? selected))
  const event = parent && custom ? { ...parent, key: custom.key, label: `${parent.label} (modelo próprio)` } : parent

  async function createTemplate() {
    setCreateError('')
    const base = library?.events.find((item) => item.key === newEvent)
    if (!base || newName.trim().length < 2) {
      setCreateError('Informe o nome e o evento do novo modelo.')
      return
    }
    try {
      const source = await getTemplate(base.key)
      const key = `custom-${Date.now().toString(36)}`
      const content = source.published?.content ?? source.default
      if (!content) throw new Error('Este evento não tem texto de partida.')
      await saveTemplateDraft(key, { ...content, name: newName.trim(), event: base.key }, 'Modelo criado')
      setNewName('')
      await load()
      setSelected(key)
    } catch (err) {
      setCreateError(errorMessage(err, 'Não foi possível criar o modelo.'))
    }
  }

  return (
    <section className="settings-group" aria-labelledby="settings-email-templates">
      <header>
        <span>
          <Icon name="mail" size={22} weight="duotone" />
        </span>
        <div>
          <h2 id="settings-email-templates">Modelos de e-mail</h2>
          <p>Assunto, texto e informações de cada comunicação. Rascunhos não valem até serem publicados.</p>
        </div>
      </header>
      {error && <Alert tone="error">{error}</Alert>}
      {library && (
        <details className="settings-customize">
          <summary>Abrir modelos de e-mail</summary>
          <div className="settings-customize-body ui-stacked">
            <label className="maintenance-form-field">
              <span>Modelo</span>
              <select value={selected} onChange={(item) => setSelected(item.target.value)}>
                {library.events.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                    {item.published ? ` (publicado: v${item.published})` : ' (texto padrão)'}
                    {item.hasDraft ? ' · rascunho' : ''}
                  </option>
                ))}
                {library.custom.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.name} (modelo próprio{item.published ? `, publicado: v${item.published}` : ', não publicado'})
                  </option>
                ))}
              </select>
            </label>
            {canEdit && (
              <fieldset className="parameter-fields" data-testid="new-template">
                <legend>Novo modelo</legend>
                <div className="form-grid">
                  <label className="maintenance-form-field">
                    <span>Nome</span>
                    <input maxLength={120} value={newName} onChange={(item) => setNewName(item.target.value)} />
                  </label>
                  <label className="maintenance-form-field">
                    <span>Evento</span>
                    <select value={newEvent} onChange={(item) => setNewEvent(item.target.value)}>
                      {library.events.map((item) => (
                        <option key={item.key} value={item.key}>{item.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {createError && <Alert tone="error">{createError}</Alert>}
                <button type="button" className="maintenance-secondary-button" onClick={() => void createTemplate()}>Criar modelo</button>
              </fieldset>
            )}
            {event && <TemplateEditor key={event.key} event={event} library={library} onChanged={() => void load()} />}
          </div>
        </details>
      )}
    </section>
  )
}

export default EmailTemplatesManager
