import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { errorMessage } from '../api/modulesApi'
import { getAttachmentCapacity, getParameters, priorityLabels, saveParameters } from '../api/operationsApi'
import type { ParametersResponse, SystemSettings } from '../api/operationsApi'
import { roleLabels } from '../app/roleLabels'
import { useCatalog } from '../app/useCatalog'
import { Alert } from './ui/Feedback'
import Icon from './ui/Icon'

const kindLabels: Record<string, string> = {
  pdf: 'PDF',
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WEBP',
  docx: 'Word (.docx)',
  xlsx: 'Excel (.xlsx)',
  txt: 'Texto (.txt)',
}

function Block({
  title,
  description,
  canManage,
  onSave,
  children,
}: {
  title: string
  description: string
  canManage: boolean
  onSave: () => Promise<unknown>
  children: ReactNode
}) {
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await onSave()
      setNotice('Parâmetros salvos.')
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível salvar.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ui-card ui-stacked" onSubmit={(event) => void submit(event)}>
      <h3>{title}</h3>
      <p className="management-hint">{description}</p>
      <fieldset disabled={!canManage} className="parameter-fields">
        {children}
      </fieldset>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {canManage && (
        <button type="submit" className="maintenance-secondary-button" disabled={busy}>
          Salvar
        </button>
      )}
    </form>
  )
}

function OperationsBlock({ value, canManage }: { value: SystemSettings['operations']; canManage: boolean }) {
  const [staleDays, setStaleDays] = useState(String(value.staleDays))
  const [deadlines, setDeadlines] = useState<Record<string, string>>(
    Object.fromEntries(Object.keys(priorityLabels).map((key) => [key, value.deadlineDays[key]?.toString() ?? ''])),
  )
  return (
    <Block
      title="Prazos e alertas"
      description="Sem prazo definido para uma prioridade, nenhuma data é presumida ao abrir a solicitação."
      canManage={canManage}
      onSave={() => saveParameters('operations', { staleDays, deadlineDays: deadlines })}
    >
      <div className="form-grid">
        <label className="maintenance-form-field">
          <span>Dias sem movimentação para alertar</span>
          <input type="number" min="1" max="365" required value={staleDays} onChange={(event) => setStaleDays(event.target.value)} />
        </label>
        {Object.entries(priorityLabels).map(([key, label]) => (
          <label key={key} className="maintenance-form-field">
            <span>Prazo padrão, prioridade {label.toLowerCase()} (dias)</span>
            <input
              type="number"
              min="1"
              max="365"
              value={deadlines[key]}
              onChange={(event) => setDeadlines((current) => ({ ...current, [key]: event.target.value }))}
            />
          </label>
        ))}
      </div>
    </Block>
  )
}

const profiles = ['administrator', 'slm_operator', 'requester'] as const

function NotificationsBlock({
  value,
  options,
  canManage,
}: {
  value: SystemSettings['notifications']
  options: ParametersResponse['options']['notificationCategories']
  canManage: boolean
}) {
  const [disabled, setDisabled] = useState(value.disabled)
  const [reminderDays, setReminderDays] = useState(String(value.pendingReminderDays ?? ''))

  function toggle(profile: string, category: string, enabled: boolean) {
    setDisabled((current) => {
      const list = current[profile] ?? []
      return {
        ...current,
        [profile]: enabled ? list.filter((item) => item !== category) : [...list, category],
      }
    })
  }

  return (
    <Block
      title="Notificações por perfil"
      description="Define o que cada perfil recebe. Ninguém passa a ver o que suas permissões não permitem."
      canManage={canManage}
      onSave={() => saveParameters('notifications', { disabled, pendingReminderDays: reminderDays })}
    >
      <label className="maintenance-form-field">
        <span>Avisar a equipe sobre solicitações paradas há (dias)</span>
        <input
          type="number"
          min="1"
          max="365"
          step="1"
          disabled={!canManage}
          placeholder="Sem aviso"
          value={reminderDays}
          onChange={(event) => setReminderDays(event.target.value)}
        />
      </label>
      <div className="data-table-wrapper">
        <table className="data-table parameter-table">
          <thead>
            <tr>
              <th>Notificação</th>
              {profiles.map((profile) => (
                <th key={profile}>{roleLabels[profile]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {options.map((category) => (
              <tr key={category.key}>
                <td>{category.label}</td>
                {profiles.map((profile) => (
                  <td key={profile}>
                    <input
                      type="checkbox"
                      aria-label={`${category.label}, ${roleLabels[profile]}`}
                      checked={!(disabled[profile] ?? []).includes(category.key)}
                      onChange={(event) => toggle(profile, category.key, event.target.checked)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Block>
  )
}

function AttachmentsBlock({
  value,
  kinds,
  canManage,
}: {
  value: SystemSettings['attachments']
  kinds: string[]
  canManage: boolean
}) {
  const [maxFileMb, setMaxFileMb] = useState(String(value.maxFileMb))
  const [maxTotalMb, setMaxTotalMb] = useState(String(value.maxTotalMb))
  const [allowed, setAllowed] = useState(value.allowedKinds)
  const [capacity, setCapacity] = useState<Awaited<ReturnType<typeof getAttachmentCapacity>> | null>(null)

  useEffect(() => {
    let active = true
    getAttachmentCapacity()
      .then((data) => {
        if (active) setCapacity(data)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  return (
    <Block
      title="Anexos"
      description="Limites e tipos aceitos. O conteúdo de cada arquivo é conferido no envio."
      canManage={canManage}
      onSave={() => saveParameters('attachments', { maxFileMb, maxTotalMb, allowedKinds: allowed })}
    >
      {capacity && (
        <p className="management-hint">
          {capacity.configured
            ? `Em uso: ${Math.round(capacity.usedBytes / 1048576)} MB de ${Math.round(capacity.maxTotalBytes / 1048576)} MB, em ${capacity.files} arquivos.`
            : 'O armazenamento de anexos ainda não foi configurado pela TI.'}
        </p>
      )}
      <div className="form-grid">
        <label className="maintenance-form-field">
          <span>Tamanho máximo por arquivo (MB)</span>
          <input type="number" min="1" max="100" required value={maxFileMb} onChange={(event) => setMaxFileMb(event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Capacidade total (MB)</span>
          <input type="number" min="1" required value={maxTotalMb} onChange={(event) => setMaxTotalMb(event.target.value)} />
        </label>
      </div>
      <div className="action-row">
        {kinds.map((kind) => (
          <label key={kind} className="parameter-check">
            <input
              type="checkbox"
              checked={allowed.includes(kind)}
              onChange={(event) =>
                setAllowed((current) => (event.target.checked ? [...current, kind] : current.filter((item) => item !== kind)))
              }
            />
            {kindLabels[kind] ?? kind}
          </label>
        ))}
      </div>
    </Block>
  )
}

function CalendarBlock({ value, canManage }: { value: SystemSettings['calendar']; canManage: boolean }) {
  const [workdayStart, setStart] = useState(value.workdayStart)
  const [workdayEnd, setEnd] = useState(value.workdayEnd)
  return (
    <Block
      title="Agenda e horários"
      description="Agendamentos fora do expediente geram um aviso, mas continuam permitidos."
      canManage={canManage}
      onSave={() => saveParameters('calendar', { workdayStart, workdayEnd })}
    >
      <div className="form-grid">
        <label className="maintenance-form-field">
          <span>Início do expediente</span>
          <input type="time" required value={workdayStart} onChange={(event) => setStart(event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Fim do expediente</span>
          <input type="time" required value={workdayEnd} onChange={(event) => setEnd(event.target.value)} />
        </label>
      </div>
    </Block>
  )
}

function ReasonsBlock({
  value,
  groups,
  canManage,
}: {
  value: SystemSettings['reasons']
  groups: ParametersResponse['options']['reasonGroups']
  canManage: boolean
}) {
  const [reasons, setReasons] = useState(value)
  const [group, setGroup] = useState(groups[0]?.key ?? 'scheduling')
  const list = reasons[group] ?? []
  const update = (next: typeof list) => setReasons((current) => ({ ...current, [group]: next }))

  return (
    <Block
      title="Motivos padronizados"
      description="Opções de justificativa. Desativar tira a opção das próximas escolhas: o que já foi registrado não muda. A opção 'Outros', com texto livre, é sempre mantida."
      canManage={canManage}
      onSave={() => saveParameters('reasons', reasons)}
    >
      <label className="maintenance-form-field">
        <span>Lista</span>
        <select value={group} onChange={(event) => setGroup(event.target.value)}>
          {groups.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      {list.map((reason, index) => (
        <div className="action-row" key={`${group}-${index}`}>
          <label className="maintenance-form-field">
            <span className="visually-hidden">Nome do motivo {index + 1}</span>
            <input
              required
              maxLength={120}
              value={reason.label}
              onChange={(event) => update(list.map((item, position) => (position === index ? { ...item, label: event.target.value } : item)))}
            />
          </label>
          <label className="parameter-check">
            <input
              type="checkbox"
              disabled={reason.key === 'outro'}
              checked={reason.active}
              onChange={(event) => update(list.map((item, position) => (position === index ? { ...item, active: event.target.checked } : item)))}
            />
            Ativo
          </label>
        </div>
      ))}
      <button type="button" className="maintenance-secondary-button" onClick={() => update([...list, { key: '', label: '', active: true }])}>
        Adicionar motivo
      </button>
    </Block>
  )
}

function CommunicationsBlock({ value, canManage }: { value: SystemSettings['communications']; canManage: boolean }) {
  const [maxEmailMb, setMaxEmailMb] = useState(String(value.maxEmailMb))
  const [maxRecipients, setMaxRecipients] = useState(String(value.maxRecipients))
  const [allowExternal, setAllowExternal] = useState(value.allowExternalRecipients)

  return (
    <Block
      title="Central de comunicação"
      description="Limites dos e-mails enviados pelos operadores. Os formatos aceitos são os mesmos dos anexos. A conta de envio e as credenciais ficam no servidor, sob responsabilidade da TI."
      canManage={canManage}
      onSave={() => saveParameters('communications', { maxEmailMb, maxRecipients, allowExternalRecipients: allowExternal })}
    >
      <div className="form-grid">
        <label className="maintenance-form-field">
          <span>Total de anexos por mensagem (MB)</span>
          <input type="number" min="1" max="30" required value={maxEmailMb} onChange={(event) => setMaxEmailMb(event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Destinatários por mensagem</span>
          <input type="number" min="1" max="50" required value={maxRecipients} onChange={(event) => setMaxRecipients(event.target.value)} />
        </label>
      </div>
      <label className="parameter-check">
        <input type="checkbox" checked={allowExternal} onChange={(event) => setAllowExternal(event.target.checked)} />
        Permitir destinatários fora dos domínios institucionais
      </label>
    </Block>
  )
}

const moduleNames: Record<string, string> = { maintenance: 'Manutenção', fleet: 'Frota', flights: 'Passagens aéreas' }

function DeadlinesBlock({ value, canManage }: { value: SystemSettings['deadlines']; canManage: boolean }) {
  const { catalog } = useCatalog()
  const [warningDays, setWarningDays] = useState(String(value.warningDays))
  const [byModule, setByModule] = useState<Record<string, string>>(
    Object.fromEntries(Object.keys(moduleNames).map((key) => [key, value.byModule[key]?.toString() ?? ''])),
  )
  const [byType, setByType] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(value.byServiceType).map(([key, days]) => [key, String(days)])),
  )

  return (
    <Block
      title="Prazos por módulo e tipo de serviço"
      description="Vale o menor prazo definido entre prioridade, módulo e tipo de serviço. A espera registrada pelo solicitante não conta como atraso interno."
      canManage={canManage}
      onSave={() => saveParameters('deadlines', { warningDays, byModule, byServiceType: byType })}
    >
      <div className="form-grid">
        <label className="maintenance-form-field">
          <span>Alertar quantos dias antes do vencimento</span>
          <input type="number" min="1" max="60" required value={warningDays} onChange={(event) => setWarningDays(event.target.value)} />
        </label>
        {Object.entries(moduleNames).map(([key, label]) => (
          <label key={key} className="maintenance-form-field">
            <span>Prazo de {label} (dias)</span>
            <input type="number" min="1" max="365" value={byModule[key] ?? ''} onChange={(event) => setByModule((current) => ({ ...current, [key]: event.target.value }))} />
          </label>
        ))}
        {catalog.serviceTypes.map((type) => (
          <label key={type.id} className="maintenance-form-field">
            <span>Prazo de {type.label} (dias)</span>
            <input type="number" min="1" max="365" value={byType[type.id] ?? ''} onChange={(event) => setByType((current) => ({ ...current, [type.id]: event.target.value }))} />
          </label>
        ))}
      </div>
    </Block>
  )
}

/** Parâmetros de rotina, administráveis pela tela. A validação fica toda na API. */
function ParametersSection({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<ParametersResponse | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    getParameters()
      .then((response) => {
        if (active) setData(response)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar os parâmetros.'))
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <section className="settings-group" aria-labelledby="settings-parameters">
      <header>
        <span>
          <Icon name="settings" size={22} weight="duotone" />
        </span>
        <div>
          <h2 id="settings-parameters">Parâmetros do sistema</h2>
          <p>Prazos, notificações, anexos, expediente e motivos padronizados.</p>
        </div>
      </header>
      {error && <Alert tone="error">{error}</Alert>}
      {data && (
        <div className="settings-parameter-list">
          <OperationsBlock value={data.settings.operations} canManage={canManage} />
          <NotificationsBlock value={data.settings.notifications} options={data.options.notificationCategories} canManage={canManage} />
          <AttachmentsBlock value={data.settings.attachments} kinds={data.options.attachmentKinds} canManage={canManage} />
          <CalendarBlock value={data.settings.calendar} canManage={canManage} />
          <DeadlinesBlock value={data.settings.deadlines} canManage={canManage} />
          <CommunicationsBlock value={data.settings.communications} canManage={canManage} />
          <ReasonsBlock value={data.settings.reasons} groups={data.options.reasonGroups} canManage={canManage} />
        </div>
      )}
    </section>
  )
}

export default ParametersSection
