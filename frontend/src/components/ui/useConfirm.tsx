import { useCallback, useRef, useState } from 'react'
import Modal from './Modal'

type Pending = { message: string; confirmLabel: string; danger: boolean }

/** Confirmação em janela do sistema, no lugar do alerta do navegador. */
export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null)
  const resolver = useRef<(answer: boolean) => void>(() => {})

  const confirm = useCallback(
    (message: string, options: { confirmLabel?: string; danger?: boolean } = {}) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve
        setPending({
          message,
          confirmLabel: options.confirmLabel ?? 'Confirmar',
          danger: options.danger ?? false,
        })
      }),
    [],
  )

  const answer = (value: boolean) => {
    setPending(null)
    resolver.current(value)
  }

  const confirmDialog = pending && (
    <Modal
      title="Confirme a ação"
      onClose={() => answer(false)}
      actions={
        <>
          <button type="button" className="ui-button" onClick={() => answer(false)}>
            Voltar
          </button>
          <button
            type="button"
            autoFocus
            data-confirm
            className={pending.danger ? 'ui-button ui-button-danger' : 'ui-button ui-button-primary'}
            onClick={() => answer(true)}
          >
            {pending.confirmLabel}
          </button>
        </>
      }
    >
      <p>{pending.message}</p>
    </Modal>
  )

  return { confirm, confirmDialog }
}
