import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { errorMessage } from '../api/modulesApi'
import { getParameters, saveParameters } from '../api/operationsApi'
import type { ParametersResponse, SystemSettings } from '../api/operationsApi'
import { refreshSystemInfo } from '../app/useSystemInfo'
import { Alert } from './ui/Feedback'
import Icon from './ui/Icon'
import { PublicPageCard } from './PublicPageSettings'
import { listDemandSectors } from '../api/demandsApi'
import type { DemandSector } from '../api/demandsApi'

/**
 * Administração do sistema (13/11/2026): o que antes dependia da TI ou do código e agora a
 * administração ajusta pela tela. Cada cartão salva a própria seção; o servidor valida tudo.
 */

export function Card({
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
      await refreshSystemInfo()
      setNotice('Salvo.')
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
        <div className="ui-card-actions">
          <button type="submit" className="maintenance-primary-button" disabled={busy}>
            Salvar
          </button>
        </div>
      )}
    </form>
  )
}

function DomainsCard({ value, canManage }: { value: SystemSettings['registration']; canManage: boolean }) {
  const [text, setText] = useState(value.allowedDomains.join('\n'))
  return (
    <Card
      title="Domínios de e-mail aceitos no cadastro"
      description="Só e-mails destes domínios podem pedir conta (um por linha, por exemplo jucesp.sp.gov.br). Em branco, vale a configuração do servidor. O pedido continua exigindo aprovação."
      canManage={canManage}
      onSave={() => saveParameters('registration', { allowedDomains: text.split(/[\s,;]+/).filter(Boolean) })}
    >
      <label className="maintenance-form-field">
        <span>Domínios</span>
        <textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} placeholder="jucesp.sp.gov.br" />
      </label>
    </Card>
  )
}

function HolidaysCard({ value, canManage }: { value: SystemSettings['holidays']; canManage: boolean }) {
  const [list, setList] = useState(value.list)
  const [date, setDate] = useState('')
  const [name, setName] = useState('')
  return (
    <Card
      title="Feriados e pontos facultativos"
      description="Aparecem no Calendário, não contam como dia de trabalho na carga horária dos motoristas, e o prazo que cair num deles passa para o dia seguinte."
      canManage={canManage}
      onSave={() => saveParameters('holidays', { list })}
    >
      {list.length === 0 ? (
        <p className="management-hint">Nenhum feriado cadastrado.</p>
      ) : (
        <ul className="ui-stacked">
          {list.map((item) => (
            <li key={item.date}>
              {item.date.split('-').reverse().join('/')}: {item.name}{' '}
              <button type="button" className="central-link-button" onClick={() => setList(list.filter((entry) => entry.date !== item.date))}>
                Remover
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="form-grid">
        <label className="maintenance-form-field">
          <span>Data</span>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Nome</span>
          <input maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Consciência Negra" />
        </label>
      </div>
      <div>
        <button
          type="button"
          className="maintenance-secondary-button"
          disabled={!date || !name.trim() || list.some((item) => item.date === date)}
          onClick={() => {
            setList([...list, { date, name: name.trim() }].sort((a, b) => a.date.localeCompare(b.date)))
            setDate('')
            setName('')
          }}
        >
          <Icon name="add" size={18} />
          Incluir na lista
        </button>
        <span className="management-hint"> Depois de incluir, clique em Salvar.</span>
      </div>
    </Card>
  )
}

function AnnouncementCard({ value, canManage }: { value: SystemSettings['announcement']; canManage: boolean }) {
  const [form, setForm] = useState(value)
  return (
    <Card
      title="Aviso geral no topo do sistema"
      description="Mensagem para todas as pessoas, no topo de todas as telas e na tela de entrada, até a data final escolhida."
      canManage={canManage}
      onSave={() => saveParameters('announcement', form)}
    >
      <label className="parameter-check">
        <input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} />
        <span>Mostrar o aviso</span>
      </label>
      <label className="maintenance-form-field">
        <span>Texto do aviso</span>
        <textarea rows={2} maxLength={500} value={form.text} onChange={(event) => setForm({ ...form, text: event.target.value })} />
      </label>
      <div className="form-grid">
        <label className="maintenance-form-field">
          <span>Tipo</span>
          <select value={form.tone} onChange={(event) => setForm({ ...form, tone: event.target.value === 'warning' ? 'warning' : 'info' })}>
            <option value="info">Informação (azul)</option>
            <option value="warning">Atenção (laranja)</option>
          </select>
        </label>
        <label className="maintenance-form-field">
          <span>Mostrar até (em branco: sem data final)</span>
          <input type="date" value={form.until ?? ''} onChange={(event) => setForm({ ...form, until: event.target.value || null })} />
        </label>
      </div>
    </Card>
  )
}

const moduleLabels: Record<keyof SystemSettings['modules'], string> = {
  maintenance: 'Manutenção',
  fleet: 'Frota',
  flights: 'Passagens Aéreas',
  warehouse: 'Almoxarifado',
  demands: 'Controle de Demandas',
}

function ModulesCard({ value, canManage }: { value: SystemSettings['modules']; canManage: boolean }) {
  const [modules, setModules] = useState(value)
  return (
    <Card
      title="Módulos ligados"
      description="Um módulo desligado sai do menu e da página inicial e não recebe pedidos novos. Nada é apagado: os registros continuam consultáveis, e é possível religar a qualquer momento."
      canManage={canManage}
      onSave={() => saveParameters('modules', modules)}
    >
      <div className="parameter-check-list">
        {(Object.keys(moduleLabels) as (keyof SystemSettings['modules'])[]).map((key) => (
          <label key={key} className="parameter-check">
            <input type="checkbox" checked={modules[key] !== false} onChange={(event) => setModules({ ...modules, [key]: event.target.checked })} />
            <span>{moduleLabels[key]}</span>
          </label>
        ))}
      </div>
    </Card>
  )
}

function ContractsCard({ value, canManage }: { value: SystemSettings['contracts']; canManage: boolean }) {
  const [days, setDays] = useState(String(value.defaultNoticeDays))
  const [percent, setPercent] = useState(String(value.lowBalancePercent))
  return (
    <Card
      title="Atas e contratos"
      description="Padrões do Controle de Demandas: com quantos dias de antecedência a demanda de renovação é aberta (vale para as novas atas; cada uma pode ter o seu) e a partir de quanto o saldo de um item aparece como baixo."
      canManage={canManage}
      onSave={() => saveParameters('contracts', { defaultNoticeDays: Number(days), lowBalancePercent: Number(percent) })}
    >
      <div className="form-grid">
        <label className="maintenance-form-field">
          <span>Aviso padrão de vencimento (dias)</span>
          <input type="number" min="0" max="365" required value={days} onChange={(event) => setDays(event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Saldo baixo a partir de (%)</span>
          <input type="number" min="0" max="100" required value={percent} onChange={(event) => setPercent(event.target.value)} />
        </label>
      </div>
    </Card>
  )
}

/**
 * Guarda dos dados (LGPD, 14/11/2026): por quanto tempo os registros ficam guardados e o setor que
 * recebe a demanda para imprimir os relatórios antes do fim do prazo.
 */
function RetentionCard({ value, canManage }: { value: SystemSettings['retention']; canManage: boolean }) {
  const [months, setMonths] = useState(String(value?.months ?? 12))
  const [days, setDays] = useState(String(value?.noticeDays ?? 30))
  const [sectorId, setSectorId] = useState(value?.sectorId ?? '')
  const [sectors, setSectors] = useState<DemandSector[]>([])
  useEffect(() => {
    let active = true
    listDemandSectors()
      .then((result) => {
        if (active) setSectors(result.sectors.filter((sector) => sector.active))
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])
  return (
    <Card
      title="Guarda dos dados (LGPD)"
      description="Solicitações, CPFs de passageiros, anexos e registros de auditoria ficam guardados pelo prazo abaixo. Antes de cada mês de registros completar o prazo, o sistema abre uma demanda no setor escolhido para imprimir ou salvar os relatórios e as planilhas daquele mês. Nada é apagado automaticamente."
      canManage={canManage}
      onSave={() => saveParameters('retention', { months: Number(months), noticeDays: Number(days), sectorId: sectorId || null })}
    >
      <div className="form-grid">
        <label className="maintenance-form-field">
          <span>Prazo de guarda (meses)</span>
          <input type="number" min="1" max="120" required value={months} onChange={(event) => setMonths(event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Abrir a demanda com antecedência de (dias)</span>
          <input type="number" min="1" max="180" required value={days} onChange={(event) => setDays(event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Setor que recebe a demanda</span>
          <select value={sectorId} onChange={(event) => setSectorId(event.target.value)}>
            <option value="">Nenhum (sem aviso)</option>
            {sectors.map((sector) => (
              <option key={sector.id} value={sector.id}>
                {sector.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Card>
  )
}

function TextsCard({ value, canManage }: { value: SystemSettings['texts']; canManage: boolean }) {
  const [form, setForm] = useState(value)
  return (
    <Card
      title="Textos das telas"
      description="Mensagens fixas para orientar as pessoas. Os avisos de privacidade (LGPD) continuam fora desta edição até a validação institucional."
      canManage={canManage}
      onSave={() => saveParameters('texts', form)}
    >
      <label className="maintenance-form-field">
        <span>Mensagem da tela de entrada</span>
        <textarea rows={2} maxLength={600} value={form.loginMessage} onChange={(event) => setForm({ ...form, loginMessage: event.target.value })} />
      </label>
      <label className="maintenance-form-field">
        <span>Mensagem da página inicial</span>
        <textarea rows={2} maxLength={600} value={form.homeMessage} onChange={(event) => setForm({ ...form, homeMessage: event.target.value })} />
      </label>
    </Card>
  )
}

const profileLabels = { requester: 'Solicitante', slm_operator: 'Operador SLM' } as const

function ProfilesCard({
  value,
  options,
  canManage,
}: {
  value: SystemSettings['profileDefaults']
  options: NonNullable<ParametersResponse['options']['profileDefaults']>
  canManage: boolean
}) {
  // Marcado = o perfil recebe a permissão. O que difere do padrão do código vira ajuste.
  const initial = (profile: keyof typeof profileLabels) =>
    new Set([...options.base[profile].filter((key) => !value[profile].remove.includes(key)), ...value[profile].add])
  const [checked, setChecked] = useState({ requester: initial('requester'), slm_operator: initial('slm_operator') })

  function toggle(profile: keyof typeof profileLabels, key: string, on: boolean) {
    const next = new Set(checked[profile])
    if (on) next.add(key)
    else next.delete(key)
    setChecked({ ...checked, [profile]: next })
  }

  function adjustments() {
    return Object.fromEntries(
      (Object.keys(profileLabels) as (keyof typeof profileLabels)[]).map((profile) => {
        const base = new Set(options.base[profile])
        const adjustable = options.adjustable.map((item) => item.key)
        return [
          profile,
          {
            add: adjustable.filter((key) => checked[profile].has(key) && !base.has(key)),
            remove: adjustable.filter((key) => !checked[profile].has(key) && base.has(key)),
          },
        ]
      }),
    )
  }

  return (
    <Card
      title="Permissões padrão dos perfis"
      description="O que cada perfil recebe ao ser aprovado, e o que todas as contas desse perfil passam a ter. Só as permissões comuns de cada módulo aparecem aqui; administração, CPF, Central da SLM e agendamento continuam por concessão individual em Usuários. Concessões e retiradas individuais continuam valendo."
      canManage={canManage}
      onSave={() => saveParameters('profileDefaults', adjustments())}
    >
      <div className="data-table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Permissão</th>
              <th>{profileLabels.requester}</th>
              <th>{profileLabels.slm_operator}</th>
            </tr>
          </thead>
          <tbody>
            {options.adjustable.map((permission) => (
              <tr key={permission.key}>
                <td>{permission.label}</td>
                {(Object.keys(profileLabels) as (keyof typeof profileLabels)[]).map((profile) => (
                  <td key={profile}>
                    <input
                      type="checkbox"
                      aria-label={`${permission.label}: ${profileLabels[profile]}`}
                      checked={checked[profile].has(permission.key)}
                      onChange={(event) => toggle(profile, permission.key, event.target.checked)}
                    />
                    {options.base[profile].includes(permission.key) !== checked[profile].has(permission.key) && (
                      <small className="central-subtext">alterado</small>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function AdminSettingsSection({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<ParametersResponse | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    getParameters()
      .then((response) => {
        if (active) setData(response)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar.'))
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <section className="settings-group" aria-labelledby="settings-admin">
      <header>
        <span>
          <Icon name="customize" size={22} weight="duotone" />
        </span>
        <div>
          <h2 id="settings-admin">Administração do sistema</h2>
          <p>Cadastro, feriados, aviso geral, módulos, atas e contratos, guarda dos dados, textos e permissões padrão.</p>
        </div>
      </header>
      {error && <Alert tone="error">{error}</Alert>}
      {data && (
        <div className="settings-parameter-list">
          <AnnouncementCard value={data.settings.announcement} canManage={canManage} />
          <HolidaysCard value={data.settings.holidays} canManage={canManage} />
          <DomainsCard value={data.settings.registration} canManage={canManage} />
          <ModulesCard value={data.settings.modules} canManage={canManage} />
          <ContractsCard value={data.settings.contracts} canManage={canManage} />
          <RetentionCard value={data.settings.retention} canManage={canManage} />
          <TextsCard value={data.settings.texts} canManage={canManage} />
          <PublicPageCard value={data.settings.publicPage} canManage={canManage} />
          {data.options.profileDefaults && (
            <ProfilesCard value={data.settings.profileDefaults} options={data.options.profileDefaults} canManage={canManage} />
          )}
        </div>
      )}
    </section>
  )
}

export default AdminSettingsSection
