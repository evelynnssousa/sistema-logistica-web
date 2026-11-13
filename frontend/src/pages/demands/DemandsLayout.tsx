import { Suspense, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import {
  fetchDemandOptions,
  fetchDemandPreferences,
  notificationKindLabels,
  saveDemandPreferences,
} from '../../api/demandsApi'
import type { DemandContext, DemandMembership, DemandOptions, DemandProfile } from '../../api/demandsApi'
import { errorMessage } from '../../api/modulesApi'
import { useDemandContext } from '../../app/useDemandContext'
import { Alert, Loading } from '../../components/ui/Feedback'
import Icon from '../../components/ui/Icon'
import type { IconName } from '../../components/ui/Icon'
import Modal from '../../components/ui/Modal'
import PageHeader from '../../components/ui/PageHeader'
import AccessDeniedPage from '../AccessDeniedPage'
import type { DemandsOutlet } from './useDemands'

function PreferencesDialog({ onClose }: { onClose: () => void }) {
  const [reminderDays, setReminderDays] = useState('3')
  const [muted, setMuted] = useState<string[]>([])
  const [email, setEmail] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    fetchDemandPreferences()
      .then(({ preferences }) => {
        if (!active) return
        setReminderDays(String(preferences.reminderDays))
        setMuted(preferences.muted)
        setEmail(preferences.email)
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar as preferências.'))
      })
    return () => {
      active = false
    }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await saveDemandPreferences({ reminderDays: Number(reminderDays), muted, email })
      setSaved(true)
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível salvar as preferências.'))
    }
  }

  return (
    <Modal title="Preferências de notificação" onClose={onClose}>
      {!loaded && !error && <Loading />}
      {error && <Alert tone="error">{error}</Alert>}
      {saved && <Alert tone="success">Preferências salvas.</Alert>}
      {loaded && (
        <form className="demand-dialog-form" onSubmit={(event) => void submit(event)}>
          <label className="maintenance-form-field">
            <span>Lembrar quantos dias antes do prazo</span>
            <input
              type="number"
              min="0"
              max="60"
              value={reminderDays}
              onChange={(event) => setReminderDays(event.target.value)}
            />
          </label>
          <fieldset className="demand-checks">
            <legend>Receber aviso de</legend>
            {Object.entries(notificationKindLabels).map(([kind, label]) => (
              <label key={kind}>
                <input
                  type="checkbox"
                  checked={!muted.includes(kind)}
                  onChange={(event) =>
                    setMuted((current) =>
                      event.target.checked ? current.filter((item) => item !== kind) : [...current, kind],
                    )
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <label className="demand-check">
            <input type="checkbox" checked={email} onChange={(event) => setEmail(event.target.checked)} />
            Quero receber também por e-mail institucional
          </label>
          <p className="demand-muted">
            Os avisos chegam sempre pelo sino e pela página de Notificações. Por e-mail, só para quem marcar
            esta opção, respeitando os tipos silenciados acima, e só depois de a instituição ativar o serviço
            de e-mail. Em demanda restrita, o e-mail leva apenas o número, sem título nem conteúdo.
          </p>
          <div className="demand-dialog-actions">
            <button type="submit" className="maintenance-primary-button">Salvar preferências</button>
          </div>
        </form>
      )}
    </Modal>
  )
}

const profileLabels: Record<DemandProfile, string> = {
  servidor: 'Servidor do setor',
  chefe: 'Chefe do setor',
  diretor: 'Diretor da Diretoria Administrativa',
  administrador: 'Administrador do sistema',
}

/** Diz com qual perfil a pessoa está e o que ele permite. O backend confere cada operação. */
function ProfileSummary({ context }: { context: DemandContext }) {
  const sectorsOf = (role: DemandMembership['role']) =>
    context.memberships.filter((item) => item.role === role).map((item) => item.sectorName).join(', ')
  const parts = context.profiles.map((profile) => {
    const sectors = profile === 'chefe' ? sectorsOf('responsavel') : profile === 'servidor' ? sectorsOf('colaborador') : ''
    return sectors ? `${profileLabels[profile]} (${sectors})` : profileLabels[profile]
  })
  const reach = context.consultationOnly
    ? 'Somente consulta: você vê as demandas de todos os setores e não altera nenhum registro.'
    : context.directorate
      ? 'Você vê, cadastra e edita as demandas de todos os setores da Diretoria Administrativa.'
      : 'Você vê, cadastra e edita as demandas do seu setor.'
  return (
    <p className="demand-profile" data-testid="demand-profile">
      <strong>Seu acesso: {parts.join(' + ')}.</strong> {reach}
    </p>
  )
}

function DemandsLayout() {
  const { context, failed } = useDemandContext()
  const [options, setOptions] = useState<DemandOptions | null>(null)
  const [optionsError, setOptionsError] = useState('')
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const hasAccess = context?.hasAccess === true

  useEffect(() => {
    if (!hasAccess) return
    let active = true
    fetchDemandOptions()
      .then((data) => {
        if (active) setOptions(data)
      })
      .catch((err: unknown) => {
        if (active) setOptionsError(errorMessage(err, 'Não foi possível carregar o módulo.'))
      })
    return () => {
      active = false
    }
  }, [hasAccess])

  if (failed) return <Alert tone="error">Não foi possível carregar o Controle de Demandas.</Alert>
  if (!context) return <Loading label="Carregando o Controle de Demandas..." />
  if (!context.migrated) {
    return (
      <div className="admin-module-page">
        <PageHeader title="Controle de Demandas" />
        <Alert tone="warning">O módulo depende de uma atualização do banco de dados ainda não aplicada.</Alert>
        {import.meta.env.DEV && (
          <Alert tone="info">
            Ambiente de desenvolvimento: para ver o módulo funcionando sem tocar neste banco, rode{' '}
            <code>npm run demo:demandas</code> e abra o endereço que o comando mostrar.
          </Alert>
        )}
      </div>
    )
  }
  if (!context.hasAccess) return <AccessDeniedPage />

  const tabs: { to: string; label: string; icon: IconName; end?: boolean; show?: boolean }[] = [
    { to: '/demandas', label: 'Painel Geral', icon: 'overview', end: true },
    { to: '/demandas/todas', label: 'Todas as Demandas', icon: 'requests' },
    { to: '/demandas/minhas', label: 'Minhas Atividades', icon: 'inventory' },
    { to: '/demandas/setores', label: 'Demandas por Setor', icon: 'lists' },
    { to: '/demandas/compartilhadas', label: 'Demandas Compartilhadas', icon: 'users' },
    { to: '/demandas/agenda', label: 'Agenda', icon: 'calendar' },
    { to: '/demandas/atas', label: 'Atas e Contratos', icon: 'scales' },
    { to: '/demandas/relatorios', label: 'Relatórios', icon: 'reports', show: context.canSeeReports },
  ]

  return (
    <div className="admin-module-page demands-page">
      <PageHeader
        title="Controle de Demandas"
        description="Atividades e providências administrativas dos setores da Diretoria Administrativa."
        actions={
          <>
            <button type="button" className="maintenance-secondary-button" onClick={() => setPreferencesOpen(true)}>
              <Icon name="notifications" size={18} />
              Preferências
            </button>
            {context.canCreate && (
              <Link className="maintenance-primary-button" to="/demandas/nova">
                <Icon name="add" size={18} />
                Nova demanda
              </Link>
            )}
          </>
        }
      />

      <ProfileSummary context={context} />

      <nav className="module-tabs" aria-label="Áreas do Controle de Demandas">
        {tabs
          .filter((tab) => tab.show !== false)
          .map((tab) => (
            <NavLink key={tab.to} to={tab.to} end={tab.end}>
              <Icon name={tab.icon} size={18} />
              {tab.label}
            </NavLink>
          ))}
      </nav>

      {optionsError && <Alert tone="error">{optionsError}</Alert>}
      {!options && !optionsError && <Loading label="Carregando..." />}
      {options && (
        <Suspense fallback={<Loading label="Carregando..." />}>
          <Outlet context={{ context, options } satisfies DemandsOutlet} />
        </Suspense>
      )}

      {preferencesOpen && <PreferencesDialog onClose={() => setPreferencesOpen(false)} />}
    </div>
  )
}

export default DemandsLayout
