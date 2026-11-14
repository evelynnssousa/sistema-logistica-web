import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { deleteRecord, downloadRecordCopy, getRecordDeletion } from '../api/configApi'
import type { DeletableKind } from '../api/configApi'
import { errorMessage } from '../api/modulesApi'
import { useAuthenticatedUser, useHasPermission } from '../auth/UserContext'
import { Alert, Loading } from './ui/Feedback'
import Icon from './ui/Icon'
import Modal from './ui/Modal'

type Deletion = Awaited<ReturnType<typeof getRecordDeletion>>

const environmentText = {
  local: 'Banco local de desenvolvimento.',
  homologacao: 'Banco de homologação (testes).',
  principal: 'ATENÇÃO: este é o banco principal, usado de verdade. Exclua só se tiver certeza de que esta solicitação é teste ou foi aberta por engano.',
} as const

/**
 * Excluir uma solicitação ou um pedido de materiais (14/11/2026), só para o Administrador. Mesmas
 * garantias da limpeza de testes: baixar a cópia antes, digitar o protocolo e ficar na Auditoria.
 */
function DeleteRecordButton({ kind, id, afterPath }: { kind: DeletableKind; id: string; afterPath: string }) {
  const user = useAuthenticatedUser()
  const canManage = useHasPermission('settings:manage')
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<Deletion | null>(null)
  const [fingerprint, setFingerprint] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (user?.role !== 'administrator' || !canManage) return null

  async function start() {
    setOpen(true)
    setInfo(null)
    setFingerprint('')
    setConfirmation('')
    setError('')
    try {
      setInfo(await getRecordDeletion(kind, id))
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível preparar a exclusão.'))
    }
  }

  async function copy() {
    setBusy(true)
    setError('')
    try {
      setFingerprint(await downloadRecordCopy(kind, id))
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível baixar a cópia.'))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setError('')
    try {
      await deleteRecord(kind, id, { fingerprint, confirmation })
      navigate(afterPath, { replace: true })
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível excluir.'))
      setFingerprint('')
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" className="ui-button-danger" onClick={() => void start()}>
        <Icon name="clear" size={18} />
        Excluir
      </button>
      {open && (
        <Modal title="Excluir esta solicitação" onClose={() => !busy && setOpen(false)}>
          <div className="ui-stacked">
            {!info && !error && <Loading compact label="Preparando..." />}
            {info && (
              <>
                <Alert tone={info.environment === 'principal' ? 'error' : 'warning'}>{environmentText[info.environment]}</Alert>
                <p>
                  A solicitação some do sistema para sempre, com o histórico, os anexos, os e-mails e as notificações dela:{' '}
                  <strong>{info.preview.total} registros</strong>
                  {info.preview.files ? `, com ${info.preview.files} arquivos anexados` : ''}. Fica só o registro na Auditoria de quem
                  excluiu e quando. O número do protocolo não é reaproveitado.
                </p>
                <ol className="delete-record-steps">
                  <li>
                    <span>Baixe a cópia, para guardar fora do sistema.</span>
                    <button type="button" className="maintenance-secondary-button" disabled={busy} onClick={() => void copy()}>
                      <Icon name="download" size={18} /> {fingerprint ? 'Cópia baixada' : 'Baixar a cópia'}
                    </button>
                  </li>
                  <li>
                    <label className="maintenance-form-field">
                      <span>
                        Digite o protocolo <strong>{info.confirmation}</strong> para confirmar
                      </span>
                      <input
                        autoComplete="off"
                        disabled={!fingerprint || busy}
                        value={confirmation}
                        onChange={(event) => setConfirmation(event.target.value)}
                      />
                    </label>
                  </li>
                </ol>
                {!fingerprint && <p className="management-hint">O campo do protocolo é liberado depois de baixar a cópia.</p>}
                <button
                  type="button"
                  className="ui-button-danger"
                  disabled={!fingerprint || busy || confirmation.trim().toUpperCase() !== info.confirmation.toUpperCase()}
                  onClick={() => void remove()}
                >
                  {busy ? 'Excluindo...' : 'Excluir definitivamente'}
                </button>
              </>
            )}
            {error && <Alert tone="error">{error}</Alert>}
          </div>
        </Modal>
      )}
    </>
  )
}

export default DeleteRecordButton
