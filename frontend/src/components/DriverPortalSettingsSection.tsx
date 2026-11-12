import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { FieldPlacement, TripField, TripGroup } from '../api/driverApi'
import { tripGroupLabels, tripGroupOrder } from '../api/driverApi'
import { errorMessage } from '../api/modulesApi'
import {
  createOccurrenceType,
  getDriverPortalHistory,
  getParameters,
  listOccurrenceTypes,
  saveParameters,
  updateOccurrenceType,
} from '../api/operationsApi'
import type { OccurrenceType, ParametersResponse, SettingsChange, SystemSettings } from '../api/operationsApi'
import { Alert } from './ui/Feedback'
import Icon from './ui/Icon'
import { useConfirm } from './ui/useConfirm'

type Section = 'driverJourney' | 'driverExecution' | 'driverAccess' | 'driverNotifications' | 'driverDisplay'

const weekdays = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
const outsideRuleLabels = { identify: 'Registrar e identificar', justify: 'Exigir justificativa' }
const placementLabels: Record<FieldPlacement, string> = { card: 'No cartão', details: 'Nos detalhes', hidden: 'Não exibir' }
const executionFieldLabels = { vehicle: 'Veículo, se a viagem não tiver', odometer: 'Hodômetro', notes: 'Observação' }
const sectionLabels: Record<string, string> = {
  driverJourney: 'Jornada de trabalho',
  driverExecution: 'Execução das viagens',
  driverAccess: 'Acesso e funcionalidades',
  driverNotifications: 'Regras de notificação',
  driverDisplay: 'Visualização',
  driverOccurrenceTypes: 'Tipos de ocorrência',
}
/** Quem precisa manter visível o que dá acesso à viagem: a API mantém mesmo que venha desmarcado. */
const requiredGroups: readonly TripGroup[] = ['proximas', 'em_andamento']

const toggled = <T,>(list: readonly T[], item: T, on: boolean) => (on ? [...list, item] : list.filter((value) => value !== item))

/**
 * Bloco com Salvar e Cancelar. Cancelar volta ao que está gravado, porque a chave do bloco muda. Quando
 * a alteração é relevante, confirm traz a pergunta antes de salvar.
 */
function PortalBlock({
  title,
  description,
  canManage,
  onSave,
  onCancel,
  confirmMessage,
  children,
}: {
  title: string
  description: string
  canManage: boolean
  onSave: () => Promise<unknown>
  onCancel: () => void
  confirmMessage?: () => string | null
  children: ReactNode
}) {
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const { confirm, confirmDialog } = useConfirm()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setNotice('')
    const question = confirmMessage?.()
    if (question && !(await confirm(question, { confirmLabel: 'Salvar alteração' }))) return
    setBusy(true)
    try {
      await onSave()
      setNotice('Alterações salvas. Já valem no Portal do Motorista.')
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível salvar.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ui-card ui-stacked" onSubmit={(event) => void submit(event)} aria-label={title}>
      <h3>{title}</h3>
      <p className="management-hint">{description}</p>
      <fieldset disabled={!canManage} className="parameter-fields">
        {children}
      </fieldset>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {canManage && (
        <div className="driver-settings-actions ui-card-actions">
          <button type="submit" className="maintenance-primary-button" disabled={busy}>Salvar</button>
          <button type="button" className="maintenance-secondary-button" disabled={busy} onClick={onCancel}>Cancelar</button>
        </div>
      )}
      {confirmDialog}
    </form>
  )
}

type BlockProps<S extends Section> = {
  value: SystemSettings[S]
  canManage: boolean
  onSaved: (section: S, value: SystemSettings[S]) => void
  onCancel: () => void
}

function JourneyBlock({ value, canManage, onSaved, onCancel }: BlockProps<'driverJourney'>) {
  const [draft, setDraft] = useState({
    ...value,
    breakMinutes: String(value.breakMinutes),
    expectedMinutes: value.expectedMinutes === null ? '' : String(value.expectedMinutes),
  })
  const set = <K extends keyof typeof draft>(key: K, next: (typeof draft)[K]) => setDraft((current) => ({ ...current, [key]: next }))

  return (
    <PortalBlock
      title="Jornada de trabalho"
      description="Vale para as viagens iniciadas depois de salvar. As anteriores continuam com a jornada vigente quando começaram."
      canManage={canManage}
      onCancel={onCancel}
      confirmMessage={() =>
        `Confirmar a jornada de ${draft.start} às ${draft.end}? Ela vale para as próximas viagens, e os registros anteriores não mudam.`
      }
      onSave={async () => {
        const response = await saveParameters('driverJourney', draft)
        onSaved('driverJourney', response.value as SystemSettings['driverJourney'])
      }}
    >
      <div className="form-grid">
        <label className="maintenance-form-field">
          <span>Início da jornada</span>
          <input type="time" required value={draft.start} onChange={(event) => set('start', event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Término da jornada</span>
          <input type="time" required value={draft.end} onChange={(event) => set('end', event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Intervalo para descanso (minutos)</span>
          <input type="number" min="0" max="240" required value={draft.breakMinutes} onChange={(event) => set('breakMinutes', event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Duração prevista, sem o intervalo (minutos)</span>
          <input type="number" min="1" max="1440" placeholder="Sem duração definida" value={draft.expectedMinutes} onChange={(event) => set('expectedMinutes', event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Viagem iniciada fora da jornada</span>
          <select value={draft.outsideStart} onChange={(event) => set('outsideStart', event.target.value as typeof draft.outsideStart)}>
            {Object.entries(outsideRuleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label className="maintenance-form-field">
          <span>Viagem encerrada fora da jornada</span>
          <select value={draft.outsideFinish} onChange={(event) => set('outsideFinish', event.target.value as typeof draft.outsideFinish)}>
            {Object.entries(outsideRuleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="driver-settings-fieldset">
        <legend>Dias de funcionamento</legend>
        <div className="driver-settings-checks">
          {weekdays.map((label, day) => (
            <label key={label} className="parameter-check">
              <input
                type="checkbox"
                checked={draft.weekdays.includes(day)}
                onChange={(event) => set('weekdays', toggled(draft.weekdays, day, event.target.checked).sort())}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="parameter-check">
        <input type="checkbox" checked={draft.allowOutsideStart} onChange={(event) => set('allowOutsideStart', event.target.checked)} />
        Permitir registros excepcionais fora da jornada. Desmarcado, o motorista não inicia fora dela, e a equipe de Frota registra. Finalizar nunca é impedido.
      </label>
    </PortalBlock>
  )
}

function ExecutionBlock({ value, canManage, onSaved, onCancel }: BlockProps<'driverExecution'>) {
  const [draft, setDraft] = useState({ ...value, upcomingDays: String(value.upcomingDays) })
  const check = (list: 'startFields' | 'finishFields', key: 'vehicle' | 'odometer' | 'notes') => (
    <label key={key} className="parameter-check">
      <input
        type="checkbox"
        checked={draft[list].includes(key)}
        onChange={(event) => setDraft((current) => ({ ...current, [list]: toggled(current[list], key, event.target.checked) }))}
      />
      {executionFieldLabels[key]}
    </label>
  )

  return (
    <PortalBlock
      title="Execução das viagens"
      description="O que o motorista precisa informar e quais situações o portal mostra. Data, horário e motorista são sempre automáticos."
      canManage={canManage}
      onCancel={onCancel}
      onSave={async () => {
        const response = await saveParameters('driverExecution', draft)
        onSaved('driverExecution', response.value as SystemSettings['driverExecution'])
      }}
    >
      <fieldset className="driver-settings-fieldset">
        <legend>Obrigatório para iniciar</legend>
        <div className="driver-settings-checks">
          {(['vehicle', 'odometer', 'notes'] as const).map((key) => check('startFields', key))}
        </div>
      </fieldset>
      <fieldset className="driver-settings-fieldset">
        <legend>Obrigatório para finalizar</legend>
        <div className="driver-settings-checks">
          {(['odometer', 'notes'] as const).map((key) => check('finishFields', key))}
        </div>
      </fieldset>
      <fieldset className="driver-settings-fieldset">
        <legend>Situações exibidas no portal</legend>
        <div className="driver-settings-checks">
          {tripGroupOrder.map((group) => (
            <label key={group} className="parameter-check">
              <input
                type="checkbox"
                disabled={requiredGroups.includes(group)}
                checked={draft.visibleGroups.includes(group)}
                onChange={(event) => setDraft((current) => ({ ...current, visibleGroups: toggled(current.visibleGroups, group, event.target.checked) }))}
              />
              {tripGroupLabels[group]}
              {requiredGroups.includes(group) && ' (sempre)'}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="maintenance-form-field">
        <span>Dias à frente para a viagem aparecer em Próximas</span>
        <input type="number" min="1" max="60" required value={draft.upcomingDays} onChange={(event) => setDraft((current) => ({ ...current, upcomingDays: event.target.value }))} />
      </label>
    </PortalBlock>
  )
}

function emptyType(): Omit<OccurrenceType, 'key'> {
  return { label: '', active: true, requiresJustification: false, allowsAttachments: true, asksDelay: false }
}

function OccurrenceTypesBlock({ canManage, onChanged }: { canManage: boolean; onChanged: () => void }) {
  const [types, setTypes] = useState<OccurrenceType[] | null>(null)
  const [draft, setDraft] = useState(emptyType)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  useEffect(() => {
    let active = true
    listOccurrenceTypes()
      .then((data) => {
        if (active) setTypes(data.types)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os tipos de ocorrência.'))
      })
    return () => {
      active = false
    }
  }, [])

  async function perform(key: string, action: () => Promise<{ type: OccurrenceType }>, success: string) {
    setBusyKey(key)
    setError('')
    setNotice('')
    try {
      const { type } = await action()
      setTypes((current) => {
        const list = current ?? []
        return list.some((item) => item.key === type.key)
          ? list.map((item) => (item.key === type.key ? type : item))
          : [...list, type]
      })
      setNotice(success)
      onChanged()
      return true
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível salvar o tipo de ocorrência.'))
      return false
    } finally {
      setBusyKey(null)
    }
  }

  async function save(type: OccurrenceType) {
    const { key, ...body } = type
    await perform(key, () => updateOccurrenceType(key, body), 'Tipo atualizado. As ocorrências já registradas mantêm o nome que usaram.')
  }

  async function toggle(type: OccurrenceType) {
    if (
      type.active &&
      !(await confirm(`Desativar "${type.label}"? Ele sai das próximas escolhas, e as ocorrências já registradas continuam como estão.`, { confirmLabel: 'Desativar' }))
    ) {
      return
    }
    await save({ ...type, active: !type.active })
  }

  const change = (key: string, patch: Partial<OccurrenceType>) =>
    setTypes((current) => (current ?? []).map((item) => (item.key === key ? { ...item, ...patch } : item)))

  return (
    <section className="ui-card ui-stacked" aria-label="Tipos de ocorrência">
      <h3>Tipos de ocorrência</h3>
      <p className="management-hint">Não há exclusão: desativar tira o tipo das próximas escolhas. Quem registra uma ocorrência sempre escreve a descrição.</p>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {types && (
        <div className="data-table-wrapper">
          <table className="data-table parameter-table driver-settings-types" data-testid="occurrence-types">
            <thead>
              <tr>
                <th>Descrição</th>
                <th>Justificativa</th>
                <th>Anexos</th>
                <th>Minutos de atraso</th>
                <th>Situação</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {types.map((type) => (
                <tr key={type.key} data-type={type.key}>
                  <td>
                    <label>
                      <span className="visually-hidden">Descrição de {type.label}</span>
                      <input required disabled={!canManage} maxLength={80} value={type.label} onChange={(event) => change(type.key, { label: event.target.value })} />
                    </label>
                  </td>
                  <td>
                    <input type="checkbox" disabled={!canManage} aria-label={`Exige justificativa: ${type.label}`} checked={type.requiresJustification} onChange={(event) => change(type.key, { requiresJustification: event.target.checked })} />
                  </td>
                  <td>
                    <input type="checkbox" disabled={!canManage} aria-label={`Permite anexos: ${type.label}`} checked={type.allowsAttachments} onChange={(event) => change(type.key, { allowsAttachments: event.target.checked })} />
                  </td>
                  <td>
                    <input type="checkbox" disabled={!canManage} aria-label={`Pede atraso: ${type.label}`} checked={type.asksDelay} onChange={(event) => change(type.key, { asksDelay: event.target.checked })} />
                  </td>
                  <td>{type.active ? 'Ativo' : 'Inativo'}</td>
                  <td>
                    {canManage && (
                      <div className="driver-settings-actions">
                        <button type="button" className="maintenance-secondary-button" disabled={busyKey !== null} onClick={() => void save(type)}>Salvar</button>
                        <button type="button" className="maintenance-secondary-button" disabled={busyKey !== null} onClick={() => void toggle(type)}>
                          {type.active ? 'Desativar' : 'Ativar'}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canManage && (
        <form
          className="action-row"
          onSubmit={(event) => {
            event.preventDefault()
            void perform('new', () => createOccurrenceType(draft), 'Tipo cadastrado. Já aparece no portal.').then((created) => {
              if (created) setDraft(emptyType())
            })
          }}
        >
          <label className="maintenance-form-field">
            <span>Novo tipo de ocorrência</span>
            <input required minLength={2} maxLength={80} value={draft.label} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} />
          </label>
          <label className="parameter-check">
            <input type="checkbox" checked={draft.requiresJustification} onChange={(event) => setDraft((current) => ({ ...current, requiresJustification: event.target.checked }))} />
            Exige justificativa
          </label>
          <label className="parameter-check">
            <input type="checkbox" checked={draft.allowsAttachments} onChange={(event) => setDraft((current) => ({ ...current, allowsAttachments: event.target.checked }))} />
            Permite anexos
          </label>
          <button type="submit" className="maintenance-secondary-button" disabled={busyKey !== null}>Adicionar tipo</button>
        </form>
      )}
      {confirmDialog}
    </section>
  )
}

function NotificationsBlock({
  value,
  events,
  canManage,
  onSaved,
  onCancel,
}: BlockProps<'driverNotifications'> & { events: ParametersResponse['options']['driverPortal']['notificationEvents'] }) {
  const [rules, setRules] = useState(value.rules)
  const set = (key: string, audience: 'driver' | 'team', on: boolean) =>
    setRules((current) => ({ ...current, [key]: { ...current[key], [audience]: on } }))

  return (
    <PortalBlock
      title="Regras de notificação"
      description="Pela plataforma e por e-mail, com os modelos e a configuração geral de envio. Desligar um aviso não apaga o histórico da viagem. Os avisos ao solicitante não mudam aqui."
      canManage={canManage}
      onCancel={onCancel}
      onSave={async () => {
        const response = await saveParameters('driverNotifications', { rules })
        onSaved('driverNotifications', response.value as SystemSettings['driverNotifications'])
      }}
    >
      <div className="data-table-wrapper">
        <table className="data-table parameter-table">
          <thead>
            <tr>
              <th>Evento</th>
              <th>Motorista</th>
              <th>Equipe administrativa da Frota</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.key}>
                <td>{event.label}</td>
                <td>
                  {event.appliesToDriver ? (
                    <input type="checkbox" aria-label={`${event.label}, motorista`} checked={rules[event.key]?.driver ?? false} onChange={(change) => set(event.key, 'driver', change.target.checked)} />
                  ) : (
                    <span title="É o próprio motorista quem registra.">—</span>
                  )}
                </td>
                <td>
                  <input type="checkbox" aria-label={`${event.label}, equipe`} checked={rules[event.key]?.team ?? false} onChange={(change) => set(event.key, 'team', change.target.checked)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PortalBlock>
  )
}

function AccessBlock({ value, canManage, onSaved, onCancel }: BlockProps<'driverAccess'>) {
  const [draft, setDraft] = useState(value)
  const check = (key: keyof typeof draft, label: string) => (
    <label className="parameter-check">
      <input type="checkbox" checked={draft[key]} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.checked }))} />
      {label}
    </label>
  )

  return (
    <PortalBlock
      title="Acesso e funcionalidades"
      description="Liga e desliga recursos do portal. A restrição às próprias viagens e o bloqueio dos módulos administrativos ficam no servidor e não dependem destas opções."
      canManage={canManage}
      onCancel={onCancel}
      confirmMessage={() =>
        value.portalEnabled && !draft.portalEnabled
          ? 'Desativar o Portal do Motorista? Os motoristas deixam de ver as viagens e de registrar a execução, e a equipe de Frota precisará iniciar e finalizar pela solicitação.'
          : value.occurrencesEnabled && !draft.occurrencesEnabled
            ? 'Desativar o registro de ocorrências? As já registradas continuam guardadas.'
            : null
      }
      onSave={async () => {
        const response = await saveParameters('driverAccess', draft)
        onSaved('driverAccess', response.value as SystemSettings['driverAccess'])
      }}
    >
      <div className="ui-stacked">
        {check('portalEnabled', 'Portal do Motorista ativo')}
        {check('occurrencesEnabled', 'Motorista pode registrar ocorrências')}
        {check('attachmentsEnabled', 'Motorista pode anexar arquivos às ocorrências')}
        {check('allowDocuments', 'Aceitar documentos (PDF, Word, Excel, texto)')}
        {check('allowPhotos', 'Aceitar fotografias (PNG, JPEG, WEBP)')}
      </div>
      <p className="management-hint">Os formatos e limites gerais de anexos, em Parâmetros do sistema, continuam valendo.</p>
    </PortalBlock>
  )
}

function DisplayBlock({
  value,
  fields,
  canManage,
  onSaved,
  onCancel,
}: BlockProps<'driverDisplay'> & { fields: ParametersResponse['options']['driverPortal']['tripFields'] }) {
  const [draft, setDraft] = useState(value)
  const setContact = (key: keyof typeof draft.contact, next: string | boolean) =>
    setDraft((current) => ({ ...current, contact: { ...current.contact, [key]: next } }))
  const setNotice = (index: number, patch: Partial<(typeof draft.notices)[number]>) =>
    setDraft((current) => ({ ...current, notices: current.notices.map((item, position) => (position === index ? { ...item, ...patch } : item)) }))

  return (
    <PortalBlock
      title="Visualização"
      description="O que aparece no cartão da viagem e as mensagens ao motorista. Campo marcado como não exibir não sai nem da API. Data, horário, situação e protocolo sempre aparecem."
      canManage={canManage}
      onCancel={onCancel}
      onSave={async () => {
        const response = await saveParameters('driverDisplay', draft)
        onSaved('driverDisplay', response.value as SystemSettings['driverDisplay'])
      }}
    >
      <div className="form-grid">
        {fields.map((field) => (
          <label key={field.key} className="maintenance-form-field">
            <span>{field.label}</span>
            <select
              value={draft.fields[field.key as TripField]}
              onChange={(event) => setDraft((current) => ({ ...current, fields: { ...current.fields, [field.key]: event.target.value } }))}
            >
              {Object.entries(placementLabels)
                .filter(([key]) => key !== 'hidden' || field.key !== 'destination')
                .map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
        ))}
      </div>

      <fieldset className="driver-settings-fieldset">
        <legend>Avisos operacionais</legend>
        {draft.notices.map((notice, index) => (
          <div className="action-row" key={index}>
            <label className="maintenance-form-field">
              <span className="visually-hidden">Aviso {index + 1}</span>
              <textarea rows={2} required minLength={3} maxLength={500} value={notice.text} onChange={(event) => setNotice(index, { text: event.target.value })} />
            </label>
            <label className="parameter-check">
              <input type="checkbox" checked={notice.active} onChange={(event) => setNotice(index, { active: event.target.checked })} />
              Ativo
            </label>
            <button
              type="button"
              className="maintenance-secondary-button"
              onClick={() => setDraft((current) => ({ ...current, notices: current.notices.filter((_item, position) => position !== index) }))}
            >
              Remover
            </button>
          </div>
        ))}
        <button
          type="button"
          className="maintenance-secondary-button"
          disabled={draft.notices.length >= 10}
          onClick={() => setDraft((current) => ({ ...current, notices: [...current.notices, { text: '', active: true }] }))}
        >
          Adicionar aviso
        </button>
      </fieldset>

      <fieldset className="driver-settings-fieldset">
        <legend>Mensagem de orientação aos motoristas</legend>
        <label className="parameter-check">
          <input type="checkbox" checked={draft.guidance.active} onChange={(event) => setDraft((current) => ({ ...current, guidance: { ...current.guidance, active: event.target.checked } }))} />
          Exibir no portal
        </label>
        <label className="maintenance-form-field">
          <span>Orientação</span>
          <textarea rows={3} maxLength={1000} value={draft.guidance.text} onChange={(event) => setDraft((current) => ({ ...current, guidance: { ...current.guidance, text: event.target.value } }))} />
        </label>
      </fieldset>

      <fieldset className="driver-settings-fieldset">
        <legend>Contato administrativo para situações excepcionais</legend>
        <label className="parameter-check">
          <input type="checkbox" checked={draft.contact.active} onChange={(event) => setContact('active', event.target.checked)} />
          Exibir no portal
        </label>
        <div className="form-grid">
          <label className="maintenance-form-field">
            <span>Nome ou setor</span>
            <input maxLength={120} value={draft.contact.name} onChange={(event) => setContact('name', event.target.value)} />
          </label>
          <label className="maintenance-form-field">
            <span>Telefone</span>
            <input type="tel" maxLength={40} value={draft.contact.phone} onChange={(event) => setContact('phone', event.target.value)} />
          </label>
          <label className="maintenance-form-field">
            <span>E-mail</span>
            <input type="email" maxLength={160} value={draft.contact.email} onChange={(event) => setContact('email', event.target.value)} />
          </label>
          <label className="maintenance-form-field">
            <span>Horário de atendimento</span>
            <input maxLength={120} value={draft.contact.hours} onChange={(event) => setContact('hours', event.target.value)} />
          </label>
        </div>
      </fieldset>
    </PortalBlock>
  )
}

const formatChange = (value: unknown) => (value === null || value === undefined ? 'sem valor gravado' : JSON.stringify(value))
const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })

function HistoryBlock({ version }: { version: number }) {
  const [history, setHistory] = useState<SettingsChange[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    getDriverPortalHistory()
      .then((data) => {
        if (active) setHistory(data.history)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar o histórico.'))
      })
    return () => {
      active = false
    }
  }, [version])

  return (
    <details className="ui-card ui-stacked" data-testid="driver-settings-history">
      <summary>Histórico de alterações</summary>
      {error && <Alert tone="error">{error}</Alert>}
      {history?.length === 0 && <p className="management-hint">Nenhuma alteração registrada. Valem os padrões documentados.</p>}
      {history && history.length > 0 && (
        <ul className="driver-settings-history">
          {history.map((change) => (
            <li key={change.id}>
              <strong>{sectionLabels[change.section] ?? change.section}</strong>
              {' · '}{change.user ?? 'Usuário removido'} · {dateTime.format(new Date(change.at))}
              <code>Antes: {formatChange(change.before)}</code>
              <code>Depois: {formatChange(change.after)}</code>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}

/** Parâmetros do Portal do Motorista. Tudo fica no banco, e a validação e as permissões, na API. */
function DriverPortalSettingsSection({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<ParametersResponse | null>(null)
  const [error, setError] = useState('')
  // Salvar ou cancelar remonta o bloco, que volta a partir do que está gravado.
  const [revisions, setRevisions] = useState<Record<string, number>>({})
  const [historyVersion, setHistoryVersion] = useState(0)

  useEffect(() => {
    let active = true
    getParameters()
      .then((response) => {
        if (active) setData(response)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar as configurações do portal.'))
      })
    return () => {
      active = false
    }
  }, [])

  const reset = (section: Section) => setRevisions((current) => ({ ...current, [section]: (current[section] ?? 0) + 1 }))
  const refreshHistory = useCallback(() => setHistoryVersion((current) => current + 1), [])
  const saved = <S extends Section>(section: S, value: SystemSettings[S]) => {
    setData((current) => current && { ...current, settings: { ...current.settings, [section]: value } })
    refreshHistory()
  }

  const key = (section: Section) => `${section}-${revisions[section] ?? 0}`

  return (
    <section className="settings-group" aria-labelledby="settings-driver-portal" data-testid="driver-portal-settings">
      <header>
        <span>
          <Icon name="fleet" size={22} weight="duotone" />
        </span>
        <div>
          <h2 id="settings-driver-portal">Configurações do Portal do Motorista</h2>
          <p>Jornada, execução, ocorrências, notificações, acesso e o que o motorista vê.</p>
        </div>
      </header>
      {error && <Alert tone="error">{error}</Alert>}
      {data && (
        <div className="settings-parameter-list">
          <JourneyBlock key={key('driverJourney')} value={data.settings.driverJourney} canManage={canManage} onSaved={saved} onCancel={() => reset('driverJourney')} />
          <ExecutionBlock key={key('driverExecution')} value={data.settings.driverExecution} canManage={canManage} onSaved={saved} onCancel={() => reset('driverExecution')} />
          <OccurrenceTypesBlock canManage={canManage} onChanged={refreshHistory} />
          <NotificationsBlock key={key('driverNotifications')} value={data.settings.driverNotifications} events={data.options.driverPortal.notificationEvents} canManage={canManage} onSaved={saved} onCancel={() => reset('driverNotifications')} />
          <AccessBlock key={key('driverAccess')} value={data.settings.driverAccess} canManage={canManage} onSaved={saved} onCancel={() => reset('driverAccess')} />
          <DisplayBlock key={key('driverDisplay')} value={data.settings.driverDisplay} fields={data.options.driverPortal.tripFields} canManage={canManage} onSaved={saved} onCancel={() => reset('driverDisplay')} />
          <HistoryBlock version={historyVersion} />
        </div>
      )}
    </section>
  )
}

export default DriverPortalSettingsSection
