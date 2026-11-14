import { useEffect, useState } from 'react'
import { downloadTestDataCopy, getTestDataInfo, purgeTestData } from '../api/configApi'
import type { TestDataInfo } from '../api/configApi'
import { errorMessage } from '../api/modulesApi'
import { Alert, Loading } from './ui/Feedback'
import Icon from './ui/Icon'

/**
 * Limpeza dos dados de teste, só para o Administrador. Ordem obrigatória: escolher, conferir quantos
 * registros saem, baixar a cópia (a impressão digital dela autoriza a limpeza) e digitar a frase.
 */

const environmentText = {
  local: 'Banco local de desenvolvimento.',
  homologacao: 'Banco de homologação (testes).',
  principal: 'ATENÇÃO: este é o banco principal, usado de verdade. Só limpe se tiver certeza de que tudo aqui é teste.',
} as const

const tableLabels: Record<string, string> = {
  service_requests: 'Solicitações (Manutenção, Frota, Passagens)',
  material_requests: 'Pedidos de materiais',
  demands: 'Demandas',
  demand_series: 'Recorrências de demandas',
  patrimony_assets: 'Bens do patrimônio',
  patrimony_checks: 'Conferências de patrimônio',
  stock_movements: 'Movimentações de estoque',
  inventory_checks: 'Conferências de inventário',
  request_attachments: 'Anexos',
  demand_attachments: 'Anexos de demandas',
}

function TestDataSection() {
  const [info, setInfo] = useState<TestDataInfo | null>(null)
  const [groups, setGroups] = useState<string[]>([])
  const [fingerprint, setFingerprint] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  useEffect(() => {
    let active = true
    getTestDataInfo(groups)
      .then((result) => {
        if (active) setInfo(result)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar a limpeza.'))
      })
    return () => {
      active = false
    }
  }, [groups])

  function toggle(key: string, checked: boolean) {
    setFingerprint('')
    setConfirmation('')
    setDone('')
    setGroups((current) => (checked ? [...current, key] : current.filter((item) => item !== key)))
  }

  async function copy() {
    setBusy(true)
    setError('')
    try {
      setFingerprint(await downloadTestDataCopy(groups))
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível baixar a cópia.'))
    } finally {
      setBusy(false)
    }
  }

  async function purge() {
    setBusy(true)
    setError('')
    try {
      const result = await purgeTestData({ groups, fingerprint, confirmation })
      const files = result.filesFailed ? ` ${result.filesFailed} arquivos anexados não puderam ser apagados do armazenamento.` : ''
      setDone(`${result.total} registros apagados. A numeração dos protocolos foi recalculada: módulos vazios voltam a 00001.${files}`)
      setFingerprint('')
      setConfirmation('')
      setGroups([])
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível limpar.'))
      setFingerprint('')
    } finally {
      setBusy(false)
    }
  }

  if (!info) return error ? <Alert tone="error">{error}</Alert> : <Loading label="Carregando..." />
  const preview = info.preview
  const mainCounts = preview
    ? Object.entries(preview.counts).filter(([table]) => tableLabels[table]).map(([table, total]) => `${tableLabels[table]}: ${total}`)
    : []

  return (
    <section className="settings-group" aria-labelledby="settings-test-data">
      <header>
        <span>
          <Icon name="warning" size={22} weight="duotone" />
        </span>
        <div>
          <h2 id="settings-test-data">Limpar dados de teste</h2>
          <p>Só para o Administrador. Apaga solicitações e registros de teste e recomeça a numeração dos protocolos.</p>
        </div>
      </header>
      <div className="ui-card ui-stacked">
        <Alert tone={info.environment === 'principal' ? 'error' : 'info'}>{environmentText[info.environment]}</Alert>
        <p className="management-hint">
          O que for apagado some do sistema, com o histórico, os anexos, os e-mails na fila e as notificações. Fica só o
          registro na Auditoria de quem limpou e quando. Cadastros de usuários, setores, materiais, veículos, atas e
          configurações não são apagados.
        </p>

        <fieldset className="parameter-check-list">
          <legend>1. O que limpar</legend>
          {info.groups.map((group) => (
            <label key={group.key} className="parameter-check">
              <input type="checkbox" disabled={busy} checked={groups.includes(group.key)} onChange={(event) => toggle(group.key, event.target.checked)} />{' '}
              {group.label}
            </label>
          ))}
        </fieldset>

        {!preview && (
          <>
            <Alert tone="info">
              Marque acima o que limpar. Em seguida aparecem: quantos registros saem, o botão <strong>Baixar a cópia</strong> e o
              campo da frase de confirmação. O botão <strong>Apagar</strong> é liberado depois desses passos. Para excluir uma
              solicitação só, use o botão <strong>Excluir</strong> no detalhe dela.
            </Alert>
            <button type="button" className="ui-button-danger" disabled>
              Apagar registros
            </button>
          </>
        )}
        {preview && (
          <>
            <h3>2. O que vai sair</h3>
            <p>
              <strong>{preview.total} registros</strong> no total{preview.files ? `, com ${preview.files} arquivos anexados` : ''}.
            </p>
            {mainCounts.length > 0 && (
              <ul>
                {mainCounts.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}

            <h3>3. Baixe a cópia</h3>
            <p className="management-hint">
              Um arquivo com tudo o que será apagado, para guardar fora do sistema. Sem a cópia, a limpeza não é liberada.
            </p>
            <button type="button" className="maintenance-secondary-button" disabled={busy || preview.total === 0} onClick={() => void copy()}>
              <Icon name="download" size={18} /> Baixar a cópia
            </button>
            {fingerprint && <Alert tone="success">Cópia baixada. Guarde o arquivo antes de continuar.</Alert>}

            <h3>4. Confirme</h3>
            <label className="maintenance-form-field">
              <span>
                Digite <strong>{info.confirmation}</strong> para liberar
              </span>
              <input autoComplete="off" disabled={!fingerprint || busy} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
            </label>
            <button
              type="button"
              className="ui-button-danger"
              disabled={!fingerprint || busy || confirmation.trim() !== info.confirmation}
              onClick={() => void purge()}
            >
              Apagar {preview.total} registros
            </button>
          </>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        {done && <Alert tone="success">{done}</Alert>}
      </div>
    </section>
  )
}

export default TestDataSection
